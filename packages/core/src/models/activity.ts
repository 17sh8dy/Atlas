/**
 * What Atlas is doing right now, as something a person can watch.
 *
 * ── Observable actions, never reasoning ─────────────────────────────────────
 * This is a log of **what Atlas did to the world**: the query it sent, the
 * folder it looked in, the application it reached for, the file it read. Every
 * entry corresponds to something that actually happened outside the process —
 * an HTTP request, a directory walk, a Win32 call.
 *
 * It is deliberately not a thinking-out-loud channel. There is no field here
 * for a plan being considered, a hypothesis, a reason for choosing one action
 * over another, or a model's intermediate tokens. That is a product rule as
 * much as a privacy one: a panel that mixes "I searched Microsoft's docs for
 * this error" with "I wonder whether the user meant…" trains people to read
 * speculation as fact. `detail` is for the *parameters and results* of an
 * action, which is why every field below names a thing rather than a thought.
 *
 * ── Why the engine emits and renders nothing ────────────────────────────────
 * Steps are published on the bus (`activity:*`) and the surface decides what a
 * step looks like — same split as `ResultRow`. The engine has no opinion about
 * disclosure arrows, and could not have one.
 */

export type ActivityState = 'running' | 'done' | 'failed' | 'skipped' | 'halted';

/**
 * A single observable thing Atlas did, or is doing.
 *
 * Steps nest one level: a plan's step owns whatever that skill reported while
 * it ran ("Searching the web" → "Querying DuckDuckGo", "Reading 3 results").
 * One level, not a tree, because two is already deeper than anybody reads and
 * the indentation stops being legible.
 */
export interface ActivityStep {
  id: string;
  /** What this is, in the user's language: "Searching the web". */
  label: string;
  /**
   * The specifics — the query, the path, the app name, the result count.
   * Facts about the action, never commentary about it.
   */
  detail?: string;
  state: ActivityState;
  /** Epoch ms when this started. */
  startedAt: number;
  /** Epoch ms when it finished; absent while running. */
  endedAt?: number;
  /** The skill behind it, so a surface can pick an icon without string-matching a label. */
  skill?: string;
  /** Sub-steps this skill reported while running. One level only. */
  children?: ActivityStep[];
}

/** One run of a plan, from the ask to the last step. */
export interface ActivityRun {
  id: string;
  /** What was asked, so a collapsed run still says what it was for. */
  request: string;
  startedAt: number;
  endedAt?: number;
  steps: ActivityStep[];
  state: ActivityState;
}

/**
 * The progress channel handed to a skill.
 *
 * Optional everywhere: a skill that reports nothing is not broken, it just has
 * nothing worth saying, and most don't. `math.calculate` finishing in a
 * microsecond has no progress to report and should not pretend otherwise.
 *
 * The contract is narrow on purpose — a label and a detail string, both of
 * which are shown verbatim. There is no level, no percentage and no ETA,
 * because a skill that could honestly produce any of those is rare and the
 * ones that can't would end up inventing them.
 */
export interface ActivityReporter {
  /**
   * Report an observable action. Returns a handle to close it out, so a
   * caller that reports a start always has a way to report the end.
   */
  step(label: string, detail?: string): ActivityHandle;
  /** A one-shot action with no meaningful duration. */
  note(label: string, detail?: string): void;
}

export interface ActivityHandle {
  /** Replace the detail while it runs — "3 results" becoming "7 results". */
  update(detail: string): void;
  done(detail?: string): void;
  failed(detail?: string): void;
}

/** The elapsed time of a step, in the short form a status line wants. */
export function elapsedLabel(step: ActivityStep, now: number): string {
  const end = step.endedAt ?? now;
  const ms = Math.max(0, end - step.startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/** The one-line summary of a run, for the collapsed row. */
export function summarizeRun(run: ActivityRun): string {
  const done = run.steps.filter((s) => s.state === 'done').length;
  const running = run.steps.find((s) => s.state === 'running');
  if (running) return running.label;
  if (run.state === 'halted') return `Stopped after ${done} of ${run.steps.length} actions`;
  if (!run.steps.length) return 'Nothing to do';
  return done === run.steps.length
    ? `Ran ${run.steps.length} action${run.steps.length === 1 ? '' : 's'}`
    : `${done} of ${run.steps.length} actions completed`;
}
