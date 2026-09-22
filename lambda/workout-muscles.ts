/**
 * Maps a workout exercise name to a major muscle group.
 *
 * The Fitness Point export names exercises free-form in a mix of Japanese and
 * English (196 distinct names in the current history, and growing), so an exact
 * name→group table would be both huge and brittle. Instead this is an ordered
 * list of substring rules: the first rule whose keyword appears in the name
 * wins, and anything unmatched falls back to "Other".
 *
 * Order matters — earlier rules override later ones for names that could match
 * several. For example a wrist curl must resolve to Forearms before the generic
 * "curl"→Biceps rule, and a leg curl to Hamstrings before it, so both sit above
 * Biceps. Rear-delt work sits above the generic Shoulders/Chest rules so
 * "reverse butterfly" is a shoulder movement, not a chest one.
 *
 * A rule may also require a second keyword (`and`), for movements whose group is
 * decided by a pair of words rather than one: a reverse-grip curl is forearm work
 * while a reverse-grip row or pushdown is not, so the Forearms rule for it asks
 * for "reverse" and "curl" together instead of enumerating every spelling.
 *
 * These are training-convention judgment calls, not anatomy. The lower body is
 * split into Quads (knee-extension dominant: squats, presses, extensions,
 * lunges), Hamstrings (hip-hinge / knee-flexion: deadlift variants, leg curls,
 * rack pulls) and Glutes (hip thrusts, glute-ham/abductor work); face pulls and
 * upright rows count as Shoulders. The pulling group (rows, pulldowns, pull-ups)
 * is named "Lats" rather than "Back" so it doesn't read as a superset of Traps —
 * anatomically the traps are part of the back, so a "Back" group sitting beside a
 * "Traps" group is ambiguous. Adjust the rules here as the vocabulary evolves.
 */

export type MuscleGroup =
  | 'Chest'
  | 'Lats'
  | 'Quads'
  | 'Hamstrings'
  | 'Glutes'
  | 'Shoulders'
  | 'Biceps'
  | 'Triceps'
  | 'Traps'
  | 'Calves'
  | 'Abs'
  | 'Forearms'
  | 'Cardio'
  | 'Other';

export const MUSCLE_GROUPS: readonly MuscleGroup[] = [
  'Chest',
  'Lats',
  'Quads',
  'Hamstrings',
  'Glutes',
  'Shoulders',
  'Biceps',
  'Triceps',
  'Traps',
  'Calves',
  'Abs',
  'Forearms',
  'Cardio',
  'Other',
] as const;

/**
 * A group an unclassified name may be *assigned* to, and what that group means.
 *
 * These restate the judgement calls the rules below already encode, so that
 * anything resolving a name the rules could not — a person reading the import
 * report today, a model later — works from the same definitions rather than a
 * second, drifting copy of them.
 *
 * `Cardio` is deliberately absent, and the absence is load-bearing: cardio rows
 * are *dropped* at ingest (see parseWorkoutRows), so assigning a name to Cardio
 * deletes its sets instead of relabelling them. The Cardio rule runs first and
 * catches conditioning work deterministically; nothing downstream may put a name
 * back into it.
 *
 * `Other` is present on purpose. "Reviewed, and genuinely none of the above" is
 * a real answer — the log contains real lifts that belong to no single group —
 * and being able to record it is what stops such a lift being reported as
 * unresolved on every future import.
 */
export type AssignableMuscle = Exclude<MuscleGroup, 'Cardio'>;

export const MUSCLE_CRITERIA: Readonly<Record<AssignableMuscle, string>> = {
  Chest: 'Horizontal pressing and adduction: bench presses at any angle, chest presses, flyes, crossovers, dips, push-ups, pec deck.',
  Lats: 'Vertical and horizontal pulling: pulldowns, pull-ups and chin-ups, rows of every kind, pullovers, straight-arm pulldowns, back extensions.',
  Quads: 'Knee-extension dominant lower body: squats of any bar position, leg presses, leg extensions, lunges, hack and Zercher variants.',
  Hamstrings: 'Hip-hinge and knee-flexion posterior chain: leg curls, conventional and Romanian deadlifts, rack and block pulls.',
  Glutes: 'Direct hip-extension and abduction work: hip thrusts, glute-ham raises, hip abductor machines.',
  Shoulders: 'Deltoid work in any head: overhead and military presses, lateral and front raises, rear-delt flyes and reverse pec deck, face pulls, upright rows.',
  Biceps: 'Elbow flexion with a supinated or neutral grip: barbell, dumbbell, cable, preacher, spider, drag and hammer curls.',
  Triceps: 'Elbow extension: pushdowns, skull crushers, kickbacks, overhead extensions, close- and narrow-grip bench press.',
  Traps: 'Scapular elevation: shrugs of every implement.',
  Calves: 'Plantarflexion: standing, seated and leg-press calf raises.',
  Abs: 'Trunk flexion and rotation: crunches, leg and knee raises, hip raises, side bends, oblique twists, planks.',
  Forearms: 'Wrist flexion and extension, grip work, and reverse-grip (pronated) curls, which load the brachioradialis rather than the biceps.',
  Other: 'A real resistance movement that belongs to none of the groups above, or one whose target cannot be told from its name alone.',
};

