import type { FixtureLineups } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { RoomAction } from '../actions.js';
import {
  asRoundView,
  generateWith,
  HOST,
  LINEUPS,
  makeHarness,
  mustGenerate,
  newRoom,
  P2,
  P3,
  playerViews,
  sampleData,
  scoreRng,
  sub,
} from '../harness.test-utils.js';
import type { ModuleShape, RoundView } from '../module.js';
import { projectFor } from '../projection.js';
import type { EngineDeps } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import { DEFAULT_SCORING } from '../scoring.js';
import type { RoomState } from '../state.js';
import { activeSession, currentRound } from '../state.js';
import { PSG_SLOVAN_FIXTURE, PSG_SLOVAN_LINEUPS } from './fixtures/psg-slovan-401915445.test-utils.js';
import type { M10PublicPayload, M10Solution } from './m10-lineup-recall.js';
import { M10_DEFAULT_CONFIG, M10_ID, m10ContentKey, m10LineupRecall as module } from './m10-lineup-recall.js';

const publicOf = (round: { publicPayload: unknown }): M10PublicPayload => round.publicPayload as M10PublicPayload;
const solutionOf = (round: { solution: unknown }): M10Solution => round.solution as M10Solution;

const allNames = (lineups: FixtureLineups): readonly string[] =>
  [lineups.home, lineups.away].flatMap((side) => [...side.startingXI, ...side.substitutes]).map((entry) => entry.name);

/* -------------------------------- generation -------------------------------- */

describe('M10 generation', () => {
  it('serves one team’s XI with a shape hint and nothing that identifies a player', () => {
    const round = mustGenerate(module);
    const payload = publicOf(round);
    expect(payload.kind).toBe('LINEUP_RECALL');
    expect(payload.slots).toBe(11);
    expect(payload.maxGuesses).toBe(11);
    expect(payload.shape).toEqual({ GK: 1, DF: 4, MF: 3, FW: 3, UNKNOWN: 0 });
    expect(payload.formation).toBe('4-3-3');
    expect(payload.team.name).not.toBe('');
    expect(payload.opponent.teamId).not.toBe(payload.team.teamId);
    const text = JSON.stringify(payload);
    for (const name of allNames(LINEUPS)) expect(text).not.toContain(name);
    for (const entry of [...LINEUPS.home.startingXI, ...LINEUPS.away.startingXI]) expect(text).not.toContain(entry.playerId);
    expect(text).not.toContain('shirtNumber');
    expect(round.answerWindowMs).toBe(M10_DEFAULT_CONFIG.answerWindowMs);
    expect(round.contentKey).toBe(m10ContentKey(LINEUPS.fixtureId, payload.team.teamId));
  });

  it('keeps shirt numbers out of the solution too (no M3 spoiler inside a Mixed rotation)', () => {
    const round = mustGenerate(module);
    expect(JSON.stringify(round.solution)).not.toContain('shirtNumber');
    expect(solutionOf(round).starters).toHaveLength(11);
    // Decoys: the opponent's XI (the harness has no substitutes).
    expect(solutionOf(round).decoys).toHaveLength(11);
  });

  it('plays each side once, in RNG order, then reports NO_UNUSED_CONTENT', () => {
    const sides = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const first = mustGenerate(module, { seed });
      sides.add(publicOf(first).side);
      const second = mustGenerate(module, { seed, usedContentKeys: [first.contentKey] });
      expect(publicOf(second).side).not.toBe(publicOf(first).side);
      const third = generateWith(module, { seed, usedContentKeys: [first.contentKey, second.contentKey] });
      expect(third.ok ? null : third.reason).toBe('NO_UNUSED_CONTENT');
    }
    expect(sides).toEqual(new Set(['home', 'away']));
  });

  it('is deterministic for a seed', () => {
    expect(mustGenerate(module, { seed: 9 })).toEqual(mustGenerate(module, { seed: 9 }));
  });

  it('refuses without lineups, with an unusable XI, or with a projected XI unless allowed', () => {
    const none = generateWith(module, { data: sampleData({ lineups: null }) });
    expect(none.ok ? null : none.reason).toBe('INSUFFICIENT_DATA');

    const projected = sampleData({ lineups: { ...LINEUPS, confirmed: false } });
    const refused = generateWith(module, { data: projected });
    expect(refused.ok ? null : refused.detail).toBe('lineups not confirmed');
    expect(generateWith(module, { data: projected, config: { ...M10_DEFAULT_CONFIG, allowProjectedLineups: true } }).ok).toBe(
      true,
    );

    const blankNames = sampleData({
      lineups: {
        ...LINEUPS,
        home: { ...LINEUPS.home, startingXI: LINEUPS.home.startingXI.map((entry) => ({ ...entry, name: ' ' })) },
        away: { ...LINEUPS.away, startingXI: [] },
      },
    });
    const unusable = generateWith(module, { data: blankNames });
    expect(unusable.ok ? null : unusable.reason).toBe('INSUFFICIENT_DATA');
  });

  it('serves a shorter XI when that is all the lineup has (slots follow the data)', () => {
    const short = sampleData({
      lineups: {
        ...LINEUPS,
        home: { ...LINEUPS.home, startingXI: LINEUPS.home.startingXI.slice(0, 9) },
        away: { ...LINEUPS.away, startingXI: [] },
      },
    });
    const payload = publicOf(mustGenerate(module, { data: short }));
    expect(payload.slots).toBe(9);
    expect(payload.maxGuesses).toBe(9);
  });
});

