import type {
  DataQuality,
  FootballPlayerId,
  Player,
  PlayerPosition,
  PlayerProfile,
  PlayerSeasonStats,
  Team,
  TeamId,
  CompetitionId,
  SeasonId,
} from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RoomAction } from '../actions.js';
import type { RoundDataContext } from '../data.js';
import { checkModulePlayable, EMPTY_DATA_CONTEXT } from '../data.js';
import { EngineInvariantError } from '../errors.js';
import type { GameModuleId, PlayerId } from '../ids.js';
import { asGameModuleId, asSessionId } from '../ids.js';
import type { EngineGameModule, GeneratedRound, ModuleShape, RoundKind, RoundView } from '../module.js';
import { defineGameModule } from '../module.js';
import { projectFor, projectForHostScreen } from '../projection.js';
import { createSeededRng } from '../ports.js';
import type { EngineDeps } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import { DEFAULT_SCORING } from '../scoring.js';
import type { RoomState } from '../state.js';
import { activeSession, currentRound } from '../state.js';
import type { Harness } from '../harness.test-utils.js';
import {
  asRoundView,
  FULL_QUALITY,
  generateWith,
  HOST,
  makeHarness,
  mustGenerate,
  newRoom,
  P2,
  P3,
  playerViews,
  sampleData,
  scoreRng,
  sub,
  T0,
} from '../harness.test-utils.js';
import { G1_ID, g1GuessThePlayer } from './g1-guess-the-player.js';
import { G3_ID, g3CareerPath } from './g3-career-path.js';
import { G6_ID, g6TriviaRush } from './g6-trivia-rush.js';
import { ROLLED_PENALTY_META } from './helpers.js';
import { M1_ID, m1MatchMarkets } from './m1-match-markets.js';
import { M2_ID, m2WhoIsThatPlayer } from './m2-who-is-that-player.js';
import { M3_ID, m3ShirtNumber } from './m3-shirt-number.js';
import { M7_ID, m7MinuteSniper } from './m7-minute-sniper.js';
import { M10_ID, m10LineupRecall } from './m10-lineup-recall.js';
import {
  createMixedModule,
  G_MIX_ID,
  isMixable,
  M_MIX_ID,
  mixedContentKey,
  orderMixedCandidates,
  parseMixedContentKey,
  suppressesShirtNumbers,
  suppressOptionShirtNumbers,
} from './mixed.js';
import {
  createDefaultRegistry,
  createModuleRegistry,
  generalMixed,
  matchdayMixed,
  MIXED_ROTATION_EXCLUDED,
  STANDALONE_MODULES,
} from './registry.js';

/* ------------------------------ fixtures ------------------------------ */

const brand = <T extends string>(value: string): T => value as T;

interface Envelope {
  readonly kind: 'MIXED';
  readonly moduleId: GameModuleId;
  readonly inner: unknown;
}
interface SolutionEnvelope {
  readonly moduleId: GameModuleId;
  readonly inner: unknown;
}

const SUBS: Readonly<Record<string, EngineGameModule>> = {
  G1: g1GuessThePlayer,
  G3: g3CareerPath,
  G6: g6TriviaRush,
  M2: m2WhoIsThatPlayer,
  M3: m3ShirtNumber,
  M10: m10LineupRecall,
};

/**
 * The M2+M3 rotation, pinned explicitly. The default M-MIX rotation also contains M10; the
 * shirt-number and strict-alternation suites are about how M2 and M3 interact, so they configure
 * exactly those two, as a host can.
 */
const M2_M3 = { modules: [M2_ID, M3_ID] } as const;
const INNER_KIND: Readonly<Record<string, string>> = {
  G1: 'GUESS_PLAYER',
  G3: 'CAREER_PATH',
  G6: 'TRIVIA',
  M2: 'WHO_IS_IT',
  M3: 'SHIRT_NUMBER',
  M10: 'LINEUP_RECALL',
};
const subOf = (moduleId: GameModuleId): EngineGameModule => {
  const found = SUBS[moduleId];
  if (found === undefined) throw new Error(`no sub ${moduleId}`);
  return found;
};

const NATIONS = ['Spain', 'France', 'Brazil', 'England', 'Italy', 'Germany', 'Portugal', 'Argentina', 'Japan', 'Ghana'];
const POSITIONS: readonly PlayerPosition[] = ['GK', 'DF', 'MF', 'FW'];
const CLUBS = Array.from({ length: 30 }, (_, index) => `Club ${index + 1}`);
const TEAMS: readonly Team[] = Array.from({ length: 20 }, (_, index) => ({
  id: brand<TeamId>(`team-${index}`),
  name: `Team ${index}`,
  shortName: `T${index}`,
  crestUrl: null,
  country: 'Spain',
}));

/** A general dataset every general sub-game can play on for many rounds. */
const richGeneral = (size: number, seed: number, quality: DataQuality = FULL_QUALITY): RoundDataContext => {
  const rng = createSeededRng(seed);
  const profiles: PlayerProfile[] = [];
  const stats: PlayerSeasonStats[] = [];
  for (let index = 0; index < size; index += 1) {
    const team = TEAMS[index % TEAMS.length] ?? TEAMS[0];
    if (team === undefined) throw new Error('no teams');
    const player: Player = {
      id: brand<FootballPlayerId>(`gen-${seed}-${index}`),
      name: `General Player ${index}`,
      fullName: null,
      nationality: rng.pick(NATIONS) ?? 'Spain',
      dateOfBirth: null,
      age: rng.int(18, 36),
      heightCm: null,
      position: rng.pick(POSITIONS) ?? 'MF',
      shirtNumber: rng.int(1, 40),
      teamId: team.id,
      photoUrl: null,
      marketValueEur: null,
    };
    const clubs = rng.sample(CLUBS, rng.int(2, 5));
    profiles.push({
      player,
      career: clubs.map((teamName, step) => ({
        teamId: null,
        teamName,
        fromSeason: String(2010 + step * 2),
        toSeason: step === clubs.length - 1 ? null : String(2012 + step * 2),
        appearances: null,
        goals: null,
      })),
    });
    stats.push({
      playerId: player.id,
      teamId: team.id,
      competitionId: brand<CompetitionId>('comp'),
      season: brand<SeasonId>('2024'),
      appearances: rng.int(1, 38),
      minutesPlayed: 1_000,
      goals: rng.int(0, 30),
      assists: rng.int(0, 20),
      yellowCards: 0,
      redCards: 0,
      shots: null,
      shotsOnTarget: null,
      passAccuracy: null,
      tackles: null,
      rating: null,
    });
  }
  return {
    fixture: null,
    lineups: null,
    live: null,
    teams: TEAMS,
    players: profiles.map((profile) => profile.player),
    profiles,
    seasonStats: stats,
    quality,
  };
};

const GENERAL = richGeneral(200, 5);
const MATCHDAY = sampleData();
const quality = (overrides: Partial<DataQuality>): DataQuality => ({ ...FULL_QUALITY, ...overrides });

const SEEDS = Array.from({ length: 300 }, (_, index) => index * 7919 + 3);

const envelopeOf = (round: GeneratedRound<ModuleShape>): Envelope => round.publicPayload as Envelope;

/**
 * Generation-only session: one shared RNG, content keys accumulating, exactly like the reducer feeds
 * `generateRound` round after round.
 */
const generateSession = (
  module: EngineGameModule,
  seed: number,
  rounds: number,
  data: RoundDataContext,
  config: unknown = module.defaultConfig,
): readonly GeneratedRound<ModuleShape>[] => {
  const rng = createSeededRng(seed);
  const used: string[] = [];
  const out: GeneratedRound<ModuleShape>[] = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const result = module.generateRound({
      config,
      sessionId: asSessionId('s1'),
      roundIndex,
      players: playerViews([HOST, P2, P3]),
      data,
      rng,
      now: T0,
      usedContentKeys: used,
      defaultAnswerWindowMs: 20_000,
    });
    if (!result.ok) throw new Error(`round ${roundIndex} failed: ${result.reason} ${result.detail ?? ''}`);
    used.push(result.round.contentKey);
    out.push(result.round);
  }
  return out;
};

/** A fake mixable module for plugin-growth and capture tests. */
const fakeModule = (
  id: string,
  options: {
    readonly kind?: RoundKind;
    readonly minPlayers?: number;
    readonly live?: boolean;
    readonly resubmit?: boolean;
    readonly seen?: string[][];
  } = {},
): EngineGameModule => {
  const empty = z.object({}).strict();
  const answer = z.object({ n: z.number().int() }).strict();
  return defineGameModule<{
    config: z.infer<typeof empty>;
    publicPayload: { kind: string; key: string };
    privatePayload: null;
    solution: z.infer<typeof answer>;
    submission: z.infer<typeof answer>;
  }>({
    id: asGameModuleId(id),
    category: 'general',
    kind: options.kind ?? 'simultaneous-answer',
    dataRequirements: [],
    minPlayers: options.minPlayers ?? 1,
    maxPlayers: null,
    allowResubmission: options.resubmit ?? false,
    defaultConfig: {},
    configSchema: empty,
    publicPayloadSchema: z.object({ kind: z.string(), key: z.string() }).strict(),
    privatePayloadSchema: z.null(),
    solutionSchema: answer,
    submissionSchema: answer,
    generateRound: (ctx) => {
      options.seen?.push(ctx.usedContentKeys.slice());
      return {
        ok: true,
        round: {
          publicPayload: { kind: `FAKE_${id}`, key: `${id}-${ctx.roundIndex}` },
          privatePayloads: {},
          solution: { n: 1 },
          contentKey: `${id}-key-${ctx.roundIndex}`,
          answerWindowMs: 10_000,
          turnOrder: null,
        },
      };
    },
    validateSubmission: (ctx) => {
      const parsed = answer.safeParse(ctx.raw);
      return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, code: 'SCHEMA', detail: null };
    },
    scoreRound: () => ({ scores: [], winnerIds: [], penalties: [], summary: null }),
    projectRound: (ctx) => ({
      publicPayload: ctx.round.publicPayload,
      privatePayload: null,
      solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
    }),
    ...(options.live === true
      ? {
          observeEvents: (ctx) => ({
            publicPayload: ctx.round.publicPayload,
            solution: ctx.round.solution,
            privatePayloads: {},
            penalties: [],
            scoreDeltas: [],
            resolved: false,
          }),
        }
      : {}),
  });
};

