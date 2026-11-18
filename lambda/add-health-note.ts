import { randomBytes } from 'crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  HEALTH_LOG_PK,
  HEALTH_NOTES_PER_DAY_MAX,
  addHealthNoteSchema,
  newNoteId,
  toHealthLogEntry,
  type HealthLogItem,
  type HealthNote,
} from './health-log-schema';
import { fillReadiness } from './health-log-measure';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Append one note to an existing health-log day. Admin only.
 *
 * Built for the way the log is used: several things said over a day, each
 * saved as it comes. The append is a single conditional write, so nothing has
 * to be read first and an earlier note can never be lost to a stale read.
 * `tags` are added to the day's tag set in the same write (a string set, so
 * adding is a union, not a replace).
 *
 * Like update_health_log, it never creates a day and never touches the
 * measured half; afterwards it tries to record the day's readiness if it has
 * none (fillReadiness in health-log-measure.ts).
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: JSON.stringify(body),
  });

  const tableName = process.env.HEALTH_LOG_TABLE_NAME;
  if (!tableName) return respond(500, { message: 'HEALTH_LOG_TABLE_NAME is not configured' });

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body ?? '');
  } catch {
    return respond(400, { message: 'Request body must be valid JSON' });
  }
  const validation = addHealthNoteSchema.safeParse(parsedBody);
  if (!validation.success) {
    return respond(400, { message: 'Invalid health note', errors: validation.error.issues });
  }
  const { date, text, tags } = validation.data;

  const now = new Date();
  const id = newNoteId(now, randomBytes(2).toString('hex'));
  const note: HealthNote = { at: now.toISOString(), text };

  const names: Record<string, string> = {
    '#measured': 'measured',
    '#notes': 'notes',
    '#id': id,
    '#notesUpdatedAt': 'notesUpdatedAt',
  };
  const values: Record<string, unknown> = { ':note': note, ':now': note.at };
  let add = '';
  if (tags && tags.length > 0) {
    names['#tags'] = 'tags';
    values[':tags'] = new Set(tags);
    add = ' ADD #tags :tags';
  }

  const send = (setNotes: string, condition: string, extraValues: Record<string, unknown>) =>
    ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: HEALTH_LOG_PK, date },
        UpdateExpression: `SET ${setNotes}, #notesUpdatedAt = :now${add}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...values, ...extraValues },
        ReturnValues: 'ALL_NEW',
        // On a refusal, say why: no day, no notes yet, or a full day.
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );

  let saved: HealthLogItem;
  try {
    // The common case: the day already has entries; add one to the map.
    const result = await send(
      '#notes.#id = :note',
      'attribute_exists(#measured) AND attribute_exists(#notes) AND size(#notes) < :max',
      { ':max': HEALTH_NOTES_PER_DAY_MAX },
    );
    saved = result.Attributes as HealthLogItem;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    // The refused item comes back raw (AttributeValues); presence is all we need.
    const existing = error.Item;
    if (!existing?.measured) {
      return respond(404, {
        message:
          `No health log entry for ${date}. Days are created only by the scheduled job: today's at 00:05 the ` +
          `owner's time, so a future day does not exist yet, and days before the log's first 28-day backfill never will.`,
      });
    }
    if (existing.notes) {
      return respond(409, { message: `${date} already has ${HEALTH_NOTES_PER_DAY_MAX} notes, the most a day can hold.` });
    }
    // The day's first note: create the map with it, unless another note
    // created it in the meantime, in which case the first form now applies.
    try {
      const result = await send('#notes = :first', 'attribute_exists(#measured) AND attribute_not_exists(#notes)', {
        ':first': { [id]: note },
      });
      saved = result.Attributes as HealthLogItem;
    } catch (retryError) {
      if (!(retryError instanceof ConditionalCheckFailedException)) throw retryError;
      const result = await send('#notes.#id = :note', 'attribute_exists(#measured) AND attribute_exists(#notes)', {});
      saved = result.Attributes as HealthLogItem;
    }
  }

  const { item, readinessFetch } = await fillReadiness(tableName, saved);
  return respond(200, { id, ...toHealthLogEntry(item), readinessFetch });
};