/* -------------------------------- validation -------------------------------- */

describe('M10 validation', () => {
  const round = asRoundView(mustGenerate(module));
  const validate = (raw: unknown, view: RoundView<ModuleShape> = round) =>
    module.validateSubmission({
      config: M10_DEFAULT_CONFIG,
      round: view,
      playerId: HOST,
      raw,
      submittedAt: 0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts up to one guess per starter and trims them', () => {
    const result = validate({ guesses: ['  home Player 1  ', 'x'] });
    expect(result).toEqual({ ok: true, payload: { guesses: ['home Player 1', 'x'] } });
  });

  it('rejects the wrong shape, extra keys, blank guesses and too many guesses', () => {
    expect(validate({ guesses: 'Mbappe' })).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(validate({ guesses: ['a'], extra: 1 })).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(validate(null)).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(validate({ guesses: [] })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validate({ guesses: ['   '] })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validate({ guesses: ['x'.repeat(61)] })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validate({ guesses: Array.from({ length: 12 }, (_, i) => `g${i}`) })).toMatchObject({
      ok: false,
      code: 'OUT_OF_RANGE',
    });
  });

  it('caps guesses at the XI size of this round', () => {
    const short = asRoundView(
      mustGenerate(module, {
        data: sampleData({
          lineups: { ...LINEUPS, home: { ...LINEUPS.home, startingXI: LINEUPS.home.startingXI.slice(0, 9) }, away: { ...LINEUPS.away, startingXI: [] } },
        }),
      }),
    );
    expect(validate({ guesses: Array.from({ length: 10 }, (_, i) => `g${i}`) }, short)).toMatchObject({
      ok: false,
      code: 'OUT_OF_RANGE',
      detail: 'at most 9 guesses',
    });
  });
});

/* --------------------------------- scoring --------------------------------- */

