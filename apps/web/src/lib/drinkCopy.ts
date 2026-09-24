/**
 * The single place alcohol-explicit copy lives. The engine only ever emits neutral
 * `RecordedPenalty`s (`{ reason, target, appliedSips, ... }`) — every "drink"/"sip"/"down it" word
 * in the app is rendered through the functions below, so a wording change never touches more than
 * this file.
 */

import type { PenaltyReason, PenaltyTarget, RecordedPenalty } from '@fdg/game-core';

export const sipsLabel = (sips: number): string => (sips === 1 ? '1 sip' : `${sips} sips`);

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
  ASSIGNED_EVENT_FIRED: 'their assigned event fired',
  BINGO_LINE: 'bingo line',
  BINGO_FULL_HOUSE: 'full house',
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
  const sips = sipsLabel(penalty.appliedSips);
  if (penalty.appliedSips <= 0) return `${recipientNickname} gets away with it this time.`;
  return `${recipientNickname} ${penalty.target === 'self' ? 'downs' : 'drinks'} ${sips} — ${penaltyReasonCopy(penalty.reason)}.`;
};

/** The "who made this happen" framing, for a compact reveal feed grouped by source penalty. */
export const drinkAnnouncement = (penalty: RecordedPenalty, subjectNickname: string): string =>
  `${subjectNickname} ${targetVerb(penalty.target)} ${sipsLabel(penalty.appliedSips)} — ${penaltyReasonCopy(
    penalty.reason,
  )}.`;

export const drinkTallyHeadline = (totalSips: number): string =>
  totalSips === 0 ? 'Nobody owes a single sip. Suspicious.' : `${sipsLabel(totalSips)} owed on the table.`;

export const RESPONSIBLE_DRINKING_NOTICE =
  'Drink responsibly. This game is 18+, sips are a suggestion not a rule, and water is always a valid substitute.';
