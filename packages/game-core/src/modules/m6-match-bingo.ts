/**
 * M6 — Match Bingo (matchday, `private-card`, live events, `since-round-open` window)
 *
 * Catalog: "A card of match events per player, auto-ticked from the live feed. Line = everyone
 * drinks; full house = table downs."
 *
 * ## Why not 5×5
 *
 * A whole ESPN match yields roughly 25 shots off target, 12–15 fouls, 10 shots on target, 10
 * substitutions, 9 corners, 5 offsides, 2–3 goals and 1–4 cards (the recorded PSG–Slovan game:
 * 26/14/11/10/9/5/7/1). Twenty-five distinct cells would need events that barely happen, so a card
 * would almost never complete. Cards are **3×3 (default) or 4×4**, drawn from three difficulty tiers
 * of cells built only from what the feed emits (`live-event-kinds.ts`):
 *
 * | tier   | cells (count, optional side)                                                                 | per card 3×3 / 4×4 |
 * |--------|-----------------------------------------------------------------------------------------------|--------------------|
 * | common | corner ×1/×3, home corner, away corner, foul ×3/×6, shot off target ×1/×3 and per side, shot on target ×1/×2 and per side, substitution ×1 and per side, offside | 7 / 11 |
 * | medium | a goal, a card, offside ×2, substitution ×4, corner ×5, shot on target ×4                      | 2 / 4  |
 * | rare   | goal by home, goal by away, card for home, card for away, goal ×2                             | 0 / 1  |
 *
 * A cell is `{ event, side, count }`: "`count` × `event` (by `side`, or either team when `null`)"
 * since the round opened. Its label is the client's job (e.g. "3 corners", "Card for <away team>").
 *
 * ## Rules
 *
 * - **Cards.** Dealt when the round opens, one per player in the room, from the seeded RNG, all
 *   different layouts. Cards are **public** (everyone watches everyone's card; bingo is a table game);
 *   nothing to submit.
 * - **Ticking.** Every in-window live event advances each matching cell; a cell is ticked once its
 *   count is reached. Events are applied one at a time in match order.
 * - **Lines** are the rows, columns and both diagonals. Each completed line drinks **once**:
 *   `BINGO_LINE`, target `others` — "line = everyone drinks" means everyone *except the line's owner*
 *   (their reward is not drinking), `lineSips`, meta `{ line, eventId }`.
 * - **Full house** (every cell ticked): `BINGO_FULL_HOUSE`, target `others`, `fullHouseSips` (default
 *   6 — "the table downs it"; the caps still bound it). The event that completes it may also complete
 *   lines, which drink too. The first full house ends the round; two cards completing on the same
 *   event share it.
 * - **The round ends** at the first full house, at the regulation `FULL_TIME`, or when the host
 *   reveals. Opened after full time (baseline contains `FULL_TIME`): void, nothing charged.
 * - **Fairness.** No action is ever required. A player who joins mid-round has no card (in `others`
 *   penalties they drink with the table, like anyone present). A card owner who left keeps ticking;
 *   their line still makes the table drink.
 * - **Points** at the reveal (card holders still in the room): accuracy = ticked / cells, `correct`
 *   when at least one line, a streak only for a full house. Winners: the full house(s), else the most
 *   lines (≥ 1), else nobody.
 */

import type { MatchEvent } from '@fdg/football-data';
import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import type { LiveEventWindow } from '../live-window.js';
import type { MatchClock } from '../match-events.js';
import { clockOf, matchClockSchema } from '../match-events.js';
import type { RoundView } from '../module.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import type { Rng } from '../ports.js';
import type { RoundScore } from '../scoring.js';
import { scoreAnswer } from '../scoring.js';
import { teamIdSchema } from './helpers.js';
import type { LiveEventKind } from './live-event-kinds.js';
import { liveEventKindOf, liveEventKindSchema, liveEventSideOf, orderLiveBatch, sideSchema } from './live-event-kinds.js';

export const M6_ID = asGameModuleId('M6');

type Side = z.infer<typeof sideSchema>;

export interface BingoCellSpec {
  readonly event: LiveEventKind;
  readonly side: Side | null;
  readonly count: number;
}

const spec = (event: LiveEventKind, count = 1, side: Side | null = null): BingoCellSpec => ({ event, side, count });

