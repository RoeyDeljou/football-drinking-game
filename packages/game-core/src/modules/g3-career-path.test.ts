import type { CareerEntry, FootballPlayerId, Player, PlayerProfile, TeamId } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { RoomAction } from '../actions.js';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import type { PlayerId } from '../ids.js';
import { asSessionId } from '../ids.js';
import { projectFor, projectForHostScreen } from '../projection.js';
import type { Rng } from '../ports.js';
import { createSeededRng } from '../ports.js';
import type { EngineDeps } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import { DEFAULT_SCORING } from '../scoring.js';
import type { RoomState } from '../state.js';
import { currentRound } from '../state.js';
import type { Harness } from '../harness.test-utils.js';
import {
  ALL_BUILT,
  asRoundView,
  drawFor,
  generateWith,
  HOST,
  makeHarness,
  mustGenerate,
  newRoom,
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
import { maxOpeningDecoys } from './g1-guess-the-player.js';
import {
  careerEliminationStep,
  careerPath,
  clubKey,
  G3_DEFAULT_CONFIG,
  G3_ID,
  G3_MIN_CLUE_INTERVAL_MS,
  g3CareerPath as module,
  roundClueInterval,
  shownPath,
} from './g3-career-path.js';
import { buildOptions, ROLLED_PENALTY_META } from './helpers.js';

interface Club {
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
}
interface G3Public {
  readonly kind: 'CAREER_PATH';
  readonly clubs: readonly Club[];
  readonly options: readonly { readonly playerId: string; readonly name: string }[];
  readonly clueIntervalMs: number;
}
interface G3Solution {
  readonly playerId: string;
  readonly name: string;
  readonly clueCount: number;
}

const brand = <T extends string>(value: string): T => value as T;

/* --------------------------------- pools --------------------------------- */

const CLUBS = Array.from({ length: 30 }, (_, index) => `Club ${index + 1}`);
const ACADEMIES = Array.from({ length: 8 }, (_, index) => `Academy ${index + 1}`);

const entry = (teamName: string, from: string, to: string | null): CareerEntry => ({
  teamId: null,
  teamName,
  fromSeason: from,
  toSeason: to,
  appearances: null,
  goals: null,
});

const profileOf = (id: string, name: string, career: readonly CareerEntry[]): PlayerProfile => ({
  player: {
    id: brand<FootballPlayerId>(id),
    name,
    fullName: null,
    nationality: 'Spain',
    dateOfBirth: null,
    age: 25,
    heightCm: null,
    position: 'MF',
    shirtNumber: 8,
    teamId: brand<TeamId>('team-x'),
    photoUrl: null,
    marketValueEur: null,
  } satisfies Player,
  career,
});

/**
 * A league-sized pool with realistic, chronological careers: most players start at one of a few
 * academies (so first clubs are shared, as in real data), then 1-6 distinct senior clubs.
 */
const makePool = (
  size: number,
  seed: number,
  options: { readonly name?: (index: number) => string; readonly minLen?: number; readonly maxLen?: number } = {},
): PlayerProfile[] => {
  const rng = createSeededRng(seed);
  return Array.from({ length: size }, (_, index) => {
    const senior = rng.sample(CLUBS, rng.int(options.minLen ?? 1, options.maxLen ?? 6));
    const clubs = rng.next() < 0.7 ? [rng.pick(ACADEMIES) ?? 'Academy 1', ...senior] : senior.slice();
    const start = 2008 + rng.int(0, 6);
    const career = clubs.map((club, step) =>
      entry(club, String(start + step * 2), step === clubs.length - 1 ? null : String(start + step * 2 + 2)),
    );
    return profileOf(`pool-${seed}-${index}`, options.name?.(index) ?? `Pool Player ${index}`, career);
  });
};

const poolData = (profiles: readonly PlayerProfile[]) =>
  sampleData({ profiles, players: profiles.map((profile) => profile.player) });

const SEEDS = Array.from({ length: 150 }, (_, index) => index * 7919 + 1);
const POOLS: Readonly<Record<string, readonly PlayerProfile[]>> = {
  'league-sized (300)': makePool(300, 11),
  'big (900)': makePool(900, 12),
  'journeymen (4-6 clubs)': makePool(300, 13, { minLen: 4, maxLen: 6 }),
};

interface Analysed {
  readonly answer: PlayerProfile;
  readonly distractors: readonly PlayerProfile[];
  readonly payload: G3Public;
  readonly solution: G3Solution;
}

const analyse = (profiles: readonly PlayerProfile[], seed: number, config: object = {}): Analysed => {
  const generatedRound = mustGenerate(module, {
    seed,
    data: poolData(profiles),
    config: { ...G3_DEFAULT_CONFIG, ...config },
  });
  const payload = generatedRound.publicPayload as G3Public;
  const solution = generatedRound.solution as G3Solution;
  const byId = new Map(profiles.map((profile) => [profile.player.id as string, profile]));
  const answer = byId.get(solution.playerId);
  if (answer === undefined) throw new Error('answer missing from pool');
  const distractors = payload.options
    .filter((option) => option.playerId !== solution.playerId)
    .map((option) => {
      const profile = byId.get(option.playerId);
      if (profile === undefined) throw new Error('distractor missing from pool');
      return profile;
    });
  return { answer, distractors, payload, solution };
};

/** Independent oracle: every club a profile ever played for (raw names, trimmed + lowercased). */
const playedFor = (profile: PlayerProfile): ReadonlySet<string> =>
  new Set(profile.career.map((stint) => stint.teamName.trim().toLowerCase()));

/** Independent oracle: first index of `clubs` the candidate never played for, else `null`. */
const oracleStep = (clubs: readonly Club[], candidate: PlayerProfile): number | null => {
  const played = playedFor(candidate);
  const index = clubs.findIndex((club) => !played.has(club.name.trim().toLowerCase()));
  return index === -1 ? null : index;
};

/* --------------------------- direct-module fixture --------------------------- */

const generated = mustGenerate(module, { data: poolData(POOLS['league-sized (300)'] ?? []) });
const round = asRoundView(generated);
const payload = generated.publicPayload as G3Public;
const answer = (generated.solution as G3Solution).playerId;
const wrong = payload.options.find((option) => option.playerId !== answer)?.playerId;
const INTERVAL = payload.clueIntervalMs;

const score = (
  submissions: readonly ReturnType<typeof sub>[],
  config: unknown = G3_DEFAULT_CONFIG,
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

/* ---------------------------------- tests ---------------------------------- */

describe('careerPath', () => {
  it('orders a dated career chronologically, current (open-ended) club last', () => {
    const profile = profileOf('x', 'X', [
      entry('Current FC', '2021', null),
      entry('Youth FC', '2010', '2014'),
      entry('Loan FC', '2016', '2017'),
      entry('Senior FC', '2014', '2021'),
    ]);
    expect(careerPath(profile).map((step) => step.name)).toEqual(['Youth FC', 'Senior FC', 'Loan FC', 'Current FC']);
  });

  it('breaks same-start ties by end year, with an open end last, then by input order', () => {
    const profile = profileOf('x', 'X', [
      entry('B', '2015', null),
      entry('A', '2015', '2016'),
      entry('C', '2015', '2016'),
    ]);
    expect(careerPath(profile).map((step) => step.name)).toEqual(['A', 'C', 'B']);
  });

  it('trusts the provider order when any entry lacks a start year', () => {
    const profile = profileOf('x', 'X', [entry('Late', '2020', null), entry('Early', 'unknown', '2012')]);
    expect(careerPath(profile).map((step) => step.name)).toEqual(['Late', 'Early']);
    expect(careerPath(profile)[1]?.from).toBeNull();
  });

  it('collapses consecutive spells at one club but keeps a later return', () => {
    const profile = profileOf('x', 'X', [
      entry('Chelsea', '2010', '2012'),
      entry(' chelsea ', '2012', '2013'),
      entry('Vitesse', '2013', '2014'),
      entry('Chelsea', '2014', null),
    ]);
    expect(careerPath(profile)).toEqual([
      { name: 'Chelsea', from: '2010', to: '2013' },
      { name: 'Vitesse', from: '2013', to: '2014' },
      { name: 'Chelsea', from: '2014', to: null },
    ]);
  });

  it('drops blank club names and yields nothing for an empty career', () => {
    expect(careerPath(profileOf('x', 'X', [entry('  ', '2010', null), entry('Real', '2011', null)]))).toHaveLength(1);
    expect(careerPath(profileOf('x', 'X', []))).toEqual([]);
  });

  it('keys clubs case- and whitespace-insensitively', () => {
    expect(clubKey('  Real   Madrid ')).toBe(clubKey('real madrid'));
  });
});

describe('shownPath and roundClueInterval', () => {
  it('shows only the most recent maxClubs clubs, so the give-away stays last', () => {
    const path = Array.from({ length: 10 }, (_, index) => ({ name: `C${index}`, from: null, to: null }));
    expect(shownPath(path, 8).map((step) => step.name)).toEqual(['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);
    expect(shownPath(path.slice(0, 3), 8)).toHaveLength(3);
  });

  it('keeps the configured interval for short paths and shortens it for long ones', () => {
    expect(roundClueInterval(G3_DEFAULT_CONFIG, 2)).toBe(G3_DEFAULT_CONFIG.clueIntervalMs);
    expect(roundClueInterval(G3_DEFAULT_CONFIG, 8)).toBeLessThan(G3_DEFAULT_CONFIG.clueIntervalMs);
  });

  it('always unlocks the last club at least finalClueHoldMs before the deadline, never below the floor', () => {
    const configs = [
      G3_DEFAULT_CONFIG,
      { ...G3_DEFAULT_CONFIG, answerWindowMs: 20_000, finalClueHoldMs: 5_000, maxClubs: 12, clueIntervalMs: 60_000 },
      { ...G3_DEFAULT_CONFIG, answerWindowMs: 15_000, finalClueHoldMs: 1_000, maxClubs: 15, clueIntervalMs: 1_000 },
    ];
    for (const config of configs) {
      expect(module.parseConfig(config).ok).toBe(true);
      for (let clubs = 1; clubs <= config.maxClubs; clubs += 1) {
        const interval = roundClueInterval(config, clubs);
        expect(interval).toBeGreaterThanOrEqual(G3_MIN_CLUE_INTERVAL_MS);
        expect(interval).toBeLessThanOrEqual(config.clueIntervalMs);
        expect((clubs - 1) * interval).toBeLessThanOrEqual(config.answerWindowMs - config.finalClueHoldMs);
      }
    }
  });
});

describe('G3 config', () => {
  it('accepts the defaults and rejects inconsistent settings at the boundary', () => {
    expect(module.parseConfig(G3_DEFAULT_CONFIG)).toEqual({ ok: true, config: G3_DEFAULT_CONFIG });
    const inverted = module.parseConfig({ ...G3_DEFAULT_CONFIG, minClubs: 9, maxClubs: 8 });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.issues.join()).toContain('minClubs');
    const cramped = module.parseConfig({ ...G3_DEFAULT_CONFIG, answerWindowMs: 10_000, finalClueHoldMs: 5_000 });
    expect(cramped.ok).toBe(false);
    if (!cramped.ok) expect(cramped.issues.join()).toContain('answerWindowMs');
    expect(module.parseConfig({ ...G3_DEFAULT_CONFIG, extra: 1 }).ok).toBe(false);
  });
});

describe('G3 generation', { timeout: 60_000 }, () => {
  it('is a general simultaneous-answer game built on career history', () => {
    expect(module.id).toBe(G3_ID);
    expect(module.id).toBe('G3');
    expect(module.category).toBe('general');
    expect(module.kind).toBe('simultaneous-answer');
    expect(module.dataRequirements).toEqual(['hasCareerHistory']);
    expect(module.hasTimedContent).toBe(true);
  });

  it('reveals the answer’s real path, earliest club first and most recent club last', () => {
    for (const pool of Object.values(POOLS)) {
      for (const seed of SEEDS.slice(0, 60)) {
        const analysed = analyse(pool, seed);
        const full = careerPath(analysed.answer);
        expect(analysed.payload.clubs).toEqual(shownPath(full, G3_DEFAULT_CONFIG.maxClubs));
        expect(analysed.payload.clubs.at(-1)?.name).toBe(full.at(-1)?.name);
        expect(analysed.payload.clubs.at(-1)?.to).toBeNull();
        // Years ascend along the path.
        const years = analysed.payload.clubs.map((club) => Number(club.from));
        expect(years).toEqual([...years].sort((a, b) => a - b));
        expect(analysed.solution.clueCount).toBe(analysed.payload.clubs.length);
        expect(analysed.payload.clubs.length).toBeGreaterThanOrEqual(G3_DEFAULT_CONFIG.minClubs);
      }
    }
  });

  it('includes the answer among the options, which are unique and exactly optionCount long', () => {
    expect(payload.kind).toBe('CAREER_PATH');
    expect(payload.options).toHaveLength(G3_DEFAULT_CONFIG.optionCount);
    expect(new Set(payload.options.map((option) => option.playerId)).size).toBe(payload.options.length);
    expect(payload.options.some((option) => option.playerId === answer)).toBe(true);
    expect(generated.contentKey).toBe(answer);
    expect(generated.answerWindowMs).toBe(G3_DEFAULT_CONFIG.answerWindowMs);
    expect(generated.turnOrder).toBeNull();
    expect(generated.privatePayloads).toEqual({});
  });

  it('never puts footballer ids or teams into the club clues', () => {
    for (const club of payload.clubs) expect(Object.keys(club).sort()).toEqual(['from', 'name', 'to']);
  });

  it('fails cleanly without profiles, when every career is used, and without long-enough careers', () => {
    const empty = generateWith(module, { data: EMPTY_DATA_CONTEXT });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('INSUFFICIENT_DATA');

    const pool = makePool(10, 3, { minLen: 2, maxLen: 3 });
    const exhausted = generateWith(module, {
      data: poolData(pool),
      usedContentKeys: pool.map((profile) => profile.player.id),
    });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.reason).toBe('NO_UNUSED_CONTENT');

    const oneClubers = pool.map((profile) => ({ ...profile, career: profile.career.slice(0, 1) }));
    const short = generateWith(module, { data: poolData(oneClubers) });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toBe('INSUFFICIENT_DATA');
  });

  it('never repeats an answer within a session (content keys accumulate)', () => {
    const rng = createSeededRng(2024);
    const used: string[] = [];
    const pool = POOLS['league-sized (300)'] ?? [];
    for (let roundIndex = 0; roundIndex < 25; roundIndex += 1) {
      const result = module.generateRound({
        config: G3_DEFAULT_CONFIG,
        sessionId: asSessionId('s1'),
        roundIndex,
        players: playerViews([HOST, P2]),
        data: poolData(pool),
        rng,
        now: T0,
        usedContentKeys: used,
        defaultAnswerWindowMs: 20_000,
      });
      if (!result.ok) throw new Error(result.reason);
      expect(used).not.toContain(result.round.contentKey);
      used.push(result.round.contentKey);
    }
  });

  it('is deterministic: the same RNG state yields the same round and leaves the same RNG state', () => {
    const pools = [...Object.values(POOLS), ALL_BUILT.map((built) => built.profile)];
    for (const profiles of pools) {
      for (const seed of SEEDS.slice(0, 25)) {
        const rngA = createSeededRng(seed);
        const rngB = createSeededRng(seed);
        const ctx = {
          config: G3_DEFAULT_CONFIG,
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

  it('varies the answer across seeds (close to uniform: ~118 distinct expected for 150 draws of 300)', () => {
    const answers = new Set(SEEDS.map((seed) => analyse(POOLS['league-sized (300)'] ?? [], seed).answer.player.id));
    expect(answers.size).toBeGreaterThan(100);
  });
});

describe('G3 validation', () => {
  const validate = (raw: unknown) =>
    module.validateSubmission({
      config: G3_DEFAULT_CONFIG,
      round,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts an offered player and rejects anything else', () => {
    expect(validate({ playerId: answer }).ok).toBe(true);
    expect(validate({ playerId: wrong }).ok).toBe(true);
    const unknown = validate({ playerId: 'someone-else' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('UNKNOWN_OPTION');
    for (const malformed of [{ playerId: 42 }, {}, null, 'x', { playerId: answer, extra: true }]) {
      const result = validate(malformed);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SCHEMA');
    }
  });
});

describe('G3 scoring', () => {
  it('pays more for naming the player on fewer clubs, and reports the clubs used', () => {
    expect(payload.clubs.length).toBeGreaterThan(1);
    const early = score([sub(HOST, { playerId: answer }, 1_000)]);
    const late = score([sub(HOST, { playerId: answer }, (payload.clubs.length - 1) * INTERVAL + 10)]);
    const points = (outcome: typeof early) => outcome.scores.find((entry) => entry.playerId === HOST)?.points ?? 0;
    expect(points(early)).toBeGreaterThan(points(late));
    expect(early.scores.find((entry) => entry.playerId === HOST)?.meta).toMatchObject({ cluesUsed: 1 });
    expect(late.scores.find((entry) => entry.playerId === HOST)?.meta).toMatchObject({
      cluesUsed: payload.clubs.length,
    });
    expect(early.winnerIds).toEqual([HOST]);
    expect(early.summary).toEqual({ answerPlayerId: answer, correctCount: 1, clueCount: payload.clubs.length });
  });

  it('never pays less than the configured minimum credit', () => {
    // Any path of 2+ clubs, answered on the last club: 1 - (clubs - 1) * 0.5 <= 0.5 < 0.9.
    expect(payload.clubs.length).toBeGreaterThan(1);
    const steep = { ...G3_DEFAULT_CONFIG, cluePenalty: 0.5, minCredit: 0.9 };
    const outcome = score([sub(HOST, { playerId: answer }, 44_000)], steep);
    const entry = outcome.scores.find((scoreEntry) => scoreEntry.playerId === HOST);
    expect(entry?.breakdown.accuracyFactor).toBe(0.9);
  });

  it('makes everyone else drink when named from the first club, but not later', () => {
    const first = score([sub(HOST, { playerId: answer }, 500)]);
    const bonus = first.penalties.find((event) => event.reason === 'ROUND_WON');
    expect(bonus).toMatchObject({ playerId: HOST, target: 'others', sips: G3_DEFAULT_CONFIG.firstClueBonusSips });
    const later = score([sub(HOST, { playerId: answer }, INTERVAL + 1)]);
    expect(later.penalties.some((event) => event.reason === 'ROUND_WON')).toBe(false);
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
    expect(outcome.winnerIds).toEqual([]);
  });

  it('rolls a miss onto any tier, including the let-off and the top tier', () => {
    const letOff = score([sub(HOST, { playerId: wrong }, 1_000)], G3_DEFAULT_CONFIG, scriptedRng([drawFor(0)]));
    expect(letOff.penalties.find((event) => event.playerId === HOST)).toMatchObject({ reason: 'WRONG_ANSWER', sips: 0 });
    const top = score([sub(HOST, { playerId: wrong }, 1_000)], G3_DEFAULT_CONFIG, scriptedRng([drawFor(9)]));
    expect(top.penalties.find((event) => event.playerId === HOST)?.sips).toBe(9);
  });

  it('replays identically from the same RNG state and advances it', () => {
    const a = scoreRng(77);
    const b = scoreRng(77);
    const first = score([sub(HOST, { playerId: wrong }, 1_000)], G3_DEFAULT_CONFIG, a);
    const second = score([sub(HOST, { playerId: wrong }, 1_000)], G3_DEFAULT_CONFIG, b);
    expect(second).toEqual(first);
    expect(a.state()).toBe(b.state());
    expect(a.state()).not.toBe(scoreRng(77).state());
  });

  it('treats a zero wrongAnswerSips / noAnswerSips as "off": no event and no draw', () => {
    const rng = scoreRng();
    const before = rng.state();
    const outcome = score(
      [sub(HOST, { playerId: wrong }, 1_000)],
      { ...G3_DEFAULT_CONFIG, wrongAnswerSips: 0, noAnswerSips: 0 },
      rng,
    );
    expect(outcome.penalties).toEqual([]);
    expect(rng.state()).toBe(before);
  });

  it('shares the win on a tie and scores everyone who got it', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 2_000), sub(P2, { playerId: answer }, 2_000)]);
    expect([...outcome.winnerIds].sort()).toEqual([HOST, P2].sort());
  });
});

describe('G3 projection (no leaks)', () => {
  const project = (now: number, visibility: 'pre-reveal' | 'revealed', viewerId: PlayerId | null = HOST) =>
    module.projectRound({ config: G3_DEFAULT_CONFIG, round, viewerId, visibility, now });

  it('emits only the clubs unlocked so far pre-reveal, and never the solution', () => {
    for (let clubs = 1; clubs <= payload.clubs.length; clubs += 1) {
      const at = T0 + (clubs - 1) * INTERVAL;
      for (const viewer of [HOST, null]) {
        const before = project(at - 1, 'pre-reveal', viewer);
        const exactly = project(at, 'pre-reveal', viewer);
        expect((exactly.publicPayload as G3Public).clubs).toEqual(payload.clubs.slice(0, clubs));
        if (clubs > 1) expect((before.publicPayload as G3Public).clubs).toHaveLength(clubs - 1);
        expect(exactly.solution).toBeNull();
        expect(JSON.stringify(exactly)).not.toContain('clueCount');
      }
    }
  });

  it('shows the whole path and the solution on reveal', () => {
    const revealed = project(T0, 'revealed');
    expect((revealed.publicPayload as G3Public).clubs).toEqual(payload.clubs);
    expect(revealed.solution).toEqual(generated.solution);
  });

  it('round-trips its own public schema', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const again = mustGenerate(module, { seed, data: poolData(POOLS['big (900)'] ?? []) });
      const revealed = module.projectRound({
        config: G3_DEFAULT_CONFIG,
        round: asRoundView(again),
        viewerId: HOST,
        visibility: 'revealed',
        now: T0,
      });
      expect(revealed.publicPayload).toEqual(again.publicPayload);
    }
  });
});

describe('G3 schedule agrees with the projection', () => {
  it('nextContentChangeAt points exactly at the instant one more club appears, then null', () => {
    const clubs = payload.clubs.length;
    const visibleAt = (now: number): number =>
      (module.projectRound({ config: G3_DEFAULT_CONFIG, round, viewerId: HOST, visibility: 'pre-reveal', now })
        .publicPayload as G3Public).clubs.length;
    for (let now = T0; now < T0 + G3_DEFAULT_CONFIG.answerWindowMs; now += 250) {
      const next = module.nextContentChangeAt({ config: G3_DEFAULT_CONFIG, round, now });
      if (next === null) {
        expect(visibleAt(now)).toBe(clubs);
        continue;
      }
      expect(next).toBeGreaterThan(now);
      expect(visibleAt(next - 1)).toBe(visibleAt(now));
      expect(visibleAt(next)).toBe(visibleAt(now) + 1);
    }
  });
});

/* ----------------------------- fairness properties ----------------------------- */

describe('G3 option sets are fair elimination puzzles', { timeout: 60_000 }, () => {
  /*
   * Threshold: with only the first club visible, at most floor((optionCount - 1) / 3) wrong options
   * may still be possible (i.e. also played there). Held per round, for every seed, pool and size.
   */
  for (const [label, pool] of Object.entries(POOLS)) {
    for (const optionCount of [2, 4, 6, 12]) {
      it(`${label}, ${optionCount} options: never more than the cap survive the first club`, () => {
        for (const seed of SEEDS) {
          const analysed = analyse(pool, seed, { optionCount });
          expect(analysed.distractors).toHaveLength(optionCount - 1);
          const survivors = analysed.distractors.filter((profile) => oracleStep(analysed.payload.clubs, profile) !== 0);
          expect(survivors.length).toBeLessThanOrEqual(maxOpeningDecoys(optionCount));
        }
      });
    }
  }

  it('keeps exactly the capped number of plausible decoys when the pool has them', () => {
    for (const pool of Object.values(POOLS)) {
      let withDecoy = 0;
      for (const seed of SEEDS) {
        const analysed = analyse(pool, seed);
        const available = pool.filter(
          (profile) =>
            profile.player.id !== analysed.answer.player.id &&
            (oracleStep(analysed.payload.clubs, profile) ?? 0) >= 1,
        ).length;
        const decoys = analysed.distractors.filter((profile) => oracleStep(analysed.payload.clubs, profile) !== 0);
        expect(decoys).toHaveLength(Math.min(available, maxOpeningDecoys(4)));
        if (decoys.length === 1) withDecoy += 1;
      }
      // Real-looking careers share first clubs (academies), so a decoy is the norm, not the exception.
      expect(withDecoy).toBeGreaterThan(SEEDS.length / 2);
    }
  });

  it('is always solvable: every wrong option is ruled out by some club on the path', () => {
    for (const pool of Object.values(POOLS)) {
      for (const optionCount of [4, 12]) {
        for (const seed of SEEDS) {
          const analysed = analyse(pool, seed, { optionCount });
          for (const profile of analysed.distractors) {
            expect(oracleStep(analysed.payload.clubs, profile)).not.toBeNull();
          }
        }
      }
    }
  });

  it('spreads the immediately-ruled-out options across different current clubs', () => {
    for (const pool of Object.values(POOLS)) {
      for (const seed of SEEDS) {
        const analysed = analyse(pool, seed, { optionCount: 6 });
        const current = analysed.distractors
          .filter((profile) => oracleStep(analysed.payload.clubs, profile) === 0)
          .map((profile) => careerPath(profile).at(-1)?.name);
        expect(new Set(current).size).toBe(current.length);
      }
    }
  });

  it('spreads decoys across the club at which they drop out', () => {
    const pool = POOLS['journeymen (4-6 clubs)'] ?? [];
    for (const seed of SEEDS) {
      const analysed = analyse(pool, seed, { optionCount: 12 });
      const steps = analysed.distractors
        .map((profile) => oracleStep(analysed.payload.clubs, profile))
        .filter((step): step is number => step !== null && step >= 1);
      const availableSteps = new Set(
        pool
          .filter((profile) => profile.player.id !== analysed.answer.player.id)
          .map((profile) => oracleStep(analysed.payload.clubs, profile))
          .filter((step): step is number => step !== null && step >= 1),
      );
      expect(new Set(steps).size).toBe(Math.min(steps.length, availableSteps.size));
    }
  });

  it('would have failed with uniformly random distractors, so the threshold is meaningful', () => {
    // Deliberately club-heavy pool: few academies, so a uniform draw often lands several survivors.
    const pool = makePool(300, 71, { minLen: 1, maxLen: 2 }).map(
      (profile, index): PlayerProfile => ({
        ...profile,
        career: [entry(`Academy ${index % 2}`, '2005', '2008'), ...profile.career],
      }),
    );
    let violations = 0;
    for (const seed of SEEDS) {
      const rng = createSeededRng(seed);
      const target = rng.pick(pool);
      if (target === undefined) throw new Error('empty pool');
      const path = careerPath(target);
      const old = buildOptions(target, pool, 4, rng.shuffle, (a, b) => a.player.id === b.player.id);
      const survivors = old.filter(
        (profile) => profile.player.id !== target.player.id && oracleStep(path, profile) !== 0,
      ).length;
      if (survivors > maxOpeningDecoys(4)) violations += 1;
    }
    expect(violations).toBeGreaterThan(SEEDS.length / 5);
    // …and the real generator holds the cap on that same pool.
    for (const seed of SEEDS) {
      const analysed = analyse(pool, seed);
      const survivors = analysed.distractors.filter((profile) => oracleStep(analysed.payload.clubs, profile) !== 0);
      expect(survivors.length).toBeLessThanOrEqual(maxOpeningDecoys(4));
    }
  });

  it('agrees with the independent oracle on elimination steps', () => {
    const pool = POOLS['league-sized (300)'] ?? [];
    for (const seed of SEEDS.slice(0, 40)) {
      const analysed = analyse(pool, seed);
      for (const profile of pool.slice(0, 50)) {
        const clubs = new Set(careerPath(profile).map((step) => clubKey(step.name)));
        expect(careerEliminationStep(analysed.payload.clubs, clubs)).toBe(oracleStep(analysed.payload.clubs, profile));
      }
    }
  });

  it('keeps option names distinct when the pool allows it', () => {
    const lookalikes = makePool(80, 31, { name: (index) => `Namesake ${index % 6}` });
    for (const seed of SEEDS.slice(0, 50)) {
      const names = analyse(lookalikes, seed).payload.options.map((option) => option.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('G3 on thin and sparse pools', { timeout: 60_000 }, () => {
  it('works with exactly optionCount usable profiles', () => {
    const four = makePool(4, 81, { minLen: 2, maxLen: 4 });
    for (const seed of SEEDS.slice(0, 40)) {
      const analysed = analyse(four, seed);
      expect(analysed.payload.options).toHaveLength(4);
      expect(new Set(analysed.payload.options.map((option) => option.playerId)).size).toBe(4);
    }
  });

  it('still fills the board when every career is identical (nothing separable)', () => {
    const clones = Array.from({ length: 5 }, (_, index) =>
      profileOf(`clone-${index}`, `Clone ${index}`, [entry('Same A', '2010', '2014'), entry('Same B', '2014', null)]),
    );
    for (const seed of SEEDS.slice(0, 40)) {
      const analysed = analyse(clones, seed);
      expect(analysed.payload.options).toHaveLength(4);
      expect(analysed.payload.options.some((option) => option.playerId === analysed.answer.player.id)).toBe(true);
    }
  });

  it('prefers an answer the pool can separate when one exists', () => {
    // Nine clones plus one distinct career: only the distinct player can be fully separated.
    const clones = Array.from({ length: 9 }, (_, index) =>
      profileOf(`clone-${index}`, `Clone ${index}`, [entry('Same A', '2010', '2014'), entry('Same B', '2014', null)]),
    );
    const unique = profileOf('unique', 'Unique', [entry('Other A', '2010', '2014'), entry('Other B', '2014', null)]);
    let separated = 0;
    for (const seed of SEEDS) {
      const analysed = analyse([...clones, unique], seed);
      if (analysed.distractors.every((profile) => oracleStep(analysed.payload.clubs, profile) !== null)) separated += 1;
    }
    expect(separated).toBe(SEEDS.length);
  });

  it('uses one-club and holed careers as options only, and ignores empty careers', () => {
    const answers = makePool(3, 91, { minLen: 3, maxLen: 4 });
    const oneClub = Array.from({ length: 4 }, (_, index) =>
      profileOf(`one-${index}`, `One ${index}`, [entry(`Solo ${index}`, '2012', null)]),
    );
    const empty = Array.from({ length: 10 }, (_, index) => profileOf(`none-${index}`, `None ${index}`, []));
    const answerIds = new Set(answers.map((profile) => profile.player.id as string));
    const emptyIds = new Set(empty.map((profile) => profile.player.id as string));
    for (const seed of SEEDS.slice(0, 40)) {
      const analysed = analyse([...answers, ...oneClub, ...empty], seed);
      expect(answerIds.has(analysed.answer.player.id)).toBe(true);
      expect(analysed.payload.options.every((option) => !emptyIds.has(option.playerId))).toBe(true);
    }
  });

  it('fails cleanly below optionCount usable profiles', () => {
    const three = makePool(3, 5, { minLen: 2, maxLen: 3 });
    const result = generateWith(module, { data: poolData(three) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INSUFFICIENT_DATA');
  });

  it('plays on the shared test fixture data', () => {
    expect(generateWith(module).ok).toBe(true);
  });
});

/* ------------------- live broadcast through the reducer (TICK) ------------------- */

const start = (harness: Harness, seed = 7): RoomState => {
  const actions: readonly RoomAction[] = [
    { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
    { type: 'PLAYER_JOIN', playerId: P3, nickname: 'Cal', isGuest: true },
    { type: 'SELECT_GAME', actorId: HOST, moduleId: G3_ID, config: null },
    { type: 'START_SESSION', actorId: HOST },
  ];
  const result = reduceAll(newRoom(T0, seed), actions, harness.deps);
  expect(result.rejection).toBeNull();
  return result.state;
};

const snapshot = (room: RoomState, deps: EngineDeps): string =>
  JSON.stringify([...[HOST, P2, P3].map((viewer) => projectFor(room, viewer, deps)), projectForHostScreen(room, deps)]);

describe('G3 clubs are broadcast live through TICK (never frozen on the first club)', () => {
  const journeymen = poolData(POOLS['journeymen (4-6 clubs)'] ?? []);

  for (const seed of [7, 11, 2024, 99]) {
    it(`seed ${seed}: one commit per unlocked club plus the deadline, and no stale view in between`, () => {
      const harness = makeHarness({ data: journeymen });
      let room = start(harness, seed);
      const stored = currentRound(room)?.publicPayload as G3Public;
      const clubs = stored.clubs.length;
      expect(clubs).toBeGreaterThanOrEqual(4);
      expect(currentRound(room)?.contentChangeAt).toBe(T0 + stored.clueIntervalMs);

      let last = snapshot(room, harness.deps);
      const broadcastAt: number[] = [];
      const seen: number[] = [];
      for (let elapsed = 1_000; elapsed <= G3_DEFAULT_CONFIG.answerWindowMs + 3_000; elapsed += 1_000) {
        harness.clock.advance(1_000);
        const result = reduceRoom(room, { type: 'TICK' }, harness.deps);
        const changed = result.state !== room;
        room = result.state;
        const current = snapshot(room, harness.deps);
        if (changed) {
          broadcastAt.push(elapsed);
          last = current;
          const round_ = projectFor(room, HOST, harness.deps).round;
          if (round_?.visibility === 'pre-reveal') seen.push((round_.publicPayload as G3Public).clubs.length);
        } else {
          expect(current).toBe(last);
        }
      }
      const expected = Array.from({ length: clubs - 1 }, (_, index) => (index + 1) * stored.clueIntervalMs)
        .map((at) => Math.ceil(at / 1_000) * 1_000);
      expect(broadcastAt).toEqual([...expected, G3_DEFAULT_CONFIG.answerWindowMs]);
      expect(seen).toEqual(Array.from({ length: clubs - 1 }, (_, index) => index + 2));
      expect(room.phase).toBe('roundReveal');
    });
  }
});
