/**
 * Fuzzy matching, for every kind of name Atlas has to recognise.
 *
 * This started life inside `app.open`, where it existed to rescue
 * "Steelseires" and "steelseries.gg". Nothing about it was ever specific to
 * applications, so it lives here now and the app matcher is one caller among
 * several — websites, games, commands and remembered aliases all resolve
 * through the same chain, and anything added later gets typo tolerance by
 * importing this rather than by growing its own table.
 *
 * ── Why not a typo dictionary ───────────────────────────────────────────────
 * "youtub", "youtbe", "yotube", "yuotube", "youtube" — a dictionary needs a
 * row for each and still misses the sixth. Edit distance covers all of them
 * with one rule, and stays correct for names nobody has typed yet. The only
 * hand-maintained table left is a short list of *colloquial* names ("vscode"),
 * which are not misspellings at all and cannot be derived.
 *
 * ── Confidence, not permissiveness ──────────────────────────────────────────
 * Every match carries a rank, and the budget scales with word length so a
 * four-letter name will not fuzzily become a different four-letter name. A
 * caller that gets several typo-grade matches back is expected to ask rather
 * than pick — guessing wrong here launches the wrong program.
 */

/**
 * How names are compared: lowercase, alphanumerics only.
 *
 * "SteelSeries GG", "steelseries.gg" and "Steel Series GG" all reduce to the
 * same key, which is what makes the spacing, capitalisation and punctuation
 * people actually type stop mattering.
 */
export function matchKey(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Damerau-Levenshtein distance, capped early.
 *
 * Plain Levenshtein charges 2 for a transposition, which is the single most
 * common typing mistake ("steelseires", "youtbe"). Counting it as 1 is the
 * difference between finding the thing and claiming it doesn't exist.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious: number[] = [];

  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...Array<number>(b.length).fill(0)];
    let best = current[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, beforePrevious[j - 2]! + 1);
      }
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * A typo budget that grows with the word: nothing short, never more than two.
 *
 * Both ends are set by a case that has to work.
 *
 * Zero below five characters: "Edge" and "Edit" are one edit apart, and so are
 * "mail" and "maps". At that length a tolerant match is a coin flip, so
 * exactness is the only honest answer.
 *
 * Two from eight characters up: "fortnigt" is two substitutions from
 * "Fortnite" and is obviously Fortnite. One edit is not enough for real typing.
 *
 * And two is the ceiling, not three, because at three "crosshairzzz" starts
 * matching "CrosshairX" — which is far enough off that the right response is
 * to offer it, not to launch it. `nearMatches` is what covers that distance.
 */
export function typoBudget(key: string): number {
  if (key.length <= 4) return 0;
  if (key.length <= 7) return 1;
  return 2;
}

/** Ranks, lowest first. Named so call sites can reason about confidence. */
export const RANK = {
  exact: 0,
  prefix: 1,
  contains: 2,
  alias: 3,
  /** Anything at or above this was a guess. Callers should ask, not act. */
  typo: 4,
} as const;

export interface Match<T> {
  item: T;
  /** Lower is better. Compare against `RANK.typo` to tell certainty from guess. */
  rank: number;
}

export interface MatchOptions {
  /**
   * Skip the typo pass. For a list where a wrong hit is expensive and the
   * caller would rather report nothing than a guess.
   */
  exactOnly?: boolean;
}

/**
 * Rank candidates against what the user typed.
 *
 * The chain is ordered by how sure each step is: an exact key, then a prefix,
 * then a containment ("steelseries gg" finding "SteelSeries GG Client"), then
 * a typo-tolerant pass. Anything looser than this starts matching the wrong
 * thing, which is worse than saying "I couldn't find it".
 *
 * `namesOf` may return several names for one item — a display name plus its
 * aliases — and the best-scoring one wins, so an item is never penalised for
 * being known by more than one name.
 */
export function rankMatches<T>(
  items: readonly T[],
  wanted: string,
  namesOf: (item: T) => string | readonly string[],
  options: MatchOptions = {},
): Match<T>[] {
  const key = matchKey(wanted);
  if (!key) return [];

  const keysFor = (item: T): string[] => {
    const names = namesOf(item);
    const list = typeof names === 'string' ? [names] : names;
    return list.map(matchKey).filter(Boolean);
  };

  const confident: Match<T>[] = [];
  for (const item of items) {
    let best = Infinity;
    for (const candidate of keysFor(item)) {
      if (candidate === key) best = Math.min(best, RANK.exact);
      else if (candidate.startsWith(key)) {
        best = Math.min(best, RANK.prefix + candidate.length / 1000);
      } else if (candidate.includes(key)) {
        best = Math.min(best, RANK.contains + candidate.length / 1000);
      }
    }
    if (best !== Infinity) confident.push({ item, rank: best });
  }
  if (confident.length) return confident.sort((a, b) => a.rank - b.rank);
  if (options.exactOnly) return [];

  const budget = typoBudget(key);
  if (budget === 0) return [];

  const guesses: Match<T>[] = [];
  for (const item of items) {
    let best = Infinity;
    for (const candidate of keysFor(item)) {
      const distance = editDistance(key, candidate, budget);
      if (distance <= budget) best = Math.min(best, distance);
    }
    if (best !== Infinity) guesses.push({ item, rank: RANK.typo + best });
  }
  return guesses.sort((a, b) => a.rank - b.rank);
}

/**
 * Candidates close enough to *offer*, which is a wider net than close enough
 * to *act on*.
 *
 * The two thresholds are deliberately different. Launching the wrong program
 * is a real cost, so `rankMatches` stays strict; putting a wrong name in a
 * "did you mean?" list costs a glance, so this is generous. Collapsing them
 * turns a helpful list into "I can't find it", which is the worse answer.
 */
export function nearMatches<T>(
  items: readonly T[],
  wanted: string,
  namesOf: (item: T) => string | readonly string[],
  maxDistance?: number,
): Match<T>[] {
  const key = matchKey(wanted);
  if (!key) return [];

  // Proportional, not a flat number. A fixed distance of 6 means a six-letter
  // name is within reach of *everything* installed, so "zzzqqq" comes back
  // with a confident list of unrelated programs — worse than saying it found
  // nothing, because it looks like an answer.
  const limit = maxDistance ?? Math.max(2, Math.ceil(key.length * 0.6));

  const out: Match<T>[] = [];
  for (const item of items) {
    const names = namesOf(item);
    const list = typeof names === 'string' ? [names] : names;
    let best = Infinity;
    for (const name of list) {
      const distance = editDistance(key, matchKey(name), limit);
      if (distance <= limit) best = Math.min(best, distance);
    }
    if (best !== Infinity) out.push({ item, rank: best });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * The single best match, but only when it is safe to act on without asking.
 *
 * Returns null when the best candidate was a typo-grade guess and something
 * else scored equally — that is the case where picking one is a coin flip, and
 * the caller should show the options instead.
 */
export function confidentMatch<T>(matches: readonly Match<T>[]): T | null {
  const best = matches[0];
  if (!best) return null;
  if (best.rank < RANK.typo) return best.item;

  const tied = matches.filter((m) => m.rank === best.rank);
  return tied.length === 1 ? best.item : null;
}
