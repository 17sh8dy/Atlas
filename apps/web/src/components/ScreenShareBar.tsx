/**
 * The live status bar shown while Atlas is watching a screen, and the picker
 * that starts one.
 *
 * ── The bar exists to be impossible to miss and easy to end ─────────────────
 * Every control here is a way to *reduce* what Atlas can see — stop, pause,
 * switch to something narrower. There is deliberately no control that widens
 * the share without naming what it widens to: "Share a different screen"
 * reopens the picker rather than cycling, so a share can never silently become
 * a share of something else. That is the whole privacy model in one sentence,
 * and it is a UI decision, not a setting.
 *
 * The live thumbnail is part of it. A status bar that says "sharing" and shows
 * nothing asks you to trust it; one that shows the frame Atlas has proves it,
 * and — more usefully — catches the case where you shared the wrong monitor.
 *
 * ── Honest about what Atlas does with it ────────────────────────────────────
 * Nothing in this build can interpret an image, so the bar says "watching",
 * never "understanding". `Attach current view` puts the frame in the composer,
 * where it is shown and becomes a referent; it does not send it anywhere,
 * because there is nowhere for it to be sent.
 */

import { useEffect, useRef, useState } from 'react';
import type { DisplayInfo, WindowEntry } from '@atlas/core';
import { Icons, Modal, cn } from '@atlas/ui';
import type { ScreenShare, ShareTarget } from '../atlas/useScreenShare';

/** Since the last frame, in words a person reads at a glance. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

export function ScreenShareBar({
  share,
  onAttachFrame,
  onChangeTarget,
}: {
  share: ScreenShare;
  onAttachFrame(): void;
  onChangeTarget(): void;
}) {
  // Ticks only while a share is running, so an idle Atlas does no timer work.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!share.target) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [share.target]);

  if (!share.target) return null;

  const live = !share.paused && !share.error;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'border-border bg-surface-raised atlas-disclose-in mx-auto mb-3 flex w-full max-w-3xl',
        'items-center gap-3 rounded-xl border px-3 py-2 shadow-sm',
      )}
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {live && (
          <span className="bg-danger absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping" />
        )}
        <span
          className={cn(
            'relative inline-flex h-2.5 w-2.5 rounded-full',
            live ? 'bg-danger' : 'bg-foreground-subtle',
          )}
        />
      </span>

      {share.frame && (
        <img
          src={share.frame.dataUrl}
          alt=""
          className="border-border hidden h-8 w-14 shrink-0 rounded border object-cover sm:block"
        />
      )}

      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-xs font-medium">
          {share.paused ? 'Screen sharing paused' : 'Atlas is watching'}
          <span className="text-foreground-subtle font-normal"> · {share.target.label}</span>
        </p>
        <p className="text-foreground-subtle truncate text-[11px]">
          {share.error
            ? share.error
            : share.paused
              ? 'Nothing is being captured while paused.'
              : share.frame
                ? `Last look ${ago(share.frame.at, now)} · stays on this machine`
                : 'Taking a first look…'}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <BarButton
          onClick={onAttachFrame}
          disabled={!share.frame}
          label="Attach current view"
          icon={<Icons.Plus className="h-3.5 w-3.5" />}
        />
        <BarButton
          onClick={() => share.setPaused(!share.paused)}
          label={share.paused ? 'Resume' : 'Pause'}
          icon={
            share.paused ? (
              <Icons.Play className="h-3.5 w-3.5" />
            ) : (
              <span aria-hidden="true" className="flex gap-[2px]">
                <span className="h-3 w-[3px] rounded-sm bg-current" />
                <span className="h-3 w-[3px] rounded-sm bg-current" />
              </span>
            )
          }
        />
        <BarButton
          onClick={onChangeTarget}
          label="Share something else"
          icon={<Icons.RotateCcw className="h-3.5 w-3.5" />}
        />
        <button
          type="button"
          onClick={share.stop}
          className={cn(
            'bg-danger duration-fast ml-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white',
            'transition hover:brightness-110',
            'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
          )}
        >
          Stop sharing
        </button>
      </div>
    </div>
  );
}

function BarButton({
  onClick,
  label,
  icon,
  disabled,
}: {
  onClick(): void;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'text-foreground-subtle hover:text-foreground duration-fast grid h-7 w-7 place-items-center',
        'hover:bg-surface rounded-lg transition',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {icon}
    </button>
  );
}

/**
 * Choosing what to share.
 *
 * A modal rather than a popover, and deliberately: this is the one moment in
 * the flow that deserves the whole window's attention, because what is picked
 * here decides what Atlas can see. Every option names exactly what it covers —
 * "Screen 1 · 3840×2160", a window by its real title — so nobody picks by
 * guessing.
 */