/* ------------------------------ construction ------------------------------ */

describe('Mixed modules: construction and registry', { timeout: 60_000 }, () => {
  it('rotate over every mixable module of their category — and never M1', () => {
    expect(generalMixed.id).toBe(G_MIX_ID);
    expect(matchdayMixed.id).toBe(M_MIX_ID);
    expect(generalMixed.defaultConfig).toEqual({ modules: [G1_ID, G3_ID, G6_ID] });
    expect(matchdayMixed.defaultConfig).toEqual({ modules: [M2_ID, M3_ID, M10_ID] });
    expect(isMixable(m1MatchMarkets, 'matchday')).toBe(false);
    // M7 waits on live goals; M10 is one self-contained question and in the default rotation.
    expect(isMixable(m7MinuteSniper, 'matchday')).toBe(false);
    expect(isMixable(m10LineupRecall, 'matchday')).toBe(true);
    expect(MIXED_ROTATION_EXCLUDED).toEqual([]);
    expect(isMixable(m2WhoIsThatPlayer, 'matchday')).toBe(true);
    expect(isMixable(m2WhoIsThatPlayer, 'general')).toBe(false);
  });

  it('are ordinary simultaneous-answer modules that declare the timed-content hook', () => {
    for (const module of [generalMixed, matchdayMixed]) {
      expect(module.kind).toBe('simultaneous-answer');
      expect(module.allowResubmission).toBe(false);
      expect(module.supportsLiveEvents).toBe(false);
      expect(module.hasTimedContent).toBe(true);
      expect(module.minPlayers).toBe(1);
      expect(module.maxPlayers).toBeNull();
    }
    expect(generalMixed.category).toBe('general');
    expect(matchdayMixed.category).toBe('matchday');
  });

  it('declare the requirements every sub-game shares, plus "at least one sub-game" as alternatives', () => {
    expect(matchdayMixed.dataRequirements).toEqual(['hasLineups']);
    expect(matchdayMixed.dataRequirementsAnyOf).toEqual([
      ['hasLineups', 'hasPlayerSeasonStats'],
      ['hasLineups', 'hasShirtNumbers'],
      ['hasLineups'],
    ]);
    expect(generalMixed.dataRequirements).toEqual([]);
    expect(generalMixed.dataRequirementsAnyOf).toEqual([['hasCareerHistory'], ['hasCareerHistory'], ['hasPlayerSeasonStats']]);
  });

  it('are greyed out in the picker exactly when no sub-game could play', () => {
    const registry = createDefaultRegistry();
    const playable = (q: DataQuality | null, id: GameModuleId) =>
      registry.listPlayability(q).find((row) => row.module.id === id)?.playability;
    expect(playable(null, G_MIX_ID)?.playable).toBe(false);
    expect(playable(null, M_MIX_ID)?.playable).toBe(false);
    expect(playable(FULL_QUALITY, G_MIX_ID)?.playable).toBe(true);
    expect(playable(FULL_QUALITY, M_MIX_ID)?.playable).toBe(true);
    expect(playable(quality({ hasCareerHistory: false }), G_MIX_ID)?.playable).toBe(true);
    expect(playable(quality({ hasPlayerSeasonStats: false }), G_MIX_ID)?.playable).toBe(true);
    expect(playable(quality({ hasCareerHistory: false, hasPlayerSeasonStats: false }), G_MIX_ID)?.playable).toBe(false);
    const noLineups = playable(quality({ hasLineups: false }), M_MIX_ID);
    expect(noLineups?.playable).toBe(false);
    expect(noLineups?.missing).toContain('hasLineups');
    expect(playable(quality({ hasShirtNumbers: false }), M_MIX_ID)?.playable).toBe(true);
  });

  it('refuse to rotate over themselves or over nothing', () => {
    expect(() => createMixedModule({ id: G1_ID, category: 'general', pool: STANDALONE_MODULES })).toThrow(
      EngineInvariantError,
    );
    expect(() => createMixedModule({ id: M_MIX_ID, category: 'matchday', pool: [m1MatchMarkets] })).toThrow(
      EngineInvariantError,
    );
  });

  it('pick up a newly registered mixable game automatically, and skip unmixable shapes', () => {
    const pool = [
      ...STANDALONE_MODULES,
      fakeModule('G99'),
      fakeModule('G98_LIVE', { live: true }),
      fakeModule('G97_RESUBMIT', { resubmit: true }),
      fakeModule('G96_CARD', { kind: 'private-card' }),
      fakeModule('G95_TURNS', { kind: 'turn-based' }),
    ];
    const mixed = createMixedModule({ id: asGameModuleId('G-MIX-TEST'), category: 'general', pool });
    expect(mixed.defaultConfig).toEqual({ modules: [G1_ID, G3_ID, G6_ID, 'G99'] });
    const picked = new Set(SEEDS.slice(0, 80).map((seed) => envelopeOf(mustGenerate(mixed, { seed, data: GENERAL })).moduleId));
    expect(picked).toEqual(new Set([G1_ID, G3_ID, G6_ID, 'G99']));
  });
});

/* ------------------------------ config boundary ------------------------------ */

describe('Mixed config is validated at the boundary', () => {
  it('accepts the default and any non-empty subset of its own sub-games', () => {
    expect(generalMixed.parseConfig(generalMixed.defaultConfig).ok).toBe(true);
    expect(generalMixed.parseConfig({ modules: ['G3'] })).toEqual({ ok: true, config: { modules: ['G3'] } });
  });

  it('rejects M1, other categories, unknown ids, duplicates, an empty list and extra keys', () => {
    for (const bad of [
      { modules: ['M2', 'M1'] },
      { modules: ['G1'] },
      { modules: ['M9'] },
      { modules: ['M2', 'M2'] },
      { modules: [] },
      { modules: ['M2'], extra: true },
      {},
      null,
    ]) {
      expect(matchdayMixed.parseConfig(bad).ok).toBe(false);
    }
    const m1 = matchdayMixed.parseConfig({ modules: ['M1'] });
    expect(m1.ok).toBe(false);
    if (!m1.ok) expect(m1.issues.join()).toContain('M1 is not a mixable matchday game');
  });

  it('only ever serves the configured subset', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const round = mustGenerate(generalMixed, { seed, data: GENERAL, config: { modules: ['G3', 'G6'] } });
      expect([G3_ID, G6_ID]).toContain(envelopeOf(round).moduleId);
    }
  });
});

/* ------------------------------ content keys ------------------------------ */

describe('Mixed content keys', () => {
  it('round-trip, even when the inner key itself contains colons', () => {
    for (const inner of ['player-1', 'p1:NATIONALITY', 'MOST_GOALS:a|b', 'weird::inner', '', 'a#b']) {
      const key = mixedContentKey(M2_ID, inner);
      expect(key).toBe(`M2::${inner}`);
      expect(parseMixedContentKey(key)).toEqual({ moduleId: M2_ID, innerKey: inner });
    }
  });

  it('treats a key without a sub-game prefix as an inner key of unknown origin', () => {
    expect(parseMixedContentKey('player-1')).toEqual({ moduleId: null, innerKey: 'player-1' });
    expect(parseMixedContentKey('::x')).toEqual({ moduleId: null, innerKey: '::x' });
  });
});

/* ------------------------ shirt-number suppression helpers ------------------------ */

