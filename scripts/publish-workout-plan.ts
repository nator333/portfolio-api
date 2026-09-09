import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { WORKOUT_REGION } from '../lambda/workout-schema';
import { planVersionItem, planVersionSchema, workoutPlanTableName } from '../lambda/workout-plan-schema';
import { UPPER_LOWER_V1 } from '../lambda/workout-plan-upper-lower';

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

/** The version this script publishes. Point it at a newer constant to revise. */
const PLAN = UPPER_LOWER_V1;

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

  const table = workoutPlanTableName(stage);
  const item = planVersionItem(PLAN);

  if (dryRun) {
    console.log(`Would write to ${table} (${WORKOUT_REGION}):`);
    console.log(JSON.stringify(item, null, 2));
    return;
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: WORKOUT_REGION }));
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
      console.error(
        `${item.planId} ${item.sk} already exists in ${table}. Bump the version to publish a revision.`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void main();
