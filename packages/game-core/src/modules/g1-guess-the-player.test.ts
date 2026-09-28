import type { FootballPlayerId, Player, PlayerPosition, PlayerProfile, TeamId } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import { asSessionId } from '../ids.js';
import type { Rng } from '../ports.js';
import { createSeededRng } from '../ports.js';
import {
  ALL_BUILT,
  asRoundView,
  drawFor,
  generateWith,
  HOST,
  mustGenerate,
  P2,
  P3,
  playerViews,
  rollsForSeed,
  sampleData,
  SCORE_SEED,
  scoreRng,
  scriptedRng,
  sub,
  T0,
} from '../harness.test-utils.js';
import { DEFAULT_SCORING } from '../scoring.js';
import {
  clueRulesOut,
  G1_DEFAULT_CONFIG,
  G1_GIVEAWAY_CLUE_KINDS,
  G1_PROFILE_CLUE_KINDS,
  g1GuessThePlayer as module,
  maxOpeningDecoys,
  visibleClueCount,
} from './g1-guess-the-player.js';
import { buildOptions, ROLLED_PENALTY_META } from './helpers.js';
interface G1Public {
  readonly clues: readonly { readonly kind: string }[];
  readonly options: readonly { readonly playerId: string }[];
  readonly clueIntervalMs: number;
}
interface G1Solution {
  readonly playerId: string;
  readonly clueCount: number;
}

const generated = mustGenerate(module);
const round = asRoundView(generated);
const answer = (generated.solution as G1Solution).playerId;
const payload = generated.publicPayload as G1Public;
const wrong = payload.options.find((option) => option.playerId !== answer)?.playerId;

const score = (
  submissions: readonly ReturnType<typeof sub>[],
  config: unknown = G1_DEFAULT_CONFIG,
  rng: Rng = scoreRng(),
) =>
  module.scoreRound({
    config,
    round,
    submissions,
    players: playerViews([HOST, P2, P3]),
    scoring: DEFAULT_SCORING,
    now: T0,
    rng,
  });

describe('visibleClueCount', () => {
  it('shows one clue immediately and one more per interval', () => {
    expect(visibleClueCount(0, 8_000, 5)).toBe(1);
    expect(visibleClueCount(7_999, 8_000, 5)).toBe(1);
    expect(visibleClueCount(8_000, 8_000, 5)).toBe(2);
    expect(visibleClueCount(24_000, 8_000, 5)).toBe(4);
  });

  it('never exceeds the clue count, goes below one, or divides by zero', () => {
    expect(visibleClueCount(999_999, 8_000, 3)).toBe(3);
    expect(visibleClueCount(-100, 8_000, 3)).toBe(1);
    expect(visibleClueCount(10, 0, 3)).toBe(3);
    expect(visibleClueCount(10, 8_000, 0)).toBe(0);
  });
});

describe('G1 generation', () => {
  it('is a general game built on career history', () => {
    expect(module.id).toBe('G1');
    expect(module.category).toBe('general');
    expect(module.dataRequirements).toEqual(['hasCareerHistory']);
  });

  it('builds a profile-tier-first, give-away-last ladder and includes the answer among the options', () => {
    const kinds = payload.clues.map((clue) => clue.kind);
    expect(kinds).toHaveLength(5);
    expect([...kinds.slice(0, 3)].sort()).toEqual(['AGE', 'NATIONALITY', 'POSITION']);
    expect([...kinds.slice(3)].sort()).toEqual(['CAREER', 'SHIRT_NUMBER']);
    expect(payload.options).toHaveLength(G1_DEFAULT_CONFIG.optionCount);
    expect(payload.options.some((option) => option.playerId === answer)).toBe(true);
    expect((generated.solution as G1Solution).clueCount).toBe(payload.clues.length);
  });

  it('omits clues the data cannot support', () => {
    const generatedThin = mustGenerate(module, {
      data: sampleData({
        profiles: ALL_BUILT.map((entry) => ({
          player: { ...entry.player, shirtNumber: null },
          career: entry.profile.career,
        })),
      }),
    });
    const thin = generatedThin.publicPayload as G1Public;
    expect(thin.clues.map((clue) => clue.kind)).not.toContain('SHIRT_NUMBER');
  });

  it('fails without profiles and when every profile is used up', () => {
    expect(generateWith(module, { data: EMPTY_DATA_CONTEXT }).ok).toBe(false);
    const exhausted = generateWith(module, {
      usedContentKeys: ALL_BUILT.map((entry) => entry.player.id),
    });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.reason).toBe('NO_UNUSED_CONTENT');
  });

  it('runs a longer answer window than a snap round', () => {
    expect(generated.answerWindowMs).toBe(G1_DEFAULT_CONFIG.answerWindowMs);
  });
});

