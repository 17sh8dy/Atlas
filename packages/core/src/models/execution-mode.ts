/**
 * How much Atlas asks before it acts.
 *
 * Consequence — what a step actually does — always decides *whether* Atlas
 * has to ask; see `Skill.risk` and `Skill.guard`. Execution mode decides
 * *when* that question reaches the user. It never changes which steps are
 * safe and which are not, only the shape of the approval around the ones that
 * aren't — so a mode can never make a safe action ask, and never makes a
 * refused one run.
 *
 * `doIt`           — the default, and the one this concept shipped as
 *                     originally. A safe step runs; a confirm step stops and
 *                     asks, immediately before it runs.
 * `planFirst`      — for a request whose plan contains anything consequential,
 *                     the whole plan is shown once, up front, and approving it
 *                     covers every step already named in it — no re-asking per
 *                     step. A plan made entirely of safe steps never shows a
 *                     card at all: this mode does not make harmless things
 *                     slower, only consequential ones more visible in advance.
 * `confirmActions` — the same per-step gate as `doIt`, kept as its own named
 *                     mode rather than folded into it: it is the guarantee
 *                     that a plan-approval shortcut never stands in for
 *                     asking about one specific action. Pick this one to mean
 *                     "always ask me right before it happens, never in bulk."
 *
 * There is deliberately no fourth mode that removes confirmation altogether.
 * A consequential action always stops somewhere; these three only differ in
 * where that stop happens.
 */
export type ExecutionMode = 'doIt' | 'planFirst' | 'confirmActions';

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'doIt';

/** Cycle order — also the order Shift+Tab steps through. */
export const EXECUTION_MODES: readonly ExecutionMode[] = ['doIt', 'planFirst', 'confirmActions'];

export interface ExecutionModeMeta {
  /** Shown in the mode chip and in Settings. Atlas's own name, not borrowed. */
  label: string;
  /** One line explaining the mode, for Settings and a tooltip. */
  description: string;
}

export const EXECUTION_MODE_META: Record<ExecutionMode, ExecutionModeMeta> = {
  doIt: {
    label: 'Do It?',
    description: 'Handles harmless actions on its own; still asks before anything consequential.',
  },
  planFirst: {
    label: 'Plan First',
    description: 'Shows the plan and asks once before making any change, then carries it out.',
  },
  confirmActions: {
    label: 'Confirm Actions',
    description: 'Same as Do It?, but a plan can never stand in for asking about one action.',
  },
};

/** The next mode in the cycle, wrapping at the end — what Shift+Tab steps to. */
export function nextExecutionMode(current: ExecutionMode): ExecutionMode {
  const i = EXECUTION_MODES.indexOf(current);
  return EXECUTION_MODES[(i + 1) % EXECUTION_MODES.length]!;
}

/** Defends a value read back from storage — a hand-edited file, an older build. */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}
