/**
 * Pure, deterministic matching of free-text footballer names — "did this guess name that player?".
 *
 * Built for recall games (M10 Lineup Recall; reusable for G4 Name the Top 10) where players type
 * names on a phone against the clock. The goals, in order:
 *
 * 1. **Never credit the wrong player.** A guess is credited to a target only at its best match
 *    distance, only if no *decoy* (a substitute, an opponent) matches it strictly better, and each
 *    target is credited to at most one guess.
 * 2. **Forgive how people actually type names.** Accents and case never matter ("Mbappe" =
 *    "Mbappé", "MULLER" = "Müller"); punctuation and spacing never matter ("ter Stegen" =
 *    "terstegen" = "Ter-Stegen"); a surname alone is enough ("Hakimi" for "Achraf Hakimi"), as is a
 *    compound surname with its particle ("de Jong", "van Dijk") or without it ("Dijk"), a mononym
 *    ("Vitinha"), or the first name ("Kylian", "Son" for "Son Heung-Min"); and a small typo is
 *    tolerated, scaled to the length of the name (none up to 4 letters, 1 up to 8, 2 beyond).
 * 3. **Be deterministic.** Same inputs, same credits — the assignment is a maximum bipartite
 *    matching with fixed iteration order, so a guess that could mean two players ("Hernández" when
 *    both Theo and Lucas start) never blocks a later, more specific guess ("Lucas Hernández").
 *
 * Names are data (the lineup's display `name`), never copy; nothing here is user-facing text.
 */

/** Letters that Unicode decomposition does not reduce to ASCII. */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  þ: 'th',
  ħ: 'h',
};

/** Surname particles: "de Jong", "van Dijk", "ter Stegen", "Di María", "dos Santos", "El Shaarawy", … */
const PARTICLES: ReadonlySet<string> = new Set([
  'al',
  'ben',
  'bin',
  'da',
  'das',
  'de',
  'del',
  'della',
  'den',
  'der',
  'di',
  'do',
  'dos',
  'du',
  'el',
  'la',
  'le',
  'mac',
  'st',
  'ten',
  'ter',
  'van',
  'von',
]);

/** Shortest compact guess that can match anything but a full name exactly. */
const MIN_PARTIAL_LENGTH = 3;

/**
 * Lower-case ASCII words separated by single spaces: accents stripped, special letters transliterated,
 * everything that is not a letter or digit turned into a separator. `"Marc-André ter Stegen"` →
 * `"marc andre ter stegen"`.
 */
export const normalizeName = (input: string): string =>
  input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^ -~]/gu, (char) => SPECIAL_LETTERS[char] ?? ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** `normalizeName` without separators, the form every comparison uses: `"terstegen"`. */
export const compactName = (input: string): string => normalizeName(input).replace(/ /g, '');

/**
 * Every compact form a person could reasonably use for `displayName`: the full name, every suffix
 * of it (surname, compound surname, surname with particle), and the first name. Deduplicated, in a
 * fixed order.
 */
export const nameKeys = (displayName: string): readonly string[] => {
  const tokens = normalizeName(displayName).split(' ').filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  const keys: string[] = [tokens.join('')];
  for (let start = 1; start < tokens.length; start += 1) {
    const suffix = tokens.slice(start);
    // A lone particle ("de", "van") is not a name.
    if (suffix.length === 1 && PARTICLES.has(suffix[0] ?? '')) continue;
    keys.push(suffix.join(''));
  }
  const first = tokens[0];
  if (tokens.length > 1 && first !== undefined && !PARTICLES.has(first)) keys.push(first);
  return [...new Set(keys)].filter((key) => key.length > 0);
};

/** Typos tolerated against a key of this length. */
export const typoAllowance = (keyLength: number): number => (keyLength <= 4 ? 0 : keyLength <= 8 ? 1 : 2);

/**
 * Optimal-string-alignment distance (Levenshtein plus adjacent transposition), or `max + 1` as soon
 * as the distance is known to exceed `max`.
 */
