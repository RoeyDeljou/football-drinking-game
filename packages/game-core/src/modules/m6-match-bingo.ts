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
 * - **Custom mode** (all optional; omit them for the default mode above, which deals exactly as before):
 *   - `cellPool`: the host's own auto cells (`event`/`side`/`count` from the vocabulary, count
 *     `1..10`, distinct), each with an optional `label` (trimmed, 1..40 chars) shown instead of the
 *     generated label. Cards are dealt from the pool only; it must hold at least
 *     `size² − housePerCard` cells or the config is rejected (`INVALID_CONFIG`, path `cellPool`).
 *   - `houseCells`: free-text cells (≤ 16, distinct case-insensitively) the feed can never tick.
 *     Each card gets `housePerCard` of them (default `min(houseCells, size − 1)`), sampled with the
 *     seeded RNG; cell id `house:<index in houseCells>`, `event: null`, `house: true`.
 *   - The host ticks a house cell with `HOST_MARK { roundId, key: <cell id> }`: it ticks on every
 *     card holding it, and lines / full house charge exactly as for auto cells (meta `{ line,
 *     cellId }` instead of `eventId`). Marking an unknown or already-ticked house cell is refused
 *     (`INVALID_HOST_MARK`).
 *   - Every cell carries `label` (host text or `null` = render the generated label) and `house`.
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
import { LIVE_EVENT_KINDS, liveEventKindOf, liveEventKindSchema, liveEventSideOf, orderLiveBatch, sideSchema } from './live-event-kinds.js';

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

/** Longest custom text (a cell label override or a house cell). Trimmed before the check. */
export const M6_LABEL_MAX_LENGTH = 40;
/** Highest `count` a custom pool cell may ask for. */
export const M6_MAX_CUSTOM_COUNT = 10;
export const M6_MAX_POOL_CELLS = 64;
export const M6_MAX_HOUSE_CELLS = 16;

const labelSchema = z.string().trim().min(1).max(M6_LABEL_MAX_LENGTH);

/** One host-chosen auto cell: the existing vocabulary, plus an optional label shown instead of the generated one. */
const poolCellSchema = z
  .object({
    event: liveEventKindSchema,
    side: sideSchema.nullable(),
    count: z.number().int().min(1).max(M6_MAX_CUSTOM_COUNT),
    label: labelSchema.optional(),
  })
  .strict();

export type M6PoolCell = z.infer<typeof poolCellSchema>;

const sizeSchema = z.union([z.literal(3), z.literal(4)]);

/** House cells per card when the host gave house cells but no `housePerCard`. */
export const defaultHousePerCard = (size: 3 | 4, houseCellCount: number): number => Math.min(houseCellCount, size - 1);

const configSchema = z
  .object({
    size: sizeSchema,
    /** Sips for everyone but the owner, per completed line. `0` disables. */
    lineSips: z.number().int().min(0).max(5),
    /** Sips for everyone but the owner on a full house. `0` disables. */
    fullHouseSips: z.number().int().min(0).max(10),
    /**
     * Custom mode: auto cells are dealt only from this pool (distinct `event`/`side`/`count`) instead
     * of the tiered default vocabulary. Omit for default mode.
     */
    cellPool: z.array(poolCellSchema).min(1).max(M6_MAX_POOL_CELLS).optional(),
    /** Free-text cells only the host can tick (`HOST_MARK`). Distinct, case-insensitively. */
    houseCells: z.array(labelSchema).min(1).max(M6_MAX_HOUSE_CELLS).optional(),
    /** House cells per card (default `defaultHousePerCard`). Needs `houseCells`. */
    housePerCard: z.number().int().min(0).max(16).optional(),
  })
  .strict()
  .superRefine((config, issue) => {
    const cells = config.size * config.size;
    const seenCells = new Set<string>();
    (config.cellPool ?? []).forEach((cell, index) => {
      const id = bingoCellId(cell);
      if (seenCells.has(id)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ['cellPool', index], message: `duplicate cell ${id}` });
      }
      seenCells.add(id);
    });
    const seenHouse = new Set<string>();
    (config.houseCells ?? []).forEach((text, index) => {
      const key = text.toLowerCase();
      if (seenHouse.has(key)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ['houseCells', index], message: 'duplicate house cell' });
      }
      seenHouse.add(key);
    });
    const houseCount = config.houseCells?.length ?? 0;
    if (config.housePerCard !== undefined && config.housePerCard > houseCount) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['housePerCard'],
        message: `housePerCard ${config.housePerCard} exceeds the ${houseCount} house cell(s) given`,
      });
      return;
    }
    const house = housePerCardOf(config);
    if (house > cells) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['housePerCard'],
        message: `housePerCard ${house} exceeds the ${cells} cells of a ${config.size}x${config.size} card`,
      });
      return;
    }
    const needed = cells - house;
    if (config.cellPool !== undefined && config.cellPool.length < needed) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cellPool'],
        message: `a ${config.size}x${config.size} card with ${house} house cell(s) needs at least ${needed} pool cells, got ${config.cellPool.length}`,
      });
    }
  });

type M6Config = z.infer<typeof configSchema>;

