/**
 * A small panel anchored to the control that opened it.
 *
 * ── Why this and not `Modal` ────────────────────────────────────────────────
 * `Modal` dims the screen and takes the whole window's attention, which is
 * right for a decision and wrong for a menu. Attaching a file is not a
 * decision that deserves to blank out the conversation behind it — it is a
 * side errand, and the transcript staying visible and unmodified is part of
 * what makes it feel like part of the chat rather than a browser dialog.
 *
 * ── What it handles, so callers don't ───────────────────────────────────────
 * Escape, a click outside, focus moving away, and the arrow keys — a menu you
 * cannot drive from the keyboard is a menu that fails the person who opened it
 * with one. Focus moves into the panel on open and returns to the trigger on
 * close, which is the part that is always skipped and always noticed.
 *
 * Positioning is deliberately simple: anchored to the trigger's box, flipped
 * above when there isn't room below. No collision library — this app has two
 * popovers, both anchored to a control at the bottom of the window, and a
 * dependency that solves the general case would be more code than the whole
 * component.
 *
 * ── Why it renders through a portal ─────────────────────────────────────────
 * Caught in the real app, and worth writing down because the symptom points
 * nowhere near the cause: the button opened and no panel appeared. `position:
 * fixed` is resolved against the viewport *unless* an ancestor has a
 * `transform`, `filter` or `backdrop-filter`, in which case that ancestor
 * becomes the containing block. The composer has `backdrop-blur`. So the
 * panel was being placed at viewport coordinates inside a box a few hundred
 * pixels tall, which put it off-screen every time. A portal to `document.body`
 * leaves the trap behind rather than working around it — and it is the same
 * reason every popover library does the same thing.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  /** The element the panel is anchored to; focus returns here on close. */
  anchorRef: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Which edge of the anchor to line up with. Defaults to the left. */
  align?: 'start' | 'end';
  className?: string;
  /** Read out when the panel opens. */
  label?: string;
}

const GAP = 8;

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = 'start',
  className,
  label,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(
    null,
  );

  // Measured after paint but before the browser shows it, so the panel never
  // appears at 0,0 and then jumps to where it belongs.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();

      const above = a.top > p.height + GAP || window.innerHeight - a.bottom < p.height + GAP;
      const top = above ? a.top - p.height - GAP : a.bottom + GAP;
      let left = align === 'end' ? a.right - p.width : a.left;
      // Never off the side of the window, whichever edge it was aligned to.
      left = Math.max(GAP, Math.min(left, window.innerWidth - p.width - GAP));
      setPosition({ left, top, above });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align, anchorRef]);

  const close = useCallback(() => {
    onClose();
    // Returning focus is what makes Escape feel like "back" rather than
    // "lost" — without it the next Tab starts from the top of the document.
    anchorRef.current?.focus();
  }, [onClose, anchorRef]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[data-popover-item]:not([disabled])') ?? [],
      );
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
      // Wrapping, because a menu this short is faster to cycle than to
      // reverse direction in.
      items[(next + items.length) % items.length]?.focus();
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // Not `close()`: a click outside has already put focus somewhere the
      // person chose, and yanking it back to the trigger would undo that.
      onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close, onClose, anchorRef]);

  // Focus the first item once the panel exists, so the keyboard works from
  // the moment it opens rather than after one wasted Tab.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>('[data-popover-item]:not([disabled])');
    first?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className={cn(
        'border-border bg-surface-raised fixed z-50 rounded-xl border p-1.5 shadow-lg',
        'atlas-popover-in',
        className,
      )}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        // Hidden until measured rather than rendered off-screen alone, so a
        // screen reader doesn't announce it from a nonsense position.
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface PopoverItemProps {
  icon?: ReactNode;
  label: string;
  /** The quiet second line: what this does, or why it can't. */
  hint?: string;
  disabled?: boolean;
  onSelect(): void;
  /** Shown at the trailing edge — a shortcut, a count, a state word. */
  trailing?: ReactNode;
}

export function PopoverItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
  trailing,
}: PopoverItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      data-popover-item
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'duration-fast flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        disabled
          ? 'cursor-not-allowed opacity-45'
          : 'hover:bg-surface text-foreground focus:bg-surface',
      )}
    >
      {icon && <span className="text-foreground-subtle mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-tight">{label}</span>
        {hint && (
          <span className="text-foreground-subtle mt-0.5 block text-xs leading-snug">{hint}</span>
        )}
      </span>
      {trailing && <span className="text-foreground-subtle mt-0.5 shrink-0 text-xs">{trailing}</span>}
    </button>
  );
}

/** A labelled divider, for a menu with more than one kind of thing in it. */
export function PopoverGroup({ label }: { label: string }) {
  return (
    <div className="text-foreground-subtle px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide">
      {label}
    </div>
  );
}