export const editDistance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    const row = table[i] ?? [];
    const prev = table[i - 1] ?? [];
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (table[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  const distance = table[rows - 1]?.[cols - 1] ?? max + 1;
  return distance > max ? max + 1 : distance;
};

export interface NameCandidate {
  readonly id: string;
  readonly name: string;
}

/**
 * How closely `guess` names `candidate`: the smallest tolerated edit distance to any of its keys, or
 * `null` when no key is close enough. A guess shorter than `MIN_PARTIAL_LENGTH` only matches a
 * full name exactly.
 */
export const nameDistance = (guess: string, candidate: NameCandidate): number | null => {
  const compact = compactName(guess);
  if (compact.length === 0) return null;
  const keys = nameKeys(candidate.name);
  let best: number | null = null;
  keys.forEach((key, index) => {
    if (compact.length < MIN_PARTIAL_LENGTH && index !== 0) return;
    const allowance = typoAllowance(key.length);
    const distance = editDistance(compact, key, allowance);
    if (distance <= allowance && (best === null || distance < best)) best = distance;
  });
  return best;
};

export type GuessStatus =
  /** Credited to `targetId`. */
  | 'matched'
  /** Names a target that another guess of the same submission was already credited with. */
  | 'duplicate'
  /** Names a decoy (e.g. a substitute) better than any target. */
  | 'decoy'
  /** Names nobody. */
  | 'unknown';

export interface GuessResult {
  readonly guess: string;
  readonly status: GuessStatus;
  /** Set only for `matched`. */
  readonly targetId: string | null;
}

export interface GuessAssignment {
  /** One entry per guess, in submission order. */
  readonly results: readonly GuessResult[];
  /** Target ids credited, in `targets` order. */
  readonly creditedIds: readonly string[];
}

/** Target ids each guess may be credited with (its best-distance targets), or a decoy/unknown verdict. */
const candidatesFor = (
  guess: string,
  targets: readonly NameCandidate[],
  decoys: readonly NameCandidate[],
): { readonly ids: readonly string[]; readonly verdict: 'targets' | 'decoy' | 'unknown' } => {
  let bestTarget: number | null = null;
  const distances = targets.map((target) => nameDistance(guess, target));
  for (const distance of distances) {
    if (distance !== null && (bestTarget === null || distance < bestTarget)) bestTarget = distance;
  }
  let bestDecoy: number | null = null;
  for (const decoy of decoys) {
    const distance = nameDistance(guess, decoy);
    if (distance !== null && (bestDecoy === null || distance < bestDecoy)) bestDecoy = distance;
  }
  // A decoy only wins when strictly closer: an equal-distance clash gives the benefit of the doubt.
  if (bestDecoy !== null && (bestTarget === null || bestDecoy < bestTarget)) return { ids: [], verdict: 'decoy' };
  if (bestTarget === null) return { ids: [], verdict: 'unknown' };
  const ids = targets.filter((_, index) => distances[index] === bestTarget).map((target) => target.id);
  return { ids, verdict: 'targets' };
};

/**
 * Credit a submission's guesses to targets: a maximum matching between guesses and the targets each
 * could mean (Kuhn's augmenting paths, guesses in order, targets in `targets` order), so ambiguity
 * never costs a player a name they did get. Pure and deterministic.
 */
export const assignGuesses = (
  guesses: readonly string[],
  targets: readonly NameCandidate[],
  decoys: readonly NameCandidate[] = [],
): GuessAssignment => {
  const options = guesses.map((guess) => candidatesFor(guess, targets, decoys));
  const ownerOf = new Map<string, number>();

  const augment = (guessIndex: number, visited: Set<string>): boolean => {
    for (const targetId of options[guessIndex]?.ids ?? []) {
      if (visited.has(targetId)) continue;
      visited.add(targetId);
      const owner = ownerOf.get(targetId);
      if (owner === undefined || augment(owner, visited)) {
        ownerOf.set(targetId, guessIndex);
        return true;
      }
    }
    return false;
  };
  guesses.forEach((_, index) => {
    augment(index, new Set());
  });

  const targetOf = new Map<number, string>();
  for (const [targetId, guessIndex] of ownerOf) targetOf.set(guessIndex, targetId);

  const results = guesses.map((guess, index): GuessResult => {
    const targetId = targetOf.get(index);
    if (targetId !== undefined) return { guess, status: 'matched', targetId };
    const verdict = options[index]?.verdict ?? 'unknown';
    return { guess, status: verdict === 'targets' ? 'duplicate' : verdict, targetId: null };
  });
  return {
    results,
    creditedIds: targets.filter((target) => ownerOf.has(target.id)).map((target) => target.id),
  };
};
