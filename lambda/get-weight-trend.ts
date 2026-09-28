import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GoogleHealthError, listDataPoints } from './google-health';
import { handler as getExerciseHistory } from './get-exercise-history';
import { addDays, isValidTimeZone, localDate } from './readiness';
import {
  firstOfDay,
  parseBodyFat,
  parseWeight,
  relativeStrength,
  weightTrend,
  type LiftSession,
  type Reading,
} from './weight-trend';
import { estimate1rm, toKg } from './workout-schema';
import { corsHeaders } from './cors';

/**
 * Bodyweight trend from the owner's smart scale, read live from the Google
 * Health API, optionally set against one lift's estimated 1RM.
 *
 * Read live for the same reason get-readiness is: a scale syncs whenever it
 * syncs, and nothing is stored, so the privacy policy's "health data is not
 * stored" stays true. The weight and body-fat types sit under the
 * health_metrics_and_measurements scope the readiness grant already holds, so
 * this needs no new consent.
 *
 * The lift comes from the exercise-history handler called in-process, as
 * get-training-recommendation does with its inputs, so exercise-name
 * resolution ("bench" → "Bench Press") and the lb log are handled in one
 * place. An unknown exercise does not fail the weight answer; its message is
 * returned in place of the comparison.
 *
 * Reached only through the MCP server's admin gate: there is no REST route.
 */

export const DEFAULT_DAYS = 90;
export const MIN_DAYS = 14;
export const MAX_DAYS = 365;

const proxyEvent = (query: Record<string, string | undefined>): APIGatewayProxyEvent =>
  ({ body: null, queryStringParameters: query, pathParameters: null, headers: {} }) as unknown as APIGatewayProxyEvent;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: JSON.stringify(body),
  });

  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!secretName || !timeZone || !isValidTimeZone(timeZone)) {
    return respond(500, { message: 'GOOGLE_HEALTH_SECRET_NAME and a valid HEALTH_TIME_ZONE must both be configured' });
  }

  const params = event.queryStringParameters ?? {};
  const days = params.days === undefined || params.days === '' ? DEFAULT_DAYS : Number(params.days);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return respond(400, { message: `\`days\` must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}` });
  }
  const exercise = params.exercise?.trim() || undefined;

  const asOfInstant = new Date();
  const asOf = localDate(asOfInstant, timeZone);
  const from = addDays(asOf, -(days - 1));
  // Physical-time filter, widened a day each side so no local-day edge is lost
  // to the UTC offset; readings are then kept by their local date.
  const since = `${addDays(from, -1)}T00:00:00Z`;
  const until = `${addDays(asOf, 2)}T00:00:00Z`;
  const inWindow = (r: Reading) => r.date >= from && r.date <= asOf;

  let weights: Reading[];
  let bodyFat: Reading[];
  let fetched: Record<'weight' | 'bodyFat', { points: number; usable: number }>;
  try {
    const [weightPoints, fatPoints] = await Promise.all([
      listDataPoints(
        secretName,
        'weight',
        `weight.sample_time.physical_time >= "${since}" AND weight.sample_time.physical_time < "${until}"`,
      ),
      listDataPoints(
        secretName,
        'body-fat',
        `body_fat.sample_time.physical_time >= "${since}" AND body_fat.sample_time.physical_time < "${until}"`,
      ),
    ]);
    const parsedWeights = weightPoints.map((p) => parseWeight(p, timeZone)).filter((r): r is Reading => r !== null);
    const parsedFat = fatPoints.map((p) => parseBodyFat(p, timeZone)).filter((r): r is Reading => r !== null);
    weights = parsedWeights.filter(inWindow);
    bodyFat = parsedFat.filter(inWindow);
    fetched = {
      weight: { points: weightPoints.length, usable: parsedWeights.length },
      bodyFat: { points: fatPoints.length, usable: parsedFat.length },
    };
    if (parsedWeights.length < weightPoints.length) {
      console.warn('Unparseable weight point', JSON.stringify(weightPoints.find((p) => !parseWeight(p, timeZone))));
    }
  } catch (error) {
    if (error instanceof GoogleHealthError) {
      console.error('Google Health read failed', error.kind, error.status, error.message);
      return respond(error.kind === 'auth' ? 503 : 502, { message: error.message, kind: error.kind });
    }
    throw error;
  }

  const trend = weightTrend({ asOf, weights, bodyFat });

  let strength: unknown;
  if (exercise) {
    const history = await getExerciseHistory(proxyEvent({ exercise, from, to: asOf }));
    const body = JSON.parse(history.body || '{}') as {
      exercise?: string;
      message?: string;
      days?: { date: string; sets: { weight: number; reps: number }[] }[];
    };
    if (history.statusCode !== 200) {
      strength = { requested: exercise, error: body.message ?? `HTTP ${history.statusCode}`, detail: body };
    } else {
      // The log is in lb; the 1RM is estimated in lb, then converted once.
      const sessions: LiftSession[] = (body.days ?? []).map((d) => ({
        date: d.date,
        e1rmKg: toKg(Math.max(0, ...d.sets.map((s) => estimate1rm(s.weight, s.reps)))),
      }));
      strength = { exercise: body.exercise, ...relativeStrength(sessions, firstOfDay(weights)) };
    }
  }

  return respond(200, {
    asOf: asOfInstant.toISOString(),
    timeZone,
    window: { days, from, to: asOf },
    ...trend,
    ...(exercise ? { relativeStrength: strength } : {}),
    fetched,
  });
};
