/**
 * K7 — a model's reply is checked against the passages it was given.
 *
 * The model is told to answer only from the reference, but a told model can still invent a number.
 * So code checks the part that is easy to check and expensive to get wrong: every number, version
 * string and `code-formatted` name in the reply must appear in the reference (or in the question).
 * One that does not fails the whole reply, and the verbatim passages are shown instead.
 *
 * This is not a truth check. It catches invented specifics, not a wrong sentence made of right words.
 */

const LIST_MARKER = /^\s*\d{1,2}[.)]\s/;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const CODE = /`([^`\n]{1,60})`/g;

/** Lower-case, and thousands separators dropped, so "1,000" and "1000" agree. */
function norm(s: string): string {
  return s.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
}

/** The specifics in a reply that must be backed: numbers (not list markers) and code-formatted names. */
export function claimsIn(reply: string): string[] {
  const claims = new Set<string>();
  for (const line of reply.split('\n')) {
    const body = line.replace(LIST_MARKER, '');
    for (const m of body.matchAll(NUMBER)) claims.add(norm(m[0]).replace(/[.,]+$/, ''));
    for (const m of body.matchAll(CODE)) claims.add(norm(m[1]!.trim()));
  }
  return [...claims].filter((c) => c.length > 0);
}

/**
 * The claims in `reply` that `reference` (and the question) do not contain. Empty means the reply passes.
 * A number matches as a whole token, so "20" is not backed by "2026".
 */
export function unbackedClaims(reply: string, reference: string, question = ''): string[] {
  const haystack = norm(`${reference}\n${question}`);
  const tokens = new Set(haystack.match(NUMBER)?.map((n) => n.replace(/[.,]+$/, '')) ?? []);
  return claimsIn(reply).filter((c) => (/^\d/.test(c) ? !tokens.has(c) : !haystack.includes(c)));
}
