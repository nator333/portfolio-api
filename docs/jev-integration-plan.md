# Jev (TypeSafe AI) for exercise → muscle-group classification

Status: proposal. Nothing here is implemented.

Scope: **one** use case — resolving the exercise names that
`lambda/workout-muscles.ts` cannot classify. Earlier drafts of this plan also
covered the visitor chat guardrail, the exercise-name 404 candidates and a CV
agent advisory; those are dropped.

## The problem

`muscleFor()` is an ordered substring rule list over free-form Japanese/English
exercise names — 196 distinct ones today, "and growing" — and anything unmatched
falls back to `'Other'`:

```ts
export function muscleFor(exerciseName: string): MuscleGroup {
  const name = exerciseName.trim().toLowerCase();
  for (const rule of COMPILED) {
    if (rule.matchers.every((matcher) => matches(matcher, name))) return rule.muscle;
  }
  return 'Other';
}
```

That fallback is **silent**. A newly logged movement lands in `Other`, and since
`summarize()` rolls sets up per muscle, everything downstream inherits the gap:
the weekly `MUSCLE`/`WEEK` rollups, `get-muscle-volume-status`, and through it
the whole planned-versus-actual story that `workout-plan-compliance.ts` exists to
protect. Nothing reports it. It stays wrong until someone notices a muscle
looking light and goes hunting in the rule table.

## Why Jev fits here specifically

This is a closed-set labelling problem over 14 known labels, off any request
path, on the owner's own data. It is exactly `choice`.

And the criteria are already written. The header comment of `workout-muscles.ts`
is a rubric — that a hinge is Hamstrings and a knee-extension is Quads, that face
pulls and upright rows count as Shoulders, that the pulling group is called
"Lats" rather than "Back" because traps are anatomically back too. Those
sentences become the per-label `criteria` descriptions more or less verbatim.

One more property matters: a single `systemOne` call carries **many named
questions** and answers them in one parallel pass. So *N* unresolved names is one
question each in **one** call, not *N* calls.

## The structural constraint

`muscleFor` is synchronous and pure, and it is called from inside
`parseWorkoutRows` (`lambda/workout-schema.ts:216`), which is also synchronous and
is the unit the schema tests exercise. A network call cannot go there, and making
it async would ripple through parsing, `summarize()`, and the tests, for the sake
of a handful of names per import.

So the rule is: **`muscleFor` does not change, and does not learn about Jev.**
The seam is an optional overrides map, consulted only where the rules already
gave up:

```ts
export function parseWorkoutRows(
  records: readonly unknown[],
  overrides?: ReadonlyMap<string, MuscleGroup>,   // keyed by normalized raw name
): { sets: WorkoutSet[]; skipped: number; excludedCardio: number };
```

Called with no overrides — as every existing test does — behavior is bit-for-bit
what it is today.

## Where it runs

`WorkoutIngestStack` in **us-west-2**, not the API stack in us-west-1. The
`portfolio-api` request/response Lambdas are untouched: no new dependency, no new
secret, no new IAM on `chatFn`/`agentFn`, no change to the 29 s gateway budget.
The blast radius is one function.

`ingestFn` already suits this: 5-minute timeout, 512 MB, read-write on the
summary table, and it is S3-event triggered off an emailed CSV — a handful of
times a month, never on a user's critical path.

## The flow

`processObject()` gains one step between parsing the CSV and writing:

1. **Scan.** Parse once with no overrides; collect the distinct raw names whose
   sets came out `'Other'`. Usually zero.
