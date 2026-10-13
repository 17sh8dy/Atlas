/**
 * Why an action failed, as a small closed set — and what to do about each.
 *
 * Skills report failures as a sentence, which is right for a person and useless for
 * anything that has to *decide* what comes next. Every retry loop, agent loop and report
 * used to re-derive "is this a permissions thing or a missing file?" from the wording.
 * This is that decision made once: classify the failure, then read the response off a
 * table. No message text lives here — what a person is told always comes from the skill
 * that failed, which knows the specifics; the table only says what kind of recovery fits.
 *
 * The classifier is deliberately conservative. A sentence it cannot place is `unknown`
 * and recovers by stopping and saying so, never by guessing a strategy.
 */

import { HALTED_PREFIX } from './halt';

export type FailureKind =
  /** The thing named does not exist (file, app, window, setting). */
  | 'not-found'
  /** Windows or Atlas's own folder grant says no. */
  | 'permission'
  /** Atlas declined on purpose: policy, guard, a protected target. */
  | 'refused'
  /** In use, locked, already running — may clear on its own. */
  | 'busy'
  | 'timeout'
  /** More than one thing fits and the request did not say which. */
  | 'ambiguous'
  /** Not possible here: no such capability in this build, offline, a service that is not running. */
  | 'unavailable'
  /** The request was malformed or missing something. */
  | 'invalid'
  /** The person said no, or the step was skipped behind one that failed. */
  | 'declined'
  /** The emergency stop ended it. */
  | 'halted'
  | 'unknown';

export type RecoveryAction =
  /** Put the choice to the person. */
  | 'ask-which'
  /** Try once more, unchanged. Only for things that clear by themselves. */
  | 'retry-once'
  /** Try a different, relevant way to the same end (a skill's own strategy ladder). */
  | 'try-alternative'
  /** Explain what access is missing and let the person decide; never work around it. */
  | 'explain-access'
  /** Ask for the missing or corrected detail. */
  | 'rephrase'
  /** Report it and end the task. */
  | 'stop';

export interface Recovery {
  action: RecoveryAction;
  /**
   * May Atlas do this without asking? True only where repeating or varying the same
   * request cannot do more than the person already approved.
   */
  automatic: boolean;
  /** One line for an agent loop's next prompt. Not shown to a person. */
  hint: string;
}

export const RECOVERY: Record<FailureKind, Recovery> = {
  'not-found': {
    action: 'try-alternative',
    automatic: true,
    hint: 'The target was not found. Check the exact name or path with a read-only listing or search before trying again.',
  },
  permission: {
    action: 'explain-access',
    automatic: false,
    hint: 'Access was denied. Do not work around it; report what access is missing.',
  },
  refused: {
    action: 'stop',
    automatic: false,
    hint: 'This was refused on purpose. Do not retry or rephrase it to get around the refusal.',
  },
  busy: {
    action: 'retry-once',
    automatic: true,
    hint: 'The target is in use. One retry may succeed; if it fails again, report it.',
  },
  timeout: {
    action: 'retry-once',
    automatic: true,
    hint: 'It timed out. One retry is reasonable; do not loop.',
  },
  ambiguous: {
    action: 'ask-which',
    automatic: false,
    hint: 'More than one thing matches. Ask which one rather than choosing.',
  },
  unavailable: {
    action: 'stop',
    automatic: false,
    hint: 'This is not available right now. Say so plainly instead of trying other routes to it.',
  },
  invalid: {
    action: 'rephrase',
    automatic: false,
    hint: 'The request was missing or had a wrong detail. Correct it from what is known, or ask for it.',
  },
  declined: {
    action: 'stop',
    automatic: false,
    hint: 'The person said no. Stop; do not propose it again.',
  },
  halted: {
    action: 'stop',
    automatic: false,
    hint: 'Atlas was stopped. Nothing continues until the person sends something new.',
  },
  unknown: {
    action: 'stop',
    automatic: false,
    hint: 'The cause is unclear. Report what happened rather than guessing a fix.',
  },
};

/** Ordered: the first pattern that matches wins, so the more specific kinds come first. */
const RULES: ReadonlyArray<[FailureKind, RegExp]> = [
  ['permission', /\b(?:permission|access(?: is)? denied|not permitted|administrator|elevat\w+|requires? (?:admin|elevation)|unauthori[sz]ed)\b/i],
  ['refused', /\b(?:won[’']?t|will not|refus\w+|not allowed|isn[’']?t allowed|policy|outside the folders|protected|blocked|can[’']?t be (?:closed|ended|stopped))\b/i],
  ['not-found', /\b(?:not found|no such|doesn[’']?t exist|does not exist|couldn[’']?t find|can[’']?t find|could not find|isn[’']?t installed|not installed|no (?:file|folder|app|window|process|drive)\b)/i],
  ['ambiguous', /\b(?:which one|more than one|several|multiple|ambiguous|did you mean)\b/i],
  ['busy', /\b(?:in use|being used|locked|busy|already running|another process)\b/i],
  ['timeout', /\b(?:timed? ?out|took too long|no response)\b/i],
  ['unavailable', /\b(?:not available|isn[’']?t available|unavailable|unsupported|not supported|in this build|offline|couldn[’']?t reach|can[’']?t reach|isn[’']?t running|not running)\b/i],
  ['invalid', /\b(?:invalid|not a valid|missing|expected|must be|needs? (?:a|an|the)|too (?:long|short|big|large)|empty|give me|tell me)\b/i],
];

/**
 * Place a failure. `skipped` is the executor's own knowledge that the step never ran
 * (declined, or behind a failure); the text of `error` is only consulted otherwise.
 */
export function classifyFailure(
  error: string | undefined,
  context: { skipped?: boolean } = {},
): FailureKind {
  const text = (error ?? '').trim();
  if (text.startsWith(HALTED_PREFIX)) return 'halted';
  if (context.skipped || /^(?:cancelled|skipped)\.?$/i.test(text)) return 'declined';
  if (!text) return 'unknown';
  for (const [kind, pattern] of RULES) if (pattern.test(text)) return kind;
  return 'unknown';
}

/** What to do about a failure of this kind. */
export function recoveryFor(kind: FailureKind): Recovery {
  return RECOVERY[kind];
}