describe('G1 validation', () => {
  const validate = (raw: unknown) =>
    module.validateSubmission({
      config: G1_DEFAULT_CONFIG,
      round,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts an offered player and rejects anything else', () => {
    expect(validate({ playerId: answer }).ok).toBe(true);
    const unknown = validate({ playerId: 'someone-else' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('UNKNOWN_OPTION');
    const malformed = validate({ playerId: 42 });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe('SCHEMA');
  });
});

describe('G1 scoring', () => {
  it('pays more for guessing on fewer clues', () => {
    const early = score([sub(HOST, { playerId: answer }, 1_000)]);
    const late = score([sub(HOST, { playerId: answer }, 33_000)]);
    const earlyPoints = early.scores.find((entry) => entry.playerId === HOST)?.points ?? 0;
    const latePoints = late.scores.find((entry) => entry.playerId === HOST)?.points ?? 0;
    expect(earlyPoints).toBeGreaterThan(latePoints);
    expect(early.scores.find((entry) => entry.playerId === HOST)?.meta).toMatchObject({ cluesUsed: 1 });
  });

  it('never pays less than the configured minimum credit', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 44_000)]);
    const entry = outcome.scores.find((score_) => score_.playerId === HOST);
    expect(entry?.breakdown.accuracyFactor).toBeGreaterThanOrEqual(G1_DEFAULT_CONFIG.minCredit);
  });

  it('makes everyone else drink when solved on the first clue', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 500)]);
    const bonus = outcome.penalties.find((event) => event.reason === 'ROUND_WON');
    expect(bonus?.target).toBe('others');
    expect(bonus?.playerId).toBe(HOST);
  });

  it('does not hand out the first-clue bonus for a later solve', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 20_000)]);
    expect(outcome.penalties.some((event) => event.reason === 'ROUND_WON')).toBe(false);
  });

  it('charges wrong answers and silence under their own reasons, each with its own drink roll', () => {
    const outcome = score([sub(HOST, { playerId: wrong }, 1_000)]);
    // Draw order: wrong answers (submission order), then non-submitters (player order).
    const [hostRoll, p2Roll, p3Roll] = rollsForSeed(SCORE_SEED, 3);
    expect(outcome.penalties).toEqual([
      { playerId: HOST, target: 'self', sips: hostRoll, reason: 'WRONG_ANSWER', meta: ROLLED_PENALTY_META },
      { playerId: P2, target: 'self', sips: p2Roll, reason: 'NO_ANSWER', meta: ROLLED_PENALTY_META },
      { playerId: P3, target: 'self', sips: p3Roll, reason: 'NO_ANSWER', meta: ROLLED_PENALTY_META },
    ]);
  });

  it('rolls a miss onto any tier, including the let-off and the top tier', () => {
    const letOff = score([sub(HOST, { playerId: wrong }, 1_000)], G1_DEFAULT_CONFIG, scriptedRng([drawFor(0)]));
    expect(letOff.penalties.find((event) => event.playerId === HOST)).toMatchObject({
      reason: 'WRONG_ANSWER',
      sips: 0,
    });
    const top = score([sub(HOST, { playerId: wrong }, 1_000)], G1_DEFAULT_CONFIG, scriptedRng([drawFor(9)]));
    expect(top.penalties.find((event) => event.playerId === HOST)?.sips).toBe(9);
  });

  it('replays identically from the same RNG state and advances it', () => {
    const a = scoreRng(77);
    const b = scoreRng(77);
    const first = score([sub(HOST, { playerId: wrong }, 1_000)], G1_DEFAULT_CONFIG, a);
    const second = score([sub(HOST, { playerId: wrong }, 1_000)], G1_DEFAULT_CONFIG, b);
    expect(second).toEqual(first);
    expect(a.state()).toBe(b.state());
    expect(a.state()).not.toBe(scoreRng(77).state());
  });

  it('treats a zero wrongAnswerSips / noAnswerSips as "off": no event and no draw', () => {
    const rng = scoreRng();
    const before = rng.state();
    const outcome = score(
      [sub(HOST, { playerId: wrong }, 1_000)],
      { ...G1_DEFAULT_CONFIG, wrongAnswerSips: 0, noAnswerSips: 0 },
      rng,
    );
    expect(outcome.penalties).toEqual([]);
    expect(rng.state()).toBe(before);
  });
});

