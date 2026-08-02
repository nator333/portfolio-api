import {
  assignSetKeys,
  parseWorkoutRows,
  SOURCE_WEIGHT_UNIT,
  summarize,
  toKg,
  workoutRecipient,
} from '../lambda/workout-schema';
import { muscleFor } from '../lambda/workout-muscles';

describe('workoutRecipient', () => {
  // Every stage adds a rule to the same shared SES rule set and SES runs all
  // matching rules, so only prod may hold the bare address.
  test('gives prod the bare address', () => {
    expect(workoutRecipient('example.com', 'prod')).toBe('workout@example.com');
  });

  test('suffixes non-prod stages so they never match the prod address', () => {
    expect(workoutRecipient('example.com', 'dev')).toBe('workout-dev@example.com');
    expect(workoutRecipient('example.com', 'test')).toBe('workout-test@example.com');
  });

  test('no two stages share a recipient', () => {
    const addresses = ['prod', 'dev', 'test'].map((s) => workoutRecipient('example.com', s));
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

// Mirrors the Fitness Point export header: Date,Exercise Name,Set,Weight/Distance,Reps/Time,Notes
const row = (
  date: string,
  exercise: string,
  set: number,
  weight: number,
  reps: number,
  notes = '',
): Record<string, string> => ({
  Date: date,
  'Exercise Name': exercise,
  Set: String(set),
  'Weight/Distance': String(weight),
  'Reps/Time': String(reps),
  Notes: notes,
});

describe('parseWorkoutRows', () => {
  test('normalizes a valid row and computes volume', () => {
    const { sets, skipped } = parseWorkoutRows([row('2026-07-24', 'ベンチプレス', 1, 100, 5)]);
    expect(skipped).toBe(0);
    expect(sets).toEqual([
      {
        date: '2026-07-24',
        exercise: 'ベンチプレス',
        setNo: 1,
        weight: 100,
        weightKg: 45.36,
        reps: 5,
        volume: 500,
        volumeKg: 226.8,
        muscle: 'Chest',
        notes: '',
      },
    ]);
  });

  test('trims a trailing space in the exercise name', () => {
    const { sets } = parseWorkoutRows([row('2026-07-24', 'Pull ups ', 1, 0, 10)]);
    expect(sets[0].exercise).toBe('Pull ups');
    expect(sets[0].muscle).toBe('Back');
  });

  test('skips invalid rows without aborting the import', () => {
    const { sets, skipped } = parseWorkoutRows([
      row('2026-07-24', 'ベンチプレス', 1, 100, 5),
      row('not-a-date', 'ベンチプレス', 1, 100, 5),
      { Date: '2026-07-24', 'Exercise Name': '', Set: '1', 'Weight/Distance': '1', 'Reps/Time': '1' },
    ]);
    expect(sets).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  test('handles fractional weights and zero-weight bodyweight sets', () => {
    const { sets } = parseWorkoutRows([
      row('2026-07-24', 'バーベル スクワット', 1, 55.25, 10),
      row('2026-07-24', 'シーテッド カーフ レイズ', 1, 0, 15),
    ]);
    expect(sets[0].weight).toBe(55.25);
    expect(sets[0].volume).toBe(552.5);
    expect(sets[1].volume).toBe(0);
  });
});

describe('weight units', () => {
  // The export records pounds. The 2016-2017 rows are the evidence: they carry
  // messy decimals that resolve to exact kilogram figures, i.e. they were entered
  // in kg and converted on export.
  test.each([
    [55.116, 25],
    [66.139, 30],
    [88.185, 40],
    [22.046, 10],
    [143.3, 65],
  ])('converts the exported %p to %p kg', (lb, expectedKg) => {
    expect(toKg(lb)).toBeCloseTo(expectedKg, 1);
  });

  test('keeps the exported figure as the stored value and carries kg alongside', () => {
    const { sets } = parseWorkoutRows([row('2017-01-09', 'ベンチプレス', 1, 143.3, 5)]);
    const [set] = sets;
    expect(set.weight).toBe(143.3);
    expect(set.weightKg).toBeCloseTo(65, 1);
    expect(set.volume).toBeCloseTo(143.3 * 5, 1);
    expect(set.volumeKg).toBeCloseTo(325, 0);
  });

  test('summaries expose both units and name the source unit', () => {
    const { sets } = parseWorkoutRows([row('2026-07-24', 'ベンチプレス', 1, 220.462, 10)]);
    const s = summarize(sets);
    expect(s.meta.unit).toBe(SOURCE_WEIGHT_UNIT);
    expect(s.meta.totalVolume).toBeCloseTo(2204.62, 1);
    expect(s.meta.totalVolumeKg).toBeCloseTo(1000, 0);
    expect(s.days[0].volumeKg).toBeCloseTo(1000, 0);
    expect(s.exercises[0].maxWeight).toBe(220.462);
    expect(s.exercises[0].maxWeightKg).toBeCloseTo(100, 0);
  });
});

describe('assignSetKeys', () => {
  test('uses the bare exercise#set key when there is no repeat', () => {
    const { sets } = parseWorkoutRows([row('2026-07-24', 'ベンチプレス', 1, 100, 5)]);
    expect(assignSetKeys(sets).map((s) => s.sk)).toEqual(['ベンチプレス#1']);
  });

  test('suffixes a repeated set number instead of colliding', () => {
    // The real history logs two different "Set 1" rows for one exercise on
    // 2024-05-02; both are distinct sets and must both survive the import.
    const { sets } = parseWorkoutRows([
      row('2024-05-02', 'ラットプルダウン', 1, 130, 10),
      row('2024-05-02', 'ラットプルダウン', 1, 140, 5),
    ]);
    const keyed = assignSetKeys(sets);
    expect(keyed.map((s) => s.sk)).toEqual(['ラットプルダウン#1', 'ラットプルダウン#1#2']);
    expect(new Set(keyed.map((s) => s.sk)).size).toBe(2);
  });

  test('does not treat the same key on a different day as a repeat', () => {
    const { sets } = parseWorkoutRows([
      row('2026-07-20', 'ベンチプレス', 1, 100, 5),
      row('2026-07-21', 'ベンチプレス', 1, 100, 5),
    ]);
    expect(assignSetKeys(sets).map((s) => s.sk)).toEqual(['ベンチプレス#1', 'ベンチプレス#1']);
  });

  test('produces keys unique per (date, sk) across a whole import', () => {
    const { sets } = parseWorkoutRows([
      row('2026-07-20', 'ベンチプレス', 1, 100, 5),
      row('2026-07-20', 'ベンチプレス', 1, 110, 3),
      row('2026-07-20', 'ベンチプレス', 2, 100, 5),
      row('2026-07-21', 'ベンチプレス', 1, 100, 5),
    ]);
    const keyed = assignSetKeys(sets);
    const composite = keyed.map((s) => `${s.date}|${s.sk}`);
    expect(new Set(composite).size).toBe(composite.length);
  });
});

describe('summarize', () => {
  const { sets } = parseWorkoutRows([
    row('2026-07-20', 'ベンチプレス', 1, 100, 5),
    row('2026-07-20', 'ベンチプレス', 2, 100, 5),
    row('2026-07-20', 'バーベル スクワット', 1, 120, 5),
    row('2026-08-02', 'ベンチプレス', 1, 110, 3),
  ]);
  const summaries = summarize(sets);

  test('rolls up per-day totals with muscle set counts', () => {
    const day = summaries.days.find((d) => d.sk === '2026-07-20')!;
    expect(day.sets).toBe(3);
    expect(day.exerciseCount).toBe(2);
    expect(day.volume).toBe(100 * 5 + 100 * 5 + 120 * 5);
    expect(day.muscles).toEqual({ Chest: 2, Quads: 1 });
  });

  test('rolls up per-month totals across distinct workout days', () => {
    const july = summaries.months.find((m) => m.sk === '2026-07')!;
    expect(july.workoutDays).toBe(1);
    expect(july.sets).toBe(3);
    const august = summaries.months.find((m) => m.sk === '2026-08')!;
    expect(august.sets).toBe(1);
  });

  test('rolls up per-exercise stats including max weight and sessions', () => {
    const bench = summaries.exercises.find((e) => e.sk === 'ベンチプレス')!;
    expect(bench.sets).toBe(3);
    expect(bench.maxWeight).toBe(110);
    expect(bench.sessions).toBe(2);
    expect(bench.firstDate).toBe('2026-07-20');
    expect(bench.lastDate).toBe('2026-08-02');
    expect(bench.muscle).toBe('Chest');
  });

  test('produces all-time meta totals', () => {
    expect(summaries.meta.totalSets).toBe(4);
    expect(summaries.meta.workoutDays).toBe(2);
    expect(summaries.meta.exerciseCount).toBe(2);
    expect(summaries.meta.firstDate).toBe('2026-07-20');
    expect(summaries.meta.lastDate).toBe('2026-08-02');
  });

  test('ranking by sets differs from ranking by volume', () => {
    // A heavy machine can out-rank a much more frequently trained lift on
    // volume alone, which is why the report ranks exercises by sets.
    const { sets: mixed } = parseWorkoutRows([
      ...Array.from({ length: 5 }, (_, i) => row('2026-07-20', 'ベンチプレス', i + 1, 100, 10)),
      row('2026-07-20', 'アブダクター (Outer)', 1, 5000, 10),
    ]);
    const s = summarize(mixed);
    expect(s.exercises[0].sk).toBe('アブダクター (Outer)'); // volume order
    const bySets = [...s.exercises].sort((a, b) => b.sets - a.sets);
    expect(bySets[0].sk).toBe('ベンチプレス');
  });

  test('days are returned in ascending date order', () => {
    const order = summaries.days.map((d) => d.sk);
    expect(order).toEqual([...order].sort());
  });
});

describe('muscleFor', () => {
  test.each([
    ['ベンチプレス', 'Chest'],
    ['ケーブルクロスオーバー', 'Chest'],
    ['ラットプルダウン', 'Back'],
    ['Pull ups', 'Back'],
    ['シーテッドケーブルロウズ', 'Back'],
    ['バーベル スクワット', 'Quads'],
    ['レッグ プレス', 'Quads'],
    ['レッグ エクステンション', 'Quads'],
    ['ルーマニアン デッドリフト', 'Hamstrings'],
    ['Barbell Hip Thrust', 'Glutes'],
    ['アブダクター (Outer)', 'Glutes'],
    ['サイド ラテラル レイズ', 'Shoulders'],
    ['ダンベル ショルダー プレス', 'Shoulders'],
    ['マシン リバース バタフライ', 'Shoulders'],
    ['プリーチャー カール', 'Biceps'],
    ['トライセップス プッシュダウン', 'Triceps'],
    ['ナロー グリップ ベンチプレス', 'Triceps'],
    ['シーテッド カーフ レイズ', 'Calves'],
    ['ダンベルシュラッグ', 'Traps'],
    ['ライング レッグカール', 'Hamstrings'],
    ['スタンディング ビハインド ザ バック ケーブル リストカール', 'Forearms'],
    ['デクライン・クランチ', 'Abs'],
    ['水泳', 'Cardio'],
  ])('maps %s to %s', (exercise, muscle) => {
    expect(muscleFor(exercise)).toBe(muscle);
  });

  test('falls back to Other for unknown exercises', () => {
    expect(muscleFor('Some Brand New Machine')).toBe('Other');
  });
});
