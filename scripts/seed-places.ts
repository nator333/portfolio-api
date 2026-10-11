import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  PLACES_TABLE_ITEM_ID,
  PlacesData,
  mergePlacesDocuments,
  placesDataSchema,
} from '../lambda/places-schema';

/**
 * Seeds the Places document (the per-town text behind /places) from a JSON
 * file, straight into the stage's CV table.
 *
 *   npm run seed:places -- --stage=prod [--file=scripts/places-seed.json] [--dry-run]
 *
 * The town facts are reference text, not something to retype into the editor
 * on every environment, so they live in the committed seed file and this is
 * the deliberate step that loads them. The file is validated with the same
 * schema as PUT /places, then merged into what is stored: the seed's towns
 * replace the stored facts for those towns, other towns and every stored
 * memory are kept (see mergePlacesDocuments). Re-running is therefore safe;
 * the only destructive case, a seed carrying memories over stored ones, needs
 * --replace-memories.
 *
 * The CV table has a CDK-generated name, so the script finds it by its
 * `PortfolioApiStack-<stage>-CvTable` prefix; pass --table=<name> to skip the
 * lookup, and --region if the stack is not in us-west-1.
 */

const argOf = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

async function findCvTable(ddb: DynamoDBClient, stage: string): Promise<string> {
  const prefix = `PortfolioApiStack-${stage}-CvTable`;
  const matches: string[] = [];
  let start: string | undefined;
  do {
    const page = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    matches.push(...(page.TableNames ?? []).filter((name) => name.startsWith(prefix)));
    start = page.LastEvaluatedTableName;
  } while (start);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No table named ${prefix}* found; is PortfolioApiStack-${stage} deployed in this region? Pass --table=<name> to override.`
        : `Several tables match ${prefix}*: ${matches.join(', ')}. Pass --table=<name>.`,
    );
  }
  return matches[0];
}

async function main(): Promise<void> {
  const stage = argOf('stage') ?? 'dev';
  const region = argOf('region') ?? 'us-west-1';
  const file = resolve(argOf('file') ?? 'scripts/places-seed.json');
  const dryRun = process.argv.includes('--dry-run');
  const replaceMemories = process.argv.includes('--replace-memories');

  // Validate before touching AWS: a malformed seed should fail on the desk.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Could not read ${file}: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const parsed = placesDataSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`${file} failed validation:`);
    console.error(JSON.stringify(parsed.error.issues, null, 2));
    process.exitCode = 1;
    return;
  }
  const seed = parsed.data;

  const client = new DynamoDBClient({ region });
  const ddb = DynamoDBDocumentClient.from(client);
  const table = argOf('table') ?? (await findCvTable(client, stage));

  const stored = await ddb.send(new GetCommand({ TableName: table, Key: { id: PLACES_TABLE_ITEM_ID } }));
  const existing = stored.Item ? (placesDataSchema.parse(stripId(stored.Item)) as PlacesData) : null;

  let merged: PlacesData;
  try {
    merged = mergePlacesDocuments(existing, seed, { replaceMemories });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }

  const towns = Object.keys(seed.cities ?? {});
  console.log(
    `${dryRun ? 'Would write' : 'Writing'} ${towns.length} town(s) [${towns.join(', ')}] and ${merged.memories.length} memories to ${table} (${region}).`,
  );
  if (dryRun) {
    console.log(JSON.stringify(merged, null, 2));
    return;
  }

  await ddb.send(new PutCommand({ TableName: table, Item: { id: PLACES_TABLE_ITEM_ID, ...merged } }));
  console.log('Done. The site caches /places for an hour per tab; open it in a new tab to see the text.');
}

function stripId(item: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = item;
  return rest;
}

void main();
