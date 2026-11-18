import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { HEALTH_LOG_PK, HEALTH_RATINGS, toHealthLogEntry, updateHealthLogSchema, type HealthLogItem } from './health-log-schema';
import { fillReadiness } from './health-log-measure';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Correct the notes half of an existing health-log day. Admin only.
 *
 * JSON Merge Patch over what list_health_log returns, like every update_ tool:
 * an omitted field is unchanged, null clears it, and `notes` (an object keyed
 * by entry id) merges, so `{id: {text}}` rewrites one entry and `{id: null}`
 * removes it while the others stay as they are. Adding an entry is
 * add_health_note's job, not this one's: every id named here must already
 * exist, so a typo cannot quietly create a note.
 *
 * Narrow by construction: the schema admits only the note fields, the update
 * names only those, and the condition refuses a day the scheduled job has not
 * created. So Claude can neither create a day nor supply a measured value.
 *
 * Afterwards, like add_health_note, it tries to record the day's readiness
 * if it has none (see fillReadiness in health-log-measure.ts).
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

  const validation = updateHealthLogSchema.safeParse(parsedBody);
  if (!validation.success) {
    return respond(400, { message: 'Invalid health log update', errors: validation.error.issues });
  }
  const { date, notes, tags, ...ratings } = validation.data;

  const names: Record<string, string> = { '#measured': 'measured', '#notesUpdatedAt': 'notesUpdatedAt' };
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const sets = ['#notesUpdatedAt = :now'];
  const removes: string[] = [];
  const conditions = ['attribute_exists(#measured)'];

  for (const field of HEALTH_RATINGS) {
    const value = ratings[field];
    if (value === undefined) continue;
    names[`#${field}`] = field;
    if (value === null) {
      removes.push(`#${field}`);
    } else {
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }
  }

  if (tags !== undefined) {
    names['#tags'] = 'tags';
    // A string set cannot be empty, so [] clears like null does.
    if (tags === null || tags.length === 0) {
      removes.push('#tags');
    } else {
      values[':tags'] = new Set(tags);
      sets.push('#tags = :tags');
    }
  }

  const ids = Object.keys(notes ?? {});
  if (ids.length > 0) {
    names['#notes'] = 'notes';
    ids.forEach((id, i) => {
      names[`#n${i}`] = id;
      conditions.push(`attribute_exists(#notes.#n${i})`);
      const change = notes![id];
      if (change === null) {
        removes.push(`#notes.#n${i}`);
      } else {
        names['#text'] = 'text';
        names['#editedAt'] = 'editedAt';
        values[`:t${i}`] = change.text;
        sets.push(`#notes.#n${i}.#text = :t${i}`, `#notes.#n${i}.#editedAt = :now`);
      }
    });
  }

  const expression = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;

  let saved: HealthLogItem;
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: HEALTH_LOG_PK, date },
        UpdateExpression: expression,
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    saved = result.Attributes as HealthLogItem;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return respond(404, {
        message:
          ids.length > 0
            ? `No health log entry for ${date}, or no note with id ${ids.join(', ')} on it. ` +
              'Use the ids list_health_log returns; to add a note, use add_health_note.'
            : `No health log entry for ${date}. Days are created only by the scheduled job: today's at 00:05 the ` +
              `owner's time, so a future day does not exist yet, and days before the log's first 28-day backfill never will.`,
      });
    }
    throw error;
  }

  const { item, readinessFetch } = await fillReadiness(tableName, saved);
  return respond(200, { ...toHealthLogEntry(item), readinessFetch });
};