2. **Cache lookup.** Read the resolved names from a new `MUSCLEMAP` partition on
   the summary table. `SUMMARY_PK` already discriminates `DAY`/`MONTH`/`EXERCISE`/
   `MUSCLE`/`E1RM`/`WEEK`/`META`; this is one more, and the README's argument for
   not adding an exercise master table ("the summary table's `EXERCISE` partition
   already is one") applies unchanged — no new table.
3. **Ask, once.** For cache misses only, one `systemOne` call with one `choice`
   question per name.
4. **Write through.** Accepted answers are persisted to `MUSCLEMAP` before the
   re-parse, keyed by the normalized raw name.
5. **Re-parse** with the overrides map and continue exactly as today.

```ts
const { answers } = await client.systemOne({
  state: { context: 'Names from a strength-training log, mixed Japanese and English.' },
  questions: Object.fromEntries(
    unresolved.map((name, i) => [`q${i}`, choice(name, MUSCLE_CRITERIA)]),
  ),
});
```

`MUSCLE_CRITERIA` is one object literal exported from `workout-muscles.ts`
alongside `MUSCLE_GROUPS`, so the rubric and the rules stay in the same file and
cannot drift apart.

## Three rules that make it safe

**1. The cache is authoritative; a re-import never re-infers.**

The CSV is the full history re-sent each time, and the import "recomputes all
rollups from scratch". That reproducibility is load-bearing — it is why the
README can argue the summaries "cannot drift from the sets [they summarise]". A
model in that path breaks it unless the cached answer is the only thing a
re-import reads. Get this wrong and the failure is silent: the same CSV imported
twice produces different rollups, and nothing alarms.

**2. Jev may never return `Cardio`.**

Cardio rows are *dropped* at ingest — `excludedCardio` — because this is a
strength log. So a misclassification into `Cardio` does not mislabel a set, it
**deletes** it, and the next import deletes it again from cache. The
`choice` criteria omit `Cardio` entirely; the Cardio rules in `muscleFor` run
first and already catch it deterministically.

**3. Low confidence stays `'Other'`, and says so.**

Below the threshold, the name keeps today's behavior and is listed in the import
report email that `buildReport()` already sends the owner — the review channel
exists, it just needs two more lines. That turns the current silent failure into
a visible one even when Jev declines to answer, which is most of the value here
independent of whether the model is any good.

Also: cap the names per call. A malformed CSV that yields thousands of junk
names should send zero questions, not thousands.

## Sequencing

| Step | Work | Status |
| --- | --- | --- |
| 0 | Obtain API access; spike `models.list()` from a us-west-2 Lambda | blocked on access |
| 1 | `MUSCLE_CRITERIA` + `overrides` param on `parseWorkoutRows`; tests prove no-override behavior is unchanged | **built** |
| 2 | `MUSCLEMAP` cache partition, read/write path, unresolved names reported in the import email | **built** |
| 3 | `lambda/jev.ts`, secret wiring in `WorkoutIngestStack`, dev-only, **shadow mode**: call, log, cache nothing | not started |
| 4 | Enforce: write through to cache, re-parse with overrides | not started |

Steps 1 and 2 are in. The live vocabulary had exactly one unplaced name —
`High low`, 8 sets over 3 sessions between 2025-04-21 and 2026-01-23 — which the
lifter classifies as rhomboid-major, trapezius-secondary. There is no Rhomboids
group, so it is seeded to `Traps`; see the note in `MUSCLE_SEEDS`.

That one name is also the honest measure of what steps 3 and 4 are worth right
now. The rules cover the vocabulary well enough that a model would have had a
single name to place, and a seed placed it in one line. The case for the Jev
steps is about the names not logged yet, so it should be judged on how often the
import actually reports one — which, as of step 2, is something this system
finally measures.

Step 2 has standalone value. A hand-seeded override table plus the report lines
fixes the silent-`Other` problem on its own; Jev then removes the hand-seeding.
If access doesn't materialize, steps 1–2 still ship.

## Blockers

1. **Access.** Jev is in limited early access (since 2026-09-15). Hard stop on
   step 3; steps 0–2 are unaffected.
2. **Secret bootstrapping.** A CFN dynamic reference resolves at deploy time, so
   a secret that does not exist yet fails the deploy — including the dev deploy on
   the PR that introduces it. Make `TYPESAFE_SECRET_ARN` optional and have the
   ingest no-op without it, the way `WORKOUT_RULE_SET_NAME` already gates this
   whole stack and `mcpCertificateArn` gates the MCP endpoint.
3. **Shared key across stages.** Dev and prod deploy into one account and
   `GOOGLE_CLIENT_SECRET_NAME` is unsuffixed, so the naive thing gives both
   stages the same key. Stage-suffix it.
4. **Pre-1.0 SDK, untested by CI.** `@typesafe-ai/sdk@0.6.0` — three versions,
   published days ago; minors may break at 0.x. `dependabot.yml` groups
   `@aws-sdk/*` and dev deps but nothing else, and `deploy-dev.yml` skips
   Dependabot PRs, so a bump gets type-check and Jest but never a deploy. Pin
   exactly.
5. **No spend guardrail reaches it.** The `CfnBudget` is filtered
   `Service: ['Amazon Bedrock']`, so third-party spend is invisible to it. At a
   few names per import this is noise, but the per-call cap in rule 3 above is
   what actually bounds it.

Not blockers, checked: the ingest Lambda is not VPC-attached and `github-ingest.ts`
already proves outbound `fetch` works; the SDK is zero-dependency with no native
binary so esbuild bundles it with no `externalModules` or `commandHooks` work;
Node ≥20 is satisfied; and the SDK's `fetch` override means tests need no network
and no key.

## Verified how

`typesafe.ai` and `docs.typesafe.ai` are blocked by this environment's egress
proxy. The API surface above comes from the published npm package —
`@typesafe-ai/sdk@0.6.0`, its README and its TypeScript declarations — which is
authoritative for the client but not for the service. Pricing, latency and rate
limits are from secondary reporting and are unverified; none of the design
decisions above depend on them, because this path is batch, low-volume, and off
every request path.
