/**
 * The words and arithmetic of code review, kept apart from the screens so they can be tested.
 *
 * The rule the wording exists to uphold, and the tests hold: **a proposal is never described as a
 * fact, and a fact is never described as a proposal.** A change that has been written says it was
 * written; one that has not says nothing has changed. Nothing here ever says "would" about
 * something that happened or "applied" about something that did not.
 */

import type { FileReview, ReviewPayload, ReviewStatus } from '@atlas/core';

export interface StatusWords {
  /** The badge. */
  label: string;
  /** One plain sentence about the state of the file on disk. */
  detail: string;
  tone: 'pending' | 'done' | 'kept' | 'undone';
}

export const STATUS_WORDS: Record<ReviewStatus, StatusWords> = {
  proposed: { label: 'Proposed', detail: 'Not written yet. Nothing in this file has changed.', tone: 'pending' },
  applied: { label: 'Applied', detail: 'Written to your file. Keep it, or undo it.', tone: 'done' },
  kept: { label: 'Kept', detail: 'Written to your file, and you kept it.', tone: 'kept' },
  reverted: { label: 'Reverted', detail: 'Written, then put back as it was before.', tone: 'undone' },
};

/** What a confirmation card with a diff says about itself, which depends on how it was answered. */
export function proposalHeading(answered: 'yes' | 'no' | 'halted' | undefined): string {
  switch (answered) {
    case 'yes':
      return 'You approved this change.';
    case 'no':
      return 'Declined. Nothing was written to your files.';
    case 'halted':
      return 'Stopped before this ran. Nothing was written.';
    default:
      return 'Proposed change. Nothing has been written to your files yet.';
  }
}

/** "+12 −3", for a badge. */
export function countsLabel(f: Pick<FileReview, 'added' | 'removed'>): string {
  return `+${f.added} −${f.removed}`;
}

/** "2 files · +12 −3": the one-line summary of a payload. */
export function summaryLine(review: ReviewPayload): string {
  const files = review.files;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `${files.length} file${files.length === 1 ? '' : 's'} · +${added} −${removed}`;
}

/** Whether a file's change can be undone from here: it was written and a checkpoint exists. */
export function canUndo(f: Pick<FileReview, 'status' | 'changeId'>): boolean {
  return (f.status === 'applied' || f.status === 'kept') && !!f.changeId;
}

/** Whether it is still waiting for a keep-or-undo decision. */
export function needsDecision(f: Pick<FileReview, 'status' | 'changeId'>): boolean {
  return f.status === 'applied' && !!f.changeId;
}

/** Tailwind classes for the status badge. */
export const TONE_CLASS: Record<StatusWords['tone'], string> = {
  pending: 'border-warning/40 bg-warning/10 text-warning',
  done: 'border-success/40 bg-success/10 text-success',
  kept: 'border-border bg-surface text-foreground-muted',
  undone: 'border-border bg-surface text-foreground-subtle',
};

/** The preference for how to lay a diff out, remembered per person but never required. */
export const MODE_KEY = 'atlas.review.mode';
export function readMode(): 'inline' | 'split' {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'inline';
  } catch {
    return 'inline';
  }
}
export function writeMode(mode: 'inline' | 'split'): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* a remembered layout is a convenience, never a requirement */
  }
}

/** Fired whenever a change is kept, undone or edited, so every card showing it can refresh. */
export const CHANGES_EVENT = 'atlas:changes-updated';
