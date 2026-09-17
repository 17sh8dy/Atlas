/**
 * Text & colors — applies Personalization's reading preferences to the page.
 *
 * Same shape as `effects.tsx` and `theme.tsx`, and for the same reason kept
 * separate from both: theme is the app's colours, effects is how much the
 * interface moves, and this is how the conversation reads. Three independent
 * settings, three providers, none able to disturb another.
 *
 * localStorage rather than the `Storage` port, like theme and accent: this is
 * read synchronously before first paint, and a font that swaps a moment after
 * launch is exactly the flash those two avoid the same way.
 *
 * Everything is applied as CSS variables on the root (see `styles/index.css`'s
 * "Text & colors" block), so no component re-renders to change a font.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_TEXT_STYLE,
  TEXT_SIZES,
  fontById,
  readTextStyle,
  textColorById,
  type TextStyle,
} from '@atlas/tokens';
import { useTheme } from './theme';

const STORAGE_KEY = 'atlas.textStyle';

interface TextStyleContextValue {
  style: TextStyle;
  update(next: Partial<TextStyle>): void;
  reset(): void;
  /** True when the OS asks for reduced motion — reply animations are then skipped whatever is chosen. */
  reducedMotion: boolean;
}

const TextStyleContext = createContext<TextStyleContextValue | null>(null);

function readStored(): TextStyle {
  try {
    return readTextStyle(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_TEXT_STYLE;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function TextStyleProvider({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  const [style, setStyle] = useState<TextStyle>(readStored);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // "System" removes the override rather than setting a stack, so the
    // default is exactly what tokens.css already ships — choosing nothing
    // changes nothing.
    if (style.font === 'system') root.style.removeProperty('--font-sans');
    else root.style.setProperty('--font-sans', fontById(style.font).stack);

    const px = TEXT_SIZES.find((s) => s.id === style.size)?.px ?? 14;
    root.style.setProperty('--atlas-reading-size', `${px}px`);

    // Re-applied on theme change: each colour has a light and a dark value.
    const color = textColorById(style.replyColor)[resolved];
    if (color) root.style.setProperty('--atlas-reply-color', color);
    else root.style.removeProperty('--atlas-reply-color');

    root.dataset.yourMessages = style.yourMessages;
  }, [style, resolved]);

  const value = useMemo<TextStyleContextValue>(() => {
    const save = (next: TextStyle) => {
      setStyle(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Unsaved is still applied for this session.
      }
    };
    return {
      style,
      update: (next) => save({ ...style, ...next }),
      reset: () => save(DEFAULT_TEXT_STYLE),
      reducedMotion,
    };
  }, [style, reducedMotion]);

  return <TextStyleContext.Provider value={value}>{children}</TextStyleContext.Provider>;
}

export function useTextStyle(): TextStyleContextValue {
  const ctx = useContext(TextStyleContext);
  if (!ctx) throw new Error('useTextStyle must be used within a TextStyleProvider');
  return ctx;
}

/**
 * Whether this machine has a font, by measurement.
 *
 * There is no API for "is this family installed" in a webview. What there is:
 * a string drawn in `"Family", monospace` is the width of monospace when the
 * family is missing, and so is one drawn in `"Family", serif` the width of
 * serif. A font that changes both is really there. Two fallbacks rather than
 * one so a font that happens to match one of them by width is not missed.
 */
export function fontInstalled(family: string): boolean {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return true; // can't tell; offering it costs a fallback at worst
  const sample = 'mmmmmmmmmmlli1WQ@#&';
  return (['monospace', 'serif'] as const).every((generic) => {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px '${family}', ${generic}`;
    return ctx.measureText(sample).width !== base;
  });
}
