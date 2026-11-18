import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BLOG_TABLE_ITEM_ID, BlogData, visiblePosts } from './blog-schema';
import { corsHeaders } from './cors';
import { INITIAL_VERSION, etag, splitVersion } from './content-version';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * The blog reader, with or without drafts. The admin variant (INCLUDE_DRAFTS=
 * true, wired behind the Cognito-gated /blog/all route) returns every post; the
 * public /blog function leaves it unset and withholds drafts so their content
 * never reaches anonymous callers. The MCP server picks per call, by whether
 * the caller is the verified admin.
 */
export const blogReader = (includeDrafts: boolean) => async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: BLOG_TABLE_ITEM_ID } }),
  );

  // A list resource returns an empty collection rather than 404 when unset.
  if (!result.Item) {
    headers.ETag = etag(INITIAL_VERSION);
    return { statusCode: 200, headers, body: JSON.stringify({ posts: [] }) };
  }

  // The version travels as the ETag, never in the document (see content-version.ts).
  const { version, rest } = splitVersion(result.Item);
  const blogData = rest as unknown as BlogData;
  headers.ETag = etag(version);

  const posts = visiblePosts(blogData.posts, includeDrafts);

  return { statusCode: 200, headers, body: JSON.stringify({ ...blogData, posts }) };
};

export const handler = blogReader(process.env.INCLUDE_DRAFTS === 'true');
