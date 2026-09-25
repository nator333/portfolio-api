import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  REFLECTION_LIST_DEFAULT_LIMIT,
  REFLECTION_TYPES,
  listReflectionsSchema,
  toReflection,
  type ReflectionItem,
  type ReflectionType,
} from './reflection-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Read reflection notes, newest first. Admin only.
 *
 * One Query per type over the date window. With no `type` both kinds are read
 * and merged, which is what "how have things been going?" wants. A `theme`
 * filter is applied server-side; since DynamoDB counts `Limit` before a filter,
 * a filtered read pages until it has enough matches rather than returning a
 * short page that looks like the end of the history.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.REFLECTIONS_TABLE_NAME;
  if (!tableName) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'REFLECTIONS_TABLE_NAME is not configured' }),
    };
  }

  const query = Object.fromEntries(
    Object.entries(event.queryStringParameters ?? {}).filter(([, v]) => v !== undefined && v !== ''),
  );
  const validation = listReflectionsSchema.safeParse(query);
  if (!validation.success) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Invalid reflection query', errors: validation.error.issues }),
    };
  }

  const { type, from, to, theme, limit = REFLECTION_LIST_DEFAULT_LIMIT } = validation.data;
  const types: readonly ReflectionType[] = type ? [type] : REFLECTION_TYPES;

  const perType = await Promise.all(
    types.map((t) => queryType(tableName, t, { from, to, theme, limit })),
  );

  // Newest first across types; the sort key leads with the date, so it orders
  // correctly as a string, and the uuid tail only breaks same-day ties.
  const reflections = perType
    .flat()
    .sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0))
    .slice(0, limit)
    .map(toReflection);

  return { statusCode: 200, headers, body: JSON.stringify({ count: reflections.length, reflections }) };
};

async function queryType(
  tableName: string,
  type: ReflectionType,
  opts: { from?: string; to?: string; theme?: string; limit: number },
): Promise<ReflectionItem[]> {
  const names: Record<string, string> = { '#type': 'type' };
  const values: Record<string, unknown> = { ':type': type };
  let keyCondition = '#type = :type';

  // `#` sorts before every uuid character, and `$` after it, so these bounds
  // take in every note on the boundary days and nothing beyond them.
  if (opts.from || opts.to) {
    names['#sk'] = 'sk';
    if (opts.from && opts.to) {
      keyCondition += ' AND #sk BETWEEN :lo AND :hi';
      values[':lo'] = `${opts.from}#`;
      values[':hi'] = `${opts.to}$`;
    } else if (opts.from) {
      keyCondition += ' AND #sk >= :lo';
      values[':lo'] = `${opts.from}#`;
    } else {
      keyCondition += ' AND #sk <= :hi';
      values[':hi'] = `${opts.to}$`;
    }
  }

  let filter: string | undefined;
  if (opts.theme) {
    names['#themes'] = 'themes';
    values[':theme'] = opts.theme;
    filter = 'contains(#themes, :theme)';
  }

  const items: ReflectionItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: keyCondition,
        FilterExpression: filter,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        // Unfiltered, the page size is exactly what is needed. Filtered, it is
        // left to DynamoDB's default so each round trip examines a full page.
        Limit: filter ? undefined : opts.limit - items.length,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((page.Items ?? []) as ReflectionItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey && items.length < opts.limit);

  return items.slice(0, opts.limit);
}
