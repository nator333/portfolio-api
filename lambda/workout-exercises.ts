/**
 * Canonicalizes a Fitness Point exercise name to a single English label.
 *
 * The export names exercises free-form in a mix of Japanese and English, and the
 * same movement is often logged both ways ("ライング レッグカール" and "Lying Leg
 * Curl") or with drifting spelling/spacing. This maps every known spelling to one
 * canonical English name so the summaries read in English and duplicate spellings
 * collapse into a single exercise. Applied at ingest, so a re-import rebuilds the
 * rollups under the canonical names; unknown names pass through unchanged (trimmed)
 * rather than being dropped, so a newly-logged exercise still appears — just in its
 * original wording until a mapping is added here.
 *
 * Muscle classification still runs on the raw name (see parseWorkoutRows), so this
 * table only affects the displayed identity, never which group a set counts toward.
 * Where a Japanese name canonicalizes onto an existing English spelling, the two are
 * mapped to the *same* string on purpose so their history merges.
 */

// Keyed by the raw name as it appears in the export → canonical English. Lookups are
// case- and whitespace-insensitive (see `normalize`), so only one spelling of each
// needs listing here; full-width spaces and stray double spaces are handled for free.
const TRANSLATIONS: Record<string, string> = {
  // — Chest —
  'ベンチプレス': 'Bench Press',
  'ケーブルクロスオーバー': 'Cable Crossover',
  'ダンベルインクラインベンチプレス': 'Incline Dumbbell Bench Press',
  'マシン ベンチプレス': 'Machine Bench Press',
  'ダンベルベンチプレス': 'Dumbbell Bench Press',
  'バーベルインクラインベンチプレス': 'Barbell Incline Bench Press',
  'インクライン チェスト プレス': 'Incline Chest Press',
  'チェスト ディップス': 'Chest Dips',
  'ディップ マシン': 'Dip Machine',
  'バタフライ': 'Butterfly',
  'インクライン ダンベルフライ': 'Incline Dumbbell Fly',
  'スミスマシン インクライン ベンチプレス': 'Smith Machine Incline Bench Press',
  'デクライン バーベル ベンチ プレス': 'Decline Barbell Bench Press',
  'ナロー グリップ ベンチプレス': 'Narrow Grip Bench Press',
  'ハンマー グリップ インクラインDB ベンチプレス': 'Hammer Grip Incline DB Bench Press',
  'ケーブル チェスト プレス': 'Cable Chest Press',
  'ケーブル インクライン プレス': 'Cable Incline Press',
  'デクラインダンベルベンチプレス': 'Decline Dumbbell Bench Press',
  'ダンベル デクライン フライズ': 'Dumbbell Decline Flyes',
  'プッシュアップ': 'Push-Up',

  // — Lats / back —
  'ラットプルダウン': 'Lat Pulldown',
  'シーテッドケーブルロウズ': 'Seated Cable Rows',
  'ロープ ラット プルダウン': 'Rope Lat Pulldown',
  'マシン ラットプルダウン': 'Machine Lat Pulldown',
  'V-バープルダウン': 'V-Bar Pulldown',
  'ダンベルプルオーバー': 'Dumbbell Pullover',
  'ワン アーム シーテッド ケーブル ロウ': 'One-Arm Seated Cable Row',
  'クライマーズ チンアップ': "Climber's Chin-Up",
  'マシンアシステッド プルアップ': 'Machine Assisted Pull Up',
  'インクラインベンチ トゥーアームダンベル ロウ': 'Incline Bench Two-Arm Dumbbell Row',
  'リバースグリップベント-オーバーロウズ': 'Reverse Grip Bent-Over Row',
  'クロースグリップ フロント ラット プルダウン': 'Close Grip Front Lat Pulldown',
  'T-バーロウ': 'T-Bar Row',
  'ストレート アーム プルダウン': 'Straight Arm Pulldown',
  'インクラインベンチ バーベル ロウ': 'Incline Bench Barbell Row',
  'ボディー ロウ': 'Body Row',
  'ラット プルダウン ビハインド ネック': 'Lat Pulldown Behind Neck',
  'チンアップ': 'Chin-Up',
  'マシン アシステッド チン アップ': 'Machine Assisted Chin-Up',
  'ハイパーエクステンション': 'Hyperextensions',

  // — Quads / hamstrings / glutes —
  'バーベル スクワット': 'Barbell Squat',
  'レッグ エクステンション': 'Leg Extension',
  'レッグ プレス': 'Leg Press',
  'ライング レッグカール': 'Lying Leg Curl',
  'ルーマニアン デッドリフト': 'Romanian Deadlift',
  'ワイド スタンス ハックスクワット': 'Wide Stance Hack Squat',
  'バーベル ランジ': 'Barbell Lunge',
  'ダンベル ランジュ': 'Dumbbell Lunge',
  'シーテッド レッグ カール': 'Seated Leg Curl',
  'ゼッカ― スクワット': 'Zercher Squat',
  'ワイドスタンス レッグプレス': 'Wide Stance Leg Press',
  'ナロースタンス レッグプレス': 'Narrow Stance Leg Press',
  'アブダクター (Outer)': 'Hip Abductor (Outer)',

  // — Shoulders —
  'サイド ラテラル レイズ': 'Side Lateral Raise',
  'マシン ショルダー (ミリタリー) プレス': 'Machine Shoulder (Military) Press',
  'シーテッド バーベル ミリタリー プレス': 'Seated Barbell Military Press',
  'ダンベル ショルダー プレス': 'Dumbbell Shoulder Press',
  'マシン リバース バタフライ': 'Machine Reverse Butterfly',
  'スタンディング ミリタリー プレス': 'Standing Military Press',
  'ケーブル ラテラル レイズ': 'Cable Lateral Raise',
  'バーベル リア デルト ロウ': 'Barbell Rear Delt Row',
  'リアデルトイドロウ': 'Rear Deltoid Row',
  'ダンベル ライング　リア ラテラル レイズ': 'Dumbbell Lying Rear Lateral Raise',
  'スミスマシン ショルダー プレス': 'Smith Machine Shoulder Press',
  'スミスマシン リア デルトロウ': 'Smith Machine Rear Delt Row',
  'ダンベル リア フライ': 'Dumbbell Rear Fly',
  'バーベルアップライトロウ': 'Barbell Upright Row',
  'ダンベル レイズ': 'Dumbbell Raise',
  'フロント ダンベル レイズ': 'Front Dumbbell Raise',

  // — Biceps —
  'プリーチャー カール': 'Preacher Curl',
  'リバース グリップ ケーブル カール': 'Reverse Grip Cable Curl',
  'インクライン ダンベル カール': 'Incline Dumbbell Curl',
  'ケーブル プリーチャー カール': 'Cable Preacher Curl',
  'EZバー カール': 'EZ Bar Curl',
  'ダンベル オルタネイト バイセップカール': 'Dumbbell Alternating Biceps Curl',
  'オルタネイトハンマーカール': 'Alternating Hammer Curl',
  'EZバー リバース グリップ バーベル カール': 'EZ Bar Reverse Grip Barbell Curl',
  'スタンディング ワンアーム ケーブルカール': 'Standing One-Arm Cable Curl',
  'ワン アーム ダンベル プリーチャーカール': 'One-Arm Dumbbell Preacher Curl',
  'オルタネイト インクライン ダンベルカール': 'Alternating Incline Dumbbell Curl',
  'バイセップスカール　バーベル': 'Barbell Biceps Curl',
  'リバース スタンディング バーベルカール': 'Reverse Grip Standing Barbell Curl',
  'マシン プリーチャー カールズ': 'Machine Preacher Curl',
  'バイセップスカール　ダンベル': 'Dumbbell Biceps Curl',
  'スタンディング バイセップ ケーブルカール': 'Standing Biceps Cable Curl',
  'リバース グリップ バイセップカール': 'Reverse Grip Biceps Curl',
  'EZバー リバース グリップ プリーチャーカール': 'EZ Bar Reverse Grip Preacher Curl',
  'スタンディングワンアーム ダンベルカール オーバー インクライン ベンチ': 'Standing One-Arm Dumbbell Curl Over Incline Bench',
  'バーベル リバース グリップ プリーチャーカール': 'Barbell Reverse Grip Preacher Curl',
  'プリーチャー ハンマー ダンベルカール': 'Preacher Hammer Dumbbell Curl',
  'スパイダーカール': 'Spider Curl',
  'トゥー アーム ダンベル プリーチャー カール': 'Two-Arm Dumbbell Preacher Curl',
  'ロープハンマーカール': 'Rope Hammer Curl',

  // — Triceps —
  'トライセップス プッシュダウン': 'Triceps Pushdown',
  'トライセップス プッシュダウン-ロープアタッチメント': 'Triceps Pushdown - Rope Attachment',
  'ディップス- トライセップスバージョン': 'Dips - Triceps Version',
  'デクライン EZ バー トライセップ エクステンション': 'Decline EZ Bar Triceps Extension',
  'ワンアームトライセップスエクステンション': 'One-Arm Triceps Extension',
  'ライング クロ―ス グリップ バーベル トライセップス エクステンション ビハインド ヘッド':
    'Lying Close Grip Barbell Triceps Extension Behind Head',
  'トライセップスプッシュダウン V-バー': 'Triceps Pushdown V-Bar',
  'ベンチディップス': 'Bench Dips',
  'デクライン クロース グリップベンチ トゥー スカル クラッシャー': 'Decline Close Grip Bench to Skull Crusher',
  'デクライン ダンベル トライセップスエクステンション': 'Decline Dumbbell Triceps Extension',
  'スタンディング ダンベル トライセップス エクステンション': 'Standing Dumbbell Triceps Extension',
  'インクライン トライセップス エクステンション': 'Incline Triceps Extension',
  'リバース グリップ トライセップス プッシュダウン': 'Reverse Grip Triceps Pushdown',
  'シーテッドトライセップスプレス': 'Seated Triceps Press',
  'ダンベル ワンアーム トライセップス エクステンション': 'Dumbbell One-Arm Triceps Extension',
  'ライング スパイントゥーアーム ダンベル トライセップス エクステンション':
    'Lying Supine Two-Arm Dumbbell Triceps Extension',
  'シーテッド オーバーヘッドバーベル トライセップス エクステンション': 'Seated Overhead Barbell Triceps Extension',
  'トライセップス エクステンション': 'Triceps Extension',
  'マシン アシステッド ディップス': 'Machine Assisted Dips',

  // — Traps —
  'ダンベルシュラッグ': 'Dumbbell Shrug',
  'Dumbbell shrug': 'Dumbbell Shrug', // merge the existing English spelling
  'スミスマシン シュラッグ': 'Smith Machine Shrug',

  // — Calves —
  'シーテッド カーフ レイズ': 'Seated Calf Raise',
  'カーフ プレス オン ザ レッグプレスマシン': 'Calf Press on the Leg Press Machine',
  'スタンディング カーフレイズ': 'Standing Calf Raise',

  // — Forearms —
  'スタンディング ビハインド ザ バック ケーブル リストカール': 'Standing Behind-the-Back Cable Wrist Curl',
  'バーベル ビハインド ザ バックリストカール': 'Barbell Behind The Back Wrist Curl',

  // — Abs —
  'デクライン・クランチ': 'Decline Crunch',
  'レッグ・レイズ': 'Leg Raise',
  'ベントニー・ヒップレイズ': 'Bent Knee Hip Raise',
  'クロスボディークランチ': 'Cross-Body Crunch',
  'アブクランチ マシン': 'Ab Crunch Machine',
  'レッグレイズ オン パラレル バー': 'Leg Raise on Parallel Bars',
  'クランチ': 'Crunch',

  // — Other (unclassified but real lifts) —
  'オールドスクール リバース エクステンションズ': 'Old School Reverse Extensions',

  // — Cardio (dropped at ingest; listed for completeness) —
  '水泳': 'Swimming',
  'トレッドミル': 'Treadmill',
  'リカベントバイク': 'Recumbent Bike',
};

/** Collapse whitespace (incl. full-width spaces) and lowercase, for lookup only. */
const normalize = (s: string): string => s.trim().replace(/[\s　]+/g, ' ').toLowerCase();

const LOOKUP: ReadonlyMap<string, string> = new Map(
  Object.entries(TRANSLATIONS).map(([raw, english]) => [normalize(raw), english]),
);

/**
 * Returns the canonical English name for an exercise, or the trimmed original when
 * no mapping exists (so unknown/new exercises still show, just untranslated).
 */
export function exerciseName(raw: string): string {
  return LOOKUP.get(normalize(raw)) ?? raw.trim();
}