describe('Mixed shirt-number suppression helpers', () => {
  it('suppressesShirtNumbers: only a number-displaying game, only when a number-asking game is configured', () => {
    expect(suppressesShirtNumbers(M2_ID, [M2_ID, M3_ID])).toBe(true);
    expect(suppressesShirtNumbers(M2_ID, [M3_ID, M2_ID])).toBe(true);
    expect(suppressesShirtNumbers(M2_ID, [M2_ID])).toBe(false);
    expect(suppressesShirtNumbers(M2_ID, [])).toBe(false);
    expect(suppressesShirtNumbers(M3_ID, [M2_ID, M3_ID])).toBe(false);
    for (const general of [G1_ID, G3_ID, G6_ID]) {
      expect(suppressesShirtNumbers(general, [G1_ID, G3_ID, G6_ID])).toBe(false);
      expect(suppressesShirtNumbers(general, [M2_ID, M3_ID])).toBe(false);
    }
  });

  it('suppressOptionShirtNumbers nulls every option number, keeps everything else, is pure and idempotent', () => {
    const payload = {
      kind: 'WHO_IS_IT',
      fact: { kind: 'AGE', value: 21 },
      options: [
        { playerId: 'a', name: 'A', shirtNumber: 7, position: 'FW', isStarter: true },
        { playerId: 'b', name: 'B', shirtNumber: null, position: 'DF', isStarter: false },
        'not-an-option',
        { playerId: 'c', name: 'C' },
      ],
    };
    const once = suppressOptionShirtNumbers(payload);
    expect(once).toEqual({
      kind: 'WHO_IS_IT',
      fact: { kind: 'AGE', value: 21 },
      options: [
        { playerId: 'a', name: 'A', shirtNumber: null, position: 'FW', isStarter: true },
        { playerId: 'b', name: 'B', shirtNumber: null, position: 'DF', isStarter: false },
        'not-an-option',
        { playerId: 'c', name: 'C' },
      ],
    });
    expect(suppressOptionShirtNumbers(once)).toEqual(once);
    expect(payload.options[0]).toEqual({ playerId: 'a', name: 'A', shirtNumber: 7, position: 'FW', isStarter: true });
  });

  it('suppressOptionShirtNumbers returns payloads without an options list as they are', () => {
    for (const value of [null, 3, 'x', [], { kind: 'SHIRT_NUMBER', target: { shirtNumber: 9 } }, { options: 'x' }]) {
      expect(suppressOptionShirtNumbers(value)).toBe(value);
    }
  });

  it('a suppressed payload the sub-game’s own schema rejects fails loudly, never silently served', () => {
    // A stand-in "M2" whose option schema does not allow a null number: fail loudly, never serve it.
    const empty = z.object({}).strict();
    const answer = z.object({ n: z.number().int() }).strict();
    const strictPayload = z
      .object({ options: z.array(z.object({ playerId: z.string(), shirtNumber: z.number().int() }).strict()) })
      .strict();
    const strictM2 = defineGameModule<{
      config: z.infer<typeof empty>;
      publicPayload: z.infer<typeof strictPayload>;
      privatePayload: null;
      solution: z.infer<typeof answer>;
      submission: z.infer<typeof answer>;
    }>({
      id: M2_ID,
      category: 'matchday',
      kind: 'simultaneous-answer',
      dataRequirements: [],
      minPlayers: 1,
      maxPlayers: null,
      allowResubmission: false,
      defaultConfig: {},
      configSchema: empty,
      publicPayloadSchema: strictPayload,
      privatePayloadSchema: z.null(),
      solutionSchema: answer,
      submissionSchema: answer,
      generateRound: () => ({
        ok: true,
        round: {
          publicPayload: { options: [{ playerId: 'a', shirtNumber: 7 }] },
          privatePayloads: {},
          solution: { n: 1 },
          contentKey: 'a',
          answerWindowMs: 10_000,
          turnOrder: null,
        },
      }),
      validateSubmission: () => ({ ok: false, code: 'SCHEMA', detail: null }),
      scoreRound: () => ({ scores: [], winnerIds: [], penalties: [], summary: null }),
      projectRound: (ctx) => ({ publicPayload: ctx.round.publicPayload, privatePayload: null, solution: null }),
    });
    const mixed = createMixedModule({ id: asGameModuleId('M-MIX-STRICT'), category: 'matchday', pool: [strictM2, m3ShirtNumber] });
    // M3 configured (so numbers must go) but unplayable this round (so the stand-in is picked): the
    // stand-in's own schema rejects the suppressed payload the moment anything reads the round.
    const noShirtFlag = { ...MATCHDAY, quality: quality({ hasShirtNumbers: false }) };
    const project = (config: unknown, round: GeneratedRound<ModuleShape>) => () =>
      mixed.projectRound({ config, round: asRoundView(round), viewerId: HOST, visibility: 'pre-reveal', now: T0 });
    const both = { modules: [M2_ID, M3_ID] };
    expect(project(both, mustGenerate(mixed, { data: noShirtFlag, config: both }))).toThrow(EngineInvariantError);
    // Without M3 in the rotation there is nothing to hide, and the stand-in plays normally.
    const alone = { modules: [M2_ID] };
    expect(project(alone, mustGenerate(mixed, { data: noShirtFlag, config: alone }))).not.toThrow();
  });
});

/* ------------------------------ candidate order ------------------------------ */

describe('orderMixedCandidates (shuffle-bag rotation)', () => {
  const A = { id: asGameModuleId('A') };
  const B = { id: asGameModuleId('B') };
  const C = { id: asGameModuleId('C') };

  it('returns a permutation, and with no history each candidate leads about equally often', () => {
    const leads = new Map<string, number>();
    for (const seed of SEEDS) {
      const order = orderMixedCandidates([A, B, C], [], createSeededRng(seed));
      expect([...order].map((entry) => entry.id).sort()).toEqual(['A', 'B', 'C']);
      const first = order[0]?.id ?? '';
      leads.set(first, (leads.get(first) ?? 0) + 1);
    }
    for (const id of ['A', 'B', 'C']) expect(leads.get(id) ?? 0).toBeGreaterThan(SEEDS.length * 0.25);
  });

  it('never leads with the previous round’s game when another exists, but still offers it last', () => {
    for (const seed of SEEDS) {
      const order = orderMixedCandidates([A, B, C], [A.id, B.id, C.id, B.id], createSeededRng(seed));
      expect(order[0]?.id).not.toBe('B');
      expect(order.at(-1)?.id).toBe('B');
    }
    expect(orderMixedCandidates([B], [B.id], createSeededRng(1)).map((entry) => entry.id)).toEqual(['B']);
  });

  it('plays the least-played game first', () => {
    for (const seed of SEEDS) {
      const order = orderMixedCandidates([A, B, C], [A.id, B.id, A.id, B.id, C.id, A.id], createSeededRng(seed));
      // Previous was A (and A is most played); B has 2, C has 1 → C, B, A.
      expect(order.map((entry) => entry.id)).toEqual(['C', 'B', 'A']);
    }
  });

  it('is deterministic for an RNG state and consumes randomness only through it', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const a = createSeededRng(seed);
      const b = createSeededRng(seed);
      expect(orderMixedCandidates([A, B, C], [A.id], a)).toEqual(orderMixedCandidates([A, B, C], [A.id], b));
      expect(a.state()).toBe(b.state());
    }
  });
});

/* ------------------------------ generation ------------------------------ */

describe('Mixed generation', { timeout: 60_000 }, () => {
  const cases = [
    { label: 'general', module: generalMixed, data: GENERAL, subs: [G1_ID, G3_ID, G6_ID] },
    { label: 'matchday', module: matchdayMixed, data: MATCHDAY, subs: [M2_ID, M3_ID, M10_ID] },
  ] as const;

  for (const { label, module, data, subs } of cases) {
    it(`${label}: wraps the sub-game's own round in the envelope, consistently`, () => {
      for (const seed of SEEDS.slice(0, 150)) {
        const round = mustGenerate(module, { seed, data });
        const envelope = envelopeOf(round);
        const solution = round.solution as SolutionEnvelope;
        expect(envelope.kind).toBe('MIXED');
        expect(subs).toContain(envelope.moduleId);
        expect(solution.moduleId).toBe(envelope.moduleId);
        expect((envelope.inner as { kind: string }).kind).toBe(INNER_KIND[envelope.moduleId]);
        expect(parseMixedContentKey(round.contentKey).moduleId).toBe(envelope.moduleId);
        expect(round.turnOrder).toBeNull();
      }
    });

    it(`${label}: is byte-identical for the same RNG state, and leaves the same RNG state`, () => {
      for (const seed of SEEDS) {
        const ctx = {
          config: module.defaultConfig,
          sessionId: asSessionId('s1'),
          roundIndex: 0,
          players: playerViews([HOST, P2]),
          data,
          now: T0,
          usedContentKeys: [],
          defaultAnswerWindowMs: 20_000,
        };
        const rngA = createSeededRng(seed);
        const rngB = createSeededRng(seed);
        const a = module.generateRound({ ...ctx, rng: rngA });
        const b = module.generateRound({ ...ctx, rng: rngB });
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(rngB.state()).toBe(rngA.state());
      }
    });

    it(`${label}: picks every sub-game a fair share of first rounds across seeds`, () => {
      const counts = new Map<string, number>();
      for (const seed of SEEDS) {
        const id = envelopeOf(mustGenerate(module, { seed, data })).moduleId;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const id of subs) expect(counts.get(id) ?? 0).toBeGreaterThan((SEEDS.length / subs.length) * 0.7);
    });
  }

  it('delegates exactly: restricted to one sub-game it is that sub-game, same RNG and all', () => {
    const cases = [
      { module: generalMixed, data: GENERAL, ids: [G1_ID, G3_ID, G6_ID] },
      { module: matchdayMixed, data: MATCHDAY, ids: [M2_ID, M3_ID, M10_ID] },
    ];
    for (const { module, data, ids } of cases) {
      for (const moduleId of ids) {
        const inner = subOf(moduleId);
        for (const seed of SEEDS.slice(0, 40)) {
          const base = {
            sessionId: asSessionId('s1'),
            roundIndex: 2,
            players: playerViews([HOST, P2]),
            data,
            now: T0,
            usedContentKeys: [],
            defaultAnswerWindowMs: 20_000,
          };
          const rngMixed = createSeededRng(seed);
          const rngDirect = createSeededRng(seed);
          const mixed = module.generateRound({ ...base, config: { modules: [moduleId] }, rng: rngMixed });
          const direct = inner.generateRound({ ...base, config: inner.defaultConfig, rng: rngDirect });
          if (!mixed.ok || !direct.ok) throw new Error('generation failed');
          expect(mixed.round.publicPayload).toEqual({ kind: 'MIXED', moduleId, inner: direct.round.publicPayload });
          expect(mixed.round.solution).toEqual({ moduleId, inner: direct.round.solution });
          expect(mixed.round.contentKey).toBe(mixedContentKey(moduleId, direct.round.contentKey));
          expect(parseMixedContentKey(mixed.round.contentKey).innerKey).toBe(direct.round.contentKey);
          expect(mixed.round.answerWindowMs).toBe(direct.round.answerWindowMs);
          expect(mixed.round.privatePayloads).toEqual(direct.round.privatePayloads);
          expect(rngMixed.state()).toBe(rngDirect.state());
        }
      }
    }
  });

  it('delegates M2 exactly inside an M2+M3 rotation, except that every option’s shirt number is null', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const base = {
        sessionId: asSessionId('s1'),
        roundIndex: 0,
        players: playerViews([HOST, P2]),
        data: MATCHDAY,
        now: T0,
        usedContentKeys: [],
        defaultAnswerWindowMs: 20_000,
      };
      const rngMixed = createSeededRng(seed);
      const mixed = matchdayMixed.generateRound({ ...base, config: M2_M3, rng: rngMixed });
      if (!mixed.ok) throw new Error('generation failed');
      if (envelopeOf(mixed.round).moduleId !== M2_ID) continue;
      // Replay the same RNG draws: Mixed's candidate shuffle, then M2's own generation.
      const rngDirect = createSeededRng(seed);
      rngDirect.shuffle([M2_ID, M3_ID]);
      const direct = m2WhoIsThatPlayer.generateRound({ ...base, config: m2WhoIsThatPlayer.defaultConfig, rng: rngDirect });
      if (!direct.ok) throw new Error('generation failed');
      const directPayload = direct.round.publicPayload as { options: { shirtNumber: number | null }[] };
      // The real payload does carry numbers — so there is something to hide.
      expect(directPayload.options.some((option) => option.shirtNumber !== null)).toBe(true);
      expect(envelopeOf(mixed.round).inner).toEqual({
        ...directPayload,
        options: directPayload.options.map((option) => ({ ...option, shirtNumber: null })),
      });
      // Still a valid M2 payload: M2's own hooks (which re-parse it with M2's schema) accept it.
      const innerView = { ...asRoundView(mixed.round), publicPayload: envelopeOf(mixed.round).inner, solution: direct.round.solution };
      expect(
        m2WhoIsThatPlayer.projectRound({ config: m2WhoIsThatPlayer.defaultConfig, round: innerView, viewerId: HOST, visibility: 'revealed', now: T0 })
          .publicPayload,
      ).toEqual(envelopeOf(mixed.round).inner);
      expect(mixed.round.solution).toEqual({ moduleId: M2_ID, inner: direct.round.solution });
      expect(mixed.round.contentKey).toBe(mixedContentKey(M2_ID, direct.round.contentKey));
      expect(rngMixed.state()).toBe(rngDirect.state());
      checked += 1;
    }
    expect(checked).toBeGreaterThan(SEEDS.length * 0.3);
  });
});

