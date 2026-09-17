/**
 * Emergency stop — the key that halts Atlas from anywhere.
 *
 * Lives in General next to Execution mode because the two answer halves of
 * one question: how much Atlas asks before acting, and how you stop it once
 * it is. Both are about control, neither is about looks.
 *
 * ── Recording, not typing ───────────────────────────────────────────────────
 * The key is captured by pressing it, the way every OS shortcut dialog works,
 * and validated as it is pressed with the same rules the shell applies
 * (`parseHaltShortcut`), so a refusal is explained before Save is offered. The
 * shell still checks again and has the final word: only it knows whether
 * another app already owns the key, and a key Windows refuses is never saved.
 *
 * ⚠️ The current stop key keeps working while recording — Windows swallows it
 * before the page sees it — so pressing it here halts Atlas rather than
 * recording it. The note under the field says so.
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import type { HaltStatus, Platform } from '@atlas/core';
import { DEFAULT_HALT_SHORTCUT, parseHaltShortcut, shortcutFromKeyEvent } from '@atlas/core';
import { Button, Kbd, cn } from '@atlas/ui';

export function EmergencyStop({ platform }: { platform: Platform }) {
  const native = platform.halt;
  const [status, setStatus] = useState<HaltStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void native
      ?.status()
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [native]);

  const active = native ? (status?.shortcut.active ?? null) : DEFAULT_HALT_SHORTCUT;
  const fallbackKey = status?.defaultShortcut ?? DEFAULT_HALT_SHORTCUT;
  const checked = candidate ? parseHaltShortcut(candidate) : null;

  const save = async (shortcut: string) => {
    if (!native) return;
    setSaving(true);
    setError(null);
    try {
      setStatus(await native.setShortcut(shortcut));
      setRecording(false);
      setCandidate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') return; // leave keyboard navigation alone
    e.preventDefault();
    const text = shortcutFromKeyEvent(e);
    if (!text) return;
    setCandidate(text);
    setError(null);
  };

  return (
    <section className="mb-8">
      <h2 className="text-foreground mb-1 text-sm font-medium">Emergency stop</h2>
      <p className="text-foreground-muted mb-3 text-xs leading-relaxed">
        One key that halts Atlas immediately, from any app, in every execution mode: it stops typing
        and mouse control, cancels the running task and anything queued behind it, ends running
        builds and tests, and cuts off a reply mid-sentence. Nothing runs again until you send
        something new.
      </p>

      {!native ? (
        <p className="text-foreground-subtle text-xs leading-relaxed">
          In the browser, <Kbd>{DEFAULT_HALT_SHORTCUT}</Kbd> stops Atlas while this page has focus. The
          desktop app registers it system-wide and lets you change it.
        </p>
      ) : (
        <div className="border-border rounded-xl border px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-foreground-muted text-xs">Stop key</span>
            {active ? (
              <KeyCombo value={active} />
            ) : (
              <span className="text-danger text-xs font-medium">No key registered</span>
            )}
            <div className="ml-auto flex gap-2">
              {!recording && (
                <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
                  Change
                </Button>
              )}
              {active !== fallbackKey && (
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(fallbackKey)}>
                  Restore {fallbackKey}
                </Button>
              )}
            </div>
          </div>

          {status?.shortcut.error && !recording && (
            <p className="text-warning mt-2 text-xs">{status.shortcut.error}</p>
          )}

          {recording && (
            <div className="mt-3">
              <div
                tabIndex={0}
                role="textbox"
                aria-label="Press the new stop key"
                // Focused on open, so the next key pressed is the one recorded.
                ref={(el) => el?.focus()}
                onKeyDown={onKeyDown}
                className={cn(
                  'border-border-strong bg-surface flex h-10 items-center rounded-lg border px-3 text-sm',
                  'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                )}
              >
                {candidate ? (
                  <KeyCombo value={checked?.ok ? checked.value : candidate} />
                ) : (
                  <span className="text-foreground-subtle">Press the keys you want…</span>
                )}
              </div>
              {checked && !checked.ok && <p className="text-warning mt-1.5 text-xs">{checked.reason}</p>}
              {error && <p className="text-warning mt-1.5 text-xs">{error}</p>}
              <p className="text-foreground-subtle mt-1.5 text-xs leading-relaxed">
                Function keys, Pause and Scroll Lock work on their own; anything else needs Ctrl, Alt
                or Win. {active && <>Your current key ({active}) still stops Atlas while you choose.</>}
              </p>
              <div className="mt-2.5 flex gap-2">
                <Button
                  size="sm"
                  disabled={!checked?.ok || saving}
                  onClick={() => checked?.ok && void save(checked.value)}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRecording(false);
                    setCandidate(null);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function KeyCombo({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {value.split('+').map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-foreground-subtle">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}
