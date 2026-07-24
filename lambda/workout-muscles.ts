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
 * "curl"→Biceps rule, and a leg curl to Legs before it, so both sit above
 * Biceps. Rear-delt work sits above the generic Shoulders/Chest rules so
 * "reverse butterfly" is a shoulder movement, not a chest one.
 *
 * These are training-convention judgment calls, not anatomy: deadlift variants
 * are counted as Legs (posterior-chain dominant), face pulls and upright rows as
 * Shoulders. Adjust the rules here as the exercise vocabulary evolves.
 */

export type MuscleGroup =
  | 'Chest'
  | 'Back'
  | 'Legs'
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
  'Back',
  'Legs',
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

interface MuscleRule {
  readonly muscle: MuscleGroup;
  readonly keywords: readonly string[];
}

// First matching rule wins; see the file header for why the order is what it is.
const RULES: readonly MuscleRule[] = [
  { muscle: 'Cardio', keywords: ['水泳', 'トレッドミル', 'リカベントバイク', 'treadmill', 'recumbent', 'exercise bike', 'stationary bike'] },
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
    muscle: 'Legs',
    keywords: [
      'スクワット', 'squat', 'レッグ プレス', 'レッグプレス', 'leg press', 'レッグ エクステンション',
      'leg extension', 'レッグ カール', 'レッグカール', 'leg curl', 'ランジ', 'lunge', 'デッドリフト',
      'deadlift', 'dead lift', 'rdl', 'ルーマニアン', 'romanian', 'グルート', 'glute', 'hip thrust',
      'ブルガリアン', 'bulgarian', 'ハック', 'hack', 'ゼッカ', 'zercher', 'アブダクター', 'abductor',
      'thigh', 'rack pull', 'block pull', 'レッグ',
    ],
  },
  {
    // "hammer" is deliberately absent — it also names Hammer Strength machines
    // and hammer-grip pulls; the actual hammer *curls* all carry カール / "curl".
    muscle: 'Biceps',
    keywords: ['カール', 'curl', 'プリーチャー', 'preacher', 'スパイダー', 'spider', 'drag curl', 'ドラッグ', 'pinwheel', 'バイセップ', 'bicep'],
  },
  { muscle: 'Traps', keywords: ['シュラッグ', 'shrug'] },
  {
    muscle: 'Back',
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
// load so muscleFor does at most one regex test plus a few includes per rule.
interface CompiledRule {
  readonly muscle: MuscleGroup;
  readonly asciiRegex: RegExp | null;
  readonly substrings: readonly string[];
}

const COMPILED: readonly CompiledRule[] = RULES.map((rule) => {
  const lowered = rule.keywords.map((k) => k.toLowerCase());
  const ascii = lowered.filter(isAscii).map(escapeRegExp);
  const substrings = lowered.filter((k) => !isAscii(k));
  return {
    muscle: rule.muscle,
    asciiRegex: ascii.length ? new RegExp(`(^|[^a-z])(?:${ascii.join('|')})`) : null,
    substrings,
  };
});

/** Resolves an exercise name to its major muscle group, defaulting to "Other". */
export function muscleFor(exerciseName: string): MuscleGroup {
  const name = exerciseName.trim().toLowerCase();
  for (const rule of COMPILED) {
    if (rule.asciiRegex?.test(name)) return rule.muscle;
    if (rule.substrings.some((keyword) => name.includes(keyword))) return rule.muscle;
  }
  return 'Other';
}