/** The cell vocabulary, by tier. Every cell is reachable from events the feed emits. */
export const M6_CELL_TIERS: {
  readonly common: readonly BingoCellSpec[];
  readonly medium: readonly BingoCellSpec[];
  readonly rare: readonly BingoCellSpec[];
} = {
  common: [
    spec('CORNER'),
    spec('CORNER', 3),
    spec('CORNER', 1, 'home'),
    spec('CORNER', 1, 'away'),
    spec('FOUL', 3),
    spec('FOUL', 6),
    spec('SHOT_OFF_TARGET'),
    spec('SHOT_OFF_TARGET', 3),
    spec('SHOT_OFF_TARGET', 1, 'home'),
    spec('SHOT_OFF_TARGET', 1, 'away'),
    spec('SHOT_ON_TARGET'),
    spec('SHOT_ON_TARGET', 2),
    spec('SHOT_ON_TARGET', 1, 'home'),
    spec('SHOT_ON_TARGET', 1, 'away'),
    spec('SUBSTITUTION'),
    spec('SUBSTITUTION', 1, 'home'),
    spec('SUBSTITUTION', 1, 'away'),
    spec('OFFSIDE'),
  ],
  medium: [
    spec('GOAL'),
    spec('CARD'),
    spec('OFFSIDE', 2),
    spec('SUBSTITUTION', 4),
    spec('CORNER', 5),
    spec('SHOT_ON_TARGET', 4),
  ],
  rare: [spec('GOAL', 1, 'home'), spec('GOAL', 1, 'away'), spec('CARD', 1, 'home'), spec('CARD', 1, 'away'), spec('GOAL', 2)],
};

/** Cells per tier for each card size. */
export const M6_CARD_MIX: Readonly<Record<3 | 4, { common: number; medium: number; rare: number }>> = {
  3: { common: 7, medium: 2, rare: 0 },
  4: { common: 11, medium: 4, rare: 1 },
};

export const bingoCellId = (cell: BingoCellSpec): string => `${cell.event}:${cell.side ?? 'any'}:${cell.count}`;

const configSchema = z
  .object({
    size: z.union([z.literal(3), z.literal(4)]),
    /** Sips for everyone but the owner, per completed line. `0` disables. */
    lineSips: z.number().int().min(0).max(5),
    /** Sips for everyone but the owner on a full house. `0` disables. */
    fullHouseSips: z.number().int().min(0).max(10),
  })
  .strict();

const playerIdSchema = z.string().min(1).transform((value) => value as PlayerId);

const cellSchema = z
  .object({
    id: z.string().min(1),
    event: liveEventKindSchema,
    side: sideSchema.nullable(),
    count: z.number().int().min(1),
    /** Matching events so far, capped at `count`. */
    progress: z.number().int().min(0),
    ticked: z.boolean(),
    /** Match clock of the event that ticked it. */
    tickedAt: matchClockSchema.nullable(),
  })
  .strict();

const cardSchema = z
  .object({
    playerId: playerIdSchema,
    /** Row-major, `size × size`. */
    cells: z.array(cellSchema).min(9).max(16),
    /** Completed line ids (`row-0`…, `col-0`…, `diag-main`, `diag-anti`), in completion order. */
    lines: z.array(z.string()),
    fullHouse: z.boolean(),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('MATCH_BINGO'),
    fixtureId: z.string().min(1),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    size: z.union([z.literal(3), z.literal(4)]),
    lineSips: z.number().int().min(0),
    fullHouseSips: z.number().int().min(0),
    clockKnown: z.boolean(),
    matchClock: matchClockSchema.nullable(),
    /** Every player's card. Public. */
    cards: z.array(cardSchema),
  })
  .strict();

const solutionSchema = z
  .object({
    status: z.enum(['running', 'ended', 'void']),
    endedBy: z.enum(['FULL_HOUSE', 'FULL_TIME', 'MATCH_OVER']).nullable(),
    fullHouseIds: z.array(playerIdSchema),
  })
  .strict();

const submissionSchema = z.object({}).strict();

interface M6Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M6PublicPayload = M6Shape['publicPayload'];
export type M6Solution = M6Shape['solution'];
export type M6Card = z.infer<typeof cardSchema>;
export type M6Cell = z.infer<typeof cellSchema>;

export const M6_DEFAULT_CONFIG: M6Shape['config'] = { size: 3, lineSips: 2, fullHouseSips: 6 };

/** Every line of a `size × size` card, as cell indexes (row-major). */
export const bingoLines = (size: number): readonly { readonly id: string; readonly cells: readonly number[] }[] => {
  const range = Array.from({ length: size }, (_, index) => index);
  return [
    ...range.map((row) => ({ id: `row-${row}`, cells: range.map((col) => row * size + col) })),
    ...range.map((col) => ({ id: `col-${col}`, cells: range.map((row) => row * size + col) })),
    { id: 'diag-main', cells: range.map((index) => index * size + index) },
    { id: 'diag-anti', cells: range.map((index) => index * size + (size - 1 - index)) },
  ];
};

