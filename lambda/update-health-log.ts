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
import { hasReadiness, recordReadiness } from './health-log-measure';
import { GoogleHealthError } from './google-health';
import { isValidTimeZone } from './readiness';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Add to or correct the notes half of an existing health-log day. Admin only.
 *
 * The one write Claude has on the log, and it is narrow by construction: the
 * schema admits only the note fields, the update expression names only those,
 * and the condition refuses a day the scheduled job has not created (today is
 * opened at 00:05). So Claude can neither create a day nor supply a measured
 * value. A field sent as null is removed; a field left out is left as it was.
 *
 * After the notes are saved, if the day has no readiness reading yet, the
 * handler itself tries to record one from Google Health, so the first note of
 * the morning also captures the night's sleep, HRV and resting heart rate.
 * The values come from Google, never from Claude's arguments, and are written
 * under the 'until-ready' rule (health-log-measure.ts), which never replaces
 * a "ready" reading. A Google failure is reported in `readinessFetch` and
 * does not undo the notes; the 10:00 and 22:00 runs try again.
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
    const saved = result.Attributes as HealthLogItem;
    const { item, readinessFetch } = await fillReadiness(tableName, saved);
    return respond(200, { ...toHealthLogEntry(item), readinessFetch });
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return respond(404, {
        message:
          `No health log entry for ${date}. Days are created only by the scheduled job: today's at 00:05 the ` +
          `owner's time, so a future day does not exist yet, and days before the log's first 28-day backfill never will.`,
      });
    }
    throw error;
  }
};

type ReadinessFetch =
  | { attempted: false; reason: 'already_ready' }
  | { attempted: true; outcome: 'recorded' | 'already_ready' }
  | { attempted: true; outcome: 'failed'; message: string };

/** Try to record the day's readiness if it has none. Never throws. */
async function fillReadiness(
  tableName: string,
  item: HealthLogItem,
): Promise<{ item: HealthLogItem; readinessFetch: ReadinessFetch }> {
  if (hasReadiness(item)) return { item, readinessFetch: { attempted: false, reason: 'already_ready' } };

  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!secretName || !timeZone || !isValidTimeZone(timeZone)) {
    return {
      item,
      readinessFetch: { attempted: true, outcome: 'failed', message: 'Google Health is not configured on this endpoint' },
    };
  }
  try {
    const stored = await recordReadiness(tableName, secretName, timeZone, item.date);
    // null: something else recorded a ready reading first; the notes still stand.
    return stored
      ? { item: stored, readinessFetch: { attempted: true, outcome: 'recorded' } }
      : { item, readinessFetch: { attempted: true, outcome: 'already_ready' } };
  } catch (error) {
    const message = error instanceof GoogleHealthError ? error.message : 'Google Health could not be read';
    console.error('Readiness fetch on health log update failed', error);
    return { item, readinessFetch: { attempted: true, outcome: 'failed', message } };
  }
}
