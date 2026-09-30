/**
 * Sending input is not the same as it having worked.
 *
 * `SendInput` reports how many events it *queued*. It does not say the target
 * received them, and when Windows' own UI Privilege Isolation discards input
 * bound for a window running above Atlas it still reports success. So "the API
 * returned without an error" is the weakest thing that can be said, and this
 * module never says more than the evidence supports. Every input result carries
 * one of four levels, in `data.input`:
 *
 *  - `blocked`  — refused before sending (a Windows permission screen, a window
 *                 above Atlas, something unidentifiable). Nothing was sent.
 *  - `sent`     — the events were delivered to Windows. Nothing readable shows
 *                 what they did. Said as "sent, not verified".
 *  - `changed`  — sent, and something observable moved: the window in front, its
 *                 title, or which control has focus. That is evidence of *an*
 *                 effect, not proof of the intended one, and is worded as such.
 *  - `verified` — sent, and the expected state is confirmed by reading it: typed
 *                 text that now appears in the field it went into.
 *
 * And one case is a failure rather than a caveat: text was typed into a field
 * that *can* be read, and the text is not there. The keys went somewhere; it was
 * not where they were meant to.
 *
 * Reading a field's contents is possible only where the control exposes them
 * (and never for a password field) — many editors do not. Then the honest answer
 * is `sent`, and that is what is said.
 */

import { InputBlockedError, type Platform, type SkillResult } from '@atlas/core';

export type InputLevel = 'blocked' | 'sent' | 'changed' | 'verified';

interface Snapshot {
  /** The focused control is a password field. */
  secret?: boolean;
  windowId?: string;
  title?: string;
  focus?: string;
  value?: string;
}

async function snapshot(platform: Platform): Promise<Snapshot> {
  const [win, focused] = await Promise.all([
    platform.activeWindow?.().catch(() => null),
    platform.uiaFocusedElement?.().catch(() => null),
  ]);
  return {
    secret: focused?.password === true,
    windowId: win?.id,
    title: win?.title?.trim() || undefined,
    focus: focused ? `${focused.role}|${focused.name}|${focused.automationId}` : undefined,
    value: focused?.value,
  };
}

const norm = (text: string) => text.replace(/\r\n/g, '\n');

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count += 1;
  }
  return count;
}

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface PerformInput {
  platform: Platform;
  /**
   * What was sent, past tense: "Pressed Ctrl+N", "Clicked at 10, 20". A function
   * so it can leave out what was typed when the target is a password field:
   * a secret is never echoed back, in a message or anywhere else.
   */
  label: string | ((secret: boolean) => string);
  /** Does the sending. `undefined`/`false` means the platform couldn't. */
  send: () => Promise<boolean | undefined>;
  /** Said when it could not be sent at all. */
  failure: string;
  /** Text this input types, so it can be looked for afterwards. */
  typed?: string;
  /** How long to let the target react before looking. */
  settleMs?: number;
}

/** Send input, then say honestly what is known about it. */
export async function performInput(input: PerformInput): Promise<SkillResult> {
  const { platform } = input;
  const before = await snapshot(platform);
  const label =
    typeof input.label === 'function' ? input.label(before.secret === true) : input.label;

  let sent: boolean | undefined;
  try {
    sent = await input.send();
  } catch (err) {
    if (err instanceof InputBlockedError) {
      return {
        ok: false,
        error: err.message,
        data: { input: 'blocked' satisfies InputLevel, code: err.code },
      };
    }
    throw err;
  }
  if (!sent)
    return { ok: false, error: input.failure, data: { input: 'blocked' satisfies InputLevel } };

  await new Promise((resolve) => setTimeout(resolve, input.settleMs ?? 150));
  const after = await snapshot(platform);
  const front = after.title ? ` (in front: “${after.title}”)` : '';

  // Typed text: look for it in the field it was typed into.
  if (input.typed !== undefined && input.typed !== '') {
    const want = norm(input.typed);
    if (after.value !== undefined) {
      const had = occurrences(norm(before.value ?? ''), want);
      const has = occurrences(norm(after.value), want);
      if (has > had) {
        return {
          ok: true,
          message: `${label} — verified: it is now in the field${front}.`,
          data: { input: 'verified' satisfies InputLevel, evidence: 'field contents' },
        };
      }
      return {
        ok: false,
        error: `I sent the keys, but “${clip(input.typed)}” isn't in the field${front}. They may have gone somewhere else, so I'm not calling that done.`,
        data: {
          input: 'sent' satisfies InputLevel,
          evidence: 'text not found in the focused field',
        },
      };
    }
    return {
      ok: true,
      message: `${label} — sent, not verified: this control doesn't let me read its text back${front}.`,
      data: { input: 'sent' satisfies InputLevel },
    };
  }

  // Anything observable that moved.
  const moved: string[] = [];
  if (before.windowId !== after.windowId && after.title)
    moved.push(`the window in front is now “${after.title}”`);
  else if (before.title !== after.title && after.title) {
    moved.push(
      `the window title changed${before.title ? ` from “${before.title}”` : ''} to “${after.title}”`,
    );
  }
  if (before.focus !== after.focus && after.focus) moved.push('a different control has focus');
  if (moved.length) {
    return {
      ok: true,
      message: `${label} — sent; ${moved.join(' and ')}. I can't confirm that is the effect you wanted.`,
      data: { input: 'changed' satisfies InputLevel, evidence: moved },
    };
  }
  return {
    ok: true,
    message: `${label} — sent, not verified: nothing I can read changed${front}.`,
    data: { input: 'sent' satisfies InputLevel },
  };
}
