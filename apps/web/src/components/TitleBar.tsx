/**
 * The window chrome, drawn by the app.
 *
 * The Tauri window has `decorations: false`, which buys a title bar that
 * matches the product instead of the OS — and obliges us to provide the two
 * things the OS was doing for us: a drag region and window controls.
 *
 * `data-tauri-drag-region` is what makes the bar draggable. It has to be on the
 * element the pointer actually lands on, so the buttons deliberately sit
 * *outside* it — an element inside a drag region swallows its own clicks.
 *
 * In a browser there is no window to control, so the buttons render only under
 * Tauri and the bar degrades to a plain header.
 */

import { useCallback, useEffect, useState } from 'react';

import { AtlasMark, Icons, cn } from '@atlas/ui';
import { isTauri } from '@atlas/platform';

interface Props {
  right?: React.ReactNode;
  /** Clicking the logo returns to the welcome screen, like a site's logo does. */
  onLogoClick?: () => void;
}

export function TitleBar({ right, onLogoClick }: Props) {
  const native = isTauri();

  const [maximized, setMaximized] = useState(false);

  const windowAction = async (action: 'minimize' | 'close') => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    // Close hides rather than exits — Atlas stays resident, and the summon key
    // keeps working. Quitting is done from the tray, deliberately.
    if (action === 'minimize') await win.minimize();
    else await win.hide();
  };

  /**
   * Maximise and restore — the OS's own, not an imitation of it.
   *
   * This button used to fill the entire monitor: a borderless window sized to
   * the screen, held over the taskbar with `alwaysOnTop` and left one pixel
   * short at the bottom so the compositor would not promote it to a fullscreen
   * flip (which, on this machine, drew the pointer twice). It worked, and it
   * was still the wrong control. The middle button of a Windows 11 caption bar
   * maximises: the window fills the *work area*, the taskbar stays where it
   * is, alt-tab keeps behaving, and the change of size is the system's own
   * animation rather than an instant jump to full bleed.
   *
   * Deferring to `toggleMaximize` also settles a disagreement that was already
   * sitting in this bar — double-clicking a drag region asks Tauri to
   * maximise, so the title bar held two different ideas of "make it bigger".
   * Now the button, the double-click, Win+Up and dragging to the top edge all
   * mean the same thing.
   *
   * A maximised window stops short of covering the monitor, so the duplicated
   * cursor the old code was written around cannot arise here. It also needs no
   * geometry of its own: tao trims a maximised borderless window to the work
   * area in its own `WM_NCCALCSIZE` handler.
   */
  const toggleMaximize = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.toggleMaximize();
    setMaximized(await win.isMaximized());
  }, []);

  /**
   * Keep the glyph honest.
   *
   * The window can be maximised without this button ever being pressed —
   * double-clicking the drag region, Win+Up, dragging to the top edge, the
   * snap assistant. A window that is maximised while its button still offers
   * to maximise is the giveaway of app-drawn chrome that only half-joined the
   * OS, so the state is read back off the window on every resize rather than
   * tracked locally.
   */
  useEffect(() => {
    if (!native) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const sync = () =>
        void win.isMaximized().then((value) => {
          if (!cancelled) setMaximized(value);
        });
      sync();
      const stop = await win.onResized(sync);
      // The component may have unmounted while that was in flight.
      if (cancelled) stop();
      else unlisten = stop;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [native]);

  return (
    <header className="border-border bg-background/80 flex h-11 shrink-0 items-stretch border-b backdrop-blur">
      {/* The logo sits in its own button, outside the drag region — a click
          inside a drag region never reaches its own handler (see file doc
          comment), the same reason the window-control buttons sit outside it. */}
      {onLogoClick ? (
        <button
          type="button"
          onClick={onLogoClick}
          aria-label="Back to Atlas"
          title="Back to Atlas"
          className="duration-fast hover:bg-surface flex select-none items-center px-4 transition"
        >
          <Wordmark />
        </button>
      ) : (
        <div className="flex select-none items-center px-4">
          <Wordmark />
        </div>
      )}
      <div data-tauri-drag-region className="flex-1" />

      {/* Two groups: app affordances keep their padding and rounded shape, the
          window controls sit flush in the corner the way the OS draws them —
          a caption button that stops short of the screen edge loses the
          Fitts's-law target the real one has. */}
      <div className="flex items-center gap-1 px-2">{right}</div>

      {native && (
        <div className="flex items-stretch">
          <WindowButton label="Minimise" onClick={() => windowAction('minimize')}>
            <Icons.Minus className="h-3.5 w-3.5" />
          </WindowButton>
          <WindowButton
            label={maximized ? 'Restore down' : 'Maximise'}
            onClick={() => void toggleMaximize()}
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </WindowButton>
          <WindowButton label="Close" onClick={() => windowAction('close')} danger>
            <Icons.X className="h-3.5 w-3.5" />
          </WindowButton>
        </div>
      )}
    </header>
  );
}