/**
 * Whether a value names a group something may be assigned to.
 *
 * This is the enforcement point for the Cardio exclusion above: it is applied
 * wherever a muscle group arrives from outside this module, so a stored or
 * inferred `'Cardio'` is rejected rather than quietly deleting a lift's sets.
 */
export const isAssignableMuscle = (value: unknown): value is AssignableMuscle =>
  typeof value === 'string' &&
  value !== 'Cardio' &&
  (MUSCLE_GROUPS as readonly string[]).includes(value);

interface MuscleRule {
  readonly muscle: MuscleGroup;
  readonly keywords: readonly string[];
  /**
   * Optional second keyword list. When present the name must hit `keywords` *and*
   * `and` for the rule to match, which lets a two-word movement claim its group
   * without listing every spelling of the words in between.
   */
  readonly and?: readonly string[];
}

// First matching rule wins; see the file header for why the order is what it is.
const RULES: readonly MuscleRule[] = [
  {
    // Conditioning / steady-state work, not a resistance muscle group. The ingest
    // drops these rows entirely (this is a strength log), so the list only has to
    // recognize them, not place them anatomically. Plain English activity names
    // ("Walking", "Running", "Swimming") are included alongside the machine terms.
    muscle: 'Cardio',
    keywords: [
      '水泳', 'スイミング', 'ランニング', 'ウォーキング', 'ジョギング', 'トレッドミル', 'リカベントバイク',
      'treadmill', 'recumbent', 'exercise bike', 'stationary bike', 'cycling', 'elliptical',
      'stair climber', 'stairmaster', 'walk', 'run', 'swim', 'jog',
    ],
  },
  { muscle: 'Forearms', keywords: ['リストカール', 'リスト', 'wrist curl', 'wrist', 'plate pinch', 'pinch', 'ピンチ'] },
  { muscle: 'Calves', keywords: ['カーフ', 'calf', 'calve'] },
  {
    muscle: 'Abs',
    keywords: [
      'クランチ', 'crunch', 'レッグ レイズ', 'レッグレイズ', 'レッグ・レイズ', 'leg raise',
      'knee raise', 'ヒップレイズ', 'ヒップ レイズ', 'hip raise', 'ベントニー', 'side bend',
      'サイドベンド', 'rotation du buste', 'クロスボディ', 'oblique', 'プランク', 'plank',
    ],
  },
  {
    muscle: 'Shoulders',
    keywords: [
      // Rear-delt / lateral / overhead work — kept above the generic Chest and
      // Back rules so reverse flyes and upright rows resolve here.
      'リアデルト', 'リア デルト', 'rear delt', 'リア フライ', 'リアフライ', 'rear fly', 'reverse fly',
      'リバース バタフライ', 'reverse butterfly', 'face pull', 'アップライト', 'upright',
      'ショルダー', 'shoulder', 'ミリタリー', 'military', 'overhead press', 'z press', 'arnold',
      'アーノルド', 'ラテラル', 'lateral', 'サイド ラテラル', 'side lateral', 'デルト', 'delt',
      'front raise', 'フロント', 'レイズ', 'raise',
    ],
  },
  {
    muscle: 'Triceps',
    keywords: [
      'トライセップ', 'triceps', 'tricep', 'プッシュダウン', 'pushdown', 'push down', 'スカル',
      'skull', 'クラッシャー', 'triceps version', 'トライセップスバージョン', 'kickback', 'キックバック',
      // Close/narrow-grip *bench* is a triceps movement; plain close-grip is not
      // (it also names lat pulldowns and barbell curls), so pair it with bench.
      'close grip bench', 'close-grip bench', 'narrow grip bench', 'ナロー グリップ ベンチ',
      'ナローグリップ ベンチ', 'クロースグリップ ベンチ', 'クロースグリップベンチ', 'クロース グリップベンチ',
    ],
  },
  {
    // Knee-extension dominant. Squats, presses, extensions, lunges and their
    // hack/zercher/Bulgarian variants. Sits above Back so "leg extension" beats
    // the generic "extension"→Back rule.
    muscle: 'Quads',
    keywords: [
      'スクワット', 'squat', 'レッグ プレス', 'レッグプレス', 'leg press', 'レッグ エクステンション',
      'leg extension', 'ランジ', 'lunge', 'ブルガリアン', 'bulgarian', 'ハック', 'hack', 'ゼッカ',
      'zercher', 'thigh',
    ],
  },
  {
    // Hip-hinge and knee-flexion posterior chain. Leg curls sit above the
    // generic "curl"→Biceps rule; deadlift/RDL/rack-pull variants are counted
    // as hamstring-dominant.
    muscle: 'Hamstrings',
    keywords: [
      'レッグ カール', 'レッグカール', 'leg curl', 'デッドリフト', 'deadlift', 'dead lift', 'rdl',
      'ルーマニアン', 'romanian', 'rack pull', 'block pull',
    ],
  },
  {
    // Hip thrusts, glute-ham and hip-abductor work.
    muscle: 'Glutes',
    keywords: ['グルート', 'glute', 'hip thrust', 'アブダクター', 'abductor'],
  },
  {
    // Reverse-grip (pronated) curls load the brachioradialis and forearm
    // extensors rather than the biceps, so they resolve here and not under the
    // generic "curl"→Biceps rule just below. Pairing "reverse" with "curl"
    // covers every bar/grip/bench variant — "Reverse Grip Cable Curl", "EZ Bar
    // Reverse Grip Preacher Curl", リバース スタンディング バーベルカール — while leaving
    // reverse-grip work that isn't a curl (pushdowns, bent-over rows, reverse
    // butterfly) to its own rule. Kept below Hamstrings so a reverse-grip *leg*
    // curl would still read as a leg curl.
    muscle: 'Forearms',
    keywords: ['リバース', 'reverse'],
    and: ['カール', 'curl'],
  },
  {
    // "hammer" is deliberately absent — it also names Hammer Strength machines
    // and hammer-grip pulls; the actual hammer *curls* all carry カール / "curl".
    muscle: 'Biceps',
    keywords: ['カール', 'curl', 'プリーチャー', 'preacher', 'スパイダー', 'spider', 'drag curl', 'ドラッグ', 'pinwheel', 'バイセップ', 'bicep'],
  },
  { muscle: 'Traps', keywords: ['シュラッグ', 'shrug'] },
  {
    // The lat/row pulling group. Named "Lats" (not "Back") to disambiguate from
    // Traps, which anatomically also belongs to the back. Sits below Traps so a
    // shrug resolves there first.
    muscle: 'Lats',
    keywords: [
      'ラット', 'lat pull', 'プルダウン', 'pulldown', 'pull down', 'プルアップ', 'pull up', 'pull ups',
      'pullup', 'チンアップ', 'チン アップ', 'chin', 'ロウ', 'ロウズ', 'row', 'tirage', 'triage',
      'プルオーバー', 'pullover', 'hyperextension', 'ハイパーエクステンション', 'ストレート アーム',
      'straight arm', 'ボディ ロウ', 'ボディー ロウ', 'body row', 'meadows', 'lever row', 't-バー',
      't-bar', 'エクステンション', 'extension',
    ],
  },
  {
    muscle: 'Chest',
    keywords: [
      'ベンチプレス', 'ベンチ プレス', 'bench press', 'bench', 'チェスト', 'chest', 'フライ', 'fly',
      'flye', 'クロスオーバー', 'crossover', 'ディップ', 'dip', 'プッシュアップ', 'push up', 'push-up',
      'pushup', 'バタフライ', 'butterfly', 'pec', 'プレス', 'press',
    ],
  },
];

