import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler as getWorkoutPlan } from './get-workout-plan';

/**
 * The current training program, for the public Training page.
 *
 * Same document the admin read serves for its no-argument call — sessions,
 * exercise slots and the weekly set targets composed on — but only that one
 * call. Query parameters are dropped rather than validated: the version, date
 * and history lookups stay on the MCP tools, so the public surface is "what is
 * the plan right now" and nothing else, and the cost of a request stays two
 * single-item Queries whatever the caller sends.
 */
export const handler = (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  getWorkoutPlan({ ...event, queryStringParameters: null });
