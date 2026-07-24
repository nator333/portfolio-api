import { parseWorkoutRows, summarize } from '../lambda/workout-schema';
import { muscleFor } from '../lambda/workout-muscles';

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
        reps: 5,
        volume: 500,
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
    expect(day.muscles).toEqual({ Chest: 2, Legs: 1 });
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
    ['バーベル スクワット', 'Legs'],
    ['レッグ プレス', 'Legs'],
    ['ルーマニアン デッドリフト', 'Legs'],
    ['サイド ラテラル レイズ', 'Shoulders'],
    ['ダンベル ショルダー プレス', 'Shoulders'],
    ['マシン リバース バタフライ', 'Shoulders'],
    ['プリーチャー カール', 'Biceps'],
    ['トライセップス プッシュダウン', 'Triceps'],
    ['ナロー グリップ ベンチプレス', 'Triceps'],
    ['シーテッド カーフ レイズ', 'Calves'],
    ['ダンベルシュラッグ', 'Traps'],
    ['ライング レッグカール', 'Legs'],
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
