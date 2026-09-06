/**
 * The grammar — deterministic phrasings, matched in microseconds, offline.
 *
 * Most of what anyone actually types at an assistant is unambiguous. Sending
 * "open downloads" to a language model costs a network round trip, a few cents,
 * and a small chance of a wrong answer, to recognise something a regular
 * expression recognises perfectly. So the grammar runs first and the model is
 * the fallback for genuinely novel phrasing — which is what makes Atlas
 * local-first in behaviour and not just in marketing.
 *
 * ── Rules are registered, not edited in ─────────────────────────────────────
 * Every rule comes through `add()`, including the built-ins that ship with a
 * skill pack. A new domain therefore never has to modify this file, which is
 * what stops it becoming the place every feature meets. `order` interleaves
 * external rules with the built-ins; fractional values are expected and fine.
 *
 * ── Two guards worth understanding ──────────────────────────────────────────
 * `pathSafe`: a file path is a long string of ordinary English words, so
 * "open C:\Users\me\tax-notes.txt" happily matches a rule looking for the word
 * "notes". When the text contains a path, only path-aware rules may run.
 *
 * `questionSafe`: "what is the capital of Peru?" must not be answered by a
 * skill. Questions are declined by default, and a rule that legitimately
 * answers one ("where am I?") opts in by naming the intents it may claim.
 */

import type { Plan, PlanStep, SkillArgs } from '@atlas/core';

export interface GrammarRule {
  name: string;
  /** < 0 runs before the built-ins, >= 0 after. Fractions are fine. */
  order?: number;
  /** May this rule run when the text contains a file path? */
  pathSafe?: boolean;
  /** Intents this rule may claim even though the message is a question. */
  questionSafe?: readonly string[] | true;
  /** Return a plan, or null to decline and let the next rule try. */
  test(lower: string, raw: string): Plan | null;
}

/** Build one step. */
export function step(skill: string, args: SkillArgs = {}, say?: string): PlanStep {
  return say ? { skill, args, say } : { skill, args };
}

/** Build a grammar plan. Confidence defaults high — a match here is near-certain. */
export function plan(steps: PlanStep | PlanStep[], intent: string, confidence = 0.95): Plan {
  return {
    source: 'grammar',
    intent,
    steps: Array.isArray(steps) ? steps : [steps],
    confidence,
  };
}

/** Openers that make a message a question rather than an instruction. */
const QUESTION_START =
  /^(what|who|whom|whose|why|how|when|which|where\s+(?:is|are|was|were|can|do|does|did)\b|is|are|was|were|do|does|did|can|could|should|would|will|tell me about|explain|define)\b/;

/** Windows drive paths, UNC paths, and POSIX absolute paths. */
const LOOKS_LIKE_PATH = /(^|\s)(?:[a-z]:[\\/]|\\\\|~?\/)[^\s]*/i;

/**
 * "open chrome AND search youtube for fortnite" / "... THEN ...". Matched
 * once, at its first occurrence, so the sentence splits into exactly two
 * clauses — see `tryCompound` for why more than two isn't worth the risk yet.
 */
const COMPOUND_CONNECTOR = /\s+(?:and\s+then|then|and)\s+/i;

/**
 * Intents worth reconsidering as "maybe that was two commands, not one" —
 * every one of these captures *the rest of the line* as a bare identifier or
 * query ("open X", "search for X"), which is exactly what lets a second
 * instruction get swallowed as if it were part of the first.
 *
 * Deliberately NOT every intent. Free-text skills — `note-add`, `todo-add`,
 * `memory.remember` — also capture the rest of the line, but their captured
 * text is content a person wrote on purpose ("buy milk and eggs"), not a
 * second command wearing a trenchcoat. Second-guessing those would corrupt
 * a note the moment it contained the word "and". They are never in this set.
 */
const COMPOUND_OVERRIDABLE = new Set([
  'open-app',
  'open-site',
  'open-url',
  'open-browser',
  'web-search',
  'youtube-search',
  'research-search',
  'find-files',
  'images',
  'maps',
  'wikipedia',
]);

export class Grammar {
  private rules: GrammarRule[] = [];
  private sorted: GrammarRule[] | null = null;

