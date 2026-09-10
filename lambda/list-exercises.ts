import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SOURCE_WEIGHT_UNIT } from './workout-schema';
import { queryExerciseCatalog } from './workout-catalog';
import { corsHeaders } from './cors';

/**
 * The exercise catalogue: every movement in the training log with its all-time
 * shape, most-trained first.
 *
 * This exists so that get-exercise-history.ts is usable by an agent that does
 * not already know the log's vocabulary. Names are canonicalised at ingest
 * (workout-exercises.ts folds a decade of mixed Japanese/English spellings onto
 * one English label each), so a caller guessing at a name is guessing at a
 * closed set of ~130 strings — far better to list them.
 *
 * It reads the summary table's `EXERCISE` partition rather than a table of its
 * own; see the note in workout-catalog.ts for why there is no separate master.
 */

const region = process.env.WORKOUT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  const summaryTable = process.env.WORKOUT_SUMMARY_TABLE_NAME;
  if (!summaryTable) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'WORKOUT_SUMMARY_TABLE_NAME is not configured' }),
    };
  }

  const params = event.queryStringParameters ?? {};
  const muscle = params.muscle?.trim().toLowerCase();

  const all = await queryExerciseCatalog(ddb, summaryTable);
  const exercises = muscle ? all.filter((e) => e.muscle.toLowerCase() === muscle) : all;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      unit: SOURCE_WEIGHT_UNIT,
      count: exercises.length,
      ...(muscle ? { muscle: params.muscle } : {}),
      exercises,
    }),
  };
};
