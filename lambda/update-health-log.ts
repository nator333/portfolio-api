import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  HEALTH_LOG_PK,
  HEALTH_NOTE_FIELDS,
  toHealthLogEntry,
  updateHealthLogSchema,
  type HealthLogItem,
} from './health-log-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Add to or correct the notes half of an existing health-log day. Admin only.
 *
 * The one write Claude has on the log, and it is narrow by construction: the
 * schema admits only the note fields, the update expression names only those,
 * and the condition refuses a day the nightly job has not created. So it can
 * neither create a day nor touch what the watch measured. A field sent as null
 * is removed; a field left out is left as it was.
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
  const { date, ...changes } = validation.data;

  const names: Record<string, string> = { '#notesUpdatedAt': 'notesUpdatedAt' };
  const values: Record<string, unknown> = { ':notesUpdatedAt': new Date().toISOString() };
  const sets = ['#notesUpdatedAt = :notesUpdatedAt'];
  const removes: string[] = [];
  for (const field of HEALTH_NOTE_FIELDS) {
    const value = changes[field];
    if (value === undefined) continue;
    names[`#${field}`] = field;
    if (value === null) {
      removes.push(`#${field}`);
    } else {
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }
  }
  const expression = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: HEALTH_LOG_PK, date },
        UpdateExpression: expression,
        ConditionExpression: 'attribute_exists(#measured)',
        ExpressionAttributeNames: { ...names, '#measured': 'measured' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return respond(200, toHealthLogEntry(result.Attributes as HealthLogItem));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return respond(404, {
        message:
          `No health log entry for ${date}. Entries are created only by the nightly job at 22:00 the owner's ` +
          `time: today's appears after tonight's run, and days before the log's first 28-day backfill never exist.`,
      });
    }
    throw error;
  }
};
