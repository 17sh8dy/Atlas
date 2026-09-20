/**
 * Asking instead of guessing.
 *
 * ── When Atlas asks ─────────────────────────────────────────────────────────
 * Only when a request genuinely lacks what it needs to go ahead — a required
 * detail is missing, or is so generic it could mean anything ("open a game").
 * It does not ask when it can reasonably finish the request, and it does not
 * ask about things a confirmation card already covers: clarification is about
 * *what* to do, confirmation is about *whether* to do something consequential,
 * and the two stay separate. A clarified step still goes through the normal
 * risk gate afterwards.
 *
 * ── A mechanism, not a special case ─────────────────────────────────────────
 * Nothing here knows about any particular app or skill. A skill says *what it
 * is missing* (`ClarifyNeed`); the executor turns that into a question with
 * the same few choices every time, asks it, and carries on with the answer:
 * fill the gap with one thing, with several things, drop just this part and
 * do the rest, or stop and let the person start over.
 *
 * The original request is never lost. The step is completed in place — the
 * plan, and every step already run, is exactly as it was — and only the
 * missing piece is supplied.
 */

/** What a skill reports when it cannot proceed without more information. */
export interface ClarifyNeed {
  /** The argument that needs a value. */
  param: string;
  /** What kind of thing is wanted, singular: "game", "app", "file". */
  noun: string;
  /** The question, in the person's terms: `What do you mean by “open a game”?` */
  question: string;
  /**
   * May the answer be several things? Default yes: "open a game" can be one
   * game or three, and offering both is faster than asking twice.
   */
  many?: boolean;
  /** Wording for the "type it in" option, when "Tell me a specific <noun>" would read badly. */
  tellLabel?: string;
  /** The input's hint for that option. */
  placeholder?: string;
  /**
   * The answer is one of a fixed set — up or down, shutdown or restart. Each
   * becomes its own button, and typing is not offered: an invented value would
   * only be refused later.
   */
  options?: Array<{ value: string; label: string }>;
  /**
   * Turn what was typed into what the skill needs ("10 minutes" → 600), or
   * return `null` if it cannot be used ("Notes" where a full path is needed).
   * Engine-internal: never sent to a surface.
   */
  normalize?: (text: string) => string | null;
  /** What to say when `normalize` refuses an answer, so the person knows what is wanted. */
  hint?: string;
}

/** One option in the question Atlas asks. */
export interface ClarifyChoice {
  /** Stable, for answering: `specific`, `several`, `skip`, `other`. */
  id: string;
  label: string;
  /** Present on an option that is itself the value: choosing it fills the gap with this. */
  value?: string;
  /**
   * Present when picking this option means typing something: the surface
   * shows an input with this hint. Absent for an option that is the whole
   * answer by itself ("Just open Steam").
   */
  input?: { placeholder: string; many?: boolean };
}

/** The question as a surface shows it. */
export interface Clarification {
  question: string;
  choices: ClarifyChoice[];
}

/** The person's reply. */
export type ClarifyAnswer =
  /** A choice that needs no typing: `skip` or `other`. */
  | { kind: 'choice'; id: string }
  /** A typed value, or several. */
  | { kind: 'text'; text: string; many: boolean }
  /** Walked away from it, or the surface cannot ask. */
  | { kind: 'cancelled' };
