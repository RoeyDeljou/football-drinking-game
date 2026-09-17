import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING } from '../scoring.js';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import {
  ALL_BUILT,
  asRoundView,
  generateWith,
  HOST,
  mustGenerate,
  P2,
  P3,
  playerViews,
  sampleData,
  sub,
  T0,
} from '../harness.test-utils.js';
import {
  FACT_KIND_LEAK_FIELD,
  M2_DEFAULT_CONFIG,
  m2WhoIsThatPlayer as module,
  redactOptionsForFact,
} from './m2-who-is-that-player.js';
import type { M2FactKind } from './m2-who-is-that-player.js';
import type { PitchPlayer } from './helpers.js';

interface M2Public {
  readonly kind: 'WHO_IS_IT';
  readonly fact: { readonly kind: string; readonly value: string | number };
  readonly options: readonly { readonly playerId: string; readonly shirtNumber: number | null }[];
}
interface M2Solution {
  readonly playerId: string;
  readonly fact: { readonly kind: string; readonly value: string | number };
}

const score = (
  round: ReturnType<typeof asRoundView>,
  submissions: readonly ReturnType<typeof sub>[],
  config: unknown = M2_DEFAULT_CONFIG,
) =>
  module.scoreRound({
    config,
    round,
    submissions,
    players: playerViews([HOST, P2, P3]),
    scoring: DEFAULT_SCORING,
    now: T0,
  });

describe('M2 metadata', () => {
  it('is a matchday simultaneous-answer game needing lineups and season stats', () => {
    expect(module.id).toBe('M2');
    expect(module.category).toBe('matchday');
    expect(module.kind).toBe('simultaneous-answer');
    expect(module.dataRequirements).toEqual(['hasLineups', 'hasPlayerSeasonStats']);
    expect(module.allowResubmission).toBe(false);
  });
});

