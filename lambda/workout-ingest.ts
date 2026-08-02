import type { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { simpleParser } from 'mailparser';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  META_SK,
  assignSetKeys,
  SOURCE_WEIGHT_UNIT,
  SUMMARY_PK,
  parseWorkoutRows,
  summarize,
  type WorkoutSet,
  type WorkoutSummaries,
} from './workout-schema';

/**
 * Ingests a workout-history CSV emailed to the configured workout address.
 *
 * SES email-receiving drops the raw MIME message into S3; this function triggers
 * off that PUT, extracts the CSV attachment, normalizes every set, recomputes
 * all rollups from scratch (the CSV is the full history re-sent each time),
 * writes the raw sets and summaries to DynamoDB, and emails back an import
 * report. Everything here runs in us-west-2 alongside the tables.
 */

const s3 = new S3Client({});
const ses = new SESv2Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const DDB_BATCH_LIMIT = 25;

interface Config {
  setsTable: string;
  summaryTable: string;
  adminEmail: string;
  mailFrom: string;
}

function loadConfig(): Config {
  const setsTable = process.env.WORKOUT_SETS_TABLE_NAME;
  const summaryTable = process.env.WORKOUT_SUMMARY_TABLE_NAME;
  const adminEmail = process.env.ADMIN_EMAIL;
  const mailFrom = process.env.MAIL_FROM;
  if (!setsTable || !summaryTable || !adminEmail || !mailFrom) {
    throw new Error(
      'Missing required env: WORKOUT_SETS_TABLE_NAME, WORKOUT_SUMMARY_TABLE_NAME, ADMIN_EMAIL, MAIL_FROM',
    );
  }
  return { setsTable, summaryTable, adminEmail, mailFrom };
}

export const handler = async (event: S3Event): Promise<void> => {
  const config = loadConfig();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    await processObject(bucket, key, config);
  }
};

async function processObject(bucket: string, key: string, config: Config): Promise<void> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await object.Body!.transformToByteArray();
  const mail = await simpleParser(Buffer.from(raw));

  const sender = mail.from?.value?.[0]?.address?.toLowerCase() ?? '';
  if (sender !== config.adminEmail.toLowerCase()) {
    // Not from the owner — ignore rather than reply, to avoid backscatter to a
    // possibly-spoofed address. SES's own spam/virus scan runs upstream too.
    console.warn(`Ignoring message from unexpected sender: ${sender || '(none)'} (s3://${bucket}/${key})`);
    return;
  }

  const spamVerdict = mail.headers.get('x-ses-spam-verdict');
  const virusVerdict = mail.headers.get('x-ses-virus-verdict');
  if (failed(spamVerdict) || failed(virusVerdict)) {
    console.warn(`Ignoring message failing SES scan (spam=${String(spamVerdict)}, virus=${String(virusVerdict)})`);
    return;
  }

  const csv = extractCsv(mail);
  if (!csv) {
    await sendReport(config, {
      subject: 'Workout import failed: no CSV found',
      lines: ['No CSV attachment or CSV body was found in the emailed message.'],
    });
    return;
  }

  const records = parseCsv(csv.text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];

  const { sets, skipped } = parseWorkoutRows(records);
  if (sets.length === 0) {
    await sendReport(config, {
      subject: 'Workout import failed: no valid rows',
      lines: [
        `File: ${csv.filename}`,
        `Rows read: ${records.length}, all skipped as invalid.`,
      ],
    });
    return;
  }

  // Snapshot prior state before overwriting, so the report can show deltas.
  const [priorDays, priorTotalSets] = await Promise.all([
    loadExistingDays(config.summaryTable),
    loadPriorTotalSets(config.summaryTable),
  ]);

  const summaries = summarize(sets);

  await writeSets(config.setsTable, sets);
  await writeSummaries(config.summaryTable, summaries, csv.filename);

  const newDays = summaries.days.map((d) => d.sk).filter((sk) => !priorDays.has(sk));
  await sendReport(config, buildReport({ summaries, sets, skipped, newDays, priorTotalSets, filename: csv.filename }));

  console.log(
    `Imported ${sets.length} sets over ${summaries.meta.workoutDays} days from ${csv.filename} (${skipped} skipped, ${newDays.length} new days)`,
  );
}

const failed = (verdict: unknown): boolean =>
  typeof verdict === 'string' && verdict.toUpperCase() === 'FAIL';

interface ExtractedCsv {
  text: string;
  filename: string;
}

