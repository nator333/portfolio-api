import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GoogleHealthError, listDataPoints } from './google-health';
import {
  BASELINE_DAYS,
  addDays,
  isIsoDate,
  isValidTimeZone,
  judgeReadiness,
  localDate,
  parseDailyHrv,
  parseDailyRestingHeartRate,
  parseSleep,
  type DailyValue,
  type SleepSession,
} from './readiness';
import { corsHeaders } from './cors';

/**
 * Today's training readiness, from last night's recovery signals.
 *
 * Fetched live from the Google Health API on every call — deliberately not
 * from a scheduled snapshot like the GitHub feed. The GitHub snapshot exists to
 * keep a third party off the landing page's critical path; this is an admin
 * read asked a few times a day, and the data it needs only appears once the
 * watch syncs after waking, at a time no schedule can know in advance. A batch
 * would, on most mornings, have run before that sync and judged today on the
 * night before last.
 *
 * Three reads, in parallel:
 *
 *   sleep   the nights ending in the last few days — today's is the one judged;
 *           the older ones only say how far behind the sync is when today's
 *           is missing
 *   hrv     daily HRV over the baseline window and today
 *   rhr     daily resting heart rate over the same span
 *
 * Nothing is cached. Resting heart rate in particular is recalculated through
 * the day, and a cached morning answer is exactly the staleness this endpoint
 * exists to avoid. The judgement itself lives in readiness.ts.
 *
 * Reached only through the MCP server's admin gate: there is no REST route.
 */

/** How far back sleep is read, so a missing night can say when the last one was. */
const SLEEP_LOOKBACK_DAYS = 3;
/** The API's page-size ceiling for sleep. */
const SLEEP_PAGE_SIZE = 25;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };
  const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
    statusCode,
    headers,
    body: JSON.stringify(body),
  });

  const secretName = process.env.GOOGLE_HEALTH_SECRET_NAME;
  const timeZone = process.env.HEALTH_TIME_ZONE;
  if (!secretName || !timeZone) {
    return respond(500, { message: 'GOOGLE_HEALTH_SECRET_NAME and HEALTH_TIME_ZONE must both be configured' });
  }
  if (!isValidTimeZone(timeZone)) {
    return respond(500, { message: `HEALTH_TIME_ZONE "${timeZone}" is not a valid IANA time zone` });
  }

  // Stamped before the reads: `asOf` fixes which local day "today" is.
  const asOf = new Date();
  const today = localDate(asOf, timeZone);

  const requested = event.queryStringParameters?.date?.trim();
  if (requested && (!isIsoDate(requested) || requested > today)) {
    return respond(400, { message: `\`date\` must be an ISO YYYY-MM-DD no later than today (${today})` });
  }
  const date = requested || today;

  const tomorrow = addDays(date, 1);
  const baselineFrom = addDays(date, -BASELINE_DAYS);

  let sleeps: SleepSession[];
  let hrv: DailyValue[];
  let restingHeartRate: DailyValue[];
  try {
    const [sleepPoints, hrvPoints, rhrPoints] = await Promise.all([
      listDataPoints(
        secretName,
        'sleep',
        // Sleep is filterable on its end time only, which is what "last night"
        // means anyway: the night that ended this morning.
        `sleep.interval.civil_end_time >= "${addDays(date, -SLEEP_LOOKBACK_DAYS)}" AND sleep.interval.civil_end_time < "${tomorrow}"`,
        SLEEP_PAGE_SIZE,
      ),
      listDataPoints(
        secretName,
        'daily-heart-rate-variability',
        `daily_heart_rate_variability.date >= "${baselineFrom}" AND daily_heart_rate_variability.date < "${tomorrow}"`,
      ),
      listDataPoints(
        secretName,
        'daily-resting-heart-rate',
        `daily_resting_heart_rate.date >= "${baselineFrom}" AND daily_resting_heart_rate.date < "${tomorrow}"`,
      ),
    ]);
    sleeps = sleepPoints.map(parseSleep).filter((s): s is SleepSession => s !== null);
    hrv = hrvPoints.map(parseDailyHrv).filter((v): v is DailyValue => v !== null);
    restingHeartRate = rhrPoints.map(parseDailyRestingHeartRate).filter((v): v is DailyValue => v !== null);
  } catch (error) {
    if (error instanceof GoogleHealthError) {
      console.error('Google Health read failed', error.kind, error.status, error.message);
      // `auth` needs the owner to reconnect; `api` is Google's side. Both are
      // surfaced verbatim so the caller can say which it is.
      return respond(error.kind === 'auth' ? 503 : 502, { message: error.message, kind: error.kind });
    }
    throw error;
  }

  const result = judgeReadiness({ date, sleeps, hrv, restingHeartRate });

  return respond(200, {
    asOf: asOf.toISOString(),
    timeZone,
    ...result,
  });
};
