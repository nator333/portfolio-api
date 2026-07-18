/**
 * One-off seeder: uploads the blog markdown sources from portfolio-front into
 * the single-document blog item that GET /blog serves.
 *
 * Usage (with AWS credentials for the target account):
 *   npx ts-node scripts/seed-blog.ts <table-name> <markdown-dir>
 * e.g.
 *   npx ts-node scripts/seed-blog.ts PortfolioApiStack-dev-CvTableXXXX ../portfolio-front/src/assets/blog
 *
 * Find the table name with: aws dynamodb list-tables
 */
import * as fs from 'fs';
import * as path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { BLOG_TABLE_ITEM_ID, blogDataSchema, BlogData } from '../lambda/blog-schema';

/** Splits "---\nkey: value\n---\nbody" frontmatter used by the blog markdown files. */
function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('File has no frontmatter block');
  }
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { data, content: match[2].trim() };
}

async function main(): Promise<void> {
  const [tableName, markdownDir] = process.argv.slice(2);
  if (!tableName || !markdownDir) {
    console.error('Usage: npx ts-node scripts/seed-blog.ts <table-name> <markdown-dir>');
    process.exit(1);
  }

  const files = fs.readdirSync(markdownDir).filter((file) => file.endsWith('.md'));
  if (files.length === 0) {
    throw new Error(`No markdown files found in ${markdownDir}`);
  }

  const posts = files.map((filename) => {
    const { data, content } = parseFrontmatter(
      fs.readFileSync(path.join(markdownDir, filename), 'utf8'),
    );
    return {
      title: data['title'],
      date: new Date(data['date']).toISOString(),
      summary: data['summary'] ?? '',
      tags: (data['tags'] ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      url: data['url'],
      content,
    };
  });

  // Newest first, matching the order the front displays.
  posts.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const blogData: BlogData = blogDataSchema.parse({ posts });

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: { id: BLOG_TABLE_ITEM_ID, ...blogData },
    }),
  );

  console.log(`Seeded ${posts.length} posts into ${tableName} (item id "${BLOG_TABLE_ITEM_ID}")`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