  add(rule: GrammarRule): void {
    if (typeof rule?.test !== 'function') throw new Error(`Malformed grammar rule: ${rule?.name}`);
    this.rules.push({ ...rule, order: rule.order ?? 0 });
    this.sorted = null;
  }

  addMany(rules: readonly GrammarRule[]): void {
    for (const r of rules) this.add(r);
  }

  private chain(): GrammarRule[] {
    if (!this.sorted) {
      this.sorted = [...this.rules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return this.sorted;
  }

  /**
   * Try every rule in order; the first plan wins.
   * @returns a plan, or null when nothing matched and the message should go on
   *          to triage and then, if it's a command at all, the AI planner.
   */
  parse(text: string): Plan | null {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    const direct = this.parseDirect(raw);

    // Only reopen the question for a rule that is known to swallow the rest
    // of the line — see `COMPOUND_OVERRIDABLE`. Everything else (a note, a
    // reminder, a system command) already means exactly what it captured.
    if (!direct || COMPOUND_OVERRIDABLE.has(direct.intent)) {
      const compound = this.tryCompound(raw);
      if (compound) return compound;
    }

    return direct;
  }

  /** The ordinary single-rule chain, with no compound-splitting. */
  private parseDirect(raw: string): Plan | null {
    const lower = raw.toLowerCase();
    const hasPath = LOOKS_LIKE_PATH.test(raw);
    const isQuestion = QUESTION_START.test(lower) || raw.endsWith('?');

    for (const rule of this.chain()) {
      if (hasPath && !rule.pathSafe) continue;

      let result: Plan | null;
      try {
        result = rule.test(lower, raw);
      } catch {
        // A broken rule must not break the whole grammar.
        continue;
      }
      if (!result) continue;

      if (isQuestion && !this.allowedForQuestion(rule, result)) continue;
      return result;
    }
    return null;
  }

  /**
   * "open chrome and search youtube for fortnite" → two plans, joined.
   *
   * Each half is re-parsed from scratch, on its own, through the exact same
   * chain used for a lone sentence — never a hand-rolled second interpreter.
   * That is what makes this safe: a clause only ever contributes a step it
   * *earned* by matching a real rule unassisted, with its own leading verb.
   * "open chrome and epic games" still reaches here (its whole-string match
   * is `open-app`, which is overridable) but splits into "open chrome" /
   * "epic games" — and "epic games" alone matches nothing, having no verb —
   * so this declines and the caller falls back to `direct`, where app.open's
   * own multi-target resolution (`resolveSeveral`) already handles it as one
   * launch. Compounding only ever fires when *both* halves stand alone.
   */
  private tryCompound(raw: string): Plan | null {
    const m = COMPOUND_CONNECTOR.exec(raw);
    if (!m) return null;

    const left = raw.slice(0, m.index).trim();
    const right = raw.slice(m.index + m[0].length).trim();
    if (!left || !right) return null;

    const p1 = this.parseDirect(left);
    const p2 = this.parseDirect(right);
    if (!p1 || !p2) return null;

    // Two apps named together is one launch, not two — leave it to
    // app.open's own resolution rather than splitting it here.
    if (p1.intent === 'open-app' && p2.intent === 'open-app') return null;

    return {
      source: 'grammar',
      intent: 'compound',
      steps: [...p1.steps, ...p2.steps],
      confidence: Math.min(p1.confidence, p2.confidence),
    };
  }

  private allowedForQuestion(rule: GrammarRule, result: Plan): boolean {
    if (rule.questionSafe === true) return true;
    if (Array.isArray(rule.questionSafe)) return rule.questionSafe.includes(result.intent);
    return false;
  }

  /**
   * Is this even an instruction?
   *
   * Sits between the grammar and the AI planner. Without it, "what's the
   * capital of Peru?" gets handed to a planner that dutifully tries to find a
   * skill for it. Questions are conversation; only imperatives are worth
   * planning over.
   */
  looksActionable(text: string): boolean {
    const t = String(text ?? '')
      .trim()
      .toLowerCase();
    if (!t) return false;
    if (QUESTION_START.test(t)) return false;
    if (t.endsWith('?')) return false;
    return /\b(open|launch|start|run|show|find|search|go|take|close|hide|set|turn|enable|disable|make|create|delete|move|copy|play|stop|remind|save)\b/.test(
      t,
    );
  }

  size(): number {
    return this.rules.length;
  }
}