/* ------------------------ per-round playability + retry ------------------------ */

describe('Mixed excludes sub-games the data cannot serve, per round, without failing the session', { timeout: 60_000 }, () => {
  const pickFor = (module: EngineGameModule, data: RoundDataContext, seed: number): GameModuleId =>
    envelopeOf(mustGenerate(module, { seed, data })).moduleId;

  it('skips sub-games whose quality flags are missing', () => {
    for (const seed of SEEDS) {
      expect(pickFor(generalMixed, { ...GENERAL, quality: quality({ hasCareerHistory: false }) }, seed)).toBe(G6_ID);
      expect(pickFor(generalMixed, { ...GENERAL, quality: quality({ hasPlayerSeasonStats: false }) }, seed)).not.toBe(G6_ID);
      expect(pickFor(matchdayMixed, { ...MATCHDAY, quality: quality({ hasShirtNumbers: false }) }, seed)).not.toBe(M3_ID);
      expect(pickFor(matchdayMixed, { ...MATCHDAY, quality: quality({ hasPlayerSeasonStats: false }) }, seed)).not.toBe(M2_ID);
      expect(pickFor(matchdayMixed, { ...MATCHDAY, quality: quality({ hasShirtNumbers: false, hasPlayerSeasonStats: false }) }, seed)).toBe(M10_ID);
    }
  });

  it('fails cleanly with INSUFFICIENT_DATA when no sub-game is playable at all', () => {
    for (const module of [generalMixed, matchdayMixed]) {
      const result = generateWith(module, { data: EMPTY_DATA_CONTEXT });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('INSUFFICIENT_DATA');
        expect(result.detail).toContain('UNKNOWN_DATA_QUALITY');
      }
    }
  });

  it('retries the next candidate when the preferred sub-game fails on content the flags cannot see', () => {
    // Quality claims career history, but there are no profiles: G1 and G3 fail inside generateRound.
    const noCareers: RoundDataContext = { ...GENERAL, profiles: [] };
    for (const seed of SEEDS) {
      const rng = createSeededRng(seed);
      const result = generalMixed.generateRound({
        config: generalMixed.defaultConfig,
        sessionId: asSessionId('s1'),
        roundIndex: 0,
        players: playerViews([HOST, P2]),
        data: noCareers,
        rng,
        now: T0,
        usedContentKeys: [],
        defaultAnswerWindowMs: 20_000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(envelopeOf(result.round).moduleId).toBe(G6_ID);
    }
    // …and matchday: shirt numbers flagged but absent, so M3 fails and M2 serves every round.
    const noShirts: RoundDataContext = {
      ...MATCHDAY,
      lineups:
        MATCHDAY.lineups === null
          ? null
          : {
              ...MATCHDAY.lineups,
              home: {
                ...MATCHDAY.lineups.home,
                startingXI: MATCHDAY.lineups.home.startingXI.map((p) => ({ ...p, shirtNumber: null })),
              },
              away: {
                ...MATCHDAY.lineups.away,
                startingXI: MATCHDAY.lineups.away.startingXI.map((p) => ({ ...p, shirtNumber: null })),
              },
            },
    };
    for (const seed of SEEDS) expect(pickFor(matchdayMixed, noShirts, seed)).not.toBe(M3_ID);
  });

  it('reports NO_UNUSED_CONTENT only when every candidate is used up, else INSUFFICIENT_DATA', () => {
    const allUsed = GENERAL.profiles.map((profile) => mixedContentKey(G1_ID, profile.player.id));
    // G6 cannot build anything either (no stats, no teams, no nationalities) but players exist.
    const g6Starved: RoundDataContext = {
      ...GENERAL,
      seasonStats: [],
      teams: [],
      players: GENERAL.players.map((player) => ({ ...player, nationality: null })),
    };
    const usedUp = generateWith(generalMixed, { data: g6Starved, usedContentKeys: allUsed });
    expect(usedUp.ok).toBe(false);
    if (!usedUp.ok) {
      expect(usedUp.reason).toBe('NO_UNUSED_CONTENT');
      for (const id of [G1_ID, G3_ID, G6_ID]) expect(usedUp.detail).toContain(`${id}=NO_UNUSED_CONTENT`);
    }

    const g6Empty: RoundDataContext = { ...g6Starved, players: [] };
    const mixedReasons = generateWith(generalMixed, { data: g6Empty, usedContentKeys: allUsed });
    expect(mixedReasons.ok).toBe(false);
    if (!mixedReasons.ok) {
      expect(mixedReasons.reason).toBe('INSUFFICIENT_DATA');
      expect(mixedReasons.detail).toContain(`${G6_ID}=INSUFFICIENT_DATA`);
    }
  });

  it('skips a sub-game the room has too few players for', () => {
    const pool = [fakeModule('G90', { minPlayers: 3 }), fakeModule('G91')];
    const mixed = createMixedModule({ id: asGameModuleId('G-MIX-P'), category: 'general', pool });
    expect(mixed.minPlayers).toBe(1);
    for (const seed of SEEDS.slice(0, 60)) {
      expect(envelopeOf(mustGenerate(mixed, { seed, players: [HOST, P2] })).moduleId).toBe('G91');
    }
    const three = new Set(
      SEEDS.slice(0, 60).map((seed) => envelopeOf(mustGenerate(mixed, { seed, players: [HOST, P2, P3] })).moduleId),
    );
    expect(three).toEqual(new Set(['G90', 'G91']));
  });

  it('keeps a session alive when a sub-game becomes unplayable mid-session', () => {
    const rng = createSeededRng(77);
    const used: string[] = [];
    const picks: GameModuleId[] = [];
    for (let roundIndex = 0; roundIndex < 9; roundIndex += 1) {
      // Career data "drops out" for rounds 3-5.
      const data = roundIndex >= 3 && roundIndex <= 5 ? { ...GENERAL, quality: quality({ hasCareerHistory: false }) } : GENERAL;
      const result = generalMixed.generateRound({
        config: generalMixed.defaultConfig,
        sessionId: asSessionId('s1'),
        roundIndex,
        players: playerViews([HOST, P2]),
        data,
        rng,
        now: T0,
        usedContentKeys: used,
        defaultAnswerWindowMs: 20_000,
      });
      if (!result.ok) throw new Error(result.reason);
      used.push(result.round.contentKey);
      picks.push(envelopeOf(result.round).moduleId);
    }
    expect(picks.slice(3, 6)).toEqual([G6_ID, G6_ID, G6_ID]);
    expect(new Set(picks)).toEqual(new Set([G1_ID, G3_ID, G6_ID]));
  });
});

/* ------------------------------ rotation + dedup ------------------------------ */

describe('Mixed sessions rotate and never repeat content', { timeout: 60_000 }, () => {
  it('general: every block of three rounds plays G1, G3 and G6 once each, never back-to-back', () => {
    const sequences = new Set<string>();
    for (const seed of SEEDS.slice(0, 150)) {
      const ids = generateSession(generalMixed, seed, 9, GENERAL).map((round) => envelopeOf(round).moduleId);
      for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
      for (let block = 0; block < 9; block += 3) {
        expect([...ids.slice(block, block + 3)].sort()).toEqual([G1_ID, G3_ID, G6_ID].sort());
      }
      sequences.add(ids.join(','));
    }
    // Random, not a fixed cycle: many distinct orders across seeds.
    expect(sequences.size).toBeGreaterThan(20);
  });

  it('matchday: alternates M2 and M3, starting on either', () => {
    const starts = new Set<string>();
    for (const seed of SEEDS.slice(0, 150)) {
      const ids = generateSession(matchdayMixed, seed, 6, MATCHDAY, M2_M3).map((round) => envelopeOf(round).moduleId);
      for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
      starts.add(ids[0] ?? '');
    }
    expect(starts).toEqual(new Set([M2_ID, M3_ID]));
  });

  it('never selects M1 in a matchday rotation, across many seeds and long sessions, even with live data', () => {
    const live = { ...MATCHDAY, quality: FULL_QUALITY };
    for (const seed of SEEDS) {
      for (const round of generateSession(matchdayMixed, seed, 8, live)) {
        expect([M2_ID, M3_ID, M10_ID]).toContain(envelopeOf(round).moduleId);
        expect(envelopeOf(round).moduleId).not.toBe(M1_ID);
        expect(envelopeOf(round).moduleId).not.toBe(M7_ID);
      }
    }
  });

  it('default rotation: M10 plays both XIs early, never back-to-back, and M2/M3 carry the session on', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      for (const length of [10, 30]) {
        const rounds = generateSession(matchdayMixed, seed, length, MATCHDAY);
        expect(rounds).toHaveLength(length); // never exhausts early: generateSession throws on a failed round
        const ids = rounds.map((round) => envelopeOf(round).moduleId);
        for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
        expect(ids.filter((id) => id === M10_ID)).toHaveLength(2);
        // Shuffle-bag: every game plays once in the first three rounds.
        expect([...ids.slice(0, 3)].sort()).toEqual([M10_ID, M2_ID, M3_ID].sort());
        const xis = rounds.filter((round) => envelopeOf(round).moduleId === M10_ID);
        expect(new Set(xis.map((round) => (envelopeOf(round).inner as { side: string }).side))).toEqual(new Set(['home', 'away']));
        for (const round of xis) expect(JSON.stringify(round.solution)).not.toContain('shirtNumber');
      }
    }
  });

  it('projected (unconfirmed) lineups: M-MIX is still playable and simply skips M10 every round', () => {
    const projected: RoundDataContext = {
      ...MATCHDAY,
      lineups: MATCHDAY.lineups === null ? null : { ...MATCHDAY.lineups, confirmed: false },
    };
    expect(checkModulePlayable(matchdayMixed, projected.quality).playable).toBe(true);
    for (const seed of SEEDS.slice(0, 60)) {
      const ids = generateSession(matchdayMixed, seed, 12, projected).map((round) => envelopeOf(round).moduleId);
      expect(ids).not.toContain(M10_ID);
      for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
    }
    // …and through the reducer, from START_SESSION to the end of the session.
    const room = playMixedSession(M_MIX_ID, projected, 11, 8, false);
    const played = activeSession(room)?.rounds ?? [];
    expect(played).toHaveLength(8);
    expect(played.map((round) => (round.publicPayload as Envelope).moduleId)).not.toContain(M10_ID);
    expect(activeSession(room)?.finishedAt).not.toBeNull();
  });

  it('gives each sub-game the inner keys of every earlier round, from every sub-game', () => {
    const seen: string[][] = [];
    const pool = [fakeModule('G80', { seen }), fakeModule('G81', { seen })];
    const mixed = createMixedModule({ id: asGameModuleId('G-MIX-K'), category: 'general', pool });
    const rounds = generateSession(mixed, 5, 4, GENERAL);
    const innerKeys = rounds.map((round) => parseMixedContentKey(round.contentKey).innerKey);
    expect(seen).toEqual([[], innerKeys.slice(0, 1), innerKeys.slice(0, 2), innerKeys.slice(0, 3)]);
    expect(rounds.map((round) => parseMixedContentKey(round.contentKey).moduleId)).toEqual(
      rounds.map((round) => envelopeOf(round).moduleId),
    );
  });

  it('never makes the same footballer the answer twice across G1 and G3, and never repeats a content key', () => {
    const small = richGeneral(30, 9);
    for (const seed of SEEDS.slice(0, 100)) {
      const rounds = generateSession(generalMixed, seed, 15, small);
      const keys = rounds.map((round) => round.contentKey);
      expect(new Set(keys).size).toBe(keys.length);
      const answers = rounds
        .filter((round) => [G1_ID, G3_ID].includes(envelopeOf(round).moduleId))
        .map((round) => ((round.solution as SolutionEnvelope).inner as { playerId: string }).playerId);
      expect(new Set(answers).size).toBe(answers.length);
    }
  });
});