/** House cells each card gets: `0` without house cells. */
export const housePerCardOf = (config: Pick<M6Config, 'size' | 'houseCells' | 'housePerCard'>): number =>
  config.houseCells === undefined ? 0 : (config.housePerCard ?? defaultHousePerCard(config.size, config.houseCells.length));

/** The id of the `index`-th configured house cell; the `key` of a `HOST_MARK`. */
export const houseCellId = (index: number): string => `house:${index}`;

export const isHouseCellId = (id: string): boolean => /^house:\d+$/.test(id);

const playerIdSchema = z.string().min(1).transform((value) => value as PlayerId);

const cellSchema = z
  .object({
    id: z.string().min(1),
    /** `null` for a house cell: nothing in the feed ticks it, only `HOST_MARK`. */
    event: liveEventKindSchema.nullable(),
    side: sideSchema.nullable(),
    count: z.number().int().min(1),
    /** Host text shown instead of the generated label (custom pool label, or the house cell text). */
    label: z.string().nullable().default(null),
    house: z.boolean().default(false),
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
  readonly config: M6Config;
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

/** The M6 config schema (default + custom mode), for the host's editor and boundary checks. */
export const M6_CONFIG_SCHEMA = configSchema;
export type { M6Config };

const countPresets = (): Readonly<Record<LiveEventKind, readonly number[]>> => {
  const all = [...M6_CELL_TIERS.common, ...M6_CELL_TIERS.medium, ...M6_CELL_TIERS.rare];
  const of = (kind: LiveEventKind): readonly number[] =>
    [...new Set(all.filter((cell) => cell.event === kind).map((cell) => cell.count))].sort((a, b) => a - b);
  return {
    CORNER: of('CORNER'),
    OFFSIDE: of('OFFSIDE'),
    FOUL: of('FOUL'),
    CARD: of('CARD'),
    SUBSTITUTION: of('SUBSTITUTION'),
    SHOT_ON_TARGET: of('SHOT_ON_TARGET'),
    SHOT_OFF_TARGET: of('SHOT_OFF_TARGET'),
    GOAL: of('GOAL'),
  };
};

/**
 * JSON-friendly description of what a custom card can contain, for the host's editor. Labels are
 * the client's job (no copy here): a cell renders from `event`/`side`/`count` unless it has a
 * `label` override.
 */
export const M6_BINGO_VOCABULARY = {
  kinds: [...LIVE_EVENT_KINDS],
  sides: ['home', 'away', null] as const,
  /** Counts the default vocabulary uses per kind; any `1..maxCount` is accepted. */
  countPresets: countPresets(),
  maxCount: M6_MAX_CUSTOM_COUNT,
  /** The default-mode cells by tier, each with its stable `id`: a good starting pool for the editor. */
  defaultCells: (['common', 'medium', 'rare'] as const).flatMap((tier) =>
    M6_CELL_TIERS[tier].map((cell) => ({ id: bingoCellId(cell), tier, event: cell.event, side: cell.side, count: cell.count })),
  ),
  labelMaxLength: M6_LABEL_MAX_LENGTH,
  maxPoolCells: M6_MAX_POOL_CELLS,
  maxHouseCells: M6_MAX_HOUSE_CELLS,
};

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

/** What a card is dealt from: an auto spec with an optional label, or a house cell. */
type DealtCell =
  | { readonly house: false; readonly spec: BingoCellSpec; readonly label: string | null }
  | { readonly house: true; readonly id: string; readonly label: string };

const toCell = (cell: DealtCell): M6Cell =>
  cell.house
    ? { id: cell.id, event: null, side: null, count: 1, label: cell.label, house: true, progress: 0, ticked: false, tickedAt: null }
    : {
        id: bingoCellId(cell.spec),
        event: cell.spec.event,
        side: cell.spec.side,
        count: cell.spec.count,
        label: cell.label,
        house: false,
        progress: 0,
        ticked: false,
        tickedAt: null,
      };

const dealtId = (cell: DealtCell): string => (cell.house ? cell.id : bingoCellId(cell.spec));

/** Custom-mode deal input; `null` pool = the default tiered vocabulary. */
export interface BingoDealOptions {
  readonly pool: readonly M6PoolCell[] | null;
  readonly houseCells: readonly string[];
  readonly housePerCard: number;
}

export const dealOptionsOf = (config: M6Config): BingoDealOptions => ({
  pool: config.cellPool ?? null,
  houseCells: config.houseCells ?? [],
  housePerCard: housePerCardOf(config),
});

/**
 * One card per player, all different layouts where possible. Deterministic for the RNG state.
 *
 * Default mode (no pool, no house cells): per card, one `sample` per tier and one `shuffle` of the
 * result, retried (at most 20 times) on a duplicate layout — exactly the original deal.
 * Custom mode: per card, `sample` the auto cells (from the pool, or the tiered default with its
 * surplus dropped), `sample` `housePerCard` house cells, `shuffle` the lot; same retry rule.
 */
export const dealBingoCards = (
  playerIds: readonly PlayerId[],
  size: 3 | 4,
  rng: Rng,
  options: BingoDealOptions = { pool: null, houseCells: [], housePerCard: 0 },
): readonly M6Card[] => {
  const mix = M6_CARD_MIX[size];
  const autoCount = size * size - options.housePerCard;
  const house: readonly DealtCell[] = options.houseCells.map((label, index) => ({ house: true, id: houseCellId(index), label }));
  const drawOne = (): readonly DealtCell[] => {
    const auto: readonly DealtCell[] =
      options.pool === null
        ? [
            ...rng.sample(M6_CELL_TIERS.common, mix.common),
            ...rng.sample(M6_CELL_TIERS.medium, mix.medium),
            ...rng.sample(M6_CELL_TIERS.rare, mix.rare),
          ]
            .slice(0, autoCount)
            .map((spec) => ({ house: false, spec, label: null }))
        : rng.sample(options.pool, autoCount).map((cell) => ({
            house: false,
            spec: { event: cell.event, side: cell.side, count: cell.count },
            label: cell.label ?? null,
          }));
    const dealtHouse = options.housePerCard > 0 ? rng.sample(house, options.housePerCard) : [];
    return rng.shuffle([...auto, ...dealtHouse]);
  };
  const seen = new Set<string>();
  return playerIds.map((playerId) => {
    let cells: readonly DealtCell[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      cells = drawOne();
      if (!seen.has(cells.map(dealtId).join('|'))) break;
    }
    seen.add(cells.map(dealtId).join('|'));
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

/**
 * Pure: advance every not-yet-ticked cell `advances` accepts by one, then collect the lines and
 * full houses that completes. Shared by live ticking and host marks.
 */
const advanceCards = (
  cards: readonly M6Card[],
  size: number,
  advances: (cell: M6Cell) => boolean,
  at: MatchClock | null,
): BingoTick => {
  const lines = bingoLines(size);
  const newLines: { playerId: PlayerId; line: string }[] = [];
  const newFullHouses: PlayerId[] = [];

  const next = cards.map((card) => {
    let changed = false;
    const cells = card.cells.map((cell) => {
      if (cell.ticked || !advances(cell)) return cell;
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

/** Pure: apply one live event to every card. House cells never match. */
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
  return advanceCards(
    cards,
    size,
    (cell) => !cell.house && cell.event === kind && (cell.side === null || cell.side === side),
    clockOf(event),
  );
};

/** Pure: tick house cell `cellId` on every card holding it. `at` = the match clock, when known. */
export const markHouseCell = (cards: readonly M6Card[], cellId: string, size: number, at: MatchClock | null): BingoTick =>
  advanceCards(cards, size, (cell) => cell.house && cell.id === cellId, at);

/** Bingo penalties for one tick, in order: lines first, then full houses. */
const tickPenalties = (
  tick: BingoTick,
  payload: Pick<M6PublicPayload, 'lineSips' | 'fullHouseSips'>,
  meta: Readonly<Record<string, string>>,
): readonly PenaltyEvent[] => [
  ...(payload.lineSips > 0
    ? tick.newLines.map(({ playerId, line }) => penalty(playerId, 'others', payload.lineSips, 'BINGO_LINE', { line, ...meta }))
    : []),
  ...(payload.fullHouseSips > 0
    ? tick.newFullHouses.map((playerId) => penalty(playerId, 'others', payload.fullHouseSips, 'BINGO_FULL_HOUSE', { ...meta }))
    : []),
];

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
          cards: [...dealBingoCards(ctx.players.map((player) => player.id), ctx.config.size, ctx.rng, dealOptionsOf(ctx.config))],
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
      penalties.push(...tickPenalties(tick, payload, { eventId: event.id }));
      fullHouseIds.push(...tick.newFullHouses);
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

  hostMark: (ctx) => {
    const payload = ctx.round.publicPayload;
    if (ctx.round.solution.status !== 'running') return { ok: false, detail: `round ${ctx.round.solution.status}` };
    if (!isHouseCellId(ctx.key)) return { ok: false, detail: `not a house cell: ${ctx.key}` };
    const holders = payload.cards.filter((card) => card.cells.some((cell) => cell.house && cell.id === ctx.key));
    if (holders.length === 0) return { ok: false, detail: `house cell not on any card: ${ctx.key}` };
    if (holders.every((card) => card.cells.some((cell) => cell.id === ctx.key && cell.ticked))) {
      return { ok: false, detail: `already marked: ${ctx.key}` };
    }
    const clock = clockFields(ctx.round);
    const tick = markHouseCell(payload.cards, ctx.key, payload.size, clock.matchClock);
    const endedBy: M6Solution['endedBy'] = tick.newFullHouses.length > 0 ? 'FULL_HOUSE' : null;
    return {
      ok: true,
      observation: {
        publicPayload: { ...payload, ...clock, cards: [...tick.cards] },
        privatePayloads: {},
        solution: endedBy === null ? ctx.round.solution : { status: 'ended', endedBy, fullHouseIds: [...tick.newFullHouses] },
        penalties: tickPenalties(tick, payload, { cellId: ctx.key }),
        scoreDeltas: [],
        resolved: endedBy !== null,
      },
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
