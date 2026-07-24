import type { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { simpleParser } from 'mailparser';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  META_SK,
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

async function loadExistingDays(summaryTable: string): Promise<Set<string>> {
  const days = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: summaryTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': SUMMARY_PK.day },
        ProjectionExpression: 'sk',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.sk === 'string') days.add(item.sk);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return days;
}

async function loadPriorTotalSets(summaryTable: string): Promise<number | null> {
  const result = await ddb.send(
    new GetCommand({ TableName: summaryTable, Key: { pk: SUMMARY_PK.meta, sk: META_SK } }),
  );
  const total = result.Item?.totalSets;
  return typeof total === 'number' ? total : null;
}

async function writeSets(setsTable: string, sets: readonly WorkoutSet[]): Promise<void> {
  const items = sets.map((s) => ({
    date: s.date,
    sk: `${s.exercise}#${s.setNo}`,
    exercise: s.exercise,
    setNo: s.setNo,
    weight: s.weight,
    reps: s.reps,
    volume: s.volume,
    muscle: s.muscle,
    notes: s.notes,
  }));
  await batchWrite(setsTable, items);
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
    ...summaries.muscles.map((m) => ({ pk: SUMMARY_PK.muscle, ...m })),
    { pk: SUMMARY_PK.meta, sk: META_SK, ...summaries.meta, lastImportAt: new Date().toISOString(), sourceFileName: filename },
  ];
  await batchWrite(summaryTable, items);
}

/**
 * BatchWrites items in chunks of 25 with bounded concurrency, retrying any
 * UnprocessedItems with a short backoff. The full-history import can be ~16k
 * items, well past the 25-item per-request cap.
 */
async function batchWrite(table: string, items: readonly Record<string, unknown>[]): Promise<void> {
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < items.length; i += DDB_BATCH_LIMIT) {
    chunks.push(items.slice(i, i + DDB_BATCH_LIMIT));
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

const num = (n: number): string => n.toLocaleString('en-US');
const kg = (n: number): string => `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} kg`;

function buildReport(input: ReportInput): Report {
  const { summaries, skipped, newDays, priorTotalSets, filename } = input;
  const { meta } = summaries;
  const newSets = priorTotalSets === null ? null : meta.totalSets - priorTotalSets;

  const thisMonth = summaries.months[summaries.months.length - 1];
  const topExercises = summaries.exercises.slice(0, 5);

  const lines: string[] = [
    `File: ${filename}`,
    '',
    '— Import —',
    `Rows imported: ${num(meta.totalSets)} sets${skipped ? ` (${num(skipped)} skipped)` : ''}`,
    newSets === null
      ? 'First import (no prior baseline).'
      : `New sets since last import: ${num(newSets)}`,
    `New workout days: ${newDays.length}${newDays.length ? ` (${newDays.slice(-20).join(', ')})` : ''}`,
    '',
    '— All-time —',
    `Date range: ${meta.firstDate} → ${meta.lastDate}`,
    `Workout days: ${num(meta.workoutDays)}`,
    `Distinct exercises: ${num(meta.exerciseCount)}`,
    `Total reps: ${num(meta.totalReps)}`,
    `Total volume: ${kg(meta.totalVolume)}`,
  ];

  if (thisMonth) {
    lines.push(
      '',
      `— This month (${thisMonth.sk}) —`,
      `Sets: ${num(thisMonth.sets)} over ${num(thisMonth.workoutDays)} days`,
      `Volume: ${kg(thisMonth.volume)}`,
    );
  }

  if (summaries.muscles.length) {
    lines.push('', '— Volume by muscle group (all-time) —');
    for (const m of summaries.muscles) {
      lines.push(`${m.sk}: ${kg(m.volume)} (${num(m.sets)} sets)`);
    }
  }

  if (topExercises.length) {
    lines.push('', '— Top exercises by volume —');
    for (const e of topExercises) {
      lines.push(`${e.sk}: ${kg(e.volume)} (${num(e.sets)} sets, max ${e.maxWeight} kg)`);
    }
  }

  const subject = `Workout import: ${num(meta.totalSets)} sets, ${num(meta.workoutDays)} days${
    newDays.length ? `, +${newDays.length} new` : ''
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