export function ShareTargetPicker({
  open,
  onClose,
  share,
  onPick,
}: {
  open: boolean;
  onClose(): void;
  share: ScreenShare;
  onPick(target: ShareTarget): void;
}) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [windows, setWindows] = useState<WindowEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const listTargets = useRef(share.listTargets);
  listTargets.current = share.listTargets;

  // Read when the picker opens, never on mount: the set of windows is stale
  // the moment it is read, and reading it early means it is stale on arrival.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void listTargets
      .current()
      .then((t) => {
        if (!alive) return;
        setDisplays(t.displays);
        setWindows(t.windows);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open]);

  const pick = (target: ShareTarget) => {
    onPick(target);
    onClose();
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      label="Share a screen with Atlas"
      className="w-full max-w-lg p-5"
    >
      <h2 className="text-foreground mb-1 text-sm font-medium">Share a screen with Atlas</h2>
      <p className="text-foreground-subtle mb-4 text-xs leading-relaxed">
        Atlas takes a still picture of what you choose, about once a second, for as long as you
        leave it on. It stays on this machine — nothing in this build can read an image, and
        nothing is uploaded. Stop any time from the bar at the top.
      </p>

      {loading && <p className="text-foreground-subtle text-xs">Looking…</p>}

      {displays.length > 0 && (
        <>
          <h3 className="text-foreground-subtle mb-2 text-[11px] font-medium uppercase tracking-wide">
            Screens
          </h3>
          <div className="mb-4 flex flex-col gap-1.5">
            {displays.map((d, i) => (
              <TargetRow
                key={`${d.name}-${i}`}
                icon={<Icons.MonitorSmartphone className="h-4 w-4" />}
                title={d.primary ? `Screen ${i + 1} (main)` : `Screen ${i + 1}`}
                subtitle={`${d.width}×${d.height}${d.name ? ` · ${d.name}` : ''}`}
                onSelect={() =>
                  pick({
                    kind: 'display',
                    id: String(i),
                    label: d.primary ? `Screen ${i + 1} (main)` : `Screen ${i + 1}`,
                  })
                }
              />
            ))}
            {displays.length > 1 && (
              <TargetRow
                icon={<Icons.AppWindow className="h-4 w-4" />}
                title="All screens"
                subtitle={`Everything across ${displays.length} monitors, as one picture`}
                onSelect={() => pick({ kind: 'all', label: 'All screens' })}
              />
            )}
          </div>
        </>
      )}

      {windows.length > 0 && (
        <>
          <h3 className="text-foreground-subtle mb-2 text-[11px] font-medium uppercase tracking-wide">
            A single window
          </h3>
          <p className="text-foreground-subtle mb-2 text-[11px] leading-relaxed">
            The narrowest choice: Atlas sees this window and nothing else on your desktop.
          </p>
          <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
            {windows.map((w) => (
              <TargetRow
                key={w.id}
                icon={<Icons.AppWindow className="h-4 w-4" />}
                title={w.title || w.processName}
                subtitle={w.processName}
                onSelect={() =>
                  pick({ kind: 'window', id: w.id, label: w.title || w.processName })
                }
              />
            ))}
          </div>
        </>
      )}

      {!loading && !displays.length && !windows.length && (
        <p className="text-foreground-subtle text-xs">
          Nothing to share — this build can&rsquo;t read the displays or the window list.
        </p>
      )}
    </Modal>
  );
}

function TargetRow({
  icon,
  title,
  subtitle,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'border-border hover:bg-surface-raised duration-fast flex w-full items-center gap-3',
        'rounded-lg border px-3 py-2 text-left transition',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
      )}
    >
      <span className="text-foreground-subtle shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm">{title}</span>
        <span className="text-foreground-subtle block truncate text-xs">{subtitle}</span>
      </span>
    </button>
  );
}