describe('G1 projection', () => {
  it('only emits the clues unlocked so far, and all of them on reveal', () => {
    const project = (now: number, visibility: 'pre-reveal' | 'revealed') =>
      module.projectRound({ config: G1_DEFAULT_CONFIG, round, viewerId: HOST, visibility, now });

    const first = project(T0, 'pre-reveal').publicPayload as G1Public;
    expect(first.clues).toHaveLength(1);

    const third = project(T0 + 16_000, 'pre-reveal').publicPayload as G1Public;
    expect(third.clues).toHaveLength(3);

    const revealed = project(T0, 'revealed');
    expect((revealed.publicPayload as G1Public).clues).toHaveLength(payload.clues.length);
    expect(revealed.solution).toEqual(generated.solution);
  });
});

/* ------------------------- deduction-puzzle properties ------------------------- */

type ClueKind = 'NATIONALITY' | 'POSITION' | 'AGE' | 'CAREER' | 'SHIRT_NUMBER';
interface FullClue {
  readonly kind: ClueKind;
  readonly value?: string | number;
  readonly clubs?: readonly string[];
}
interface FullPublic {
  readonly clues: readonly FullClue[];
  readonly options: readonly { readonly playerId: string; readonly name: string }[];
}

const brand = <T extends string>(value: string): T => value as T;
const OTHER_NATIONS = [
  'England',
  'France',
  'Germany',
  'Italy',
  'Portugal',
  'Brazil',
  'Argentina',
  'Netherlands',
  'Belgium',
  'Croatia',
  'Uruguay',
  'Colombia',
  'Morocco',
  'Senegal',
  'Nigeria',
  'Ghana',
  'Japan',
  'Korea',
  'USA',
  'Mexico',
  'Norway',
  'Denmark',
  'Sweden',
  'Poland',
  'Serbia',
];
const CLUBS = Array.from({ length: 30 }, (_, index) => `Club ${index + 1}`);

/**
 * A realistic league-sized pool: `spanishShare` of players are Spanish (a La Liga build is about
 * that skewed), positions weighted like real squads, ages 18-36.
 */
const makePool = (
  size: number,
  seed: number,
  options: {
    readonly spanishShare?: number;
    readonly sparse?: boolean;
    readonly name?: (index: number) => string;
  } = {},
): PlayerProfile[] => {
  const rng = createSeededRng(seed);
  const positionFor = (): PlayerPosition => {
    const roll = rng.next();
    if (roll < 0.1) return 'GK';
    if (roll < 0.45) return 'DF';
    if (roll < 0.8) return 'MF';
    return 'FW';
  };
  return Array.from({ length: size }, (_, index): PlayerProfile => {
    const id = brand<FootballPlayerId>(`pool-${seed}-${index}`);
    const teamId = brand<TeamId>(`team-${index % 20}`);
    const clubs = rng.sample(CLUBS, rng.int(1, 4));
    const player: Player = {
      id,
      name: options.name?.(index) ?? `Pool Player ${index}`,
      fullName: null,
      nationality: rng.next() < (options.spanishShare ?? 0.4) ? 'Spain' : (rng.pick(OTHER_NATIONS) ?? 'Wales'),
      dateOfBirth: null,
      age: rng.int(18, 36),
      heightCm: null,
      position: options.sparse === true ? 'UNKNOWN' : positionFor(),
      shirtNumber: options.sparse === true ? null : rng.int(1, 40),
      teamId,
      photoUrl: null,
      marketValueEur: null,
    };
    return {
      player,
      career: clubs.map((teamName, step) => ({
        teamId,
        teamName,
        fromSeason: String(2015 + step),
        toSeason: null,
        appearances: null,
        goals: null,
      })),
    };
  });
};

const poolData = (profiles: readonly PlayerProfile[]) =>
  sampleData({ profiles, players: profiles.map((profile) => profile.player) });

/** Independent oracle: the raw value a clue kind shows for a profile. */
const exactValue = (kind: ClueKind, profile: PlayerProfile): string | number | null => {
  switch (kind) {
    case 'NATIONALITY':
      return profile.player.nationality;
    case 'POSITION':
      return profile.player.position;
    case 'AGE':
      return profile.player.age;
    case 'CAREER':
      return profile.career.map((entry) => entry.teamName).join('|');
    case 'SHIRT_NUMBER':
      return profile.player.shirtNumber;
  }
};