/** Pulls the CSV out of the message: a .csv attachment first, else a CSV-looking text body. */
function extractCsv(mail: Awaited<ReturnType<typeof simpleParser>>): ExtractedCsv | null {
  for (const attachment of mail.attachments ?? []) {
    const name = attachment.filename ?? '';
    const isCsv =
      name.toLowerCase().endsWith('.csv') ||
      (attachment.contentType ?? '').toLowerCase().includes('csv');
    if (isCsv && attachment.content) {
      return { text: attachment.content.toString('utf-8'), filename: name || 'attachment.csv' };
    }
  }

  // Fallback: some clients paste the CSV inline. Accept it only if it carries the
  // expected header, so ordinary prose emails don't get parsed as data.
  const body = mail.text ?? '';
  if (/(^|\n)\s*Date\s*,\s*Exercise Name\s*,/i.test(body)) {
    return { text: body, filename: '(email body)' };
  }
  return null;
}

/** Every sort key currently stored under one summary partition. */
async function queryPartitionSks(summaryTable: string, pk: string): Promise<Set<string>> {
  const sks = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: summaryTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'sk',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.sk === 'string') sks.add(item.sk);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return sks;
}

async function loadExistingDays(summaryTable: string): Promise<Set<string>> {
  return queryPartitionSks(summaryTable, SUMMARY_PK.day);
}

async function loadPriorTotalSets(summaryTable: string): Promise<number | null> {
  const result = await ddb.send(
    new GetCommand({ TableName: summaryTable, Key: { pk: SUMMARY_PK.meta, sk: META_SK } }),
  );
  const total = result.Item?.totalSets;
  return typeof total === 'number' ? total : null;
}

async function writeSets(setsTable: string, sets: readonly WorkoutSet[]): Promise<void> {
  const items = assignSetKeys(sets).map((s) => ({
    date: s.date,
    sk: s.sk,
    exercise: s.exercise,
    setNo: s.setNo,
    // The exported figure is the source of truth; the kg conversion rides along
    // so consumers never have to know the export's unit.
    weight: s.weight,
    weightKg: s.weightKg,
    reps: s.reps,
    volume: s.volume,
    volumeKg: s.volumeKg,
    muscle: s.muscle,
    notes: s.notes,
  }));
  await batchWrite(setsTable, items, (item) => `${item.date}|${item.sk}`);
}

async function writeSummaries(
  summaryTable: string,
  summaries: WorkoutSummaries,
  filename: string,
): Promise<void> {
  const items: Record<string, unknown>[] = [
    ...summaries.days.map((d) => ({ pk: SUMMARY_PK.day, ...d })),
    ...summaries.months.map((m) => ({ pk: SUMMARY_PK.month, ...m })),
    ...summaries.exercises.map((e) => ({ pk: SUMMARY_PK.exercise, ...e })),
    ...summaries.exerciseMonths.map((e) => ({ pk: SUMMARY_PK.exerciseMonth, ...e })),
    ...summaries.weeks.map((w) => ({ pk: SUMMARY_PK.week, ...w })),
    ...summaries.muscles.map((m) => ({ pk: SUMMARY_PK.muscle, ...m })),
    { pk: SUMMARY_PK.meta, sk: META_SK, ...summaries.meta, lastImportAt: new Date().toISOString(), sourceFileName: filename },
  ];
  await batchWrite(summaryTable, items, (item) => `${item.pk}|${item.sk}`);
  // Write first, then prune: the fresh rollup is always in place even if the
  // prune fails, and pruning never removes a group the new rollup still has.
  await deleteStaleMuscleRows(summaryTable, summaries.muscles.map((m) => m.sk));
}

/**
 * The import rebuilds every rollup from scratch, but BatchWrite only upserts —
 * it can't remove a MUSCLE row the new rollup no longer produces. When exercises
 * are re-classified into a different group (e.g. the Legs split into
 * Quads/Hamstrings/Glutes, or folding Traps into Back), the old group's row would
 * otherwise linger forever and double-count in the all-time muscle balance.
 * Delete any MUSCLE row whose group is absent from the freshly written summary.
 */
async function deleteStaleMuscleRows(
  summaryTable: string,
  keptMuscles: readonly string[],
): Promise<void> {
  const keep = new Set<string>(keptMuscles);
  const existing = await queryPartitionSks(summaryTable, SUMMARY_PK.muscle);
  const stale = [...existing].filter((sk) => !keep.has(sk));
  if (stale.length === 0) return;
  await batchDelete(summaryTable, stale.map((sk) => ({ pk: SUMMARY_PK.muscle, sk })));
  console.log(`Removed ${stale.length} stale muscle summary row(s): ${stale.join(', ')}`);
}