/* ------------------------------ delegated hooks ------------------------------ */

/** First seed whose opening general round is `moduleId`. */
const seedFor = (module: EngineGameModule, data: RoundDataContext, moduleId: GameModuleId): number => {
  const seed = SEEDS.find((candidate) => envelopeOf(mustGenerate(module, { seed: candidate, data })).moduleId === moduleId);
  if (seed === undefined) throw new Error(`no seed opens on ${moduleId}`);
  return seed;
};

const roundOf = (module: EngineGameModule, data: RoundDataContext, moduleId: GameModuleId) => {
  const generated = mustGenerate(module, { seed: seedFor(module, data, moduleId), data });
  const view = asRoundView(generated);
  const envelope = envelopeOf(generated);
  const innerView: RoundView<ModuleShape> = {
    ...view,
    publicPayload: envelope.inner,
    solution: (generated.solution as SolutionEnvelope).inner,
  };
  return { generated, view, innerView, inner: subOf(moduleId), config: module.defaultConfig };
};

const ALL_CASES = [
  { module: generalMixed, data: GENERAL, id: G1_ID },
  { module: generalMixed, data: GENERAL, id: G3_ID },
  { module: generalMixed, data: GENERAL, id: G6_ID },
  { module: matchdayMixed, data: MATCHDAY, id: M2_ID },
  { module: matchdayMixed, data: MATCHDAY, id: M3_ID },
] as const;

describe('Mixed validation delegates to the picked sub-game', () => {
  const validate = (module: EngineGameModule, view: RoundView<ModuleShape>, raw: unknown) =>
    module.validateSubmission({
      config: module.defaultConfig,
      round: view,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts exactly what the sub-game accepts, unwrapped, and rejects with the sub-game’s own codes', () => {
    const g1 = roundOf(generalMixed, GENERAL, G1_ID);
    const option = (g1.innerView.publicPayload as { options: { playerId: string }[] }).options[0]?.playerId;
    expect(validate(generalMixed, g1.view, { playerId: option })).toEqual({ ok: true, payload: { playerId: option } });
    expect(validate(generalMixed, g1.view, { playerId: 'nobody' })).toMatchObject({ ok: false, code: 'UNKNOWN_OPTION' });
    expect(validate(generalMixed, g1.view, { playerId: 1 })).toMatchObject({ ok: false, code: 'SCHEMA' });
    // An envelope is not an answer: players send the sub-game's own payload.
    expect(validate(generalMixed, g1.view, { moduleId: G1_ID, inner: { playerId: option } })).toMatchObject({
      ok: false,
      code: 'SCHEMA',
    });

    const g6 = roundOf(generalMixed, GENERAL, G6_ID);
    expect(validate(generalMixed, g6.view, { playerId: option })).toMatchObject({ ok: false, code: 'SCHEMA' });

    const m3 = roundOf(matchdayMixed, MATCHDAY, M3_ID);
    expect(validate(matchdayMixed, m3.view, { guess: 7 })).toEqual({ ok: true, payload: { guess: 7 } });
    expect(validate(matchdayMixed, m3.view, { guess: 150 })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validate(matchdayMixed, m3.view, { guess: 'x' })).toMatchObject({ ok: false, code: 'SCHEMA' });
  });

  it('agrees with the sub-game on every case', () => {
    for (const { module, data, id } of ALL_CASES) {
      const { view, innerView, inner } = roundOf(module, data, id);
      const payload = innerView.publicPayload as { options?: { playerId?: string; id?: string }[] };
      const raws: unknown[] = [
        null,
        {},
        { guess: 10 },
        { optionId: payload.options?.[0]?.id ?? 'x' },
        { playerId: payload.options?.[0]?.playerId ?? 'x' },
      ];
      for (const raw of raws) {
        expect(validate(module, view, raw)).toEqual(
          inner.validateSubmission({
            config: inner.defaultConfig,
            round: innerView,
            playerId: HOST,
            raw,
            submittedAt: T0,
            elapsedMs: 0,
            alreadySubmitted: false,
          }),
        );
      }
    }
  });
});

describe('Mixed scoring delegates and only re-wraps the summary', () => {
  it('produces the sub-game’s exact scores, winners and (rolled) penalties, drawing the same randomness', () => {
    for (const { module, data, id } of ALL_CASES) {
      const { view, innerView, inner } = roundOf(module, data, id);
      const payload = innerView.publicPayload as { options?: { playerId?: string; id?: string }[] };
      const answerFor = (index: number): unknown =>
        id === M3_ID
          ? { guess: 5 + index }
          : id === G6_ID
            ? { optionId: payload.options?.[index]?.id }
            : { playerId: payload.options?.[index]?.playerId };
      const submissions = [sub(HOST, answerFor(0), 1_500), sub(P2, answerFor(1), 9_000)];
      const rngMixed = scoreRng(31);
      const rngDirect = scoreRng(31);
      const players = playerViews([HOST, P2, P3]);
      const mixed = module.scoreRound({
        config: module.defaultConfig,
        round: view,
        submissions,
        players,
        scoring: DEFAULT_SCORING,
        now: T0,
        rng: rngMixed,
      });
      const direct = inner.scoreRound({
        config: inner.defaultConfig,
        round: innerView,
        submissions,
        players,
        scoring: DEFAULT_SCORING,
        now: T0,
        rng: rngDirect,
      });
      expect(mixed.scores).toEqual(direct.scores);
      expect(mixed.winnerIds).toEqual(direct.winnerIds);
      expect(mixed.penalties).toEqual(direct.penalties);
      expect(mixed.summary).toEqual({ moduleId: id, inner: direct.summary });
      expect(rngMixed.state()).toBe(rngDirect.state());
      // P3 never answered: a rolled NO_ANSWER, the established convention.
      expect(mixed.penalties.find((event) => event.playerId === P3)).toMatchObject({
        reason: 'NO_ANSWER',
        meta: ROLLED_PENALTY_META,
      });
    }
  });
});

