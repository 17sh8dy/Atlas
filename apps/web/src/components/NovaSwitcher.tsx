/**
 * The Nova product switcher — a small trigger next to the title bar's logo that opens a menu of
 * sibling Nova products. Ported from the reference implementation in OpenCutSite
 * (src/components.mjs `novaSwitcher()` + data/nova.js) and mirrored in Open Cut's and Replay.gg's
 * own apps — see any of those for the design rationale, and keep this list in sync with theirs
 * by hand.
 *
 * The trigger reads "Product Switcher" rather than "Atlas" or "Nova" — it announces what it
 * does, not which product you're already in (the wordmark to its left already does that).
 *
 * Left out on purpose: Nova, Nova.Help and NovaLegal each already have their own way to switch
 * between the products they front, so neither gets this switcher nor is listed as a destination
 * in it. Online Earth was never asked for and isn't here either.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Platform } from '@atlas/core';
import { Icons, cn } from '@atlas/ui';

import { NovaAllProducts } from './NovaAllProducts';
import { NOVA_HOME_URL, openNovaProduct, type NovaLaunchable, type NovaProductKind } from './novaProducts';

interface NovaProduct extends NovaLaunchable {
  tagline: string;
  icon: Icons.LucideIcon;
  /**
   * 'app' launches the installed program in the background, 'site' opens the browser, 'soon'
   * renders disabled. See `novaProducts.ts` for how each one is opened. Only addresses that
   * really exist are listed: Atlas's own download page is real; Nova Cut and Replay.gg have none
   * yet, so a missing install sends people to the Nova home page instead of a guessed domain.
   */
  kind: NovaProductKind;
}

const PRODUCTS: NovaProduct[] = [
  {
    id: 'nova-cut',
    label: 'Nova Cut',
    tagline: 'Create and edit',
    icon: Icons.Scissors,
    // "Soon" until Nova Cut is ready. To turn it on: kind: 'app', appIds: ['novacut'].
    kind: 'soon',
  },
  {
    id: 'replay-gg',
    label: 'Replay.GG',
    tagline: 'Record and clip gameplay',
    icon: Icons.Gamepad2,
    kind: 'app',
    appIds: ['replaygg'],
  },
  {
    id: 'atlas',
    label: 'Atlas',
    tagline: 'Your desktop assistant',
    icon: Icons.Sparkles,
    kind: 'app',
    getUrl: 'https://atlas-website.shadylabs.workers.dev/',
  },
  {
    id: 'nova-games',
    label: 'Nova Games',
    tagline: 'Coming soon',
    icon: Icons.Gamepad2,
    kind: 'soon',
  },
];

/**
 * The Nova websites, shown under "Websites" in View all (not in the quick dropdown, which is
 * for jumping between apps). Only sites that are deployed and have a real address are links;
 * the rest render as "Soon" until they are.
 */
const SITES: NovaProduct[] = [
  {
    id: 'nova-help',
    label: 'Nova.Help',
    tagline: 'Support and guides',
    icon: Icons.Search,
    kind: 'site',
    url: 'https://nova-help.shadylabs.workers.dev/',
  },
  {
    id: 'atlas-site',
    label: 'Atlas Website',
    tagline: 'Download and learn about Atlas',
    icon: Icons.Sparkles,
    kind: 'site',
    url: 'https://atlas-website.shadylabs.workers.dev/',
  },
  { id: 'nova', label: 'Nova', tagline: 'The Nova home page', icon: Icons.Globe, kind: 'site', url: NOVA_HOME_URL },
  { id: 'nova-legal', label: 'Nova Legal', tagline: 'Terms and privacy', icon: Icons.FileText, kind: 'soon' },
  { id: 'nova-cut-site', label: 'Nova Cut Website', tagline: 'Nova Cut, on the web', icon: Icons.Scissors, kind: 'soon' },
];

/** The Nova sparkle mark — identical to assets/favicon.svg in the Nova repo. */
function NovaMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-full w-full">
      <rect width="24" height="24" rx="5.5" fill="#0E1120" />
      <path
        fill="#7C5CFF"
        d="M12 3.1c.52 5.46 3.95 8.89 9.41 9.41-5.46.52-8.89 3.95-9.41 9.41-.52-5.46-3.95-8.89-9.41-9.41C8.05 11.99 11.48 8.56 12 3.1Z"
      />
    </svg>
  );
}

