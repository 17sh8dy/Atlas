/**
 * Recovering an obvious typo in the leading word of an instruction —
 * "openn fortnite" → "open fortnite", "launh discord" → "launch discord".
 *
 * ── Why this is a separate, narrow pass ─────────────────────────────────────
 * `text/fuzzy.ts` already forgives a typo'd *name* ("Steelseires" →
 * SteelSeries) once a grammar rule has captured it — but every rule captures
 * a name only after matching a literal verb first (`appOpen`'s regex is
 * anchored on `open|launch|start|run`, nothing looser). A typo in the verb
 * itself never reaches that far: the rule's regex simply fails to match, the
 * message falls through every other rule the same way, and — if a provider
 * happens to be configured — it lands in front of one, which is how a
 * misspelled "open" turns into "I couldn't reach that provider." An app name
 * has an open-ended vocabulary an assistant cannot fully know in advance;
 * the instruction verbs are the opposite, a short closed list the grammar
 * already commits to (`Grammar.COMMAND_VERBS`) — which is exactly the shape
 * `fuzzy.ts`'s edit-distance matching was built for, reused here rather than
 * re-implemented.
 *
 * ── Why only the first word ──────────────────────────────────────────────────
 * Every rule this feeds is anchored at the start of the string, so the verb
 * *is* the first word by construction once filler has been stripped
 * (`normalize.ts` runs before this, in `Engine.ask`'s retry chain). Scanning
 * further into the sentence would risk "correcting" a word that was never
 * meant as a verb — a note's own content, an app name, a search query — for
 * no benefit, since nothing downstream reads a verb from anywhere else.
 *
 * ── Why an exact verb is never touched ──────────────────────────────────────
 * "go open the file" should not have its `go` rewritten to `go` — obviously
 * — but more importantly a word that already *is* a known verb is left alone
 * even when another verb is one edit away ("set" vs "get" is one
 * substitution), because there is nothing to correct: the grammar already
 * understands it.
 *
 * ── Confidence, not permissiveness — same rule as `fuzzy.ts` ────────────────
 * A correction is only ever made when exactly one verb is within budget and
 * closer than every other. Two verbs tying, or nothing within budget, both
 * mean "decline" — the caller falls through to whatever it would have done
 * without this pass (the AI planner if one is configured, or the honest
 * clarifying question in `Engine.unresolvedReply`), never a guess between two
 * different actions. This is also why a corrected verb never changes *risk*:
 * it only ever resolves to the one word the grammar would have matched had
 * it been typed correctly, so a typo'd "delete" still reaches `file.delete`
 * exactly as written, with the same confirmation gate it always had — this
 * pass runs before a single rule sees the text, nowhere near the executor's
 * risk check.
 */

import { editDistance, typoBudget } from './fuzzy';
import { COMMAND_VERBS } from '../planner/grammar';

/**
 * Correct the leading word of `text` against the closed instruction-verb
 * vocabulary, or return `null` when there is nothing safe to correct —
 * already exact, no candidate within budget, or more than one tied.
 *
 * Never mutates anything past the first word; the rest of the string is
 * carried through untouched, whitespace included.
 */
export function correctLeadingVerb(text: string): string | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const split = /^(\S+)(\s.*)?$/.exec(trimmed);
  if (!split) return null;
  const [, firstWord, rest = ''] = split;
  const lower = firstWord!.toLowerCase();

  // Already a real verb (or not a word at all) — nothing to fix.
  if ((COMMAND_VERBS as readonly string[]).includes(lower)) return null;

  // Same length-scaled budget names use, and for the same reason: nothing
  // short enough to be a coin flip gets "corrected" at all. This is also
  // what keeps a real word that happens to be four letters or fewer — "take",
  // "stop", "save" typed correctly — from ever being second-guessed, since a
  // budget of 0 means only an exact match (already handled above) counts.
  const budget = typoBudget(lower);
  if (budget === 0) return null;

  let bestDistance = budget + 1;
  let bestVerbs: string[] = [];
  for (const verb of COMMAND_VERBS) {
    const distance = editDistance(lower, verb, budget);
    if (distance > budget) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestVerbs = [verb];
    } else if (distance === bestDistance) {
      bestVerbs.push(verb);
    }
  }
  if (bestVerbs.length !== 1) return null;

  return bestVerbs[0] + rest;
}