interface Analysed {
  readonly kinds: readonly ClueKind[];
  readonly answer: PlayerProfile;
  readonly distractors: readonly PlayerProfile[];
  readonly payload: FullPublic;
}

const analyse = (profiles: readonly PlayerProfile[], seed: number, optionCount = 4): Analysed => {
  const generatedRound = mustGenerate(module, {
    seed,
    data: poolData(profiles),
    config: { ...G1_DEFAULT_CONFIG, optionCount },
  });
  const full = generatedRound.publicPayload as FullPublic;
  const byId = new Map(profiles.map((profile) => [profile.player.id as string, profile]));
  const answerId = (generatedRound.solution as G1Solution).playerId;
  const answerProfile = byId.get(answerId);
  if (answerProfile === undefined) throw new Error('answer missing from pool');
  const distractors = full.options
    .filter((option) => option.playerId !== answerId)
    .map((option) => {
      const profile = byId.get(option.playerId);
      if (profile === undefined) throw new Error('distractor missing from pool');
      return profile;
    });
  return { kinds: full.clues.map((clue) => clue.kind), answer: answerProfile, distractors, payload: full };
};

const openerOf = (round: Analysed): ClueKind => {
  const opener = round.kinds[0];
  if (opener === undefined) throw new Error('no clues');
  return opener;
};

/** Distractors showing the exact same value as the answer on the opening clue. */
const sharingOpener = (round: Analysed): number => {
  const opener = openerOf(round);
  const target = exactValue(opener, round.answer);
  return round.distractors.filter((profile) => exactValue(opener, profile) === target).length;
};

/** Distractors the opening clue does not fairly rule out (the engine's stricter notion). */
const survivingOpener = (round: Analysed): readonly PlayerProfile[] => {
  const opener = openerOf(round);
  return round.distractors.filter((profile) => !clueRulesOut(opener, round.answer, profile));
};

const SEEDS = Array.from({ length: 150 }, (_, index) => index * 7919 + 1);
const MIXED_POOL = makePool(300, 11, { spanishShare: 0.4 });
const LA_LIGA_POOL = makePool(300, 12, { spanishShare: 0.6 });
const REALISTIC_POOLS: Readonly<Record<string, readonly PlayerProfile[]>> = {
  'mixed league (40% Spanish)': MIXED_POOL,
  'La Liga-like (60% Spanish)': LA_LIGA_POOL,
  'extreme (90% Spanish)': makePool(300, 13, { spanishShare: 0.9 }),
};

describe('G1 clue ladder varies per round', () => {
  it('opens on every profile clue kind, never on a give-away clue, and uses many distinct orders', () => {
    const openers = new Map<ClueKind, number>();
    const orders = new Set<string>();
    for (const seed of SEEDS) {
      const round = analyse(MIXED_POOL, seed);
      const opener = openerOf(round);
      openers.set(opener, (openers.get(opener) ?? 0) + 1);
      orders.add(round.kinds.join(','));
      expect(new Set(round.kinds.slice(0, 3))).toEqual(new Set(G1_PROFILE_CLUE_KINDS));
      expect(new Set(round.kinds.slice(3))).toEqual(new Set(G1_GIVEAWAY_CLUE_KINDS));
    }
    expect([...openers.keys()].sort()).toEqual(['AGE', 'NATIONALITY', 'POSITION']);
    // Roughly a third each over 150 rounds; every opener must be common, not a rare exception.
    for (const count of openers.values()) expect(count).toBeGreaterThan(SEEDS.length / 6);
    // 3! profile orders x 2! give-away orders = 12 possible ladders, and all of them turn up.
    expect(orders.size).toBe(12);
  });

  it('varies across consecutive rounds of one session (one shared RNG, content keys accumulating)', () => {
    const rng = createSeededRng(2024);
    const used: string[] = [];
    const openers: ClueKind[] = [];
    for (let roundIndex = 0; roundIndex < 12; roundIndex += 1) {
      const result = module.generateRound({
        config: G1_DEFAULT_CONFIG,
        sessionId: asSessionId('s1'),
        roundIndex,
        players: playerViews([HOST, P2]),
        data: poolData(MIXED_POOL),
        rng,
        now: T0,
        usedContentKeys: used,
        defaultAnswerWindowMs: 20_000,
      });
      if (!result.ok) throw new Error(result.reason);
      used.push(result.round.contentKey ?? '');
      const opener = (result.round.publicPayload as FullPublic).clues[0]?.kind;
      if (opener !== undefined) openers.push(opener);
    }
    expect(new Set(openers).size).toBe(3);
    expect(openers.every((kind) => kind === 'NATIONALITY')).toBe(false);
  });

  it('is deterministic: the same RNG state yields the same round and leaves the same RNG state', () => {
    const pools = [...Object.values(REALISTIC_POOLS), ALL_BUILT.map((entry) => entry.profile)];
    for (const profiles of pools) {
      for (const seed of SEEDS.slice(0, 25)) {
        const rngA = createSeededRng(seed);
        const rngB = createSeededRng(seed);
        const ctx = {
          config: G1_DEFAULT_CONFIG,
          sessionId: asSessionId('s1'),
          roundIndex: 0,
          players: playerViews([HOST, P2]),
          data: poolData(profiles),
          now: T0,
          usedContentKeys: [],
          defaultAnswerWindowMs: 20_000,
        };
        const a = module.generateRound({ ...ctx, rng: rngA });
        const b = module.generateRound({ ...ctx, rng: rngB });
        expect(b).toEqual(a);
        expect(rngB.state()).toBe(rngA.state());
      }
    }
  });
});