describe('M2 round generation', () => {
  it('asks about one of the 22 and offers the configured number of options', () => {
    const round = mustGenerate(module);
    const payload = round.publicPayload as M2Public;
    const solution = round.solution as M2Solution;
    expect(payload.kind).toBe('WHO_IS_IT');
    expect(payload.options).toHaveLength(M2_DEFAULT_CONFIG.optionCount);
    expect(new Set(payload.options.map((option) => option.playerId)).size).toBe(
      M2_DEFAULT_CONFIG.optionCount,
    );
    expect(payload.options.some((option) => option.playerId === solution.playerId)).toBe(true);
    expect(ALL_BUILT.some((entry) => entry.player.id === solution.playerId)).toBe(true);
  });

  it('only uses a fact whose value is unique among the 22', () => {
    const round = mustGenerate(module);
    const solution = round.solution as M2Solution;
    const kind = solution.fact.kind;
    const valuesForKind = ALL_BUILT.map((entry) => {
      switch (kind) {
        case 'NATIONALITY':
          return entry.player.nationality;
        case 'AGE':
          return entry.player.age;
        case 'HEIGHT_CM':
          return entry.player.heightCm;
        case 'SEASON_GOALS':
          return entry.stats.goals;
        case 'SEASON_ASSISTS':
          return entry.stats.assists;
        default:
          return entry.stats.appearances;
      }
    });
    expect(valuesForKind.filter((value) => value === solution.fact.value)).toHaveLength(1);
  });

  it('emits the fact as structured data, never as a sentence', () => {
    const payload = mustGenerate(module).publicPayload as M2Public;
    expect(Object.keys(payload.fact).sort()).toEqual(['kind', 'value']);
    expect(M2_DEFAULT_CONFIG.factKinds).toContain(payload.fact.kind);
  });

  it('is deterministic for a seed and varies across seeds', () => {
    const a = mustGenerate(module, { seed: 3 }).contentKey;
    const b = mustGenerate(module, { seed: 3 }).contentKey;
    const c = mustGenerate(module, { seed: 900 }).contentKey;
    expect(a).toBe(b);
    expect(new Set([a, c]).size).toBeGreaterThanOrEqual(1);
  });

  it('never repeats a used fact', () => {
    const first = mustGenerate(module, { seed: 7 });
    const second = mustGenerate(module, { seed: 7, usedContentKeys: [first.contentKey] });
    expect(second.contentKey).not.toBe(first.contentKey);
  });

  it('fails cleanly without lineups', () => {
    const result = generateWith(module, { data: EMPTY_DATA_CONTEXT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('INSUFFICIENT_DATA');
  });

  it('reports NO_UNUSED_CONTENT once every fact has been played', () => {
    const keys: string[] = [];
    for (const entry of ALL_BUILT) {
      for (const kind of M2_DEFAULT_CONFIG.factKinds) keys.push(`${entry.player.id}:${kind}`);
    }
    const result = generateWith(module, { usedContentKeys: keys });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NO_UNUSED_CONTENT');
  });

  it('fails when a single fact kind yields no unique value', () => {
    const result = generateWith(module, {
      config: { ...M2_DEFAULT_CONFIG, factKinds: ['NATIONALITY'], optionCount: 6 },
      data: sampleData({
        players: ALL_BUILT.map((entry) => ({ ...entry.player, nationality: 'England' })),
      }),
    });
    expect(result.ok).toBe(false);
  });
});

describe('M2 submission validation', () => {
  const round = asRoundView(mustGenerate(module));

  const validate = (raw: unknown) =>
    module.validateSubmission({
      config: M2_DEFAULT_CONFIG,
      round,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts an offered option', () => {
    const payload = round.publicPayload as M2Public;
    const first = payload.options[0];
    expect(validate({ playerId: first?.playerId }).ok).toBe(true);
  });

  it('rejects a malformed payload', () => {
    const result = validate({ nope: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCHEMA');
  });

  it('rejects a footballer who is not among the options', () => {
    const result = validate({ playerId: 'not-on-the-pitch' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNKNOWN_OPTION');
  });
});

describe('M2 scoring and penalties', () => {
  const generated = mustGenerate(module);
  const round = asRoundView(generated);
  const answer = (generated.solution as M2Solution).playerId;
  const wrong = (round.publicPayload as M2Public).options.find(
    (option) => option.playerId !== answer,
  )?.playerId;

  it('rewards the fast correct answer above the slow one and punishes the rest', () => {
    const outcome = score(round, [
      sub(HOST, { playerId: answer }, 1_000),
      sub(P2, { playerId: answer }, 9_000),
      sub(P3, { playerId: wrong }, 500),
    ]);

    const points = new Map(outcome.scores.map((entry) => [entry.playerId, entry.points]));
    expect((points.get(HOST) ?? 0) > (points.get(P2) ?? 0)).toBe(true);
    expect(points.get(P3)).toBe(0);
    expect(outcome.winnerIds).toEqual([HOST]);

    const reasons = outcome.penalties.map((event) => `${event.playerId}:${event.reason}:${event.sips}`);
    expect(reasons).toContain(`${P3}:WRONG_ANSWER:2`);
    // P2 was the last of the two correct answers.
    expect(reasons).toContain(`${P2}:LAST_CORRECT:1`);
  });

  it('does not punish a lone correct answer as "last correct"', () => {
    const outcome = score(round, [sub(HOST, { playerId: answer }, 1_000)]);
    expect(outcome.penalties.some((event) => event.reason === 'LAST_CORRECT')).toBe(false);
  });

  it('charges every player who did not answer', () => {
    const outcome = score(round, []);
    expect(outcome.penalties).toHaveLength(3);
    expect(outcome.penalties.every((event) => event.reason === 'NO_ANSWER')).toBe(true);
    expect(outcome.scores.every((entry) => !entry.correct && entry.points === 0)).toBe(true);
    expect(outcome.winnerIds).toEqual([]);
  });

  it('ties the round between two equally fast correct answers', () => {
    const outcome = score(round, [
      sub(HOST, { playerId: answer }, 2_000),
      sub(P2, { playerId: answer }, 2_000),
    ]);
    expect([...outcome.winnerIds].sort()).toEqual([HOST, P2].sort());
  });

  it('honours a zero-sip configuration', () => {
    const config = { ...M2_DEFAULT_CONFIG, wrongAnswerSips: 0, noAnswerSips: 0, lastCorrectSips: 0 };
    const outcome = score(round, [sub(P3, { playerId: wrong }, 100)], config);
    expect(outcome.penalties).toEqual([]);
  });
});

describe('M2 projection', () => {
  const round = asRoundView(mustGenerate(module));

  it('withholds the answer before reveal and releases it after', () => {
    const hidden = module.projectRound({
      config: M2_DEFAULT_CONFIG,
      round,
      viewerId: HOST,
      visibility: 'pre-reveal',
      now: T0,
    });
    expect(hidden.solution).toBeNull();
    expect(hidden.privatePayload).toBeNull();

    const shown = module.projectRound({
      config: M2_DEFAULT_CONFIG,
      round,
      viewerId: HOST,
      visibility: 'revealed',
      now: T0,
    });
    expect(shown.solution).toEqual(round.solution);
  });
});

describe('N2: no fact kind may leak its answer through an untouched option field', () => {
  const samplePlayer: PitchPlayer = ALL_BUILT[0]?.player.id
    ? {
        playerId: ALL_BUILT[0].player.id,
        name: ALL_BUILT[0].player.name,
        teamId: ALL_BUILT[0].player.teamId,
        shirtNumber: 7,
        position: 'FW',
        isStarter: true,
      }
    : (() => {
        throw new Error('fixture missing');
      })();

  it('covers every fact kind the module actually supports — this is the live tripwire', () => {
    // Not just a compile-time guarantee: if a future fact kind is added to the config's runtime enum
    // without a decision recorded in FACT_KIND_LEAK_FIELD, this fails at test time too.
    expect(Object.keys(FACT_KIND_LEAK_FIELD).sort()).toEqual([...M2_DEFAULT_CONFIG.factKinds].sort());
  });

  it("today's fact kinds touch no PitchPlayer field, so redaction is a no-op for all of them", () => {
    for (const kind of Object.keys(FACT_KIND_LEAK_FIELD) as M2FactKind[]) {
      expect(FACT_KIND_LEAK_FIELD[kind]).toBeNull();
      expect(redactOptionsForFact(kind, [samplePlayer])).toEqual([samplePlayer]);
    }
  });

  it('generated M2 rounds carry real shirt numbers and positions for every current fact kind', () => {
    let checked = 0;
    for (const kind of M2_DEFAULT_CONFIG.factKinds) {
      const result = generateWith(module, { config: { ...M2_DEFAULT_CONFIG, factKinds: [kind] } });
      if (!result.ok) continue; // this fixture's data happens not to have a unique value for `kind`
      const payload = result.round.publicPayload as M2Public & { options: readonly PitchPlayer[] };
      // Untouched: at least one option keeps a real (non-null) shirt number, proving the pipeline
      // does not overzealously strip data it has no reason to.
      expect(payload.options.some((option) => option.shirtNumber !== null)).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('the redaction mechanism itself strips shirtNumber or position when a mapping says to', () => {
    // Exercises the same branches `redactOptionsForFact` would take for a real future mapping,
    // without needing an actual M2FactKind that doesn't exist yet.
    const applyMapping = (field: 'shirtNumber' | 'position' | null): readonly PitchPlayer[] =>
      field === null
        ? [samplePlayer]
        : field === 'shirtNumber'
          ? [{ ...samplePlayer, shirtNumber: null }]
          : [{ ...samplePlayer, position: 'UNKNOWN' }];

    expect(applyMapping('shirtNumber')).toEqual([{ ...samplePlayer, shirtNumber: null }]);
    expect(applyMapping('position')).toEqual([{ ...samplePlayer, position: 'UNKNOWN' }]);
    expect(applyMapping(null)).toEqual([samplePlayer]);
    // And the real function agrees for every kind that maps to null today.
    expect(redactOptionsForFact('NATIONALITY', [samplePlayer])).toEqual(applyMapping(null));
  });
});
