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

export type AccentId =
  | 'purple'
  | 'red'
  | 'orange'
  | 'sunset'
  | 'ocean'
  | 'emerald'
  | 'titanium'
  | 'arctic'
  | 'gold'
  | 'rose';

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
    // Four points darker than the original `124 92 255`, as tokens.css says: white
    // on the old value measured 4.35:1. This file overrides the stylesheet at
    // runtime, so the stylesheet's fix had quietly stopped applying.
    dark: { primary: '120 88 251', primaryForeground: '255 255 255', accent: '99 102 241' },
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
    // Same orange-to-pink, taken darker so a white label clears 4.5:1 on both
    // stops — at rest and under the 10% brightening a hovered button gets.
    dark: { primary: '172 79 15', primaryForeground: '255 255 255', accent: '184 56 119' },
    light: { primary: '184 69 9', primaryForeground: '255 255 255', accent: '199 35 108' },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    mixed: true,
    // Same blue-to-teal, taken darker for the same reason as Sunset.
    dark: { primary: '10 113 160', primaryForeground: '255 255 255', accent: '13 119 107' },
    light: { primary: '2 112 169', primaryForeground: '255 255 255', accent: '10 119 109' },
  },
  // ── Palettes that pair a bright accent with a near-black label ──────────────
  // Each is three colours: the accent (#39D98A), its highlight (#A3FFD1, the
  // second glow stop) and a deep tone (#101B17) that the button *label* uses in
  // dark mode — bright fills want dark text, and it is what makes them read as
  // one palette rather than a colour with white pasted on. Light mode takes the
  // same hue down to a shade that still reads as text on white.
  {
    // Emerald / Matrix — clean green, subtle glow, a local-computing feel.
    id: 'emerald',
    label: 'Emerald',
    mixed: false,
    dark: { primary: '57 217 138', primaryForeground: '16 27 23', accent: '163 255 209' },
    light: { primary: '8 127 75', primaryForeground: '255 255 255', accent: '11 107 69' },
  },
  {
    // Titanium / Silver — minimal and hardware-like. #D1D5DB with #FFFFFF, on #17191D.
    id: 'titanium',
    label: 'Titanium',
    mixed: false,
    dark: { primary: '209 213 219', primaryForeground: '23 25 29', accent: '255 255 255' },
    light: { primary: '71 85 105', primaryForeground: '255 255 255', accent: '100 116 139' },
  },
  {
    // Arctic — ice cyan.
    id: 'arctic',
    label: 'Arctic',
    mixed: false,
    dark: { primary: '103 232 249', primaryForeground: '8 30 36', accent: '165 243 252' },
    light: { primary: '14 116 144', primaryForeground: '255 255 255', accent: '21 94 117' },
  },
  {
    // Gold — warm and understated.
    id: 'gold',
    label: 'Gold',
    mixed: false,
    dark: { primary: '245 197 66', primaryForeground: '30 22 4', accent: '253 230 138' },
    light: { primary: '161 98 7', primaryForeground: '255 255 255', accent: '133 77 14' },
  },
  {
    // Rose — soft pink, distinct from Red.
    id: 'rose',
    label: 'Rose',
    mixed: false,
    dark: { primary: '251 113 133', primaryForeground: '40 6 14', accent: '253 164 175' },
    light: { primary: '190 18 60', primaryForeground: '255 255 255', accent: '159 18 57' },
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

/**
 * The colour of a label drawn *on* a scheme's fill — the same one the primary
 * button uses. A tick on a swatch needs it: white is right on purple and
 * invisible on Titanium's silver.
 */
export function accentLabel(scheme: AccentScheme, theme: ResolvedTheme): string {
  const vars = theme === 'light' ? scheme.light : scheme.dark;
  return `rgb(${vars.primaryForeground})`;
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