describe('M10 scoring', () => {
  const generated = mustGenerate(module, { seed: 4 });
  const round = asRoundView(generated);
  const starters = solutionOf(generated).starters.map((entry) => entry.name);
  const score = (submissions: ReturnType<typeof sub>[], config = M10_DEFAULT_CONFIG, players = [HOST, P2, P3]) =>
    module.scoreRound({
      config,
      round,
      submissions,
      players: playerViews(players),
      scoring: DEFAULT_SCORING,
      now: 0,
      rng: scoreRng(),
    });

  it('a perfect XI is correct, wins, and drinks nothing', () => {
    const outcome = score([sub(HOST, { guesses: starters }, 30_000)], M10_DEFAULT_CONFIG, [HOST]);
    expect(outcome.winnerIds).toEqual([HOST]);
    expect(outcome.scores[0]).toMatchObject({ correct: true, meta: { found: 11, missed: 0 } });
    expect(outcome.penalties).toEqual([]);
  });

  it('drinks one sip per starter missed, and a silent player misses the whole XI', () => {
    const outcome = score([
      sub(HOST, { guesses: starters.slice(0, 8) }, 20_000),
      sub(P2, { guesses: ['Nobody', starters[0] ?? ''] }, 20_000),
    ]);
    expect(outcome.penalties).toEqual([
      { playerId: HOST, target: 'self', sips: 3, reason: 'WRONG_ANSWER', meta: { missed: 3, found: 8 } },
      { playerId: P2, target: 'self', sips: 10, reason: 'WRONG_ANSWER', meta: { missed: 10, found: 1 } },
      { playerId: P3, target: 'self', sips: 11, reason: 'NO_ANSWER', meta: { missed: 11 } },
    ]);
    expect(outcome.winnerIds).toEqual([HOST]);
    // A partial XI earns proportional points but breaks the streak (not `correct`).
    expect(outcome.scores.find((entry) => entry.playerId === HOST)).toMatchObject({ correct: false });
    expect(outcome.scores.find((entry) => entry.playerId === HOST)?.points).toBeGreaterThan(0);
  });

  it('scales sips with sipsPerMiss, and 0 turns the drinks off', () => {
    const doubled = score([sub(HOST, { guesses: starters.slice(0, 10) })], { ...M10_DEFAULT_CONFIG, sipsPerMiss: 2 }, [HOST]);
    expect(doubled.penalties[0]?.sips).toBe(2);
    expect(score([sub(HOST, { guesses: ['x'] })], { ...M10_DEFAULT_CONFIG, sipsPerMiss: 0 }).penalties).toEqual([]);
  });

  it('ties on names found share the win; speed only separates points', () => {
    const outcome = score([sub(HOST, { guesses: starters.slice(0, 5) }, 10_000), sub(P2, { guesses: starters.slice(3, 8) }, 60_000)]);
    expect(outcome.winnerIds).toEqual([HOST, P2]);
    const points = (id: string) => outcome.scores.find((entry) => entry.playerId === id)?.points ?? 0;
    expect(points(HOST)).toBeGreaterThan(points(P2));
  });

  it('has no winner when nobody names anyone', () => {
    expect(score([sub(HOST, { guesses: ['zzz'] }), sub(P2, { guesses: ['qqq'] })]).winnerIds).toEqual([]);
  });

  it('summarises who found whom and how each guess was read', () => {
    const outcome = score([sub(HOST, { guesses: [starters[0] ?? '', 'zzz', starters[0] ?? ''] })], M10_DEFAULT_CONFIG, [HOST]);
    const summary = outcome.summary as {
      bestFound: number;
      starters: { name: string; foundBy: string[] }[];
      players: { guesses: { status: string }[] }[];
    };
    expect(summary.bestFound).toBe(1);
    expect(summary.starters.find((entry) => entry.name === starters[0])?.foundBy).toEqual([HOST]);
    expect(summary.players[0]?.guesses.map((guess) => guess.status)).toEqual(['matched', 'unknown', 'duplicate']);
  });

  it('does not consume randomness (fixed per-miss drinks, no roll)', () => {
    const rng = scoreRng();
    const before = rng.state();
    module.scoreRound({
      config: M10_DEFAULT_CONFIG,
      round,
      submissions: [],
      players: playerViews([HOST, P2]),
      scoring: DEFAULT_SCORING,
      now: 0,
      rng,
    });
    expect(rng.state()).toBe(before);
  });
});

/* ------------------------------ with real data ------------------------------ */

describe('M10 on the recorded PSG–Slovan lineups (fair free-text matching)', () => {
  const data = sampleData({
    fixture: PSG_SLOVAN_FIXTURE,
    lineups: PSG_SLOVAN_LINEUPS,
    teams: [PSG_SLOVAN_FIXTURE.homeTeam, PSG_SLOVAN_FIXTURE.awayTeam],
  });
  const psgSeed = (() => {
    for (let seed = 1; seed < 50; seed += 1) if (publicOf(mustGenerate(module, { seed, data })).side === 'home') return seed;
    throw new Error('no seed opens on PSG');
  })();
  const generated = mustGenerate(module, { seed: psgSeed, data });

  it('names the team from the fixture and never the players', () => {
    expect(publicOf(generated).team.name).toBe('Paris Saint-Germain');
    expect(publicOf(generated).opponent.name).toBe('Slovan Bratislava');
    expect(JSON.stringify(generated.publicPayload)).not.toContain('Dembélé');
  });

  it('credits how fans type names and refuses substitutes and opponents', () => {
    const guesses = [
      'dembele', // accent-free surname
      'Hakimi',
      'VITINHA', // mononym, shouting
      'fabian ruiz',
      'Nuno Mendez', // one-letter typo on a long name
      'ferran', // first name
      'Doue', // on the bench: not credited
      'Kvaratskhelia', // on the bench: not credited
      'Camara', // Slovan: not credited
      'Safonov',
      'Pacho',
    ];
    const outcome = module.scoreRound({
      config: M10_DEFAULT_CONFIG,
      round: asRoundView(generated),
      submissions: [sub(HOST, { guesses }, 45_000)],
      players: playerViews([HOST]),
      scoring: DEFAULT_SCORING,
      now: 0,
      rng: scoreRng(),
    });
    const summary = outcome.summary as { players: { found: number; guesses: { guess: string; status: string }[] }[] };
    expect(summary.players[0]?.found).toBe(8);
    expect(summary.players[0]?.guesses.filter((guess) => guess.status === 'decoy').map((guess) => guess.guess)).toEqual([
      'Doue',
      'Kvaratskhelia',
      'Camara',
    ]);
    expect(outcome.penalties[0]).toMatchObject({ sips: 3, meta: { missed: 3, found: 8 } });
  });
});