describe('G1 option sets are fair deduction puzzles', () => {
  it('caps decoys at a third of the distractors, rounded down', () => {
    expect(maxOpeningDecoys(2)).toBe(0);
    expect(maxOpeningDecoys(3)).toBe(0);
    expect(maxOpeningDecoys(4)).toBe(1);
    expect(maxOpeningDecoys(7)).toBe(2);
    expect(maxOpeningDecoys(12)).toBe(3);
  });

  /*
   * Threshold: with only the opening clue visible, at most floor((optionCount - 1) / 3) distractors
   * may share the answer's exact value — one of three at the default four options, so at most two of
   * the four buttons fit the clue. Held per round (not on average), for every seed, pool and size.
   */
  for (const [label, pool] of Object.entries(REALISTIC_POOLS)) {
    for (const optionCount of [2, 4, 6, 12]) {
      it(`${label}, ${optionCount} options: never more than the cap share the opening clue`, () => {
        for (const seed of SEEDS) {
          const round = analyse(pool, seed, optionCount);
          expect(round.distractors).toHaveLength(optionCount - 1);
          expect(sharingOpener(round)).toBeLessThanOrEqual(maxOpeningDecoys(optionCount));
          // Stricter "fair" notion too: ages within a year count as not ruled out.
          expect(survivingOpener(round).length).toBeLessThanOrEqual(maxOpeningDecoys(optionCount));
        }
      });
    }
  }

  it('keeps exactly the capped number of plausible decoys, so the opener alone is not a lookup', () => {
    for (const pool of Object.values(REALISTIC_POOLS)) {
      for (const seed of SEEDS) {
        expect(survivingOpener(analyse(pool, seed))).toHaveLength(1);
      }
    }
  });

  it('is always solvable: every distractor is ruled out by at least one clue', () => {
    for (const pool of Object.values(REALISTIC_POOLS)) {
      for (const seed of SEEDS) {
        const round = analyse(pool, seed);
        for (const profile of round.distractors) {
          expect(round.kinds.some((kind) => clueRulesOut(kind, round.answer, profile))).toBe(true);
        }
      }
    }
  });

  it('spreads the ruled-out distractors across different values of the opening clue', () => {
    for (const pool of Object.values(REALISTIC_POOLS)) {
      for (const seed of SEEDS) {
        const round = analyse(pool, seed);
        const opener = openerOf(round);
        const values = round.distractors
          .filter((profile) => clueRulesOut(opener, round.answer, profile))
          .map((profile) => exactValue(opener, profile));
        expect(new Set(values).size).toBe(values.length);
      }
    }
  });

  it('does not open on nationality when nationality cannot split the pool', () => {
    const allSpanish = makePool(120, 21, { spanishShare: 1 });
    for (const seed of SEEDS) {
      const round = analyse(allSpanish, seed);
      expect(round.kinds[0]).not.toBe('NATIONALITY');
      expect(round.kinds).toContain('NATIONALITY');
      expect(sharingOpener(round)).toBeLessThanOrEqual(1);
    }
  });

  it('would have failed with the old uniform distractors, so the threshold is meaningful', () => {
    // Old behaviour: nationality always first, distractors sampled uniformly from the whole pool.
    let violations = 0;
    for (const seed of SEEDS) {
      const rng = createSeededRng(seed);
      const answerProfile = rng.pick(LA_LIGA_POOL);
      if (answerProfile === undefined) throw new Error('empty pool');
      const old = buildOptions(answerProfile, LA_LIGA_POOL, 4, rng.shuffle, (a, b) => a.player.id === b.player.id);
      const shared = old.filter(
        (profile) =>
          profile.player.id !== answerProfile.player.id &&
          profile.player.nationality === answerProfile.player.nationality,
      ).length;
      if (shared > maxOpeningDecoys(4)) violations += 1;
    }
    expect(violations).toBeGreaterThan(SEEDS.length / 5);
  });

  it('keeps option names distinct when the pool allows it', () => {
    const lookalikes = makePool(60, 31, { name: (index) => `Namesake ${index % 6}` });
    for (const seed of SEEDS.slice(0, 50)) {
      const names = analyse(lookalikes, seed).payload.options.map((option) => option.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('emits a payload its own public schema accepts, with each clue kind at most once', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const generatedRound = mustGenerate(module, { seed, data: poolData(MIXED_POOL) });
      // `projectRound` parses the stored payload with the module's schemas and throws on a mismatch.
      const revealed = module.projectRound({
        config: G1_DEFAULT_CONFIG,
        round: asRoundView(generatedRound),
        viewerId: HOST,
        visibility: 'revealed',
        now: T0,
      });
      expect(revealed.publicPayload).toEqual(generatedRound.publicPayload);
      const kinds = (generatedRound.publicPayload as FullPublic).clues.map((clue) => clue.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it('never gives an opening decoy that no clue can separate from the answer', () => {
    // Specific regression: the pool's only national of a country must not open on nationality with
    // zero decoys when another opener can supply one.
    const pool = REALISTIC_POOLS['extreme (90% Spanish)'] ?? [];
    for (const seed of SEEDS) {
      const round = analyse(pool, seed);
      for (const decoy of survivingOpener(round)) {
        expect(round.kinds.slice(1).some((kind) => clueRulesOut(kind, round.answer, decoy))).toBe(true);
      }
    }
  });
});

describe('G1 on thin and sparse pools', () => {
  it('works with exactly optionCount usable profiles', () => {
    const four = ALL_BUILT.slice(0, 4).map((entry) => entry.profile);
    for (const seed of SEEDS.slice(0, 40)) {
      const round = analyse(four, seed);
      expect(round.payload.options).toHaveLength(4);
      expect(new Set(round.payload.options.map((option) => option.playerId)).size).toBe(4);
    }
  });

  it('still fills the board when every profile looks alike on the profile clues', () => {
    const clones = makePool(4, 41, { spanishShare: 1 }).map(
      (profile, index): PlayerProfile => ({
        ...profile,
        player: { ...profile.player, position: 'MF', age: 24 + (index % 2) },
      }),
    );
    for (const seed of SEEDS.slice(0, 40)) {
      const round = analyse(clones, seed);
      expect(round.payload.options).toHaveLength(4);
      expect(round.payload.options.some((option) => option.playerId === round.answer.player.id)).toBe(true);
    }
  });

  it('drops clues the data cannot support and still opens on a profile clue', () => {
    const sparse = makePool(40, 51, { sparse: true });
    for (const seed of SEEDS.slice(0, 40)) {
      const round = analyse(sparse, seed);
      expect(round.kinds).not.toContain('POSITION');
      expect(round.kinds).not.toContain('SHIRT_NUMBER');
      expect(new Set(round.kinds.slice(0, 2))).toEqual(new Set(['NATIONALITY', 'AGE']));
      expect(round.kinds[2]).toBe('CAREER');
      expect(round.payload.options).toHaveLength(4);
    }
  });

  it('ignores profiles missing nationality or age, and fails cleanly below optionCount', () => {
    const pool = makePool(8, 61);
    const holed = pool.map(
      (profile, index): PlayerProfile =>
        index < 5 ? { ...profile, player: { ...profile.player, nationality: null } } : profile,
    );
    const result = generateWith(module, { data: poolData(holed) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INSUFFICIENT_DATA');

    const partial = pool.map(
      (profile, index): PlayerProfile =>
        index < 4 ? { ...profile, player: { ...profile.player, age: null } } : profile,
    );
    const round = analyse(partial, 3);
    const excluded = new Set(partial.slice(0, 4).map((profile) => profile.player.id as string));
    expect(round.payload.options).toHaveLength(4);
    expect(round.payload.options.every((option) => !excluded.has(option.playerId))).toBe(true);
  });
});