describe('Mixed projection leaks nothing the sub-game would not', () => {
  it('pre-reveal: the envelope around the sub-game’s own projection, and no solution', () => {
    for (const { module, data, id } of ALL_CASES) {
      const { view, innerView, inner } = roundOf(module, data, id);
      for (const now of [T0, T0 + 8_500, T0 + 30_000]) {
        for (const viewerId of [HOST, null] as const) {
          const mixed = module.projectRound({ config: module.defaultConfig, round: view, viewerId, visibility: 'pre-reveal', now });
          const direct = inner.projectRound({
            config: inner.defaultConfig,
            round: innerView,
            viewerId,
            visibility: 'pre-reveal',
            now,
          });
          expect(mixed.publicPayload).toEqual({ kind: 'MIXED', moduleId: id, inner: direct.publicPayload });
          expect(mixed.privatePayload).toEqual(direct.privatePayload);
          expect(mixed.solution).toBeNull();
        }
      }
      const revealed = module.projectRound({
        config: module.defaultConfig,
        round: view,
        viewerId: HOST,
        visibility: 'revealed',
        now: T0,
      });
      expect(revealed.solution).toEqual({ moduleId: id, inner: innerView.solution });
    }
  });

  it('refuses a corrupted round rather than guessing which game it belongs to', () => {
    const { view } = roundOf(generalMixed, GENERAL, G1_ID);
    const mismatched = { ...view, solution: { ...(view.solution as SolutionEnvelope), moduleId: G6_ID } };
    const unknown = { ...view, publicPayload: { ...(view.publicPayload as Envelope), moduleId: 'M2' } };
    for (const round of [mismatched, unknown]) {
      expect(() =>
        generalMixed.projectRound({ config: generalMixed.defaultConfig, round, viewerId: HOST, visibility: 'pre-reveal', now: T0 }),
      ).toThrow(EngineInvariantError);
    }
  });
});

describe('Mixed nextContentChangeAt delegates to the picked sub-game', () => {
  it('matches the timed sub-game exactly and is null for untimed ones', () => {
    for (const { module, data, id } of ALL_CASES) {
      const { view, innerView, inner } = roundOf(module, data, id);
      for (let now = T0; now < T0 + 50_000; now += 500) {
        const mixed = module.nextContentChangeAt({ config: module.defaultConfig, round: view, now });
        const direct = inner.nextContentChangeAt({ config: inner.defaultConfig, round: innerView, now });
        expect(mixed).toBe(direct);
        if (!inner.hasTimedContent) expect(mixed).toBeNull();
      }
      if (inner.hasTimedContent) {
        expect(module.nextContentChangeAt({ config: module.defaultConfig, round: view, now: T0 })).not.toBeNull();
      }
    }
  });
});

/* ------------------------------ reducer level ------------------------------ */

const join = (playerId: PlayerId, nickname: string): RoomAction => ({ type: 'PLAYER_JOIN', playerId, nickname, isGuest: true });

const startMixed = (
  moduleId: GameModuleId,
  harness: Harness,
  seed: number,
  rounds = 3,
  config: unknown = null,
): RoomState => {
  const result = reduceAll(
    newRoom(T0, seed),
    [
      join(P2, 'Bea'),
      join(P3, 'Cal'),
      { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: rounds } },
      { type: 'SELECT_GAME', actorId: HOST, moduleId, config },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

const snapshot = (room: RoomState, deps: EngineDeps): string =>
  JSON.stringify([...[HOST, P2, P3].map((viewer) => projectFor(room, viewer, deps)), projectForHostScreen(room, deps)]);

/** First room seed whose round 1 is `moduleId`. */
const roomSeedFor = (moduleId: GameModuleId, data: RoundDataContext, mixedId: GameModuleId): number => {
  for (let seed = 1; seed < 500; seed += 1) {
    const room = startMixed(mixedId, makeHarness({ data }), seed);
    if ((currentRound(room)?.publicPayload as Envelope).moduleId === moduleId) return seed;
  }
  throw new Error(`no room seed opens on ${moduleId}`);
};

/** 1 s gateway tick loop with the transport's broadcast rule; asserts no viewer is ever stale. */
const tickLoop = (room: RoomState, harness: Harness, durationMs: number) => {
  let state = room;
  let last = snapshot(state, harness.deps);
  const broadcastAt: number[] = [];
  const innerVisible: number[] = [];
  for (let elapsed = 1_000; elapsed <= durationMs; elapsed += 1_000) {
    harness.clock.advance(1_000);
    const result = reduceRoom(state, { type: 'TICK' }, harness.deps);
    expect(result.rejection).toBeNull();
    const changed = result.state !== state;
    state = result.state;
    const current = snapshot(state, harness.deps);
    if (changed) {
      broadcastAt.push(elapsed);
      last = current;
      const projected = projectFor(state, HOST, harness.deps).round;
      if (projected?.visibility === 'pre-reveal') {
        const inner = (projected.publicPayload as Envelope).inner as { clues?: unknown[]; clubs?: unknown[] };
        innerVisible.push((inner.clues ?? inner.clubs ?? []).length);
      }
    } else {
      expect(current).toBe(last);
    }
  }
  return { state, broadcastAt, innerVisible };
};

describe('Mixed rounds broadcast timed content live through TICK', { timeout: 60_000 }, () => {
  for (const timedId of [G1_ID, G3_ID]) {
    it(`a ${timedId} round inside G-MIX unlocks progressively, never frozen on its first clue`, () => {
      const seed = roomSeedFor(timedId, GENERAL, G_MIX_ID);
      const harness = makeHarness({ data: GENERAL });
      const room = startMixed(G_MIX_ID, harness, seed);
      const stored = (currentRound(room)?.publicPayload as Envelope).inner as {
        clues?: unknown[];
        clubs?: unknown[];
        clueIntervalMs: number;
      };
      const total = (stored.clues ?? stored.clubs ?? []).length;
      const window = currentRound(room)?.answerWindowMs ?? 0;
      expect(total).toBeGreaterThan(1);
      expect(currentRound(room)?.contentChangeAt).toBe(T0 + stored.clueIntervalMs);

      const { state, broadcastAt, innerVisible } = tickLoop(room, harness, window + 3_000);
      const unlocks = Array.from({ length: total - 1 }, (_, index) => (index + 1) * stored.clueIntervalMs)
        .filter((at) => at < window)
        .map((at) => Math.ceil(at / 1_000) * 1_000);
      expect(broadcastAt).toEqual([...unlocks, window]);
      expect(innerVisible).toEqual(unlocks.map((_, index) => index + 2));
      expect(state.phase).toBe('roundReveal');
    });
  }

  it('an untimed sub-game round schedules nothing and only changes at its deadline', () => {
    for (const [mixedId, data, untimed] of [
      [G_MIX_ID, GENERAL, G6_ID],
      [M_MIX_ID, MATCHDAY, M2_ID],
      [M_MIX_ID, MATCHDAY, M3_ID],
    ] as const) {
      const harness = makeHarness({ data });
      const room = startMixed(mixedId, harness, roomSeedFor(untimed, data, mixedId));
      expect(currentRound(room)?.contentChangeAt).toBeNull();
      const window = currentRound(room)?.answerWindowMs ?? 0;
      const { broadcastAt } = tickLoop(room, harness, window + 3_000);
      expect(broadcastAt).toEqual([window]);
    }
  });

  it('re-schedules for a timed round that follows an untimed one', () => {
    const harness = makeHarness({ data: GENERAL });
    let room = startMixed(G_MIX_ID, harness, roomSeedFor(G6_ID, GENERAL, G_MIX_ID), 3);
    expect(currentRound(room)?.contentChangeAt).toBeNull();
    room = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps).state;
    room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps).state;
    const second = currentRound(room);
    expect([G1_ID, G3_ID]).toContain((second?.publicPayload as Envelope).moduleId);
    const interval = ((second?.publicPayload as Envelope).inner as { clueIntervalMs: number }).clueIntervalMs;
    expect(second?.contentChangeAt).toBe((second?.startedAt ?? 0) + interval);
    harness.clock.set((second?.startedAt ?? 0) + interval);
    expect(reduceRoom(room, { type: 'TICK' }, harness.deps).events).toEqual([
      { type: 'ROUND_UPDATED', roundId: second?.id },
    ]);
  });
});

/** A scripted answer for player `index`: right for the host, wrong for P2, silent P3 on odd rounds. */
const scriptedAnswer = (round: NonNullable<ReturnType<typeof currentRound>>, index: number): unknown => {
  const envelope = round.publicPayload as Envelope;
  const solution = (round.solution as SolutionEnvelope).inner as Record<string, unknown>;
  const options = (envelope.inner as { options?: { playerId?: string; id?: string }[] }).options ?? [];
  switch (envelope.moduleId) {
    case M3_ID: {
      const truth = solution['shirtNumber'] as number;
      return { guess: index === 0 ? truth : Math.min(99, truth + 3) };
    }
    case G6_ID: {
      const right = solution['optionId'] as string;
      return { optionId: index === 0 ? right : (options.find((option) => option.id !== right)?.id ?? right) };
    }
    case M10_ID: {
      const starters = solution['starters'] as readonly { name: string }[];
      return { guesses: index === 0 ? starters.map((starter) => starter.name) : ['Nobody Atall'] };
    }
    default: {
      const right = solution['playerId'] as string;
      return { playerId: index === 0 ? right : (options.find((option) => option.playerId !== right)?.playerId ?? right) };
    }
  }
};

