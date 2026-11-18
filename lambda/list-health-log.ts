import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  HEALTH_LIST_DEFAULT_DAYS,
  HEALTH_LOG_PK,
  listHealthLogSchema,
  toHealthLogEntry,
  type HealthLogItem,
} from './health-log-schema';
import { addDays, isValidTimeZone, localDate } from './readiness';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Read health-log days, newest first. Admin only.
 *
 * With no window, the last HEALTH_LIST_DEFAULT_DAYS days ending today in the
 * owner's time zone; with only one bound, that many days from or to it. Reads
 * only what the scheduled job and the note tools stored; never Google.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: JSON.stringify(body),
  });

  const tableName = process.env.HEALTH_LOG_TABLE_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!tableName || !timeZone || !isValidTimeZone(timeZone)) {
    return respond(500, { message: 'HEALTH_LOG_TABLE_NAME and a valid HEALTH_TIME_ZONE must both be configured' });
  }

  const query = Object.fromEntries(
    Object.entries(event.queryStringParameters ?? {}).filter(([, v]) => v !== undefined && v !== ''),
  );
  const validation = listHealthLogSchema.safeParse(query);
  if (!validation.success) {
    return respond(400, { message: 'Invalid health log query', errors: validation.error.issues });
  }

  const span = HEALTH_LIST_DEFAULT_DAYS - 1;
  let { from, to } = validation.data;
  if (!from && !to) to = localDate(new Date(), timeZone);
  if (!from) from = addDays(to!, -span);
  if (!to) to = addDays(from, span);

  const items: HealthLogItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk AND #date BETWEEN :from AND :to',
        ExpressionAttributeNames: { '#pk': 'pk', '#date': 'date' },
        ExpressionAttributeValues: { ':pk': HEALTH_LOG_PK, ':from': from, ':to': to },
        ScanIndexForward: false,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((page.Items ?? []) as HealthLogItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return respond(200, { from, to, count: items.length, days: items.map(toHealthLogEntry) });
};
