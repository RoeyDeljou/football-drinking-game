/**
 * The live-event vocabulary shared by the "things happen on the pitch" games (M5 Event Roulette,
 * M6 Match Bingo).
 *
 * Only what the live feed actually emits (ESPN, see `football-data/src/espn/normalize.ts`): no
 * throw-ins, no goal kicks. Provider types are folded into a small set of kinds a player can
 * recognise on the TV:
 *
 * | kind              | provider event types                         | side (`teamId` meaning)                  |
 * |-------------------|----------------------------------------------|------------------------------------------|
 * | `CORNER`          | CORNER                                       | the team awarded the corner              |
 * | `OFFSIDE`         | OFFSIDE                                      | the team caught offside                  |
 * | `FOUL`            | FOUL                                         | the offender's team                      |
 * | `CARD`            | YELLOW_CARD, SECOND_YELLOW, RED_CARD         | the booked player's team                 |
 * | `SUBSTITUTION`    | SUBSTITUTION                                 | the team making the change               |
 * | `SHOT_ON_TARGET`  | SHOT_ON_TARGET, SAVE ("attempt saved")       | the shooting team                        |
 * | `SHOT_OFF_TARGET` | SHOT_OFF_TARGET (off target, blocked, post)  | the shooting team                        |
 * | `GOAL`            | GOAL, PENALTY_SCORED, OWN_GOAL               | the team credited (own goal: the opponent of `teamId`, see `match-events.ts`) |
 *
 * Everything else (KICK_OFF, HALF_TIME, FULL_TIME, VAR_CHECK, PENALTY_AWARDED/MISSED, ASSIST) is not
 * a kind: never dealt, never ticked.
 */

import type { MatchEvent } from '@fdg/football-data';
import { z } from 'zod';
import type { GoalSide } from '../match-events.js';
import { clockOf, compareMatchClock, goalCreditedSide } from '../match-events.js';

export const LIVE_EVENT_KINDS = [
  'CORNER',
  'OFFSIDE',
  'FOUL',
  'CARD',
  'SUBSTITUTION',
  'SHOT_ON_TARGET',
  'SHOT_OFF_TARGET',
  'GOAL',
] as const;

export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

export const liveEventKindSchema = z.enum(LIVE_EVENT_KINDS);

export const sideSchema = z.enum(['home', 'away']);

const KIND_BY_TYPE: Readonly<Partial<Record<MatchEvent['type'], LiveEventKind>>> = {
  CORNER: 'CORNER',
  OFFSIDE: 'OFFSIDE',
  FOUL: 'FOUL',
  YELLOW_CARD: 'CARD',
  SECOND_YELLOW: 'CARD',
  RED_CARD: 'CARD',
  SUBSTITUTION: 'SUBSTITUTION',
  SHOT_ON_TARGET: 'SHOT_ON_TARGET',
  SAVE: 'SHOT_ON_TARGET',
  SHOT_OFF_TARGET: 'SHOT_OFF_TARGET',
  GOAL: 'GOAL',
  PENALTY_SCORED: 'GOAL',
  OWN_GOAL: 'GOAL',
};

/** The kind an event counts as, or `null` for events no game deals or ticks. */
export const liveEventKindOf = (event: Pick<MatchEvent, 'type'>): LiveEventKind | null => KIND_BY_TYPE[event.type] ?? null;

/** The side an event belongs to (see the table), or `null` when its team is unknown. */
export const liveEventSideOf = (
  event: Pick<MatchEvent, 'type' | 'teamId'>,
  homeTeamId: string,
  awayTeamId: string,
): GoalSide | null => {
  if (liveEventKindOf(event) === 'GOAL') return goalCreditedSide(event, homeTeamId, awayTeamId);
  return event.teamId === homeTeamId ? 'home' : event.teamId === awayTeamId ? 'away' : null;
};

/** One classified live event, as the roulette/bingo payloads record it. */
export const firedEventSchema = z
  .object({
    eventId: z.string().min(1),
    kind: liveEventKindSchema,
    side: sideSchema.nullable(),
    minute: z.number().int().min(0),
    extraMinute: z.number().int().min(0).nullable(),
    playerName: z.string().nullable(),
  })
  .strict();

export type FiredEvent = z.infer<typeof firedEventSchema>;

export const toFiredEvent = (event: MatchEvent, kind: LiveEventKind, homeTeamId: string, awayTeamId: string): FiredEvent => ({
  eventId: event.id,
  kind,
  side: liveEventSideOf(event, homeTeamId, awayTeamId),
  minute: event.minute,
  extraMinute: event.extraMinute,
  playerName: event.playerName,
});

/**
 * A batch in the order the pitch games apply it: cut at the batch's first `FULL_TIME` (batch order
 * decides the whistle, so extra-time events listed after it never count), the rest in match-clock
 * order (stable for ties, so a provider listing plays out of order changes nothing).
 */
export const orderLiveBatch = (
  events: readonly MatchEvent[],
): { readonly ordered: readonly MatchEvent[]; readonly fullTime: boolean } => {
  const whistle = events.findIndex((event) => event.type === 'FULL_TIME');
  const before = whistle === -1 ? events : events.slice(0, whistle);
  const ordered = before
    .map((event, index) => ({ event, index }))
    .sort((a, b) => compareMatchClock(clockOf(a.event), clockOf(b.event)) || a.index - b.index)
    .map((entry) => entry.event);
  return { ordered, fullTime: whistle !== -1 };
};
