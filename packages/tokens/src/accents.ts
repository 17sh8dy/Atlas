/**
 * Accent schemes — the colour of every button, highlight and focus ring.
 *
 * This is deliberately *not* a second theme system. Light/dark decides the
 * surfaces you read on; an accent decides the one colour painted on top of
 * them, and the two compose: each scheme carries a dark and a light variant,
 * because a purple that reads well on near-black is too pale on white.
 *
 * Schemes are applied as inline custom properties on the root element rather
 * than as another `[data-*]` block in `tokens.css`. Inline wins over every
 * stylesheet rule without a specificity argument, which matters because the
 * light theme already overrides these same variables — and it keeps the
 * definitions here, in one typed place the settings UI can render swatches
 * from instead of repeating the colours in markup.
 *
 * A "mixed" scheme paints a gradient. Since `--color-primary` has to stay a
 * flat colour (Tailwind's `bg-primary/10` tints depend on it), the gradient
 * lives in its own variable and only the handful of solid accent surfaces —
 * the `.accent-surface` class in `tokens.css` — pick it up. Everything tinted,
 * outlined or lit by the accent keeps using the flat primary, which is what
 * makes a gradient scheme look intentional rather than smeared everywhere.
 */

import type { ResolvedTheme } from './index';

/** Raw `r g b` channels, so Tailwind's `/<alpha>` modifiers keep working. */
interface AccentVars {
  primary: string;
  primaryForeground: string;
  /** The gradient's second stop. Equal to `primary` in the flat schemes. */
  accent: string;
}

export type AccentId = 'purple' | 'red' | 'orange' | 'sunset' | 'ocean';

export interface AccentScheme {
  id: AccentId;
  label: string;
  /** Paints a gradient rather than a flat colour. */
  mixed: boolean;
  dark: AccentVars;
  light: AccentVars;
}

export const ACCENTS: readonly AccentScheme[] = [
  {
    id: 'purple',
    label: 'Purple',
    mixed: false,
    dark: { primary: '124 92 255', primaryForeground: '255 255 255', accent: '99 102 241' },
    light: { primary: '109 74 255', primaryForeground: '255 255 255', accent: '79 82 221' },
  },
  {
    id: 'red',
    label: 'Red',
    mixed: false,
    dark: { primary: '239 68 68', primaryForeground: '255 255 255', accent: '220 38 38' },
    light: { primary: '220 38 38', primaryForeground: '255 255 255', accent: '185 28 28' },
  },
  {
    id: 'orange',
    label: 'Orange',
    mixed: false,
    dark: { primary: '249 115 22', primaryForeground: '25 12 2', accent: '234 88 12' },
    light: { primary: '234 88 12', primaryForeground: '255 255 255', accent: '194 65 12' },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    mixed: true,
    dark: { primary: '249 115 22', primaryForeground: '255 255 255', accent: '236 72 153' },
    light: { primary: '234 88 12', primaryForeground: '255 255 255', accent: '219 39 119' },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    mixed: true,
    dark: { primary: '14 165 233', primaryForeground: '255 255 255', accent: '20 184 166' },
    light: { primary: '2 132 199', primaryForeground: '255 255 255', accent: '13 148 136' },
  },
];

export const DEFAULT_ACCENT: AccentId = 'purple';

export function accentById(id: string): AccentScheme {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]!;
}

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === 'string' && ACCENTS.some((a) => a.id === value);
}

function gradient(vars: AccentVars): string {
  return `linear-gradient(135deg, rgb(${vars.primary}), rgb(${vars.accent}))`;
}

/**
 * What a scheme looks like as a single swatch — the gradient for mixed
 * schemes, the flat colour for the rest. Read by the settings UI so the
 * preview can't drift from what applying the scheme actually does.
 */
export function accentSwatch(scheme: AccentScheme, theme: ResolvedTheme): string {
  const vars = theme === 'light' ? scheme.light : scheme.dark;
  return scheme.mixed ? gradient(vars) : `rgb(${vars.primary})`;
}

/** Paint a scheme onto the document. Safe to call on every theme change. */
export function applyAccent(root: HTMLElement, id: AccentId, theme: ResolvedTheme): void {
  const scheme = accentById(id);
  const vars = theme === 'light' ? scheme.light : scheme.dark;

  root.style.setProperty('--color-primary', vars.primary);
  root.style.setProperty('--color-primary-foreground', vars.primaryForeground);
  root.style.setProperty('--color-accent', vars.accent);
  root.style.setProperty('--color-ring', vars.primary);
  root.style.setProperty('--gradient-primary', scheme.mixed ? gradient(vars) : 'none');
  // The glow is built from both stops so a mixed scheme glows in both colours.
  root.style.setProperty(
    '--shadow-glow',
    `0 0 0 1px rgb(${vars.primary} / 0.3), 0 8px 30px -6px rgb(${vars.accent} / 0.35)`,
  );

  // Exposed as an attribute too, for anything that needs to style *by* scheme
  // rather than by colour.
  root.dataset.accent = id;
}
