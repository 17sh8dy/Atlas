/**
 * Background ("virtual") input — the keyboard-and-mouse tools' first choice.
 *
 * When a call names a window (or a control in it), Atlas first tries to do the thing through the
 * window's own accessibility interface: it activates the control, adds the text to the field, scrolls
 * the area. That never moves the person's cursor and never takes the keyboard focus or changes the
 * window in front, so they can keep working while Atlas works.
 *
 * ── The rules this module enforces ───────────────────────────────────────────────────────
 *  1. NEVER a silent fall-back. If the background route cannot do it, Atlas says so, says WHY, and
 *     asks before using the real mouse and keyboard — and the question says what that will do
 *     (move the cursor, type into the window in front). `mode: 'virtual'` never asks and never
 *     falls back; `mode: 'real'` skips the background route (the person asked for it).
 *  2. A refusal is not "unsupported". A permission screen, a protected desktop or a window running
 *     above Atlas is refused (`InputBlockedError`) and that is the end: asking to "use the real
 *     keyboard instead" would only be asking to get around the guard, so it is never offered.
 *  3. Passwords. A password field (or a control Windows cannot describe) is never typed into in the
 *     background; the real route has its own handling, which keeps the secret out of every message.
 *  4. The emergency stop is checked before and after, and the native side checks it again.
 */

import { InputBlockedError, type SkillContext, type SkillResult } from '@atlas/core';

export type InputMode = 'auto' | 'virtual' | 'real';

export const MODE_PARAM = {
  type: 'string',
  required: false,
  enum: ['auto', 'virtual', 'real'],
  description:
    "how to do it: 'auto' (default) tries the background route that leaves your mouse and the window in front alone and asks before using the real ones; 'virtual' never uses the real mouse or keyboard; 'real' uses them straight away",
} as const;

export function modeOf(value: unknown): InputMode {
  return value === 'virtual' || value === 'real' ? value : 'auto';
}

/** What the background route found out. */
export type VirtualOutcome =
  | { kind: 'done'; message: string; data?: Record<string, unknown> }
  | { kind: 'unsupported'; reason: string }
  /** It was tried and it did not work; not a "can't", so the real route is not offered. */
  | { kind: 'failed'; error: string };

const UNSUPPORTED = /^UNSUPPORTED:\s*/;

/** The reason inside a native `UNSUPPORTED:…` rejection, or null when the error is something else. */
export function unsupportedReason(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return UNSUPPORTED.test(text) ? text.replace(UNSUPPORTED, '').trim() : null;
}

export interface BackgroundFirst {
  mode: InputMode;
  ctx: SkillContext;
  /** What is being done, for the question: “click “Save” in Notepad”. */
  what: string;
  /** The window it is aimed at, for the question. */
  windowTitle: string;
  /** The background route. Throw `InputBlockedError` (or let it propagate) for a refusal. */
  virtual: () => Promise<VirtualOutcome>;
  /** The real route. Only ever called after `mode: 'real'` or an explicit yes. */
  real: () => Promise<SkillResult>;
  /** What the real route will do to the person's screen, in a clause: “move your cursor onto it and click”. */
  realEffect: string;
}

const STOPPED = 'Stopped before it finished.';

export async function backgroundFirst(o: BackgroundFirst): Promise<SkillResult> {
  if (o.ctx.signal?.aborted) return { ok: false, error: STOPPED };

  if (o.mode === 'real') {
    const r = await o.real();
    return { ...r, data: { ...(r.data as object | undefined), via: 'real' } };
  }

  let outcome: VirtualOutcome;
  try {
    outcome = await o.virtual();
  } catch (err) {
    if (err instanceof InputBlockedError) {
      return { ok: false, error: err.message, data: { input: 'blocked', code: err.code, via: 'none' } };
    }
    const reason = unsupportedReason(err);
    if (reason) outcome = { kind: 'unsupported', reason };
    else return { ok: false, error: err instanceof Error ? err.message : String(err), data: { via: 'none' } };
  }
  if (o.ctx.signal?.aborted) return { ok: false, error: STOPPED };

  if (outcome.kind === 'done') {
    return {
      ok: true,
      message: `${outcome.message} Done in the background — your mouse, keyboard and the window in front were not touched.`,
      data: { ...outcome.data, via: 'virtual' },
    };
  }
  if (outcome.kind === 'failed') return { ok: false, error: outcome.error, data: { via: 'virtual' } };

  // The background route cannot do it. Say so; never switch quietly.
  // The reason reads mid-sentence: no trailing full stop, and a sentence-case start (from the native
  // side) is lowered.
  const why = outcome.reason.replace(/\.$/, '').replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
  const cannot = `I can't ${o.what} in the background: ${why}.`;
  if (o.mode === 'virtual') {
    return { ok: false, error: `${cannot} I didn't use your mouse or keyboard, because you asked for the background route only.`, data: { via: 'none', unsupported: outcome.reason } };
  }
  if (!o.ctx.confirm) {
    return { ok: false, error: `${cannot} I didn't use your real mouse and keyboard without asking, and I can't ask you from here, so I left it alone.`, data: { via: 'none', unsupported: outcome.reason } };
  }
  const approved = await o.ctx.confirm(
    `Use your real mouse and keyboard to ${o.what}?`,
    `${cannot}\nUsing the real ones means Atlas will ${o.realEffect} while you wait — don't touch the mouse or keyboard meanwhile. You can press the emergency stop at any time.`,
    { yesLabel: 'Use real mouse and keyboard', noLabel: 'Not now' },
  );
  if (o.ctx.signal?.aborted) return { ok: false, error: STOPPED };
  if (!approved) {
    return { ok: false, error: `${cannot} You said no to the real mouse and keyboard, so I left it alone — nothing was sent.`, data: { via: 'none', unsupported: outcome.reason, declined: true } };
  }
  const r = await o.real();
  return {
    ...r,
    message: r.message ? `Used your real mouse and keyboard, as you approved. ${r.message}` : r.message,
    data: { ...(r.data as object | undefined), via: 'real', fellBackBecause: outcome.reason },
  };
}
