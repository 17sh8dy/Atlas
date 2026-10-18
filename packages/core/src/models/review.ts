/**
 * Code review: what an edit to a file changed, as data a surface can show.
 *
 * These are plain types and nothing else. Computing a diff lives in `@atlas/engine`; showing one lives
 * in the web app; keeping the "before" copy so an edit can be undone lives natively. This module is the
 * shared language between them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THIS VOCABULARY EXISTS TO ENFORCE: A PROPOSAL IS NEVER DRESSED AS A FACT.
 *
 *   `proposed` — shown on a confirmation card. NOTHING HAS BEEN WRITTEN. Declining leaves the file
 *                exactly as it was.
 *   `applied`  — written to disk, with a checkpoint (the text from before) so it can be undone.
 *   `kept`     — written, and you said you are happy with it.
 *   `reverted` — written, then put back to what it was before.
 *
 * A surface must say which of these it is showing, in words, and must never describe an `applied`
 * change as one that "would" happen.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

export type ReviewStatus = 'proposed' | 'applied' | 'kept' | 'reverted';

/** One line of a diff. `oldNo` is absent on an added line, `newNo` on a removed one. */
export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** A run of changes with a few unchanged lines around it, like `git diff`. */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/** One file's change, ready to show. */
export interface FileReview {
  /** Full path of the file. */
  path: string;
  /** Just the file's name, for lists. */
  name: string;
  status: ReviewStatus;
  /** Lines added and removed. Honest counts even when `hunks` is null. */
  added: number;
  removed: number;
  /**
   * The changes, line by line. `null` when the file was too large or too different to compare
   * line by line; the counts are then all there is, and `note` says so.
   */
  hunks: DiffHunk[] | null;
  /** Set once the change has been written and checkpointed; how a later undo finds it. */
  changeId?: string;
  /** Anything the reader should know that is not in the lines: "only line endings changed", "no undo". */
  note?: string;
}

/** What a card or a message shows: the files an action changes or changed. */
export interface ReviewPayload {
  files: FileReview[];
}

/** What is kept natively about one written change, for undo and for review later. */
export interface ChangeMeta {
  id: string;
  path: string;
  name: string;
  /** Milliseconds since the epoch. */
  at: number;
  status: Exclude<ReviewStatus, 'proposed'>;
  added: number;
  removed: number;
  /** Which skill wrote it, e.g. `code.edit`. */
  source: string;
  /** The file was edited by hand in the review panel after Atlas wrote it. */
  edited?: boolean;
}

/** A change with both sides of it: what the file was, and what Atlas made it. */
export interface ChangeRecord extends ChangeMeta {
  before: string;
  after: string;
}

/**
 * How an undo or an edit ended. A file that has changed since Atlas wrote it is `conflict`: it is
 * left exactly as it is, because Atlas will not overwrite work it did not do.
 */
export type ChangeOutcome =
  | { ok: true; outcome: 'reverted' | 'already' | 'kept' | 'edited'; message: string }
  | { ok: false; outcome: 'conflict' | 'missing' | 'unknown' | 'denied' | 'too-large'; message: string };
