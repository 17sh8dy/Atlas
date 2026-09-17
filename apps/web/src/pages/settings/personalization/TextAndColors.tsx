/**
 * Personalization → Text & colors: how the conversation reads.
 *
 * Every control applies the moment it is touched (like Appearance's accent
 * swatches) — there is nothing to review before saving a font — and the
 * preview at the top is a real transcript fragment rendered with the real
 * classes and the real `RevealText`, so it cannot disagree with what the
 * conversation will look like.
 *
 * The font list is filtered to what this machine actually has (see
 * `fontInstalled`), so nothing offered here silently falls back to another
 * face once chosen.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ANIMATION_SPEEDS,
  FONTS,
  FONT_CATEGORY_LABELS,
  REPLY_ANIMATIONS,
  TEXT_COLORS,
  TEXT_SIZES,
  fontById,
  type FontCategory,
  type FontOption,
} from '@atlas/tokens';
import { Icons, SegmentedControl, cn } from '@atlas/ui';
import { fontInstalled, useTextStyle } from '../../../app/text-style';
import { useTheme } from '../../../app/theme';
import { RevealText } from '../../../components/RevealText';

const PREVIEW_REPLY =
  "Done — I've opened your invoices folder and sorted it by date. The newest one is from Tuesday.";

export function TextAndColors() {
  const { style, update, reset, reducedMotion } = useTextStyle();
  const { resolved } = useTheme();
  const [replay, setReplay] = useState(0);

  const fonts = useMemo(() => FONTS.filter((f) => f.probe === null || fontInstalled(f.probe)), []);
  const animation = REPLY_ANIMATIONS.find((a) => a.id === style.animation)!;
  const speedMatters = style.animation === 'words' || style.animation === 'typewriter';

  return (
    <section>
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <h2 className="text-foreground text-sm font-medium">Text &amp; colors</h2>
        <button
          type="button"
          onClick={() => {
            reset();
            setReplay((n) => n + 1);
          }}
          className="text-foreground-subtle hover:text-foreground duration-fast text-xs transition"
        >
          Reset to defaults
        </button>
      </div>
      <p className="text-foreground-subtle mb-4 text-xs leading-relaxed">
        How your conversation with Atlas reads. The font applies across the app; size, colour and
        animation apply to messages.
      </p>

      {/* Preview — the real classes, the real reveal. */}
      <div className="border-border bg-background mb-5 flex flex-col gap-3 rounded-xl border px-4 py-4">
        <div className="accent-surface text-primary-foreground atlas-you self-end rounded-2xl rounded-br-md px-4 py-2.5">
          Open my invoices folder
        </div>
        <div className="atlas-reply max-w-[90%] leading-relaxed" key={`${replay}-${style.animation}-${style.speed}`}>
          <RevealText
            text={PREVIEW_REPLY}
            animate={!reducedMotion}
            animation={style.animation}
            speed={style.speed}
          />
        </div>
        {style.animation !== 'off' && (
          <button
            type="button"
            onClick={() => setReplay((n) => n + 1)}
            className="text-foreground-subtle hover:text-foreground duration-fast inline-flex items-center gap-1.5 self-start text-xs transition"
          >
            <Icons.RotateCcw className="h-3 w-3" /> Replay
          </button>
        )}
      </div>

      <div className="flex flex-col gap-5">
        <Row label="Font">
          <FontPicker fonts={fonts} value={style.font} onChange={(font) => update({ font })} />
        </Row>

        <Row label="Size">
          <SegmentedControl
            options={TEXT_SIZES.map((s) => ({ value: s.id, label: s.label }))}
            value={style.size}
            onChange={(size) => update({ size })}
          />
        </Row>

        <Row label="Atlas's replies">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Reply colour">
            {TEXT_COLORS.map((color) => {
              const selected = color.id === style.replyColor;
              const channels = color[resolved];
              return (
                <button
                  key={color.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => update({ replyColor: color.id })}
                  className={cn(
                    'duration-fast flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition',
                    'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                    selected
                      ? 'border-border-strong bg-surface text-foreground'
                      : 'border-border bg-surface/40 text-foreground-muted hover:bg-surface hover:text-foreground',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="text-sm font-semibold leading-none"
                    style={{ color: channels ? `rgb(${channels})` : 'rgb(var(--color-foreground))' }}
                  >
                    Aa
                  </span>
                  {color.label}
                </button>
              );
            })}
          </div>
        </Row>

        <Row label="Your messages">
          <SegmentedControl
            options={[
              { value: 'accent', label: 'Accent' },
              { value: 'subtle', label: 'Subtle' },
            ]}
            value={style.yourMessages}
            onChange={(yourMessages) => update({ yourMessages })}
          />
        </Row>

        <Row label="Reply animation">
          <SegmentedControl
            options={REPLY_ANIMATIONS.map((a) => ({ value: a.id, label: a.label }))}
            value={style.animation}
            onChange={(next) => {
              update({ animation: next });
              setReplay((n) => n + 1);
            }}
          />
          <p className="text-foreground-subtle mt-1.5 text-xs">
            {animation.description}
            {reducedMotion && style.animation !== 'off' && (
              <> Currently off, because your system has reduced motion turned on.</>
            )}
          </p>
        </Row>

        {speedMatters && (
          <Row label="Speed">
            <SegmentedControl
              options={ANIMATION_SPEEDS.map((s) => ({ value: s.id, label: s.label }))}
              value={style.speed}
              onChange={(speed) => {
                update({ speed });
                setReplay((n) => n + 1);
              }}
            />
          </Row>
        )}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-foreground-muted mb-1.5 text-xs font-medium">{label}</p>
      {children}
    </div>
  );
}