/* ------------------------------ through the reducer ------------------------------ */

const startM10 = (deps: EngineDeps, seed = 42): RoomState => {
  const result = reduceAll(
    newRoom(undefined, seed),
    [
      { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
      { type: 'PLAYER_JOIN', playerId: P3, nickname: 'Cal', isGuest: true },
      { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 2 } },
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M10_ID, config: null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

describe('M10 through the reducer', () => {
  it('never shows the XI or a rival’s guesses before reveal, then shows everything', () => {
    const { deps } = makeHarness();
    let room = startM10(deps);
    const round = currentRound(room);
    if (round === undefined) throw new Error('no round');
    const names = solutionOf(round).starters.map((entry) => entry.name);
    room = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: round.id, payload: { guesses: names.slice(0, 4) } },
      deps,
    ).state;
    for (const viewer of [P2, P3, null] as const) {
      const text = JSON.stringify(projectFor(room, viewer, deps));
      for (const name of names) expect(text).not.toContain(name);
    }
    // The submitter sees their own guesses back, and nothing more.
    const own = projectFor(room, HOST, deps);
    expect(own.round?.yourSubmission).toEqual({ guesses: names.slice(0, 4) });
    expect(own.round !== null && 'solution' in (own.round ?? {})).toBe(false);

    const revealed = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    const view = projectFor(revealed, P2, deps).round;
    if (view?.visibility !== 'revealed') throw new Error('expected reveal');
    expect((view.solution as M10Solution).starters.map((entry) => entry.name)).toEqual(names);
    expect(view.submissions.find((entry) => entry.playerId === HOST)?.payload).toEqual({ guesses: names.slice(0, 4) });
  });

  it('applies the room caps: a full miss of 11 is charged 10 (perPenalty)', () => {
    const { deps } = makeHarness();
    const revealed = reduceRoom(startM10(deps), { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    const charged = revealed.penalties.filter((entry) => entry.reason === 'NO_ANSWER');
    expect(charged).toHaveLength(3);
    for (const entry of charged) expect(entry).toMatchObject({ requestedSips: 11, appliedSips: 10, cappedBy: 'perPenalty' });
  });

  it('auto-reveals once everyone has submitted, and plays both XIs to the end deterministically', () => {
    const play = (): RoomState => {
      const { deps, clock } = makeHarness();
      let room = startM10(deps, 7);
      for (let guard = 0; guard < 10 && !(room.phase === 'intermission' && activeSession(room)?.finishedAt !== null); guard += 1) {
        const round = currentRound(room);
        if (room.phase === 'playing' && round !== undefined) {
          const names = solutionOf(round).starters.map((entry) => entry.name);
          [HOST, P2, P3].forEach((playerId, index) => {
            clock.advance(5_000);
            const action: RoomAction = {
              type: 'SUBMIT_ANSWER',
              playerId,
              roundId: round.id,
              payload: { guesses: names.slice(0, 11 - index * 4) },
            };
            room = reduceRoom(room, action, deps).state;
          });
          expect(room.phase).toBe('roundReveal');
        }
        room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, deps).state;
        if (room.phase === 'intermission' && activeSession(room)?.finishedAt === null) {
          room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, deps).state;
        }
      }
      return room;
    };
    const first = play();
    expect(JSON.stringify(play())).toBe(JSON.stringify(first));
    const rounds = activeSession(first)?.rounds ?? [];
    expect(rounds.map((round) => publicOf(round).side).sort()).toEqual(['away', 'home']);
    expect(first.players.find((player) => player.id === HOST)?.correctAnswers).toBe(2);
    expect(first.players.find((player) => player.id === P3)?.sips).toBe(16);
  });
});
