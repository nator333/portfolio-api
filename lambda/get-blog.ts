import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BLOG_TABLE_ITEM_ID, BlogData, visiblePosts } from './blog-schema';
import { corsHeaders } from './cors';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The admin variant (INCLUDE_DRAFTS=true, wired behind the Cognito-gated
// /blog/all route) returns every post; the public /blog function leaves this
// unset and withholds drafts so their content never reaches anonymous callers.
const includeDrafts = process.env.INCLUDE_DRAFTS === 'true';

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const tableName = process.env.CV_TABLE_NAME;
  if (!tableName) {
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'CV_TABLE_NAME is not configured' }) };
  }

  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: BLOG_TABLE_ITEM_ID } }),
  );

  // A list resource returns an empty collection rather than 404 when unset.
  if (!result.Item) {
    return { statusCode: 200, headers, body: JSON.stringify({ posts: [] }) };
  }

  const { id, ...blogData } = result.Item as { id: string } & BlogData;

  const posts = visiblePosts(blogData.posts, includeDrafts);

  return { statusCode: 200, headers, body: JSON.stringify({ ...blogData, posts }) };
};
