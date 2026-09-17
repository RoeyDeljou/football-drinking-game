/**
 * Penalty engine.
 *
 * The engine emits neutral, structured `PenaltyEvent`s. `reason` is a machine-readable code —
 * never a sentence. All alcohol-explicit wording is the client's job (`drinkCopy`).
 */

import { z } from 'zod';
import type { PlayerId, RoundId, SessionId } from './ids.js';
import { asPlayerId } from './ids.js';

/** Who ends up drinking. */
export type PenaltyTarget = 'self' | 'others' | 'everyone';

/** Machine-readable reason codes. The client maps these to copy. */
export const PENALTY_REASONS = [
  'WRONG_ANSWER',
  'NO_ANSWER',
  'LATE_ANSWER',
  'LAST_CORRECT',
  'DISTANCE_FROM_TARGET',
  'LOST_MARKET',
  'WORST_SLIP',
  'PERFECT_SLIP',
  'LOWEST_SCORE',
  'ROUND_WON',
  'PERFECT_ROUND',
  'ASSIGNED_EVENT_FIRED',
  'BINGO_LINE',
  'BINGO_FULL_HOUSE',
  'DUEL_LOST',
  'CHAIN_BROKEN',
  'HOST_MANUAL',
] as const;

export type PenaltyReason = (typeof PENALTY_REASONS)[number];

/** Extra machine-readable context, e.g. `{ marketId: 'BTTS', distance: 4 }`. */
export type PenaltyMeta = Readonly<Record<string, string | number | boolean>>;

export interface PenaltyEvent {
  /** The player the penalty is *about*. With `others`/`everyone` they may not be the one drinking. */
  readonly playerId: PlayerId;
  readonly target: PenaltyTarget;
  /** Magnitude in sips, before caps. */
  readonly sips: number;
  readonly reason: PenaltyReason;
  readonly meta: PenaltyMeta | null;
}

export interface PenaltyCaps {
  /** Maximum sips a single emitted penalty may inflict on one recipient. */
  readonly perPenalty: number;
  /** Maximum sips one recipient can accrue in a single round. */
  readonly perRound: number;
  /** Maximum sips one recipient can accrue across the whole session. */
  readonly perSession: number;
}

export const DEFAULT_PENALTY_CAPS: PenaltyCaps = {
  perPenalty: 6,
  perRound: 10,
  perSession: 60,
};

export const penaltyCapsSchema = z
  .object({
    perPenalty: z.number().int().min(0).max(50),
    perRound: z.number().int().min(0).max(200),
    perSession: z.number().int().min(0).max(2000),
  })
  .strict();

export type CapReason = 'none' | 'perPenalty' | 'perRound' | 'perSession';

/** One penalty, resolved onto one recipient, after caps. This is what gets persisted. */
export interface RecordedPenalty {
  readonly sessionId: SessionId;
  readonly roundId: RoundId | null;
  /** The player the penalty is about (the subject of `reason`). */
  readonly playerId: PlayerId;
  /** The player who actually drinks. */
  readonly recipientId: PlayerId;
  readonly target: PenaltyTarget;
  readonly reason: PenaltyReason;
  readonly meta: PenaltyMeta | null;
  /** Sips requested before caps. */
  readonly requestedSips: number;
  /** Sips actually owed after caps. */
  readonly appliedSips: number;
  readonly cappedBy: CapReason;
}

export interface ApplyPenaltiesInput {
  readonly events: readonly PenaltyEvent[];
  /** Everyone eligible to drink. Disconnected players still owe sips; that is the point of the game. */
  readonly participantIds: readonly PlayerId[];
  readonly caps: PenaltyCaps;
  readonly sessionId: SessionId;
  readonly roundId: RoundId | null;
  /** Sips each recipient has already accrued this session, used for the per-session cap. */
  readonly sessionSipsByPlayer: Readonly<Partial<Record<PlayerId, number>>>;
  /**
   * Sips each recipient has already accrued in *this round* from earlier batches (a long-running
   * round applies penalties once per live-event batch and again at reveal). Without it the per-round
   * cap would reset on every call. Use `tallySipsForRound` to derive it from recorded penalties.
   */
  readonly roundSipsByPlayer: Readonly<Partial<Record<PlayerId, number>>>;
}

