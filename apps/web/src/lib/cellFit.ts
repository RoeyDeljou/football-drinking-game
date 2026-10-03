/**
 * Fitting host-written text into a small bingo cell. A cell can hold roughly a dozen letters per line at
 * 390px wide, so the font shrinks to the longest word (done in CSS from `--w`, see `.bingo-label`)
 * instead of splitting it. Display only.
 */

/** Longest word a cell may hold before it has to be shown small enough to be hard to read. */
export const MAX_COMFORTABLE_WORD = 14;

/** Characters in the longest whitespace-separated word (hyphens count as break points). */
export const longestWord = (text: string): number =>
  text
    .split(/[\s‐-―-]+/)
    .reduce((longest, word) => Math.max(longest, word.length), 0);

/** The word that is too long for a cell (so the editor can name it), or `null`. */
export const wordTooLongForCell = (text: string): string | null =>
  text.split(/[\s‐-―-]+/).find((word) => word.length > MAX_COMFORTABLE_WORD) ?? null;

/** A gentle editor hint for a label with a very long word; `null` when it fits. */
export const labelFitWarning = (text: string): string | null => {
  const word = wordTooLongForCell(text);
  return word === null ? null : `“${word}” is a long word. It will be shown small on a card, so a shorter one reads better.`;
};