const playMixedSession = (
  mixedId: GameModuleId,
  data: RoundDataContext,
  seed: number,
  rounds: number,
  roundTrip: boolean,
  config: unknown = null,
) => {
  const harness = makeHarness({ data });
  let room = startMixed(mixedId, harness, seed, rounds, config);
  const dispatch = (action: RoomAction): void => {
    const result = reduceRoom(room, action, harness.deps);
    expect(result.rejection).toBeNull();
    room = roundTrip ? (JSON.parse(JSON.stringify(result.state)) as RoomState) : result.state;
  };
  for (let guard = 0; guard < rounds * 4; guard += 1) {
    if (room.phase === 'intermission' && activeSession(room)?.finishedAt !== null) break;
    if (room.phase === 'playing') {
      const round = currentRound(room);
      if (round === undefined) throw new Error('playing without a round');
      const answering = round.index % 2 === 0 ? [HOST, P2, P3] : [HOST, P2];
      answering.forEach((playerId, index) => {
        harness.clock.advance(1_200 + index * 900);
        if (room.phase === 'playing') {
          dispatch({ type: 'SUBMIT_ANSWER', playerId, roundId: round.id, payload: scriptedAnswer(round, index) });
        }
      });
      if (room.phase === 'playing') dispatch({ type: 'SYSTEM_REVEAL_ROUND' });
    }
    harness.clock.advance(2_000);
    if (room.phase === 'roundReveal') dispatch({ type: 'ADVANCE', actorId: HOST });
    if (room.phase === 'intermission' && activeSession(room)?.finishedAt === null) {
      dispatch({ type: 'ADVANCE', actorId: HOST });
    }
  }
  return room;
};

describe('Mixed full sessions through the reducer', { timeout: 60_000 }, () => {
  const sessions = [
    { mixedId: G_MIX_ID, data: GENERAL, rounds: 9, subs: [G1_ID, G3_ID, G6_ID] },
    { mixedId: M_MIX_ID, data: MATCHDAY, rounds: 6, subs: [M2_ID, M3_ID, M10_ID] },
  ] as const;

  for (const { mixedId, data, rounds, subs } of sessions) {
    for (const seed of [3, 42, 2024]) {
      it(`${mixedId} seed ${seed}: plays to the end, rotating games, and every total reconciles`, () => {
        const room = playMixedSession(mixedId, data, seed, rounds, false);
        const session = activeSession(room);
        expect(room.phase).toBe('intermission');
        expect(session?.finishedAt).not.toBeNull();
        expect(session?.moduleId).toBe(mixedId);
        const played = session?.rounds ?? [];
        expect(played).toHaveLength(rounds);

        const ids = played.map((round) => (round.publicPayload as Envelope).moduleId);
        expect(new Set(ids)).toEqual(new Set(subs));
        for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
        for (const round of played) {
          expect(round.moduleId).toBe(mixedId);
          expect(round.status).toBe('resolved');
          expect((round.outcome?.summary as { moduleId: GameModuleId }).moduleId).toBe(
            (round.publicPayload as Envelope).moduleId,
          );
        }

        for (const player of room.players) {
          const points = played
            .flatMap((round) => round.outcome?.scores ?? [])
            .filter((entry) => entry.playerId === player.id)
            .reduce((sum, entry) => sum + entry.points, 0);
          expect(player.score).toBe(points);
          const sips = room.penalties
            .filter((entry) => entry.recipientId === player.id)
            .reduce((sum, entry) => sum + entry.appliedSips, 0);
          expect(player.sips).toBe(sips);
          expect(session?.sipsByPlayer[player.id] ?? 0).toBe(sips);
        }
        const host = room.players.find((player) => player.id === HOST);
        expect(host?.correctAnswers).toBe(rounds);
        expect(room.penalties.some((entry) => entry.reason === 'NO_ANSWER')).toBe(true);
      });
    }

    it(`${mixedId}: replays byte-for-byte, and survives a JSON round-trip on every dispatch`, () => {
      const first = playMixedSession(mixedId, data, 99, rounds, false);
      const second = playMixedSession(mixedId, data, 99, rounds, false);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(playMixedSession(mixedId, data, 99, rounds, true)).toEqual(first);
    });

    it(`${mixedId}: different seeds play different rotations`, () => {
      // Spread seeds: mulberry32's first draw is correlated across tiny consecutive seeds (1-6 all
      // draw > 0.5), while production rooms use uniform 32-bit seeds.
      const orders = new Set(
        SEEDS.slice(0, 8).map((seed) =>
          (activeSession(playMixedSession(mixedId, data, seed, rounds, false))?.rounds ?? [])
            .map((round) => (round.publicPayload as Envelope).moduleId)
            .join(','),
        ),
      );
      expect(orders.size).toBeGreaterThan(1);
    });
  }

  it('a pre-reveal projection never carries a solution or rival picks, for any sub-game', () => {
    for (const { mixedId, data, subs } of sessions) {
      for (const subId of subs) {
        const harness = makeHarness({ data });
        let room = startMixed(mixedId, harness, roomSeedFor(subId, data, mixedId));
        const round = currentRound(room);
        if (round === undefined) throw new Error('no round');
        room = reduceRoom(
          room,
          { type: 'SUBMIT_ANSWER', playerId: P2, roundId: round.id, payload: scriptedAnswer(round, 0) },
          harness.deps,
        ).state;
        for (const viewer of [HOST, P3, null] as const) {
          const projected = projectFor(room, viewer, harness.deps).round;
          expect(projected?.visibility).toBe('pre-reveal');
          expect(projected !== null && 'solution' in projected).toBe(false);
          expect(projected?.yourSubmission ?? null).toBeNull();
          const inner = (projected?.publicPayload as Envelope).inner;
          const directSub = subOf(subId);
          const expectedInner = directSub.projectRound({
            config: directSub.defaultConfig,
            round: {
              ...roundViewOf(round),
              publicPayload: (round.publicPayload as Envelope).inner,
              solution: (round.solution as SolutionEnvelope).inner,
            },
            viewerId: viewer,
            visibility: 'pre-reveal',
            now: harness.clock.now(),
          }).publicPayload;
          expect(inner).toEqual(expectedInner);
        }
      }
    }
  });
});

/* ---------------------- no shirt number asked after it was shown ---------------------- */

type StoredRound = NonNullable<ReturnType<typeof currentRound>>;

/**
 * Every footballer id paired with an integer `shirtNumber` anywhere inside `values` (any depth) — i.e.
 * every number a client receiving those values could read, whether or not a screen renders it.
 */
const numberedFootballers = (values: readonly unknown[]): readonly string[] => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record['playerId'] === 'string' && Number.isInteger(record['shirtNumber'])) found.add(record['playerId']);
    Object.values(record).forEach(visit);
  };
  values.forEach(visit);
  return [...found];
};

/** Everything `module` sends about `round`: stored payloads, outcome, and every projection of it. */
const everySurface = (module: EngineGameModule, round: StoredRound): readonly unknown[] => {
  const view = roundViewOf(round);
  const projections = (['pre-reveal', 'revealed'] as const).flatMap((visibility) =>
    [HOST, P2, null].map((viewerId) =>
      module.projectRound({ config: module.defaultConfig, round: view, viewerId, visibility, now: round.startedAt }),
    ),
  );
  return [round.publicPayload, round.privatePayloads, round.solution, round.outcome?.summary ?? null, ...projections];
};

/**
 * Footballers whose shirt number a stored round put in front of players, read off every surface
 * (never off the content key): for M2, any option with a number; for M3, its revealed target.
 */
const numbersOnScreen = (round: StoredRound): readonly string[] => numberedFootballers(everySurface(matchdayMixed, round));