export interface ApplyPenaltiesResult {
  readonly recorded: readonly RecordedPenalty[];
  /** Sips added by this call, per recipient. */
  readonly sipsByPlayer: Readonly<Partial<Record<PlayerId, number>>>;
}

/** Expand a penalty's `target` into the concrete players who drink. */
export const resolvePenaltyRecipients = (
  event: PenaltyEvent,
  participantIds: readonly PlayerId[],
): readonly PlayerId[] => {
  switch (event.target) {
    case 'self':
      return participantIds.includes(event.playerId) ? [event.playerId] : [];
    case 'others':
      return participantIds.filter((id) => id !== event.playerId);
    case 'everyone':
      return participantIds.slice();
    default: {
      const exhaustive: never = event.target;
      return exhaustive;
    }
  }
};

const readSips = (map: Readonly<Partial<Record<PlayerId, number>>>, id: PlayerId): number => map[id] ?? 0;

/**
 * Pure. Resolves targets, applies the three caps in order (per-penalty, per-round, per-session)
 * and reports exactly which cap bit, so the UI can explain a truncated penalty.
 */
export const applyPenalties = (input: ApplyPenaltiesInput): ApplyPenaltiesResult => {
  const { caps, participantIds } = input;
  const recorded: RecordedPenalty[] = [];
  const addedThisCall: Partial<Record<PlayerId, number>> = {};
  const roundTotals: Partial<Record<PlayerId, number>> = { ...input.roundSipsByPlayer };

  for (const event of input.events) {
    const recipients = resolvePenaltyRecipients(event, participantIds);
    for (const recipientId of recipients) {
      const requested = Math.max(0, Math.round(event.sips));
      let cappedBy: CapReason = 'none';
      let applied = requested;

      if (applied > caps.perPenalty) {
        applied = caps.perPenalty;
        cappedBy = 'perPenalty';
      }

      const roundSoFar = readSips(roundTotals, recipientId);
      const roundHeadroom = Math.max(0, caps.perRound - roundSoFar);
      if (applied > roundHeadroom) {
        applied = roundHeadroom;
        cappedBy = 'perRound';
      }

      const sessionSoFar =
        readSips(input.sessionSipsByPlayer, recipientId) + readSips(addedThisCall, recipientId);
      const sessionHeadroom = Math.max(0, caps.perSession - sessionSoFar);
      if (applied > sessionHeadroom) {
        applied = sessionHeadroom;
        cappedBy = 'perSession';
      }

      roundTotals[recipientId] = roundSoFar + applied;
      addedThisCall[recipientId] = readSips(addedThisCall, recipientId) + applied;

      recorded.push({
        sessionId: input.sessionId,
        roundId: input.roundId,
        playerId: event.playerId,
        recipientId,
        target: event.target,
        reason: event.reason,
        meta: event.meta,
        requestedSips: requested,
        appliedSips: applied,
        cappedBy,
      });
    }
  }

  return { recorded, sipsByPlayer: addedThisCall };
};

/** Convenience constructor so modules never hand-roll a partially filled event. */
export const penalty = (
  playerId: PlayerId,
  target: PenaltyTarget,
  sips: number,
  reason: PenaltyReason,
  meta: PenaltyMeta | null = null,
): PenaltyEvent => ({ playerId, target, sips, reason, meta });

/** Total sips owed per player across a list of recorded penalties. */
export const tallySips = (
  recorded: readonly RecordedPenalty[],
): Readonly<Partial<Record<PlayerId, number>>> => {
  const totals: Partial<Record<PlayerId, number>> = {};
  for (const entry of recorded) {
    totals[entry.recipientId] = readSips(totals, entry.recipientId) + entry.appliedSips;
  }
  return totals;
};

/** Exported for the socket layer, which validates host-issued manual penalties. */
export const penaltyEventSchema = z
  .object({
    playerId: z.string().min(1).transform(asPlayerId),
    target: z.enum(['self', 'others', 'everyone']),
    sips: z.number().int().min(0).max(50),
    reason: z.enum(PENALTY_REASONS),
    meta: z.record(z.union([z.string(), z.number(), z.boolean()])).nullable(),
  })
  .strict();

/** Sips each recipient has already been charged in one round — the input for the per-round cap. */
export const tallySipsForRound = (
  recorded: readonly RecordedPenalty[],
  roundId: RoundId,
): Readonly<Partial<Record<PlayerId, number>>> =>
  tallySips(recorded.filter((entry) => entry.roundId === roundId));
