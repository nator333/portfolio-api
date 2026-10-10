import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from './cors';
import { DEFAULT_PLAN_ID, handler as getWorkoutPlan, latestStoredVersion } from './get-workout-plan';

/**
 * The training program, for the public Training page.
 *
 * The same document the admin read serves, but a narrower set of questions:
 * the current version, or with `version=N` one of the {@link VERSIONS_BACK}
 * versions before it. Every other parameter is dropped rather than validated —
 * date and history lookups, and other plan ids, stay on the MCP tools — so a
 * request costs at most two Queries and a GetItem whatever the caller sends.
 *
 * A past version is served with the *current* weekly targets composed on, as
 * the admin version lookup does; `targetsVersion` says which set that is.
 */

/** How many versions before the current one the public page may open. */
export const VERSIONS_BACK = 5;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const current = (): Promise<APIGatewayProxyResult> =>
    getWorkoutPlan({ ...event, queryStringParameters: null });

  const raw = event.queryStringParameters?.version;
  const tableName = process.env.WORKOUT_PLAN_TABLE_NAME;
  // No table name is the admin handler's 500 to report.
  if (raw === undefined || !tableName) {
    return current();
  }

  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: '`version` must be a positive integer' }),
    };
  }

  const version = Number(raw);
  const latest = await latestStoredVersion(tableName, DEFAULT_PLAN_ID);
  if (!latest || version === latest.version) {
    // The current version, or no plan at all: both are the no-argument read.
    return current();
  }
  const oldest = Math.max(latest.version - VERSIONS_BACK, 1);
  if (version > latest.version || version < oldest) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        message: `Only versions ${oldest}-${latest.version} of the plan are public`,
      }),
    };
  }
  return getWorkoutPlan({ ...event, queryStringParameters: { version: raw } });
};
