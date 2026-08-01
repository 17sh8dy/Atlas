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
    const t = String(text ?? '').trim().toLowerCase();
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
