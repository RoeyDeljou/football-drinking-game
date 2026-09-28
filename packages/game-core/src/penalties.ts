/**
 * Penalty engine.
 *
 * The engine emits neutral, structured `PenaltyEvent`s. `reason` is a machine-readable code —
 * never a sentence. All alcohol-explicit wording is the client's job (`drinkCopy`).
 */

import { z } from 'zod';
import type { PlayerId, RoundId, SessionId } from './ids.js';
import { asPlayerId } from './ids.js';
import type { Rng } from './ports.js';

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

/**
 * `perPenalty` is 10 so the drink roll's top tier (`9`, "2 shots") reaches the recipient uncapped —
 * at the old value of 6 it was silently truncated into the "a shot" band, erasing the rarest and
 * most memorable outcome. `perRound` stays 10 (one maximal penalty per round, which is still the
 * runaway-round guard it was designed to be) and `perSession` stays 60 (six maximal rounds).
 * `drink-roll.test.ts` pins `perPenalty >= max(DRINK_ROLL_TABLE sips)` so the two cannot drift.
 */
export const DEFAULT_PENALTY_CAPS: PenaltyCaps = {
  perPenalty: 10,
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

/* -------------------------------------------------------------------------- */
/* The drink roll                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The drink roll: the magnitude of a "you got it wrong" / "you didn't answer" penalty is drawn at
 * random instead of being a fixed configured number, so a miss is sometimes a let-off, usually a
 * sip or two, and occasionally a shot.
 *
 * **Which penalties roll.** Only `WRONG_ANSWER` and `NO_ANSWER`, the everyday per-player misses, and
 * each recipient gets an independent draw. Every other reason keeps its fixed, configured magnitude,
 * because those are deliberate "this specific event costs exactly N" mechanics (`LAST_CORRECT`,
 * `ROUND_WON`, `WORST_SLIP`, `PERFECT_SLIP`, M1's per-market `LOST_MARKET`) or already vary by
 * formula (M3's `DISTANCE_FROM_TARGET`).
 *
 * **Config fields.** The modules' existing `wrongAnswerSips` / `noAnswerSips` config fields are kept
 * (the schemas are strict: removing them would reject every stored or client-sent config that still
 * carries them) but their meaning changed — they are now an **on/off switch**. `0` disables that
 * penalty entirely (no event, no RNG draw); any positive value enables it, and the magnitude always
 * comes from `rollDrinkSips`, never from the field's numeric value.
 *
 * **Determinism.** A roll draws exactly one `rng.next()` from the injected, seeded `Rng` that the
 * reducer threads into `scoreRound` (`ScoreRoundContext.rng`); the advanced RNG state is committed
 * back into `RoomState.rngState`. Same state in, same rolls and same state out.
 *
 * **Tiers.** Each value sits inside exactly one band of the client's `drinkActionLabel`
 * (`0` no drinking, `1` 1 sip, `2` 2 sips, `3–4` a chug, `5–7` a shot, `8+` 2 shots), so the rolled
 * number always renders as the intended action. A roll of `0` is still emitted as an event so the
 * client can announce the let-off. Weights (sum 100):
 *
 * | sips | label       | weight | why                                                          |
 * |------|-------------|--------|--------------------------------------------------------------|
 * | 0    | no drinking | 12     | a real, noticeable let-off: about one miss in eight           |
 * | 1    | 1 sip       | 30     | the bread and butter: most misses are cheap                   |
 * | 2    | 2 sips      | 28     | the old fixed value, still very common                        |
 * | 3    | a chug      | 15     | a step up that happens a few times a night                    |
 * | 6    | a shot      | 10     | rarer, a genuine "oh no" moment                               |
 * | 9    | 2 shots     | 5      | the rarest by far: one in twenty, memorable, never routine    |
 *
 * Expected value is 2.36 sips per roll, close to the old fixed 2, so an evening's total drinking
 * stays about where it was: the change is variety, not escalation. Caps still apply on top (see
 * `DEFAULT_PENALTY_CAPS`, whose `perPenalty` admits the top tier).
 */
export interface DrinkRollTier {
  readonly sips: number;
  readonly weight: number;
}

export const DRINK_ROLL_TABLE: readonly DrinkRollTier[] = [
  { sips: 0, weight: 12 },
  { sips: 1, weight: 30 },
  { sips: 2, weight: 28 },
  { sips: 3, weight: 15 },
  { sips: 6, weight: 10 },
  { sips: 9, weight: 5 },
];

const DRINK_ROLL_TOTAL_WEIGHT = DRINK_ROLL_TABLE.reduce((sum, tier) => sum + tier.weight, 0);

/** Consumes exactly one `rng.next()` and returns one of `DRINK_ROLL_TABLE`'s sip values. */
export const rollDrinkSips = (rng: Rng): number => {
  const draw = rng.next() * DRINK_ROLL_TOTAL_WEIGHT;
  let cumulative = 0;
  for (const tier of DRINK_ROLL_TABLE) {
    cumulative += tier.weight;
    if (draw < cumulative) return tier.sips;
  }
  // Only reachable if a non-conforming Rng returns >= 1: treat it as the top tier.
  return DRINK_ROLL_TABLE[DRINK_ROLL_TABLE.length - 1]?.sips ?? 0;
};

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