const isAscii = (s: string): boolean => /^[\x00-\x7f]+$/.test(s);
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Japanese has no word boundaries, so Japanese keywords must match as plain
// substrings. ASCII keywords instead match only at the *start* of a word — this
// keeps plurals working ("dips", "chins", "rows") while preventing mid-word hits
// like "chin" inside "machine" or "row" inside "crossover". Compiled once at
// load so muscleFor does at most one regex test plus a few includes per keyword
// list, and a rule has one list unless it declares an `and` clause.
interface CompiledKeywords {
  readonly asciiRegex: RegExp | null;
  readonly substrings: readonly string[];
}

interface CompiledRule {
  readonly muscle: MuscleGroup;
  /** Every matcher must hit; one per keyword list the rule declares. */
  readonly matchers: readonly CompiledKeywords[];
}

function compileKeywords(keywords: readonly string[]): CompiledKeywords {
  const lowered = keywords.map((k) => k.toLowerCase());
  const ascii = lowered.filter(isAscii).map(escapeRegExp);
  return {
    asciiRegex: ascii.length ? new RegExp(`(^|[^a-z])(?:${ascii.join('|')})`) : null,
    substrings: lowered.filter((k) => !isAscii(k)),
  };
}

const COMPILED: readonly CompiledRule[] = RULES.map((rule) => ({
  muscle: rule.muscle,
  matchers: rule.and
    ? [compileKeywords(rule.keywords), compileKeywords(rule.and)]
    : [compileKeywords(rule.keywords)],
}));

const matches = (matcher: CompiledKeywords, name: string): boolean =>
  matcher.asciiRegex?.test(name) === true ||
  matcher.substrings.some((keyword) => name.includes(keyword));

/** Resolves an exercise name to its major muscle group, defaulting to "Other". */
export function muscleFor(exerciseName: string): MuscleGroup {
  const name = exerciseName.trim().toLowerCase();
  for (const rule of COMPILED) {
    if (rule.matchers.every((matcher) => matches(matcher, name))) return rule.muscle;
  }
  return 'Other';
}
