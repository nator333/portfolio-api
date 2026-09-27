import {
  GYM_SUMMARY_SYSTEM_PROMPT,
  attachGymSummaries,
  buildGymPrompt,
  dateFromReflectionKey,
  itemsToGymSummaries,
  parseGymSummary,
} from '../lambda/gym-summary-schema';
import { MAX_SUMMARY_CHARS } from '../lambda/github-summary-schema';

describe('GYM_SUMMARY_SYSTEM_PROMPT', () => {
  test('keeps private life out of the public line', () => {
    // The one guard between private notes and the public site besides the
    // add_reflection instruction; a rewrite must not drop it.
    expect(GYM_SUMMARY_SYSTEM_PROMPT).toMatch(/Never mention private life/);
    expect(GYM_SUMMARY_SYSTEM_PROMPT).toContain(`never exceed ${MAX_SUMMARY_CHARS}`);
  });
});

describe('buildGymPrompt', () => {
  test('numbers each note under the session date', () => {
    expect(buildGymPrompt('2026-09-20', [' Squat 140x5. ', 'Felt strong.'])).toBe(
      ['Session date: 2026-09-20', '', 'Note 1:', 'Squat 140x5.', '', 'Note 2:', 'Felt strong.'].join('\n'),
    );
  });

  test('caps the text handed to the model', () => {
    const prompt = buildGymPrompt('2026-09-20', ['a'.repeat(10000), 'b'.repeat(10000), 'c'.repeat(10)]);
    expect(prompt.length).toBeLessThan(12200);
    expect(prompt).not.toContain('Note 3:');
  });
});

describe('parseGymSummary', () => {
  test('normalises a phrase, leaving an overrun uncapped so it can be sent back', () => {
    expect(parseGymSummary('"Hit a squat PR at 140 kg."')).toBe('Hit a squat PR at 140 kg');
    expect(parseGymSummary('x '.repeat(100))!.length).toBeGreaterThan(MAX_SUMMARY_CHARS);
  });

  test('treats the no-summary marker and an empty reply as nothing to publish', () => {
    expect(parseGymSummary(' - ')).toBeNull();
    expect(parseGymSummary('')).toBeNull();
  });
});

describe('dateFromReflectionKey', () => {
  test('reads the session date off a reflection sort key', () => {
    expect(dateFromReflectionKey('2026-09-20#1b2c')).toBe('2026-09-20');
    expect(dateFromReflectionKey('garbage')).toBeNull();
    expect(dateFromReflectionKey(undefined)).toBeNull();
  });
});

describe('itemsToGymSummaries / attachGymSummaries', () => {
  test("puts each day's summary on that day's gym entry only", () => {
    const summaries = itemsToGymSummaries([
      { date: '2026-09-20', summary: 'Hit a squat PR' },
      { date: '2026-09-21', summary: 'No session logged' },
      { date: '2026-09-22' },
    ]);
    const entries = attachGymSummaries(
      [
        { date: '2026-09-20', type: 'gym', title: 'Workout: 18 sets' },
        { date: '2026-09-19', type: 'gym', title: 'Workout: 12 sets' },
      ],
      summaries,
    );
    expect(entries).toEqual([
      { date: '2026-09-20', type: 'gym', title: 'Workout: 18 sets', summary: 'Hit a squat PR' },
      { date: '2026-09-19', type: 'gym', title: 'Workout: 12 sets' },
    ]);
  });
});
