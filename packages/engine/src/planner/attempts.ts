/**
 * Bounded, goal-directed attempts for a single skill call.
 *
 * ── The problem this exists to solve ────────────────────────────────────────
 * A skill like `app.open` already knows several legitimate ways to satisfy
 * one request — an installed app, a multi-target reading of the sentence, a
 * known website — and used to try them as a chain of hand-written `if`
 * statements that all had to agree, separately, about when to stop. That
 * worked, but it made "how many things did this try?" and "did it stop the
 * instant one of them worked?" facts you had to re-derive by reading every
 * branch rather than facts the code stated once.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * This is *not* a general retry loop, an agent framework, or a place to hand
 * Atlas a goal and let it improvise. The strategy list is always written by
 * the skill that owns the goal, ahead of time — never assembled at runtime,
 * never a free-form command. Relevance is enforced by construction: a skill
 * can only declare attempts that serve *its own* declared purpose, the same
 * way it can only declare the capabilities it needs. Nothing here can decide
 * to go looking somewhere unrelated just because attempts remain.
 *
 * ── The contract ─────────────────────────────────────────────────────────
 *  - At most `MAX_ATTEMPTS` strategies ever run, however many are passed in.
 *  - Strategies run in the given order, and each one runs at most once — the
 *    array itself is the guarantee that nothing is repeated.
 *  - The first strategy that reports `final: true` stops the ladder right
 *    there, whether it succeeded or not. "Final" means *committed* — it took
 *    a real action (launched something, opened something), so the answer is
 *    that action's outcome, not a reason to go try something unrelated.
 *  - A strategy that was not applicable (wrong shape of request, nothing to
 *    act on) reports a plain failure with no `final` flag, which is the only
 *    thing that lets the ladder move on to the next relevant idea.
 *  - Exhausting every strategy without a final one is not a fabricated
 *    failure — it is the honest signal for "nothing relevant worked," which
 *    is exactly the moment a skill should turn around and ask the user
 *    rather than invent a fourth thing to try.
 */

import type { SkillResult } from '@atlas/core';

/** Small on purpose. Resilience, not autonomy — see the module doc. */
export const MAX_ATTEMPTS = 3;

export interface AttemptOutcome<T> {
  result: SkillResult<T>;
  /**
   * This strategy determined it was *the* relevant one for the request and
   * acted, so the ladder must not fall through to a different strategy
   * afterward — regardless of whether the action itself succeeded. Defaults
   * to `result.ok`: an attempt that simply wasn't applicable needs nothing
   * special, since a plain failure already lets the ladder continue.
   */
  final?: boolean;
}

export interface Attempt<T> {
  /** A short, stable id — for tests and logs, never shown to the user. */
  id: string;
  run(): AttemptOutcome<T> | Promise<AttemptOutcome<T>>;
}

export interface AttemptsLog<T> {
  /** The outcome to act on — the committed attempt's result, or the last one tried. */
  result: SkillResult<T>;
  /** True once some attempt committed. False means every strategy declined — ask the user. */
  final: boolean;
  /** Every strategy id actually run, in order. Length is capped by `MAX_ATTEMPTS`. */
  tried: string[];
}

/**
 * Run strategies in order until one commits (`final: true`) or the list —
 * capped at `MAX_ATTEMPTS` — is exhausted.
 */
export async function attemptGoal<T>(
  strategies: readonly Attempt<T>[],
  /** The emergency stop: no further strategy starts once it aborts. */
  signal?: { readonly aborted: boolean },
): Promise<AttemptsLog<T>> {
  const bounded = strategies.slice(0, MAX_ATTEMPTS);
  const tried: string[] = [];
  let last: SkillResult<T> = { ok: false, error: 'Nothing relevant to try.' };

  for (const strategy of bounded) {
    if (signal?.aborted) break;
    tried.push(strategy.id);
    const outcome = await strategy.run();
    last = outcome.result;
    const committed = outcome.final ?? outcome.result.ok;
    if (committed) return { result: last, final: true, tried };
  }

  return { result: last, final: false, tried };
}