/**
 * A dropdown of fonts, each named in its own face, grouped by kind. A native
 * <select> cannot render options in different fonts inside WebView2, which is
 * the entire point of the list — so this is a small listbox with the keyboard
 * behaviour a select has: arrows move, Enter picks, Escape closes.
 */
function FontPicker({
  fonts,
  value,
  onChange,
}: {
  fonts: FontOption[];
  value: string;
  onChange(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, fonts.findIndex((f) => f.id === value)));
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const current = fontById(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    list.current?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (index: number) => {
    const font = fonts[index];
    if (!font) return;
    onChange(font.id);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + fonts.length) % fonts.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open) pick(active);
      else setOpen(true);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  const categories = [...new Set(fonts.map((f) => f.category))] as FontCategory[];

  return (
    <div ref={root} className="relative max-w-xs" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        // Seeds the resting position, so the first synthetic move after the
        // list scrolls is recognised as not a move at all.
        onPointerDown={(e) => (lastPointer.current = { x: e.clientX, y: e.clientY })}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'border-border bg-surface hover:border-border-strong duration-fast flex w-full items-center justify-between',
          'gap-3 rounded-lg border px-3 py-2 text-left text-sm transition',
          'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        )}
      >
        <span className="text-foreground truncate" style={{ fontFamily: current.stack }}>
          {current.label}
        </span>
        <Icons.ChevronDown
          className={cn('text-foreground-subtle duration-fast h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <ul
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-label="Font"
          aria-activedescendant={`font-${fonts[active]?.id}`}
          className={cn(
            'border-border bg-surface-raised atlas-reply-in absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto',
            'rounded-lg border p-1 shadow-lg focus:outline-none',
          )}
        >
          {categories.map((category) => (
            <li key={category} role="presentation">
              <p className="text-foreground-subtle px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide">
                {FONT_CATEGORY_LABELS[category]}
              </p>
              <ul role="group">
                {fonts.map((font, index) =>
                  font.category !== category ? null : (
                    <li
                      key={font.id}
                      id={`font-${font.id}`}
                      data-index={index}
                      role="option"
                      aria-selected={font.id === value}
                      // Move, not enter: arrowing through the list scrolls
                      // items under a resting pointer, and "enter" would then
                      // snatch the highlight back from the keyboard (seen in
                      // the real app — Down x10 landed on the 4th font).
                      onPointerMove={(e) => {
                        const moved = lastPointer.current;
                        lastPointer.current = { x: e.clientX, y: e.clientY };
                        // Chromium also sends a synthetic move after a scroll,
                        // at the same coordinates — only a real move counts.
                        if (moved && moved.x === e.clientX && moved.y === e.clientY) return;
                        if (index !== active) setActive(index);
                      }}
                      onClick={() => pick(index)}
                      className={cn(
                        'flex cursor-default items-center justify-between rounded-md px-2.5 py-1.5 text-sm',
                        index === active ? 'bg-surface text-foreground' : 'text-foreground-muted',
                      )}
                      style={{ fontFamily: font.stack }}
                    >
                      {font.label}
                      {font.id === value && <Icons.Check className="text-primary h-3.5 w-3.5" />}
                    </li>
                  ),
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
