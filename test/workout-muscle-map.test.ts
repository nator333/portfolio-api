import {
  MUSCLE_SEEDS,
  loadMuscleOverrides,
  muscleOverrideItem,
  putMuscleOverrides,
} from '../lambda/workout-muscle-map';
import { MUSCLE_CRITERIA, MUSCLE_GROUPS, isAssignableMuscle, muscleFor } from '../lambda/workout-muscles';
import { parseWorkoutRows } from '../lambda/workout-schema';
import { SUMMARY_PK } from '../lambda/workout-schema';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const TABLE = 'portfolio-workout-summary-test';

/** A doc client whose send() replays queued responses and records the commands. */
const fakeDdb = (...pages: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: unknown }[]) => {
  const sent: any[] = [];
  const queue = [...pages];
  const client = {
    send: jest.fn(async (command: any) => {
      sent.push(command);
      return queue.shift() ?? {};
    }),
  };
  return { client: client as unknown as DynamoDBDocumentClient, sent };
};

const storedRow = (sk: string, muscle: unknown) => ({ pk: SUMMARY_PK.muscleMap, sk, muscle });

describe('MUSCLE_CRITERIA', () => {
  // The rubric is what anything resolving an unplaced name works from, so a
  // group missing from it is a group that can never be assigned.
  test('describes every group except Cardio', () => {
    const described = Object.keys(MUSCLE_CRITERIA).sort();
    const expected = MUSCLE_GROUPS.filter((m) => m !== 'Cardio').sort();
    expect(described).toEqual(expected);
  });

  // Load-bearing: cardio rows are dropped at ingest, so assigning a name to
  // Cardio deletes its sets rather than relabelling them.
  test('offers no way to assign Cardio', () => {
    expect(MUSCLE_CRITERIA).not.toHaveProperty('Cardio');
    expect(isAssignableMuscle('Cardio')).toBe(false);
  });

  test('accepts Other, which is a reviewed answer rather than a gap', () => {
    expect(isAssignableMuscle('Other')).toBe(true);
    expect(MUSCLE_CRITERIA.Other).toBeTruthy();
  });

  test('rejects values that are not groups at all', () => {
    expect(isAssignableMuscle('Legs')).toBe(false);
    expect(isAssignableMuscle('')).toBe(false);
    expect(isAssignableMuscle(undefined)).toBe(false);
    expect(isAssignableMuscle(7)).toBe(false);
  });
});

describe('MUSCLE_SEEDS', () => {
  test('only names groups a name may be assigned to', () => {
    for (const [name, muscle] of Object.entries(MUSCLE_SEEDS)) {
      expect({ name, ok: isAssignableMuscle(muscle) }).toEqual({ name, ok: true });
    }
  });

  // A seed is only reachable for a name no rule places; one that a rule already
  // claims is dead weight, and means the two layers disagree about the name.
  test('seeds only names the rules leave unplaced', () => {
    for (const name of Object.keys(MUSCLE_SEEDS)) {
      expect({ name, ruled: muscleFor(name) }).toEqual({ name, ruled: 'Other' });
    }
  });

  test('reach parseWorkoutRows through loadMuscleOverrides', async () => {
    const { client } = fakeDdb();
    const overrides = await loadMuscleOverrides(client, TABLE);
    const { sets, unresolved } = parseWorkoutRows(
      [
        {
          Date: '2026-01-23',
          'Exercise Name': 'High low',
          Set: '1',
          'Weight/Distance': '51.6',
          'Reps/Time': '10',
          Notes: '',
        },
      ],
      overrides,
    );
    expect(sets[0].muscle).toBe('Traps');
    expect(unresolved).toEqual([]);
  });

  // A seed is a decision that has been made; a stored row must not undo it.
  test('win over a stored row for the same name', async () => {
    const { client } = fakeDdb({ Items: [storedRow('high low', 'Biceps')] });
    const overrides = await loadMuscleOverrides(client, TABLE);
    expect(overrides.get('high low')).toBe('Traps');
  });
});