/**
 * BatchWrites items in chunks of 25 with bounded concurrency, retrying any
 * UnprocessedItems with a short backoff. The full-history import can be ~16k
 * items, well past the 25-item per-request cap.
 *
 * `keyOf` identifies an item's primary key. BatchWriteItem rejects an entire
 * request that contains two items with the same key, which once failed a whole
 * import over a single duplicated row, so the last write for each key wins here
 * rather than reaching DynamoDB as a fatal ValidationException.
 */
async function batchWrite(
  table: string,
  items: readonly Record<string, unknown>[],
  keyOf: (item: Record<string, unknown>) => string,
): Promise<void> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of items) byKey.set(keyOf(item), item);
  const deduped = [...byKey.values()];
  if (deduped.length !== items.length) {
    console.warn(`Collapsed ${items.length - deduped.length} duplicate key(s) writing to ${table}`);
  }

  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < deduped.length; i += DDB_BATCH_LIMIT) {
    chunks.push(deduped.slice(i, i + DDB_BATCH_LIMIT));
  }

  const concurrency = 5;
  for (let i = 0; i < chunks.length; i += concurrency) {
    await Promise.all(chunks.slice(i, i + concurrency).map((chunk) => writeChunk(table, chunk)));
  }
}

async function writeChunk(table: string, chunk: Record<string, unknown>[]): Promise<void> {
  let requests = chunk.map((Item) => ({ PutRequest: { Item } }));
  for (let attempt = 0; attempt < 5 && requests.length > 0; attempt += 1) {
    const result = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
    const unprocessed = result.UnprocessedItems?.[table] ?? [];
    if (unprocessed.length === 0) return;
    requests = unprocessed as typeof requests;
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  if (requests.length > 0) {
    throw new Error(`BatchWrite to ${table} left ${requests.length} items unprocessed after retries`);
  }
}

/** Mirror of batchWrite for removals, used to prune summary rows the rebuild dropped. */
async function batchDelete(table: string, keys: readonly Record<string, string>[]): Promise<void> {
  const chunks: Record<string, string>[][] = [];
  for (let i = 0; i < keys.length; i += DDB_BATCH_LIMIT) {
    chunks.push(keys.slice(i, i + DDB_BATCH_LIMIT));
  }

  const concurrency = 5;
  for (let i = 0; i < chunks.length; i += concurrency) {
    await Promise.all(chunks.slice(i, i + concurrency).map((chunk) => deleteChunk(table, chunk)));
  }
}

async function deleteChunk(table: string, chunk: Record<string, string>[]): Promise<void> {
  let requests = chunk.map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 0; attempt < 5 && requests.length > 0; attempt += 1) {
    const result = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
    const unprocessed = result.UnprocessedItems?.[table] ?? [];
    if (unprocessed.length === 0) return;
    requests = unprocessed as typeof requests;
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  if (requests.length > 0) {
    throw new Error(`BatchDelete to ${table} left ${requests.length} items unprocessed after retries`);
  }
}

interface Report {
  subject: string;
  lines: string[];
}

interface ReportInput {
  summaries: WorkoutSummaries;
  sets: readonly WorkoutSet[];
  skipped: number;
  newDays: string[];
  priorTotalSets: number | null;
  filename: string;
}

const num = (n: number): string => Math.round(n).toLocaleString('en-US');
const whole = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
/** Kilograms lead, with the export's own pound figure kept alongside. */
const mass = (kgValue: number, sourceValue: number): string =>
  `${whole(kgValue)} kg (${whole(sourceValue)} ${SOURCE_WEIGHT_UNIT})`;

/** Dates listed inline before the report just points at the totals instead. */
const MAX_LISTED_DAYS = 20;
/** Weeks averaged for the sets-per-muscle-per-week figure. */
const WEEKS_WINDOW = 12;
/** Lifts shown in the strength-progression section, most-trained first. */
const TOP_LIFTS = 6;

function buildReport(input: ReportInput): Report {
  const { summaries, skipped, newDays, priorTotalSets, filename } = input;
  const { meta } = summaries;
  const newSets = priorTotalSets === null ? null : meta.totalSets - priorTotalSets;

  const thisMonth = summaries.months[summaries.months.length - 1];
  // Ranked by sets, matching what the section reports. Ranking by volume put the
  // heavy-stack machines on top regardless of how much they were actually done —
  // the same distortion that made lifetime volume worth demoting.
  const topExercises = [...summaries.exercises].sort((a, b) => b.sets - a.sets).slice(0, 5);

  // On a first import every day is "new", so listing dates says nothing; and a
  // truncated tail must say so rather than reading as the complete list.
  const listed = newDays.slice(-MAX_LISTED_DAYS);
  const newDaysLine =
    priorTotalSets === null
      ? `New workout days: ${num(newDays.length)} (all of them — first import)`
      : newDays.length === 0
        ? 'New workout days: 0'
        : newDays.length > MAX_LISTED_DAYS
          ? `New workout days: ${num(newDays.length)} (latest ${MAX_LISTED_DAYS}: ${listed.join(', ')})`
          : `New workout days: ${newDays.length} (${listed.join(', ')})`;

  const { frequency: freq } = meta;

  const lines: string[] = [
    `File: ${filename}`,
    `Weights as exported in ${SOURCE_WEIGHT_UNIT}; kilograms shown first.`,
    '',
    '— Import —',
    `Rows imported: ${num(meta.totalSets)} sets${skipped ? ` (${num(skipped)} skipped)` : ''}`,
    newSets === null
      ? 'First import (no prior baseline).'
      : `New sets since last import: ${num(newSets)}`,
    newDaysLine,
    '',
    '— Consistency —',
    `Sessions: ${num(freq.sessionsLast30)} in the last 30 days, ${num(freq.sessionsLast90)} in 90 (${freq.sessionsPerWeek}/week)`,
    `Current streak: ${num(freq.currentStreakWeeks)} consecutive weeks`,
    `Last session: ${meta.lastDate}`,
  ];

  // Sets per muscle per week is the metric training guidance is expressed in
  // (~10-20 hard sets per muscle per week), unlike total mass lifted.
  const recentWeeks = summaries.weeks.slice(-WEEKS_WINDOW);
  if (recentWeeks.length) {
    const perMuscle = new Map<string, number>();
    for (const w of recentWeeks) {
      for (const [muscle, count] of Object.entries(w.muscles)) {
        perMuscle.set(muscle, (perMuscle.get(muscle) ?? 0) + (count ?? 0));
      }
    }
    lines.push('', `— Sets per muscle per week (last ${recentWeeks.length} weeks, guide ~10-20) —`);
    for (const [muscle, total] of [...perMuscle.entries()].sort((a, b) => b[1] - a[1])) {
      const perWeek = total / recentWeeks.length;
      lines.push(`${muscle}: ${perWeek.toFixed(1)}${perWeek < 10 ? '  (below guide)' : ''}`);
    }
  }

  // Estimated 1RM progression: the headline strength signal. Free-weight lifts
  // only — on a machine this reduces to "heaviest stack", which is not comparable.
  const progressing = summaries.exercises
    .filter((e) => e.bestE1rm > 0)
    .sort((a, b) => b.sets - a.sets)
    .slice(0, TOP_LIFTS);
  if (progressing.length) {
    lines.push('', '— Estimated 1RM, best ever vs this year —');
    const thisYear = meta.lastDate.slice(0, 4);
    for (const e of progressing) {
      const yearBest = summaries.exerciseMonths
        .filter((m) => m.exercise === e.sk && m.month.startsWith(thisYear))
        .reduce((best, m) => Math.max(best, m.bestE1rmKg), 0);
      const trend = yearBest === 0 ? 'none logged' : `${yearBest.toFixed(0)} kg in ${thisYear}`;
      lines.push(`${e.sk}: best ${e.bestE1rmKg.toFixed(0)} kg (${e.bestE1rmDate}) — ${trend}`);
    }
  }

  if (thisMonth) {
    lines.push(
      '',
      `— This month (${thisMonth.sk}) —`,
      `Sets: ${num(thisMonth.sets)} over ${num(thisMonth.workoutDays)} days`,
    );
  }

  if (topExercises.length) {
    lines.push('', '— Most-trained exercises —');
    for (const e of topExercises) {
      lines.push(
        `${e.sk}: ${num(e.sets)} sets, max ${mass(e.maxWeightKg, e.maxWeight)}`,
      );
    }
  }

  lines.push(
    '',
    '— Lifetime —',
    `${meta.firstDate} → ${meta.lastDate} · ${num(meta.workoutDays)} days · ${num(meta.totalSets)} sets · ${num(meta.exerciseCount)} exercises`,
    `Total volume ${mass(meta.totalVolumeKg, meta.totalVolume)} (a curiosity, not a training signal)`,
  );

  const subject = `Workout import: ${num(meta.totalSets)} sets, ${freq.sessionsPerWeek}/week${
    newDays.length ? `, +${newDays.length} new day${newDays.length === 1 ? '' : 's'}` : ''
  }`;
  return { subject, lines };
}

async function sendReport(config: Config, report: Report): Promise<void> {
  const text = report.lines.join('\n');
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: config.mailFrom,
      Destination: { ToAddresses: [config.adminEmail] },
      ReplyToAddresses: [config.adminEmail],
      Content: {
        Simple: {
          Subject: { Data: report.subject },
          Body: {
            Text: { Data: text },
            Html: { Data: `<pre style="font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(text)}</pre>` },
          },
        },
      },
    }),
  );
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
