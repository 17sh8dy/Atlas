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

import { useRef, useState } from 'react';

import { Icons, cn } from '@atlas/ui';
import { isTauri } from '@atlas/platform';

interface Props {
  right?: React.ReactNode;
  /** Clicking the logo returns to the welcome screen, like a site's logo does. */
  onLogoClick?: () => void;
}

export function TitleBar({ right, onLogoClick }: Props) {
  const native = isTauri();

  const [fullscreen, setFullscreen] = useState(false);
  /** Where the window was before it filled the screen, to put it back. */
  const windowedBounds = useRef<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );

  const windowAction = async (action: 'minimize' | 'close') => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    // Close hides rather than exits — Atlas stays resident, and the summon key
    // keeps working. Quitting is done from the tray, deliberately.
    if (action === 'minimize') await win.minimize();
    else await win.hide();
  };

  /**
   * Full screen, done as a borderless window rather than `setFullscreen`.
   *
   * Both look identical — the window has no decorations either way — but a
   * borderless window that covers a whole monitor is promoted by the desktop
   * compositor to a fullscreen flip, and on some GPU/high-refresh combinations
   * that path draws the pointer twice: the hardware cursor plus a larger copy
   * that lags behind it, most obvious when hovering, because that is when the
   * two disagree about which cursor shape to show.
   *
   * The window is therefore one pixel SHORT of the monitor. Covering it and
   * overhanging it both count as covering it; leaving a row uncovered is what
   * actually fails the test. The gap sits on the bottom edge, under the
   * composer, where there is nothing to see.
   *
   * `alwaysOnTop` is what puts it over the taskbar, which the OS fullscreen
   * state used to do for us.
   */
  const toggleFullscreen = async () => {
    const [{ getCurrentWindow, currentMonitor }, { PhysicalPosition, PhysicalSize }] =
      await Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/dpi')]);
    const win = getCurrentWindow();

    if (fullscreen) {
      await win.setAlwaysOnTop(false);
      const previous = windowedBounds.current;
      if (previous) {
        await win.setPosition(new PhysicalPosition(previous.x, previous.y));
        await win.setSize(new PhysicalSize(previous.width, previous.height));
      }
      setFullscreen(false);
      return;
    }

    // `setSize` sets the *inner* size while `outerPosition` reports the frame,
    // and on Windows 11 a resizable window's frame includes an invisible
    // ~8px drag border. Mixing the two makes the window grow every round trip
    // and sit a border's width off the left edge, so measure the inset once
    // and keep inner sizes with inner sizes.

    const monitor = await currentMonitor();
    if (!monitor) {
      // No monitor to measure: fall back to the OS state rather than doing
      // nothing. Duplicated cursor beats a dead button.
      await win.setFullscreen(true);
      setFullscreen(true);
      return;
    }

    const outer = await win.outerPosition();
    const inner = await win.innerPosition();
    const innerSize = await win.innerSize();
    windowedBounds.current = {
      x: outer.x,
      y: outer.y,
      width: innerSize.width,
      height: innerSize.height,
    };

    const insetX = inner.x - outer.x;
    const insetY = inner.y - outer.y;

    await win.setAlwaysOnTop(true);
    await win.setPosition(
      new PhysicalPosition(monitor.position.x - insetX, monitor.position.y - insetY),
    );
    await win.setSize(new PhysicalSize(monitor.size.width, monitor.size.height - 1));
    setFullscreen(true);
  };

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
            label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? (
              <Icons.Minimize className="h-3.5 w-3.5" />
            ) : (
              <Icons.Maximize className="h-3.5 w-3.5" />
            )}
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
        <Icons.Compass className="h-3 w-3" />
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
