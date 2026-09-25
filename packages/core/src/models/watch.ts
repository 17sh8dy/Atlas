/**
 * Atlas Watch — "keep an eye on this, and carry on when it's done."
 *
 * A watch is three things held together: a **condition** Atlas can check on
 * its own (a process exiting, a download finishing, a file appearing), a
 * **continuation** — validated plan steps to run once it holds — and the
 * **approval** the person gave for exactly those steps when the watch was made.
 *
 * Everything here is data, because a watch outlives the conversation that made
 * it and, since 1.0.3, outlives Atlas itself: it is written to storage and
 * restored on launch. So the record has to answer, on its own, the questions a
 * restart asks — was the approval for these steps? which steps already ran?
 * was one of them half-way through when the power went? — without anything
 * else in memory. See ARCHITECTURE §6.9 for the recovery rules this makes
 * possible, and `WatchManager` in `@atlas/engine` for where they live.
 */

import type { PlanStep } from './plan';

/**
 * What Atlas is waiting for. A closed set, each one something Atlas can read
 * off the machine with a call it already has — never a free-form predicate,
 * for the same reason a plan step names a skill rather than carrying code.
 */
export type WatchCondition =
  /** A running process is no longer running. `name` is its image name, `.exe` optional. */
  | { kind: 'process-exits'; name: string; label?: string }
  /** A process that was not running is now running. */
  | { kind: 'process-starts'; name: string; label?: string }
  /** Every unfinished download present when the watch began is gone, and its file is complete. */
  | { kind: 'downloads-finish'; folder: string; partials: string[] }
  /** A file or folder exists at this path. */
  | { kind: 'path-exists'; path: string }
  /** The network is reachable again. */
  | { kind: 'online' }
  /** A fixed time has passed since the watch began. */
  | { kind: 'after'; seconds: number };

export type WatchConditionKind = WatchCondition['kind'];

/**
 * Where a watch is in its life.
 *
 *  - `active`            — checking the condition.
 *  - `paused`            — not checking; the person (or the emergency stop) paused it.
 *  - `running`           — the condition held; the continuation is running now.
 *  - `awaiting-approval` — stopped for the person: a step the original approval
 *                          did not cover, or a restart left it unsure whether a
 *                          step already happened. Nothing more runs until they answer.
 *  - `done` / `failed` / `expired` / `cancelled` — finished, one way or another.
 */
export type WatchStatus =
  | 'active'
  | 'paused'
  | 'running'
  | 'awaiting-approval'
  | 'done'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** A watch that will never do anything again. */
export const FINISHED_WATCH_STATUSES: readonly WatchStatus[] = [
  'done',
  'failed',
  'expired',
  'cancelled',
];

/**
 * One continuation step's progress, persisted *before* and *after* it runs.
 *
 * `started` is the load-bearing value: it is written before the step is
 * invoked and replaced once it returns. A restored watch that finds a step
 * still `started` knows Atlas stopped in the middle of it and cannot know
 * whether it happened — so it asks rather than repeating it.
 */
export type WatchStepState = 'pending' | 'started' | 'done' | 'failed' | 'skipped';

/** Why a watch is waiting for the person. */
export interface WatchQuestion {
  kind: 'uncovered-step' | 'uncertain-step' | 'met-while-offline';
  /** One sentence, shown on the card and in the notification. */
  question: string;
  detail?: string;
  /** The continuation step the question is about, when there is one. */
  step?: number;
}

export interface WatchLogLine {
  at: number;
  text: string;
}

export interface Watch {
  id: string;
  /** What the person said, for the list — "when the build finishes, run the tests". */
  request: string;
  /** The condition in words — "Cargo exits". */
  describe: string;
  condition: WatchCondition;
  /** Validated steps to run once the condition holds. Empty = just tell me. */
  steps: PlanStep[];
  /** A readable line per step, fixed at approval time. */
  stepLabels: string[];
  stepStates: WatchStepState[];
  /**
   * The fingerprint of `steps` the person approved. A continuation step only
   * runs without a fresh card when the stored steps still hash to this — so a
   * record edited on disk cannot smuggle a new step under an old approval.
   */
  approval: string;
  status: WatchStatus;
  createdAt: number;
  expiresAt: number;
  firedAt?: number;
  finishedAt?: number;
  lastCheckedAt?: number;
  /** What the condition looked like when the watch began — see `WatchBaseline`. */
  baseline: WatchBaseline;
  question?: WatchQuestion;
  /** Short, human, newest last. Capped by the manager. */
  log: WatchLogLine[];
}

/**
 * What was true when the watch began, so "has it changed?" has an answer.
 * `process-exits` records whether the process was seen at all (a watch on
 * something already gone is refused at creation, but a restart needs to know
 * it was once there); the rest need only the start time.
 */
export interface WatchBaseline {
  startedAt: number;
  sawProcess?: boolean;
}

/** How long a watch lives by default, and at most. */
export const WATCH_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const WATCH_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setups — "get my PC ready for recording"
// ---------------------------------------------------------------------------

/**
 * One thing a setup does *and checks*. Every item is an action paired with
 * the reading that proves it worked, because the report at the end is built
 * from those readings — "OBS is running", not "I clicked OBS".
 *
 * A closed set on purpose: each kind maps to existing skills and existing
 * reads, so a setup can never do anything a single request could not, and
 * inherits every gate those skills already have.
 */
export type SetupItem =
  /** Open an app (if it isn't already) and confirm its process is running. */
  | { kind: 'open'; app: string; process?: string }
  /** Close an app's windows (asks, like any close) and confirm it is gone. */
  | { kind: 'close'; app: string; process?: string }
  /** Read the default microphone; when `expect` is set, it must contain that name. */
  | { kind: 'mic'; expect?: string }
  /** Confirm a drive has at least `minGb` free. */
  | { kind: 'storage'; drive: string; minGb: number }
  /** Put an app's window somewhere, and confirm it is there. */
  | { kind: 'place'; app: string; position: WindowPosition; display?: number }
  /** Confirm the network is reachable. */
  | { kind: 'online' };

export type SetupItemKind = SetupItem['kind'];

/** Where `window.place` can put a window, relative to a display's work area. */
export type WindowPosition =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'maximize';

export const WINDOW_POSITIONS: readonly WindowPosition[] = [
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
  'maximize',
];

export interface Setup {
  /** Lowercase, what follows "ready for" — "recording", "streaming", "work". */
  name: string;
  items: SetupItem[];
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  /** The last report, so Settings can show how it went. */
  lastReport?: string;
}

/** One line of a setup's verified report. */
export interface SetupCheck {
  item: SetupItem;
  ok: boolean;
  /** What was actually observed — "OBS is running", "347 GB free on D:". */
  observed: string;
  /** Set when the action itself was skipped (declined, not needed). */
  skipped?: boolean;
}
