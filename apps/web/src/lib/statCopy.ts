/** Plain-English names for Stat Duel's stats (defined by the engine's `M8_STATS`). */

export type DuelStat = 'SHOTS' | 'SHOTS_ON_TARGET' | 'GOAL_INVOLVEMENTS' | 'FEWEST_FOULS';

const LABEL: Record<DuelStat, string> = {
  SHOTS: 'Most shots',
  SHOTS_ON_TARGET: 'Most shots on target',
  GOAL_INVOLVEMENTS: 'Most goals + assists',
  FEWEST_FOULS: 'Fewest fouls',
};

const NOUN: Record<DuelStat, string> = {
  SHOTS: 'shots',
  SHOTS_ON_TARGET: 'shots on target',
  GOAL_INVOLVEMENTS: 'goals + assists',
  FEWEST_FOULS: 'fouls',
};

export const statLabel = (stat: DuelStat): string => LABEL[stat];
export const statNoun = (stat: DuelStat): string => NOUN[stat];