export function NovaSwitcher({ current, platform }: { current: string; platform: Platform }) {
  const [open, setOpen] = useState(false);
  /** Why the last open didn't happen ("isn't installed"), shown in the menu. */
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const openProduct = async (p: NovaProduct) => {
    setNote(null);
    setBusyId(p.id);
    const result = await openNovaProduct(platform, p);
    setBusyId(null);
    if (result.ok) {
      setOpen(false);
      setAllOpen(false);
    } else {
      setNote(result.message);
    }
  };
  const [allOpen, setAllOpen] = useState(false);
  /**
   * Where the portaled menu below should sit, in viewport coordinates.
   *
   * Measured from the trigger the instant it opens rather than left to CSS
   * `absolute` positioning, because the menu is no longer a DOM descendant of
   * this component once portaled (see the doc comment above the portal call
   * for why it's portaled at all).
   */
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // A click is "outside" only if it lands in neither the trigger's own
    // wrapper nor the portaled menu — checked separately because the menu no
    // longer lives inside `rootRef` in the DOM.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          // Measured before the flip, in the same handler, so the menu never
          // paints a frame at its previous (or default 0,0) position — by the
          // time `open` reaches this render, `menuPos` already matches it.
          if (!open) {
            setNote(null);
            const rect = rootRef.current?.getBoundingClientRect();
            if (rect) setMenuPos({ top: rect.bottom + 8, left: rect.left });
          }
          setOpen((v) => !v);
        }}
        className={cn(
          'atlas-enhance duration-fast flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition',
          'border-border text-foreground-muted hover:bg-surface hover:text-foreground',
          open && 'bg-surface text-foreground border-border-strong',
        )}
      >
        <span className="h-4 w-4 shrink-0 overflow-hidden rounded">
          <NovaMark />
        </span>
        <span>Product Switcher</span>
        <Icons.ChevronDown
          className={cn(
            'duration-fast h-3 w-3 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {/*
        Portaled to `document.body` rather than left as a plain `absolute`
        child here — the title bar this trigger lives in has `backdrop-blur`
        (see `TitleBar.tsx`), and `backdrop-filter` creates a CSS stacking
        context on whatever element it's set on. That pins every descendant's
        stacking — however high its own `z-index` — inside the title bar's
        single slot in the *page's* stacking order, so a later, unrelated
        sibling with no `z-index` of its own (the ordinary content area below
        the title bar) can end up compositing on top of this menu wherever the
        two visually overlap, even though the menu is drawn with `z-50`. Menu
        items would still render, but a click there would land on whatever
        the compositor decided was actually on top — "the button is right
        there and does nothing" is exactly what that looks like. Portaling
        clears the title bar's stacking context entirely, the same reasoning
        `NovaAllProducts` below already applies via `Modal`'s own portal.
      */}
      {createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
          className={cn(
            'border-border bg-surface-raised z-50 w-64 origin-top-left rounded-lg border p-2 shadow-lg',
            'duration-base transition-[opacity,transform] ease-out',
            open
              ? 'pointer-events-auto visible translate-y-0 scale-100 opacity-100'
              : 'pointer-events-none invisible -translate-y-1.5 scale-95 opacity-0',
          )}
        >
          <p className="text-foreground-subtle mx-2 mb-1.5 mt-0.5 text-[10px] font-bold uppercase tracking-wide">
            Nova
          </p>
          {PRODUCTS.map((p) => {
            const Icon = p.icon;
            const isCurrent = p.id === current;
            const body = (
              <>
                <span
                  className={cn(
                    'bg-surface text-foreground-muted grid h-7 w-7 shrink-0 place-items-center rounded-md',
                    // The active row reads as "on", the same state every other flat
                    // indicator in the app (toggles, focus rings, the plain — not
                    // gradient-surface — buttons) paints with `primary`, not the
                    // separate `accent` token. Sunset/Ocean's `accent` is a second,
                    // deliberately different hue for gradients only (see
                    // `accents.ts`); used flat here it was the one control in the
                    // whole app that didn't track the chosen accent colour.
                    isCurrent && 'text-primary',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="text-foreground text-[13px] font-semibold">{p.label}</span>
                  <span
                    className={cn('text-foreground-subtle text-[11px]', isCurrent && 'text-primary')}
                  >
                    {isCurrent ? "You're here" : p.tagline}
                  </span>
                </span>
              </>
            );

            if (isCurrent) {
              return (
                <span
                  key={p.id}
                  role="menuitem"
                  aria-current="true"
                  className="bg-primary/10 flex cursor-default items-center gap-2.5 rounded-md p-2"
                >
                  {body}
                </span>
              );
            }
            if (p.kind === 'soon') {
              return (
                <span
                  key={p.id}
                  role="menuitem"
                  aria-disabled="true"
                  className="text-foreground-subtle flex cursor-default items-center gap-2.5 rounded-md p-2"
                >
                  {body}
                  <span className="bg-surface text-foreground-subtle ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold">
                    Soon
                  </span>
                </span>
              );
            }
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                disabled={busyId !== null}
                onClick={() => void openProduct(p)}
                className="hover:bg-surface flex w-full items-center gap-2.5 rounded-md p-2 text-left disabled:opacity-60"
              >
                {body}
                {p.kind === 'site' && (
                  <Icons.Globe
                    className="text-foreground-subtle ml-auto h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
          {note && (
            <p role="status" className="text-foreground-muted mx-2 my-1.5 text-[11px] leading-snug">
              {note}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setAllOpen(true);
            }}
            className="text-foreground-muted hover:text-foreground hover:bg-surface duration-fast border-border group mt-0.5 flex w-full items-center justify-center gap-1.5 rounded-md border-t p-2 text-xs font-semibold transition"
          >
            <span>View all</span>
            <Icons.ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>,
        document.body,
      )}
      <NovaAllProducts
        open={allOpen}
        onClose={() => setAllOpen(false)}
        current={current}
        products={PRODUCTS}
        sites={SITES}
        mark={<NovaMark />}
        onOpen={(id) => {
          const p = [...PRODUCTS, ...SITES].find((x) => x.id === id);
          if (p) void openProduct(p);
        }}
        note={note}
      />
    </div>
  );
}
