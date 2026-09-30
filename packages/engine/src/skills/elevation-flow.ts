/**
 * Asking before administrator rights are used — the renderer's half.
 *
 * The native side (`elevation.rs`) does the part that must not be trusted to
 * anyone else: it checks the operation against a closed set, issues a one-time
 * token bound to exactly it, and only runs what that token names. This is the
 * part that puts the question to the person, in Atlas, *before* Windows shows
 * its own prompt.
 *
 * The order is the point:
 *
 *   1. `elevationPrepare` — nothing runs; a token and the exact text come back.
 *   2. Atlas shows a card: the operation, the fixed Windows program, the exact
 *      arguments, the reason, and that Windows will then show its own prompt.
 *   3. Allow → `elevationRun` with the token *and the command line that was
 *      shown*. Deny → the token is cancelled.
 *   4. Windows shows the UAC prompt. Atlas does not see it, click it or answer
 *      it, and will not send it input.
 *
 * This card is asked from inside the skill, so it appears in **every**
 * execution mode: Plan First's approval of a plan, Do It?'s Allowed Folders and
 * a watch's earlier approval were all given before anyone knew a step would need
 * administrator rights, and none of them covers it.
 */

import type {
  ElevationOperation,
  ElevationOutcome,
  ElevationRequest,
  Platform,
  SkillContext,
} from '@atlas/core';

export type ElevationResult =
  { ok: true; outcome: ElevationOutcome; request: ElevationRequest } | { ok: false; error: string };

const message = (err: unknown): string =>
  typeof err === 'string' ? err : err instanceof Error ? err.message : 'That did not work.';

/** The card: the question, and everything the person needs to decide. */
export function elevationCard(request: ElevationRequest): { question: string; detail: string } {
  return {
    question: 'Allow administrator rights for this one action?',
    detail: [
      `What: ${request.operation}`,
      `Program: ${request.program} — ${request.programPath} (file id ${request.programId})`,
      `Runs exactly: ${request.program} ${request.commandLine}`,
      `Why: ${request.reason}`,
      'Next: Windows will show its own permission prompt (UAC). Atlas can’t see, click or answer it — that choice is yours.',
      `Scope: this action only, once, within ${request.ttlSecs} seconds. It does not give Atlas administrator rights.`,
    ].join('\n'),
  };
}

/** What a finished elevated run should be reported as, or `null` if it went fine. */
export function outcomeProblem(outcome: ElevationOutcome): string | null {
  if (outcome.timedOut) {
    return 'Windows didn’t finish that within 30 seconds, so I can’t say whether it worked.';
  }
  if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    return `Windows ran it but reported an error (code ${outcome.exitCode}).`;
  }
  return null;
}

/**
 * Ask for, and run, one administrator action. Never throws for an expected
 * refusal; the reason comes back as `error`.
 */
export async function withAdminApproval(
  platform: Platform,
  ctx: SkillContext,
  op: ElevationOperation,
): Promise<ElevationResult> {
  if (!platform.elevationPrepare || !platform.elevationRun) {
    return { ok: false, error: 'Administrator actions aren’t available in this build.' };
  }
  if (ctx.signal?.aborted) return { ok: false, error: 'Stopped.' };

  let request: ElevationRequest;
  try {
    request = await platform.elevationPrepare(op);
  } catch (err) {
    return { ok: false, error: message(err) };
  }

  const card = elevationCard(request);
  const allowed = await ctx.confirm(card.question, card.detail, {
    yesLabel: 'Allow',
    noLabel: 'Deny',
    yesNote: '✓ Allowed — for this one action.',
    noNote: 'Denied — nothing was changed.',
  });
  if (!allowed) {
    await platform.elevationCancel?.(request.token).catch(() => false);
    return { ok: false, error: 'Cancelled.' };
  }
  // A stop pressed while the card was open: the native side has already
  // cancelled the approval, and nothing further is attempted.
  if (ctx.signal?.aborted) {
    await platform.elevationCancel?.(request.token).catch(() => false);
    return { ok: false, error: 'Stopped.' };
  }

  try {
    const outcome = await platform.elevationRun(request.token, request.commandLine);
    return { ok: true, outcome, request };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}
