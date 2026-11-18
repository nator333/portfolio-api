import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { TOOL_ARGS, inputSchemaOf } from '../lambda/mcp-args';
import { TOOL_SPECS } from '../lambda/mcp-schema';
import { MAX_DAYS, MIN_DAYS } from '../lambda/weight-trend';

describe('one schema per tool', () => {
  it('should define arguments for exactly the advertised tools', () => {
    expect(Object.keys(TOOL_ARGS).sort()).toEqual(TOOL_SPECS.map((t) => t.name).sort());
  });

  it('should advertise the JSON Schema generated from the schema it enforces', () => {
    for (const tool of TOOL_SPECS) {
      expect([tool.name, tool.inputSchema]).toEqual([tool.name, inputSchemaOf(TOOL_ARGS[tool.name as keyof typeof TOOL_ARGS])]);
    }
  });

  it('should advertise closed objects with no per-tool $schema key', () => {
    for (const tool of TOOL_SPECS) {
      expect([tool.name, tool.inputSchema.type, tool.inputSchema.additionalProperties]).toEqual([tool.name, 'object', false]);
      expect(tool.inputSchema).not.toHaveProperty('$schema');
    }
  });

  it('should carry the constraints the hand-written schemas left out', () => {
    const props = (name: string) => TOOL_SPECS.find((t) => t.name === name)!.inputSchema.properties as Record<string, any>;
    // The rules that most often cost a failed call, now visible up front.
    expect(props('add_health_note').date.pattern).toBeDefined();
    expect(props('add_health_note').text.minLength).toBe(1);
    expect(props('add_health_note').tags.items.pattern).toBe('^[a-z0-9]+(?:[ -][a-z0-9]+)*$');
    expect(props('get_weight_trend').days).toMatchObject({ minimum: MIN_DAYS, maximum: MAX_DAYS });
    // And descriptions survive generation.
    expect(props('add_health_note').date.description).toMatch(/local day/);
    expect(props('replace_content').version.description).toMatch(/get_content/);
  });

  it('should type the plan in full for revise_workout_plan, without createdAt', () => {
    const plan = (TOOL_SPECS.find((t) => t.name === 'revise_workout_plan')!.inputSchema.properties as any).plan;
    expect(plan.properties.sessions.items.properties.exercises.items.properties.muscle.enum).toContain('Chest');
    expect(plan.properties).not.toHaveProperty('createdAt');
    expect(plan.required).not.toContain('changeNote');
  });
});

/**
 * The read handlers parse query strings by hand for the REST API. This layer
 * must name exactly the parameters each one reads: a missing one could never be
 * sent through MCP, and an extra one would be advertised and silently ignored.
 */
describe('read tools and the query parameters their handlers read', () => {
  const HANDLERS: Record<string, string> = {
    get_workout: 'get-workout',
    get_workout_sets: 'get-workout-sets',
    list_exercises: 'list-exercises',
    get_exercise_history: 'get-exercise-history',
    get_workout_plan: 'get-workout-plan',
    get_muscle_volume_status: 'get-muscle-volume-status',
    get_readiness: 'get-readiness',
    get_training_recommendation: 'get-training-recommendation',
    get_weight_trend: 'get-weight-trend',
  };

  it.each(Object.entries(HANDLERS))('%s should accept exactly what %s reads', (tool, file) => {
    const source = readFileSync(join(__dirname, '..', 'lambda', `${file}.ts`), 'utf8');
    const read = new Set(
      [...source.matchAll(/(?:queryStringParameters\?\.|\bparams\??\.)([a-zA-Z]+)/g)].map((m) => m[1]),
    );
    const accepted = Object.keys((TOOL_ARGS[tool as keyof typeof TOOL_ARGS] as z.ZodObject).shape);

    expect(read.size).toBeGreaterThan(0);
    expect(accepted.sort()).toEqual([...read].sort());
  });
});

describe('revise_workout_plan arguments', () => {
  const args = TOOL_ARGS.revise_workout_plan;
  const PLAN = {
    planId: 'upper-lower',
    version: 4,
    name: 'Upper/Lower',
    sessionsPerWeek: 1,
    rotation: ['upper-a'],
    bonusSessions: [],
    sessions: [
      {
        id: 'upper-a',
        name: 'Upper A',
        notes: '',
        exercises: [
          { order: 1, options: ['Bench Press'], muscle: 'Chest', sets: { min: 3, max: 3 }, reps: { min: 8, max: 10 }, rpe: null, notes: '' },
        ],
      },
    ],
    effectiveFrom: null,
    effectiveTo: null,
    notes: '',
  };

  it('should accept a whole plan, or edits', () => {
    expect(args.safeParse({ changeNote: 'x', plan: PLAN }).success).toBe(true);
    expect(args.safeParse({ changeNote: 'x', edits: [{ op: 'remove', session: 'upper-a', order: 1 }] }).success).toBe(true);
  });

  it('should require one of edits or plan', () => {
    expect(args.safeParse({ changeNote: 'x' }).success).toBe(false);
  });

  it('should refuse edit-only arguments beside a whole plan, naming each', () => {
    const result = args.safeParse({ changeNote: 'x', plan: PLAN, baseVersion: 3, name: 'Renamed' });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join('.')).sort()).toEqual(['baseVersion', 'name']);
  });
});
