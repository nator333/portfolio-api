import { randomUUID } from 'crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * Optimistic concurrency for the four site documents (cv, projects, blog,
 * home), in plain HTTP terms: every GET carries an `ETag`, and a PUT that
 * sends `If-Match` is refused with 412 if the document changed since.
 *
 * Each write stamps a fresh random `version` on the item. It is stored beside
 * the document, never inside it: readers strip it from the body, so public
 * responses and the front-end's models are unchanged.
 *
 * `If-Match` is optional at the REST layer, because the front-end's editors
 * save without it, and their saves still change the version. The MCP server's
 * replace_content always sends it, so Claude cannot overwrite an edit made
 * after it read the document.
 */

const VERSION_ATTR = 'version';

/** The version of a document never written with one (or never written at all). */
export const INITIAL_VERSION = '0';

/** The stored version, and the item with it (and the key) removed. */
export function splitVersion<T extends Record<string, unknown>>(
  item: T | undefined,
): { version: string; rest: Omit<T, 'id' | 'version'> | undefined } {
  if (!item) return { version: INITIAL_VERSION, rest: undefined };
  const { id: _id, [VERSION_ATTR]: version, ...rest } = item;
  return { version: typeof version === 'string' ? version : INITIAL_VERSION, rest: rest as Omit<T, 'id' | 'version'> };
}

export const etag = (version: string) => `"${version}"`;

/** The version a request's `If-Match` names, or undefined when it sends none. */
export function ifMatch(event: APIGatewayProxyEvent): string | undefined {
  const headers = event.headers ?? {};
  const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1];
  if (!raw) return undefined;
  return raw.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

/** The version a handler's response carries in its `ETag`, if any. */
export function versionOf(result: APIGatewayProxyResult): string | undefined {
  const raw = Object.entries(result.headers ?? {}).find(([k]) => k.toLowerCase() === 'etag')?.[1];
  return typeof raw === 'string' ? raw.replace(/^"(.*)"$/, '$1') : undefined;
}

/**
 * Put `item` under `id` with a fresh version. With `expected`, only if the
 * stored version still is that one. Returns the new version, or null on a
 * mismatch.
 */
export async function putVersioned(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  id: string,
  item: Record<string, unknown>,
  expected: string | undefined,
): Promise<string | null> {
  const version = randomUUID();
  const condition =
    expected === undefined
      ? {}
      : expected === INITIAL_VERSION
        ? { ConditionExpression: 'attribute_not_exists(#v)', ExpressionAttributeNames: { '#v': VERSION_ATTR } }
        : {
            ConditionExpression: '#v = :expected',
            ExpressionAttributeNames: { '#v': VERSION_ATTR },
            ExpressionAttributeValues: { ':expected': expected },
          };
  try {
    await ddb.send(
      new PutCommand({ TableName: tableName, Item: { ...item, id, [VERSION_ATTR]: version }, ...condition }),
    );
    return version;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}

/** The 412 a stale `If-Match` gets. */
export function preconditionFailed(headers: Record<string, string>, doc: string): APIGatewayProxyResult {
  return {
    statusCode: 412,
    headers,
    body: JSON.stringify({
      message: `The ${doc} document changed since it was read. Read it again, reapply the change, and retry with the new version.`,
    }),
  };
}
