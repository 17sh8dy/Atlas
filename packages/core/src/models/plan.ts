/**
 * A plan is what Atlas intends to do about something you said.
 *
 * Producing a plan and running it are separate on purpose. Between the two
 * sits validation: every step names a registered skill, every argument is
 * checked against that skill's declared params, and risky steps are gated.
 * Because a plan is just data, that check is total — there is no path by which
 * an instruction reaches the machine without passing through it, including
 * when the plan came from a language model.
 */

import type { SkillArgs } from './skill';

/**
 * Where a plan came from. Kept on the plan because it changes how much it
 * should be trusted and how it should be explained.
 *
 * `grammar` — matched a deterministic rule. Instant, offline, exact.
 * `ai`      — a model proposed it from novel phrasing. Always validated.
 * `routine` — a previously saved, already-validated plan being replayed.
 * `direct`  — constructed in code (a button, a result-row action).
 */
export type PlanSource = 'grammar' | 'ai' | 'routine' | 'direct';

export interface PlanStep {
  skill: string;
  args: SkillArgs;
  /** An optional line to say before this step runs. */
  say?: string;
}

export interface Plan {
  source: PlanSource;
  /** A short tag for what the user meant — used for logging and routines. */
  intent: string;
  steps: PlanStep[];
  /**
   * 0–1. Grammar matches are near-certain; AI plans carry the model's own
   * hedging. Below the engine's threshold, a plan is offered rather than run.
   */
  confidence: number;
}

/** The outcome of running one step. */
export interface StepOutcome {
  skill: string;
  ok: boolean;
  message?: string;
  error?: string;
  /** True when the user declined a confirmation. */
  skipped?: boolean;
}

export interface PlanOutcome {
  ok: boolean;
  /** How many steps completed successfully. */
  ran: number;
  outcomes: StepOutcome[];
  /** True when a failure or a refusal ended the plan early. */
  aborted: boolean;
  /** True when the emergency stop ended it. Implies `aborted`. */
  halted?: boolean;
}
