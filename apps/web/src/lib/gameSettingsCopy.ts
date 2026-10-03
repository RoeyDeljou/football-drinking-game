/** Wording for the game settings editor (the specs in `gameConfigSpecs.ts` carry no copy). */

import { eventLabel, type LiveEventKind } from './liveEventCopy';

export const FIELD_LABEL: Record<string, string> = {
  // M1 Match Markets
  sipsPerLostMarket: 'Sips per lost market',
  worstSlipSips: 'Sips for the worst slip',
  perfectSlipSips: 'Sips for a perfect slip (everyone else)',
  noAnswerSips: 'Sips for not answering',
  // M4 Your Man
  foulSips: 'Your man fouls',
  missSips: 'Your man misses',
  yellowSips: 'Your man is booked',
  redSips: 'Your man is sent off',
  ownGoalSips: 'Your man scores an own goal',
  goalSips: 'Your man scores (everyone else drinks)',
  assistSips: 'Your man assists (everyone else drinks)',
  includeGoalkeepers: 'Draft goalkeepers too',
  // M5 Event Roulette
  drinker: 'Who drinks when an event fires',
  windowMinutes: 'Length of a spin',
  eventKinds: 'Events that can be dealt',
  sipsPerFire: 'Sips per fire',
  labels: 'Rename the events',
  // M6 Match Bingo
  size: 'Card size',
  lineSips: 'Sips per line (everyone but the owner)',
  fullHouseSips: 'Sips for a full house (everyone but the owner)',
  cellPool: 'Bingo cells',
  houseCells: 'House cells',
  housePerCard: 'House cells per card',
  // M7 Minute Sniper
  furthestSips: 'Sips for the furthest pick',
  // M8 Stat Duel
  duelSips: 'Sips for losing a duel',
  // M9 Flash Rounds
  types: 'Question types',
  answerWindowMs: 'Time to answer',
  wrongAnswerSips: 'Sips for a wrong answer',
};

const OPTION_LABEL: Record<string, Record<string, string>> = {
  drinker: { owner: 'The owner drinks', others: 'Everyone else drinks' },
  size: { '3': '3 x 3', '4': '4 x 4' },
  types: {
    GOAL_IN_WINDOW: 'Goal in the window?',
    NEXT_GOAL_SIDE: 'Who scores next?',
    NEXT_CARD_SIDE: 'Whose is the next card?',
    CORNERS_OVER: 'Corners over a line?',
    TEAM_SHOT_ON_TARGET: 'Team shot on target?',
  },
};

export const fieldLabel = (key: string): string => FIELD_LABEL[key] ?? key;

export const optionLabel = (key: string, option: string | number): string => {
  const own = OPTION_LABEL[key]?.[String(option)];
  if (own !== undefined) return own;
  if (key === 'eventKinds' || key === 'labels') return eventLabel(option as LiveEventKind);
  return String(option);
};

export const unitLabel = (unit: string, value: number): string => {
  switch (unit) {
    case 'sips':
      return value === 1 ? 'sip' : 'sips';
    case 'minutes':
      return 'min';
    case 'ms':
      return 's';
    default:
      return '';
  }
};

/** Display value of an integer field (ms shown as seconds). */
export const displayValue = (unit: string, value: number): number => (unit === 'ms' ? value / 1000 : value);
