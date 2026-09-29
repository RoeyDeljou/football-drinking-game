/**
 * The short text mark shown in place of a competition logo.
 *
 * League logos and club crests are registered trademarks of their owners, and the provider's media
 * terms grant no display rights. This app is alcohol-themed, which is exactly the association rights
 * holders police hardest, so it ships logo-free — the same decision the hub's Fantasy app made
 * (its BRAND_AND_DESIGN.md §10.2). The competition's name, used to identify it, is fine; its logo is not.
 */
export const competitionMonogram = (name: string): string => {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
};
