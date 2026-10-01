/**
 * Display names for the live-event vocabulary shared by Event Roulette and Match Bingo (the kinds
 * are defined by the engine's `live-event-kinds.ts`; this only words them for the screen).
 */

export type LiveEventKind =
  | 'CORNER'
  | 'OFFSIDE'
  | 'FOUL'
  | 'CARD'
  | 'SUBSTITUTION'
  | 'SHOT_ON_TARGET'
  | 'SHOT_OFF_TARGET'
  | 'GOAL';

const SINGULAR: Record<LiveEventKind, string> = {
  CORNER: 'corner',
  OFFSIDE: 'offside',
  FOUL: 'foul',
  CARD: 'card',
  SUBSTITUTION: 'substitution',
  SHOT_ON_TARGET: 'shot on target',
  SHOT_OFF_TARGET: 'shot off target',
  GOAL: 'goal',
};

const PLURAL: Record<LiveEventKind, string> = {
  CORNER: 'corners',
  OFFSIDE: 'offsides',
  FOUL: 'fouls',
  CARD: 'cards',
  SUBSTITUTION: 'substitutions',
  SHOT_ON_TARGET: 'shots on target',
  SHOT_OFF_TARGET: 'shots off target',
  GOAL: 'goals',
};

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** "Corner", "Shot on target": the dealt event's name. */
export const eventLabel = (kind: LiveEventKind): string => capitalise(SINGULAR[kind]);

const ARTICLE = (word: string): string => (/^[aeiou]/.test(word) ? 'An' : 'A');

/**
 * A bingo cell's label from its `{ event, side, count }`: "A corner", "3 fouls", "Arsenal shot on
 * target". `teamName` is the side's team name (or `null` for either team).
 */
export const bingoCellLabel = (event: LiveEventKind, count: number, teamName: string | null): string => {
  // A bingo cell is a small square: "sub" keeps a 13-letter word from having to break at 320px.
  const noun = event === 'SUBSTITUTION' ? (count === 1 ? 'sub' : 'subs') : count === 1 ? SINGULAR[event] : PLURAL[event];
  if (teamName !== null) return count === 1 ? `${teamName} ${noun}` : `${teamName}: ${count} ${noun}`;
  return count === 1 ? `${ARTICLE(noun)} ${noun}` : `${count} ${noun}`;
};

/** "34'" or "45+2'". */
export const minuteLabel = (minute: number, extraMinute: number | null): string =>
  extraMinute !== null && extraMinute > 0 ? `${minute}+${extraMinute}'` : `${minute}'`;