/**
 * The mark, the name, and what powers it.
 *
 * The two runs of text share a **baseline**. Centring them independently —
 * which is what a plain `items-center` row does — left the 11px run sitting
 * two pixels above the 13px one, because a smaller font's baseline falls
 * higher inside a centred line box. Two pixels is not enough to look like a
 * mistake and is exactly enough to look careless: the tagline read as floating
 * beside the name rather than as set on the same line as it.
 *
 * Every element here is a `span` because this renders inside a `<button>`,
 * which may not contain a `<div>`.
 */
function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      {/* The mark is centred against the text, not baseline-aligned with it: a
          square has no baseline worth sharing, and sitting its bottom edge on
          the text's would drop it below the middle of the bar. Which is why
          the type is nested one level deeper — a baseline row that also holds
          the mark takes its height from the text and centres the mark inside
          that, which tips the whole group two pixels high instead. */}
      <span className="accent-surface text-primary-foreground grid h-5 w-5 shrink-0 place-items-center rounded-md">
        <AtlasMark className="h-2.5 w-2.5" />
      </span>
      {/* `leading-none` on both: with each line box tight to its own glyphs,
          the baseline is set by the font alone and neither run can drift when
          the inherited line height changes underneath them. */}
      <span className="flex items-baseline gap-2.5">
        <span className="text-foreground text-[13px] font-semibold leading-none tracking-tight">
          Atlas
        </span>
        <span className="text-foreground-subtle text-[11px] leading-none">Navigator Engine</span>
      </span>
    </span>
  );
}

/**
 * The caption glyphs, drawn here rather than drawn from the icon set.
 *
 * `Icons` is a curated vocabulary shared across the app; these two belong to
 * no vocabulary. They are the shapes Windows itself draws in this exact
 * corner, and the details that make them read as native — square corners, a
 * plain unrounded outline, the restore pair with its front window lower-left —
 * are invisible until they are wrong and are not what a general-purpose icon
 * set is for. The stroke weight matches the lucide glyphs either side so the
 * three buttons read as one row.
 */
function MaximizeGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
      {/* The window behind, drawn as the corner of it still showing. */}
      <path d="M8 8V4h12v12h-4" fill="none" stroke="currentColor" strokeWidth="2" />
      {/* The window in front. */}
      <rect x="4" y="8" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function WindowButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick(): void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        // 46px wide, full bar height, square and flush — the OS caption-button
        // geometry. Rounding or insetting these is what makes app-drawn chrome
        // read as "not quite right".
        'grid h-full w-[46px] shrink-0 place-items-center',
        'text-foreground-muted outline-none',
        // Only the fill and glyph move. Windows animates the hover wash in and
        // holds a flatter tint while pressed — no scale, no bounce; caption
        // buttons that spring feel like toys next to the real ones.
        'duration-fast transition-colors ease-out',
        'hover:bg-foreground/10 hover:text-foreground',
        'active:bg-foreground/[0.06] active:text-foreground',
        'focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-inset',
        // Close is the one button the OS floods with colour rather than grey,
        // and the glyph goes white on both themes because the red is fixed.
        danger && 'hover:bg-danger active:bg-danger/80 hover:text-white active:text-white',
      )}
    >
      {children}
    </button>
  );
}