const toCell = (cell: BingoCellSpec): M6Cell => ({
  id: bingoCellId(cell),
  event: cell.event,
  side: cell.side,
  count: cell.count,
  progress: 0,
  ticked: false,
  tickedAt: null,
});

/**
 * One card per player, all different layouts. Deterministic for the RNG state: per card, one
 * `sample` per tier and one `shuffle` of the result, retried (at most 20 times) on a duplicate layout.
 */
export const dealBingoCards = (playerIds: readonly PlayerId[], size: 3 | 4, rng: Rng): readonly M6Card[] => {
  const mix = M6_CARD_MIX[size];
  const seen = new Set<string>();
  return playerIds.map((playerId) => {
    let cells: readonly BingoCellSpec[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      cells = rng.shuffle([
        ...rng.sample(M6_CELL_TIERS.common, mix.common),
        ...rng.sample(M6_CELL_TIERS.medium, mix.medium),
        ...rng.sample(M6_CELL_TIERS.rare, mix.rare),
      ]);
      if (!seen.has(cells.map(bingoCellId).join('|'))) break;
    }
    seen.add(cells.map(bingoCellId).join('|'));
    return { playerId, cells: cells.map(toCell), lines: [], fullHouse: false };
  });
};

export interface BingoTick {
  readonly cards: readonly M6Card[];
  /** Lines completed by this event, per card owner, in card order. */
  readonly newLines: readonly { readonly playerId: PlayerId; readonly line: string }[];
  /** Cards that became a full house on this event. */
  readonly newFullHouses: readonly PlayerId[];
}

/** Pure: apply one live event to every card. */
export const tickBingoCards = (
  cards: readonly M6Card[],
  event: MatchEvent,
  size: number,
  homeTeamId: string,
  awayTeamId: string,
): BingoTick => {
  const kind = liveEventKindOf(event);
  if (kind === null) return { cards, newLines: [], newFullHouses: [] };
  const side = liveEventSideOf(event, homeTeamId, awayTeamId);
  const at: MatchClock = clockOf(event);
  const lines = bingoLines(size);
  const newLines: { playerId: PlayerId; line: string }[] = [];
  const newFullHouses: PlayerId[] = [];

  const next = cards.map((card) => {
    let changed = false;
    const cells = card.cells.map((cell) => {
      if (cell.ticked || cell.event !== kind || (cell.side !== null && cell.side !== side)) return cell;
      changed = true;
      const progress = Math.min(cell.count, cell.progress + 1);
      const ticked = progress >= cell.count;
      return { ...cell, progress, ticked, tickedAt: ticked ? at : null };
    });
    if (!changed) return card;
    const completed = lines
      .filter((line) => !card.lines.includes(line.id) && line.cells.every((index) => cells[index]?.ticked === true))
      .map((line) => line.id);
    for (const line of completed) newLines.push({ playerId: card.playerId, line });
    const fullHouse = cells.every((cell) => cell.ticked);
    if (fullHouse && !card.fullHouse) newFullHouses.push(card.playerId);
    return { ...card, cells, lines: [...card.lines, ...completed], fullHouse };
  });
  return { cards: next, newLines, newFullHouses };
};

type M6Round = Pick<RoundView<M6Shape>, 'liveWindow'>;

const clockFields = (round: M6Round): Pick<M6PublicPayload, 'clockKnown' | 'matchClock'> => {
  const window: LiveEventWindow | null = round.liveWindow;
  const known = window !== null && window.baselineSource !== null;
  return { clockKnown: known, matchClock: known ? window.latest : null };
};