describe('muscleOverrideItem', () => {
  test('keys on the normalized name and keeps the raw spelling', () => {
    const item = muscleOverrideItem(
      { rawName: '  High　 Low  ', muscle: 'Chest', source: 'manual' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(item).toMatchObject({
      pk: SUMMARY_PK.muscleMap,
      sk: 'high low',
      rawName: 'High　 Low',
      muscle: 'Chest',
      source: 'manual',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  // DynamoDB rejects an undefined attribute value, and the ingest client's
  // removeUndefinedValues does not apply to a hand-built item.
  test('omits confidence rather than writing undefined', () => {
    const item = muscleOverrideItem({ rawName: 'High low', muscle: 'Chest', source: 'manual' });
    expect('confidence' in item).toBe(false);
  });

  test('carries confidence when one was reported', () => {
    const item = muscleOverrideItem(
      { rawName: 'High low', muscle: 'Chest', source: 'model', confidence: 0.82 },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(item).toMatchObject({ confidence: 0.82, source: 'model' });
  });
});

describe('loadMuscleOverrides', () => {
  test('reads stored rows keyed by normalized name', async () => {
    const { client, sent } = fakeDdb({ Items: [storedRow('mystery lift', 'Chest')] });
    const overrides = await loadMuscleOverrides(client, TABLE);
    expect(overrides.get('mystery lift')).toBe('Chest');
    expect(sent[0].input).toMatchObject({
      TableName: TABLE,
      ExpressionAttributeValues: { ':pk': SUMMARY_PK.muscleMap },
    });
  });

  test('follows pagination', async () => {
    const { client } = fakeDdb(
      { Items: [storedRow('a', 'Chest')], LastEvaluatedKey: { pk: 'x', sk: 'a' } },
      { Items: [storedRow('b', 'Lats')] },
    );
    const overrides = await loadMuscleOverrides(client, TABLE);
    expect(overrides.get('a')).toBe('Chest');
    expect(overrides.get('b')).toBe('Lats');
  });

  // The whole point of validating on read: a stored 'Cardio' would delete the
  // name's sets on every import, not merely mislabel them.
  test('drops a stored row claiming Cardio', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeDdb({ Items: [storedRow('treadmill sprints', 'Cardio')] });
    const overrides = await loadMuscleOverrides(client, TABLE);
    expect(overrides.has('treadmill sprints')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('drops a stored row whose muscle is not a group', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeDdb({ Items: [storedRow('mystery lift', 'Legs')] });
    const overrides = await loadMuscleOverrides(client, TABLE);
    expect(overrides.has('mystery lift')).toBe(false);
    warn.mockRestore();
  });

  test('returns the seeds when the table is empty', async () => {
    const { client } = fakeDdb();
    const overrides = await loadMuscleOverrides(client, TABLE);
    expect(overrides.size).toBe(Object.keys(MUSCLE_SEEDS).length);
  });
});

describe('putMuscleOverrides', () => {
  test('writes nothing when there is nothing to record', async () => {
    const { client, sent } = fakeDdb();
    await putMuscleOverrides(client, TABLE, []);
    expect(sent).toHaveLength(0);
  });

  test('chunks past DynamoDB’s 25-item batch cap', async () => {
    const { client, sent } = fakeDdb();
    const many = Array.from({ length: 26 }, (_, i) => ({
      rawName: `lift ${i}`,
      muscle: 'Chest' as const,
      source: 'model' as const,
    }));
    await putMuscleOverrides(client, TABLE, many);
    expect(sent).toHaveLength(2);
    expect(sent[0].input.RequestItems[TABLE]).toHaveLength(25);
    expect(sent[1].input.RequestItems[TABLE]).toHaveLength(1);
  });

  test('refuses to persist a Cardio assignment', async () => {
    const { client, sent } = fakeDdb();
    await putMuscleOverrides(client, TABLE, [
      { rawName: 'walking', muscle: 'Cardio' as never, source: 'model' },
    ]);
    expect(sent).toHaveLength(0);
  });
});
