import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler as getReadiness } from './get-readiness';
import { handler as getMuscleVolumeStatus } from './get-muscle-volume-status';
import { handler as getWorkoutPlan } from './get-workout-plan';
import type { MuscleVolumeRow } from './muscle-volume-status';
import type { PlanSession } from './workout-plan-schema';
import { recommendTraining, type ReadinessSummary } from './training-recommendation';
import { corsHeaders } from './cors';

/**
 * Today's session and how hard to run it: readiness joined with the volume
 * status and the plan (see training-recommendation.ts for the join itself).
 *
 * The three inputs are read by calling their own handlers in-process, exactly
 * as the MCP server does, rather than by repeating their queries here. Each
 * already owns a judgement — what "today" is for readiness, what the trailing
 * window and the current targets are for the volume status, how the menu and
 * targets compose for the plan — and a second copy of any of those is how the
 * progress page and the plan came to disagree about chest. Reusing the
 * handlers means this answer and the individual tools cannot drift apart.
 *
 * Failure is asymmetric on purpose. The plan and the volume status are this
 * API's own data: if either fails, there is nothing sound to recommend and the
 * error is passed through. Readiness depends on the owner's watch and a Google
 * grant; if it fails, the session choice (which needs neither) is still
 * returned, with intensity withheld and the reason stated.
 *
 * Reached only through the MCP server's admin gate: there is no REST route.
 */

const proxyEvent = (query: Record<string, string | undefined>): APIGatewayProxyEvent =>
  ({ body: null, queryStringParameters: query, pathParameters: null, headers: {} }) as unknown as APIGatewayProxyEvent;

const ok = (r: APIGatewayProxyResult) => r.statusCode >= 200 && r.statusCode < 300;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  const planId = event.queryStringParameters?.planId?.trim() || undefined;

  const asOf = new Date();
  const [plan, volume, readiness] = await Promise.all([
    getWorkoutPlan(proxyEvent({ planId })),
    getMuscleVolumeStatus(proxyEvent({ planId })),
    // A readiness failure must not take the session choice down with it.
    getReadiness(proxyEvent({})).catch(
      (error: unknown): APIGatewayProxyResult => {
        console.error('Readiness read failed', error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Readiness could not be read' }) };
      },
    ),
  ]);

  for (const [name, result] of [['plan', plan], ['volume status', volume]] as const) {
    if (!ok(result)) {
      const detail = JSON.parse(result.body || '{}') as { message?: string };
      return {
        statusCode: result.statusCode,
        headers,
        body: JSON.stringify({ message: `Could not read the ${name}: ${detail.message ?? result.statusCode}` }),
      };
    }
  }

  const planBody = JSON.parse(plan.body) as {
    planId: string;
    version: number;
    rotation: string[];
    bonusSessions: string[];
    sessions: PlanSession[];
  };
  const volumeBody = JSON.parse(volume.body) as { window: unknown; muscles: MuscleVolumeRow[] };
  const readinessBody = JSON.parse(readiness.body || '{}') as {
    status?: ReadinessSummary['status'];
    date?: string;
    verdict?: ReadinessSummary['verdict'];
    reasons?: string[];
    message?: string;
  };

  const readinessSummary: ReadinessSummary = ok(readiness)
    ? {
        status: readinessBody.status ?? 'unavailable',
        date: readinessBody.date ?? null,
        verdict: readinessBody.verdict ?? null,
        reasons: readinessBody.reasons ?? [],
      }
    : { status: 'unavailable', date: null, verdict: null, reasons: [readinessBody.message ?? `HTTP ${readiness.statusCode}`] };

  const recommendation = recommendTraining({
    readiness: readinessSummary,
    volume: volumeBody.muscles,
    rotation: planBody.rotation,
    bonusSessions: planBody.bonusSessions,
    sessions: planBody.sessions,
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      asOf: asOf.toISOString(),
      plan: { planId: planBody.planId, version: planBody.version },
      volumeWindow: volumeBody.window,
      ...recommendation,
    }),
  };
};