/** Longest run of consecutive rounds played by the same sub-game. */
const longestStreak = (ids: readonly GameModuleId[]): number => {
  let best = 0;
  let run = 0;
  ids.forEach((moduleId, index) => {
    run = index > 0 && ids[index - 1] === moduleId ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
};

/** Every M3 round that asks for a number an earlier round of the same session already showed. */
const shirtNumberLeaks = (rounds: readonly StoredRound[]): readonly string[] => {
  const leaks: string[] = [];
  rounds.forEach((round, index) => {
    if ((round.publicPayload as Envelope).moduleId !== M3_ID) return;
    const target = ((round.solution as SolutionEnvelope).inner as { playerId: string }).playerId;
    const earlier = rounds.slice(0, index).findIndex((previous) => numbersOnScreen(previous).includes(target));
    if (earlier >= 0) leaks.push(`round ${index} asks ${target}'s number, shown in round ${earlier}`);
  });
  return leaks;
};

describe('M-MIX never shows a shirt number M3 could ask, and never starves M3', { timeout: 300_000 }, () => {
  // Room seeds that, before any fix, played M3 rounds asking numbers an earlier M2 option list showed
  // (1, 2, 5, 10: two leaking M3 rounds each in 6 rounds; 8, 12: one each).
  const KNOWN_LEAKY_SEEDS = [1, 2, 5, 8, 10, 12];
  // The second QA gate's sweep: 150 seeds × these session lengths, where the exclusion-based fix drove
  // same-game streaks up to 22 and M3's last appearance down to round 8.
  const SWEEP_SEEDS = SEEDS.slice(0, 150);
  const SWEEP_LENGTHS = [8, 12, 15, 20, 30] as const;

  const idsOf = (rounds: readonly { readonly publicPayload: unknown }[]): readonly GameModuleId[] =>
    rounds.map((round) => (round.publicPayload as Envelope).moduleId);

  it('regression: the seeds that used to leak are clean, through real reducer dispatch', () => {
    for (const seed of KNOWN_LEAKY_SEEDS) {
      const rounds = activeSession(playMixedSession(M_MIX_ID, MATCHDAY, seed, 6, false, M2_M3))?.rounds ?? [];
      expect(rounds).toHaveLength(6);
      expect(rounds.some((round) => (round.publicPayload as Envelope).moduleId === M3_ID)).toBe(true);
      expect(shirtNumberLeaks(rounds)).toEqual([]);
    }
  });

  it('every M2 round of an M2+M3 rotation shows no shirt number on any surface, pre-reveal or revealed', () => {
    let m2Rounds = 0;
    for (const seed of SEEDS.slice(0, 40)) {
      const rounds = activeSession(playMixedSession(M_MIX_ID, MATCHDAY, seed, 8, false, M2_M3))?.rounds ?? [];
      expect(rounds).toHaveLength(8);
      for (const round of rounds) {
        if ((round.publicPayload as Envelope).moduleId !== M2_ID) continue;
        m2Rounds += 1;
        const options = ((round.publicPayload as Envelope).inner as { options: { shirtNumber: unknown }[] }).options;
        expect(options.length).toBeGreaterThan(1);
        for (const option of options) expect(option.shirtNumber).toBeNull();
        // Stored payloads, outcome summary, and every viewer's projection in both visibilities.
        expect(numbersOnScreen(round)).toEqual([]);
      }
    }
    expect(m2Rounds).toBeGreaterThan(100);
  });

  it(`sweep (${SWEEP_SEEDS.length} seeds × ${SWEEP_LENGTHS.join('/')} rounds): leak-free, strict alternation, M3 plays to the end`, () => {
    let worstStreak = 0;
    for (const length of SWEEP_LENGTHS) {
      for (const seed of SWEEP_SEEDS) {
        const rounds = generateSession(matchdayMixed, seed, length, MATCHDAY, M2_M3);
        const ids = idsOf(rounds);
        worstStreak = Math.max(worstStreak, longestStreak(ids));
        // M2 never shows a number; M3 never asks one it (or an earlier M3 reveal) showed.
        for (const round of rounds) {
          if (envelopeOf(round).moduleId !== M2_ID) continue;
          expect(numberedFootballers([round.publicPayload, round.privatePayloads, round.solution])).toEqual([]);
        }
        const asked = rounds
          .filter((round) => envelopeOf(round).moduleId === M3_ID)
          .map((round) => ((round.solution as SolutionEnvelope).inner as { playerId: string }).playerId);
        expect(new Set(asked).size).toBe(asked.length);
        // M3 is never starved: it keeps its full half of the session, right up to the last two rounds.
        expect(asked.length).toBeGreaterThanOrEqual(Math.floor(length / 2));
        expect(ids.slice(-2)).toContain(M3_ID);
      }
    }
    // The healthy baseline: the two games alternate every round.
    expect(worstStreak).toBe(1);
  });

  it('the same sweep through real reducer dispatch at 30 rounds: alternating, M3 last seen in round 29 or 30', () => {
    for (const seed of SWEEP_SEEDS.slice(0, 40)) {
      const rounds = activeSession(playMixedSession(M_MIX_ID, MATCHDAY, seed, 30, false, M2_M3))?.rounds ?? [];
      expect(rounds).toHaveLength(30);
      const ids = idsOf(rounds);
      expect(longestStreak(ids)).toBe(1);
      expect(ids.lastIndexOf(M3_ID)).toBeGreaterThanOrEqual(28);
      expect(shirtNumberLeaks(rounds)).toEqual([]);
    }
  });

  it('M3’s pool is never reduced by earlier M2 rounds: 44 alternating rounds ask all 22 numbers', () => {
    const pitch = MATCHDAY.lineups === null ? [] : [...MATCHDAY.lineups.home.startingXI, ...MATCHDAY.lineups.away.startingXI];
    expect(pitch).toHaveLength(22);
    for (const seed of SEEDS.slice(0, 20)) {
      const rounds = generateSession(matchdayMixed, seed, 44, MATCHDAY, M2_M3);
      expect(longestStreak(idsOf(rounds))).toBe(1);
      const asked = rounds
        .filter((round) => envelopeOf(round).moduleId === M3_ID)
        .map((round) => ((round.solution as SolutionEnvelope).inner as { playerId: string }).playerId);
      expect([...asked].sort()).toEqual(pitch.map((entry) => entry.playerId).sort());
    }
  });

  it('M3 inside Mixed sees only inner keys: M2 rounds never constrain it', () => {
    const everyone = MATCHDAY.lineups === null ? [] : [...MATCHDAY.lineups.home.startingXI, ...MATCHDAY.lineups.away.startingXI];
    const m2History = everyone.map((entry) => mixedContentKey(M2_ID, `${entry.playerId}:AGE`));
    for (const seed of SEEDS.slice(0, 30)) {
      const plain = mustGenerate(matchdayMixed, { seed, data: MATCHDAY, config: { modules: [M3_ID] } });
      const afterM2 = mustGenerate(matchdayMixed, { seed, data: MATCHDAY, config: { modules: [M3_ID] }, usedContentKeys: m2History });
      expect(afterM2).toEqual(plain);
    }
  });

  it('shows real numbers wherever M3 is not in the rotation: standalone M2, M-MIX configured [M2], a Mixed without M3', () => {
    const withoutM3 = createMixedModule({ id: asGameModuleId('M-MIX-NO-M3'), category: 'matchday', pool: [m2WhoIsThatPlayer] });
    expect(withoutM3.defaultConfig).toEqual({ modules: [M2_ID] });
    for (const seed of SEEDS.slice(0, 40)) {
      const standalone = mustGenerate(m2WhoIsThatPlayer, { seed, data: MATCHDAY });
      expect(numberedFootballers([standalone.publicPayload]).length).toBeGreaterThan(0);
      const onlyM2 = mustGenerate(matchdayMixed, { seed, data: MATCHDAY, config: { modules: [M2_ID] } });
      const noM3 = mustGenerate(withoutM3, { seed, data: MATCHDAY });
      for (const round of [onlyM2, noM3]) {
        expect(envelopeOf(round).inner).toEqual(standalone.publicPayload);
        const view = asRoundView(round);
        for (const visibility of ['pre-reveal', 'revealed'] as const) {
          const module = round === onlyM2 ? matchdayMixed : withoutM3;
          const projected = module.projectRound({ config: { modules: [M2_ID] }, round: view, viewerId: HOST, visibility, now: T0 });
          expect((projected.publicPayload as Envelope).inner).toEqual(standalone.publicPayload);
        }
      }
    }
  });

  it('projection re-applies the suppression, so even a round stored with numbers never shows them in M2+M3', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      // A round generated without M3 in the rotation (numbers kept) …
      const round = mustGenerate(matchdayMixed, { seed, data: MATCHDAY, config: { modules: [M2_ID] } });
      expect(numberedFootballers([round.publicPayload]).length).toBeGreaterThan(0);
      // … projected by a session that does rotate M3.
      for (const visibility of ['pre-reveal', 'revealed'] as const) {
        const projected = matchdayMixed.projectRound({
          config: { modules: [M2_ID, M3_ID] },
          round: asRoundView(round),
          viewerId: HOST,
          visibility,
          now: T0,
        });
        expect(numberedFootballers([projected.publicPayload, projected.privatePayload, projected.solution])).toEqual([]);
      }
    }
  });

  it('G-MIX is untouched: its rounds are exactly the sub-games’ own', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      for (const moduleId of [G1_ID, G3_ID, G6_ID]) {
        const inner = subOf(moduleId);
        const mixed = mustGenerate(generalMixed, { seed, data: GENERAL, config: { modules: [moduleId] } });
        expect(envelopeOf(mixed).inner).toEqual(mustGenerate(inner, { seed, data: GENERAL }).publicPayload);
      }
    }
  });

  it('M3 run standalone is untouched: M2-shaped keys do not constrain it', () => {
    const everyone = MATCHDAY.lineups === null ? [] : MATCHDAY.lineups.home.startingXI;
    const m2Keys = everyone.map((entry) => `${entry.playerId}:AGE`);
    for (const seed of SEEDS.slice(0, 30)) {
      const plain = mustGenerate(m3ShirtNumber, { seed, data: MATCHDAY });
      const withM2Keys = mustGenerate(m3ShirtNumber, { seed, data: MATCHDAY, usedContentKeys: m2Keys });
      expect(withM2Keys).toEqual(plain);
    }
  });
});

const roundViewOf = (round: NonNullable<ReturnType<typeof currentRound>>): RoundView<ModuleShape> => ({
  id: round.id,
  index: round.index,
  startedAt: round.startedAt,
  answerWindowMs: round.answerWindowMs,
  deadlineAt: round.deadlineAt,
  publicPayload: round.publicPayload,
  privatePayloads: round.privatePayloads,
  solution: round.solution,
  turn: round.turn,
  liveWindow: round.liveWindow,
});

describe('Mixed registration does not disturb the rest of the catalog', () => {
  it('a registry without Mixed modules still works, and Mixed ids are unique', () => {
    const registry = createModuleRegistry(STANDALONE_MODULES);
    expect(registry.has(G_MIX_ID)).toBe(false);
    expect(createDefaultRegistry().has(G_MIX_ID)).toBe(true);
    expect(createDefaultRegistry().has(M_MIX_ID)).toBe(true);
  });
});
