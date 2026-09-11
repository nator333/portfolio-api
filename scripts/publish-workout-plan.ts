import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { WORKOUT_REGION } from '../lambda/workout-schema';
import {
  planVersionItem,
  planVersionSchema,
  targetSetItem,
  targetSetSchema,
  workoutPlanTableName,
} from '../lambda/workout-plan-schema';
import { UPPER_LOWER_TARGETS_V1, UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';
import { checkMenuAgainstTargets, describeBreach } from '../lambda/workout-plan-compliance';

/**
 * Publishes a training-program version to the plan table.
 *
 * A program is hand-authored, not ingested, so there is no Lambda that writes
 * this table — the source of truth is the committed constant, and publishing is
 * a deliberate manual step:
 *
 *   npx ts-node --prefer-ts-exts scripts/publish-workout-plan.ts --stage=prod
 *
 * To revise the program, edit the constant, bump its `version`, and run this
 * again. The write is conditional on the version not already existing, so a
 * re-run is a no-op rather than a silent overwrite: published versions are
 * immutable, which is the whole point of storing them this way.
 */

/**
 * The two halves this script publishes. A program is a menu and the weekly set
 * targets it serves, versioned separately; point either at a newer constant to
 * revise that half alone. Each write is independently conditional, so re-running
 * after bumping only one of them publishes only that one.
 */
const PLAN = UPPER_LOWER_V1;
const TARGETS = UPPER_LOWER_TARGETS_V1;

const argOf = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

async function main(): Promise<void> {
  const stage = argOf('stage') ?? 'dev';
  const dryRun = process.argv.includes('--dry-run');

  // Validate before touching AWS: a malformed program should fail on the desk,
  // not halfway through a deploy.
  const parsed = planVersionSchema.safeParse(PLAN);
  if (!parsed.success) {
    console.error('Plan failed validation:');
    console.error(JSON.stringify(parsed.error.issues, null, 2));
    process.exitCode = 1;
    return;
  }

  const parsedTargets = targetSetSchema.safeParse(TARGETS);
  if (!parsedTargets.success) {
    console.error('Targets failed validation:');
    console.error(JSON.stringify(parsedTargets.error.issues, null, 2));
    process.exitCode = 1;
    return;
  }

  // The same one-way check the write paths enforce: a seed whose menu asks for
  // more than its targets allow should fail on the desk, not in DynamoDB.
  const { breaches, bonusWarnings } = checkMenuAgainstTargets(PLAN, TARGETS.weeklySetTargets);
  if (breaches.length > 0) {
    console.error('The menu prescribes more than its targets allow:');
    for (const breach of breaches) console.error(`  - ${describeBreach(breach)}`);
    process.exitCode = 1;
    return;
  }
  for (const warning of bonusWarnings) {
    console.warn(`Warning: on a bonus week, ${describeBreach(warning)}.`);
  }

  const table = workoutPlanTableName(stage);
  const items = [planVersionItem(PLAN), targetSetItem(TARGETS)];

  if (dryRun) {
    console.log(`Would write to ${table} (${WORKOUT_REGION}):`);
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: WORKOUT_REGION }));
  for (const item of items) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
      console.log(`Published ${item.planId} ${item.sk} to ${table}.`);
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        // Not fatal: publishing a revised menu beside an unchanged target set is
        // the ordinary case, and the unchanged half is expected to already exist.
        console.log(`${item.planId} ${item.sk} already exists in ${table}; left as published.`);
        continue;
      }
      throw error;
    }
  }
}

void main();
