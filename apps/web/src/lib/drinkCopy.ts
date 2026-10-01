/**
 * The single place alcohol-explicit copy lives. The engine only ever emits neutral
 * `RecordedPenalty`s (`{ reason, target, appliedSips, ... }`) — every "drink"/"sip"/"down it" word
 * in the app is rendered through the functions below, so a wording change never touches more than
 * this file.
 */

import type { PenaltyReason, PenaltyTarget, RecordedPenalty } from '@fdg/game-core';

export const sipsLabel = (sips: number): string => (sips === 1 ? '1 sip' : `${sips} sips`);

/**
 * Turns a raw applied-sip count into a varied, colloquial drinking instruction instead of always
 * reading "N sips" — a capped/reduced penalty genuinely says "no drinking" rather than "0 sips",
 * and a big enough penalty escalates to a chug or a shot instead of just a bigger number. Thresholds
 * key off the same `appliedSips`/`sips` value the engine already emits (`RecordedPenalty`,
 * `PenaltyEvent`), so retuning or adding a tier here never needs an engine change — this stays the
 * one file that owns drinking wording, per CLAUDE.md's drink-copy invariant.
 */
const DRINK_ACTION_TIERS: readonly { readonly maxSips: number; readonly label: string }[] = [
  { maxSips: 0, label: 'no drinking' },
  { maxSips: 1, label: '1 sip' },
  { maxSips: 2, label: '2 sips' },
  { maxSips: 4, label: 'a chug' },
  { maxSips: 7, label: 'a shot' },
  { maxSips: Infinity, label: '2 shots' },
];

export const drinkActionLabel = (sips: number): string =>
  DRINK_ACTION_TIERS.find((tier) => sips <= tier.maxSips)?.label ?? '2 shots';

const REASON_COPY: Record<PenaltyReason, string> = {
  WRONG_ANSWER: 'wrong answer',
  NO_ANSWER: "didn't answer in time",
  LATE_ANSWER: 'answered too late',
  LAST_CORRECT: 'slowest correct answer',
  DISTANCE_FROM_TARGET: 'missed the number',
  LOST_MARKET: 'lost a market on the slip',
  WORST_SLIP: 'worst slip of the round',
  PERFECT_SLIP: 'someone nailed a perfect slip',
  LOWEST_SCORE: 'lowest score',
  ROUND_WON: 'someone else won the round',
  PERFECT_ROUND: 'perfect round',
  ASSIGNED_EVENT_FIRED: 'their event fired',
  BINGO_LINE: 'bingo line',
  BINGO_FULL_HOUSE: 'bingo full house',
  DUEL_LOST: 'lost the duel',
  CHAIN_BROKEN: 'broke the chain',
  HOST_MANUAL: 'house rule from the host',
};

export const penaltyReasonCopy = (reason: PenaltyReason): string => REASON_COPY[reason];

const targetVerb = (target: PenaltyTarget): string => {
  switch (target) {
    case 'self':
      return 'downs';
    case 'others':
      return 'makes everyone else down';
    case 'everyone':
      return 'makes the whole table down';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
};

/** One line of alcohol-explicit copy for a single recorded penalty, from the recipient's name. */
export const drinkLine = (penalty: RecordedPenalty, recipientNickname: string): string => {
  if (penalty.appliedSips <= 0) return `${recipientNickname} gets away with it this time.`;
  const action = drinkActionLabel(penalty.appliedSips);
  return `${recipientNickname} ${penalty.target === 'self' ? 'downs' : 'drinks'} ${action} — ${penaltyReasonCopy(penalty.reason)}.`;
};

/** The "who made this happen" framing, for a compact reveal feed grouped by source penalty. */
export const drinkAnnouncement = (penalty: RecordedPenalty, subjectNickname: string): string => {
  if (penalty.appliedSips <= 0) {
    return `${subjectNickname} gets away with it this time — ${penaltyReasonCopy(penalty.reason)}.`;
  }
  return `${subjectNickname} ${targetVerb(penalty.target)} ${drinkActionLabel(penalty.appliedSips)} — ${penaltyReasonCopy(
    penalty.reason,
  )}.`;
};

/**
 * Live pitch games (Event Roulette, Match Bingo) drink mid-round, so their copy is built from the
 * public payload's own numbers (sips per fire / line / full house) as events land. Same drink
 * wording as everywhere else (`drinkActionLabel`), one file.
 *
 * `kindLabel` is the dealt event's display name ("Corner"); `owner` is the holder's nickname.
 */
export const eventFiredLine = (
  kindLabel: string,
  ownerNames: readonly string[],
  drinker: 'owner' | 'others',
  sips: number,
): string => {
  const owners = ownerNames.join(' and ');
  const action = drinkActionLabel(sips);
  return drinker === 'owner'
    ? `${kindLabel}! ${owners} drinks ${action}.`
    : `${kindLabel}! ${owners} ${ownerNames.length === 1 ? 'is' : 'are'} safe, everyone else drinks ${action}.`;
};

/** What the deal means for a viewer, in one glanceable line. */
export const eventRuleLine = (drinker: 'owner' | 'others', sips: number): string =>
  drinker === 'owner'
    ? `When your event fires, you drink ${drinkActionLabel(sips)}.`
    : `When your event fires, everyone else drinks ${drinkActionLabel(sips)}.`;

export const bingoLineCall = (ownerName: string, sips: number): string =>
  `Line! Everyone but ${ownerName} drinks ${drinkActionLabel(sips)}.`;

export const bingoFullHouseCall = (ownerName: string, sips: number): string =>
  `Full house! ${ownerName} is done, everyone else downs ${drinkActionLabel(sips)}.`;

/** One recipient's total for a round, after caps. */
export const roundDrinkTotalLine = (nickname: string, sips: number): string =>
  sips <= 0 ? `${nickname} gets away with it.` : `${nickname} downs ${drinkActionLabel(sips)}.`;

export const drinkTallyHeadline = (totalSips: number): string =>
  totalSips === 0 ? 'Nobody owes a single sip. Suspicious.' : `${sipsLabel(totalSips)} owed on the table.`;

export const RESPONSIBLE_DRINKING_NOTICE =
  'Drink responsibly. This game is 18+, sips are a suggestion not a rule, and water is always a valid substitute.';
