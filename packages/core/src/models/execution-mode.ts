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
 * `doIt`           — the default. A safe step runs. A confirm step stops and
 *                     asks, immediately before it runs — except ordinary file
 *                     work (create, rename, move, copy, append) inside a folder
 *                     the person added to Allowed Folders, which is already an
 *                     explicit grant and runs without a second question.
 *                     Deleting is never in that group. What a UI control would
 *                     *do* is also weighed before it is pressed, in every mode.
 * `doItPlus`       — Do It +. For a task you trust: nearly everything runs without
 *                     asking, including writing files, building, running a project's
 *                     tests and scripts, installing its dependencies and local git.
 *                     It still asks before anything that cannot be taken back or that
 *                     leaves this computer — deleting for good, emptying the Recycle
 *                     Bin or a folder, installing/uninstalling software, `git push`,
 *                     ending processes, power actions (the list is
 *                     `engine/safety/dangerous.ts`). Refusals, the content policy,
 *                     Allowed Folders, the UI-consequence check, previews and the
 *                     emergency stop all still apply.
 * `planFirst`      — for a request whose plan contains anything consequential,
 *                     the whole plan is shown once, up front, and approving it
 *                     covers exactly the steps shown — no re-asking per step,
 *                     and no step that was not on the card. A plan made
 *                     entirely of safe steps never shows a card at all: this
 *                     mode does not make harmless things slower, only
 *                     consequential ones more visible in advance.
 * `confirmActions` — every consequential step is asked about on its own, right
 *                     before it happens. Nothing softens it — not Allowed
 *                     Folders, not a plan. It is the guarantee that a
 *                     plan-approval shortcut never stands in for asking about
 *                     one specific action.
 *
 * There is deliberately no mode that removes confirmation altogether. Do It +
 * asks less, never nothing: the dangerous set always stops. The others differ
 * only in where that stop happens.
 */
export type ExecutionMode = 'doIt' | 'doItPlus' | 'planFirst' | 'confirmActions';

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'doIt';

/** Cycle order — also the order Shift+Tab steps through. */
export const EXECUTION_MODES: readonly ExecutionMode[] = ['doIt', 'doItPlus', 'planFirst', 'confirmActions'];

export interface ExecutionModeMeta {
  /** Shown in the mode chip and in Settings. Atlas's own name, not borrowed. */
  label: string;
  /** One line explaining the mode, for Settings and a tooltip. */
  description: string;
}

export const EXECUTION_MODE_META: Record<ExecutionMode, ExecutionModeMeta> = {
  doIt: {
    label: 'Do It?',
    description:
      'Handles harmless actions automatically. Always asks before consequential actions.',
  },
  doItPlus: {
    label: 'Do It +',
    description:
      'Does much more without asking: writing files, building, running a project and its tests. Still asks before anything dangerous: deleting for good, emptying the Recycle Bin or a folder, installing or uninstalling software, pushing to the internet, ending programs, or power actions. Use it for work you trust Atlas with.',
  },
  planFirst: {
    label: 'Plan First',
    description:
      'Shows you the plan and asks once before making approved changes. Carries out only the approved plan.',
  },
  confirmActions: {
    label: 'Confirm Actions',
    description:
      'Handles harmless actions automatically, but requires separate approval for every consequential action. A plan never counts as approval.',
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
