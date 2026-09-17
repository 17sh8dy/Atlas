/**
 * Design token references for use in TS/JS (motion, theme mode).
 * The full token set lives in `tokens.css` as CSS variables — this file only
 * exposes the values that need to be read from application code.
 */

export const duration = {
  fast: 120,
  base: 200,
  slow: 320,
} as const;

export const easing = {
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export {
  ACCENTS,
  DEFAULT_ACCENT,
  accentById,
  accentSwatch,
  applyAccent,
  isAccentId,
} from './accents';
export type { AccentId, AccentScheme } from './accents';

export * from './text-style';