export const m6MatchBingo = defineGameModule<M6Shape>({
  id: M6_ID,
  category: 'matchday',
  kind: 'private-card',
  dataRequirements: ['hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  liveEventWindow: 'since-round-open',
  defaultConfig: M6_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const fixture = ctx.data.fixture;
    if (fixture === null) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no fixture' };
    if (fixture.status === 'FINISHED' || fixture.status === 'CANCELLED') {
      return { ok: false, reason: 'WRONG_ROUND_CONTEXT', detail: `fixture ${fixture.status}` };
    }
    if (ctx.players.length === 0) return { ok: false, reason: 'NOT_ENOUGH_PLAYERS', detail: null };
    let contentKey = `${fixture.id}:bingo:r${ctx.roundIndex + 1}`;
    for (let suffix = 2; ctx.usedContentKeys.includes(contentKey); suffix += 1) {
      contentKey = `${fixture.id}:bingo:r${ctx.roundIndex + 1}-${suffix}`;
    }
    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'MATCH_BINGO',
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          size: ctx.config.size,
          lineSips: ctx.config.lineSips,
          fullHouseSips: ctx.config.fullHouseSips,
          clockKnown: false,
          matchClock: null,
          cards: [...dealBingoCards(ctx.players.map((player) => player.id), ctx.config.size, ctx.rng)],
        },
        privatePayloads: {},
        solution: { status: 'running', endedBy: null, fullHouseIds: [] },
        contentKey,
        answerWindowMs: null,
        turnOrder: null,
      },
    };
  },

  validateSubmission: () => ({ ok: false, code: 'NOT_ALLOWED', detail: 'match bingo takes no submissions' }),

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const base = { privatePayloads: {}, scoreDeltas: [] };
    if (ctx.round.solution.status !== 'running') {
      return { ...base, publicPayload: payload, solution: ctx.round.solution, penalties: [], resolved: true };
    }
    const withClock = { ...payload, ...clockFields(ctx.round) };

    if (ctx.events.length === 0) {
      const over = ctx.history.some((event) => event.type === 'FULL_TIME');
      return {
        ...base,
        publicPayload: withClock,
        solution: over ? { status: 'void', endedBy: 'MATCH_OVER', fullHouseIds: [] } : ctx.round.solution,
        penalties: [],
        resolved: over,
      };
    }

    const { ordered, fullTime } = orderLiveBatch(ctx.events);
    let cards: readonly M6Card[] = payload.cards;
    const penalties: PenaltyEvent[] = [];
    const fullHouseIds: PlayerId[] = [];
    for (const event of ordered) {
      const tick = tickBingoCards(cards, event, payload.size, payload.homeTeamId, payload.awayTeamId);
      cards = tick.cards;
      if (payload.lineSips > 0) {
        for (const { playerId, line } of tick.newLines) {
          penalties.push(penalty(playerId, 'others', payload.lineSips, 'BINGO_LINE', { line, eventId: event.id }));
        }
      }
      for (const playerId of tick.newFullHouses) {
        fullHouseIds.push(playerId);
        if (payload.fullHouseSips > 0) {
          penalties.push(penalty(playerId, 'others', payload.fullHouseSips, 'BINGO_FULL_HOUSE', { eventId: event.id }));
        }
      }
      if (fullHouseIds.length > 0) break;
    }

    const endedBy: M6Solution['endedBy'] = fullHouseIds.length > 0 ? 'FULL_HOUSE' : fullTime ? 'FULL_TIME' : null;
    return {
      ...base,
      publicPayload: { ...withClock, cards: [...cards] },
      solution: endedBy === null ? ctx.round.solution : { status: 'ended', endedBy, fullHouseIds },
      penalties,
      resolved: endedBy !== null,
    };
  },

  scoreRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    const solution = ctx.round.solution;
    const tickedOf = (card: M6Card): number => card.cells.filter((cell) => cell.ticked).length;
    const present = payload.cards.filter((card) => ctx.players.some((player) => player.id === card.playerId));

    const scores: RoundScore[] =
      solution.status === 'void'
        ? []
        : present.map((card) => {
            const player = ctx.players.find((entry) => entry.id === card.playerId);
            return scoreAnswer({
              playerId: card.playerId,
              correct: card.lines.length > 0,
              accuracyFactor: tickedOf(card) / card.cells.length,
              countsAsCorrect: card.fullHouse,
              elapsedMs: 0,
              windowMs: null,
              streakBefore: player?.streak ?? 0,
              config: ctx.scoring,
              meta: { ticked: tickedOf(card), lines: card.lines.length, fullHouse: card.fullHouse },
            });
          });

    let winnerIds: PlayerId[] = present.filter((card) => card.fullHouse).map((card) => card.playerId);
    if (winnerIds.length === 0 && solution.status !== 'void') {
      const most = Math.max(0, ...present.map((card) => card.lines.length));
      winnerIds = most === 0 ? [] : present.filter((card) => card.lines.length === most).map((card) => card.playerId);
    }

    return {
      scores,
      winnerIds,
      // Lines and full houses already drank mid-round.
      penalties: [],
      summary: {
        status: solution.status === 'running' ? 'ended' : solution.status,
        endedBy: solution.status === 'running' ? 'HOST' : solution.endedBy,
        fullHouseIds: solution.fullHouseIds,
        cards: payload.cards.map((card) => ({
          playerId: card.playerId,
          ticked: tickedOf(card),
          cells: card.cells.length,
          lines: card.lines.length,
          fullHouse: card.fullHouse,
        })),
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: { ...ctx.round.publicPayload, ...clockFields(ctx.round) },
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
