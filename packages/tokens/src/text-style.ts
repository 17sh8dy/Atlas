/**
 * Text & colors — the conversation's typeface, size, colour and how replies
 * arrive on screen. Personalization, not Appearance: these are how *you* like
 * to read Atlas, where Appearance is the app's own light/dark and accent.
 *
 * ── Fonts are the machine's, not bundled ────────────────────────────────────
 * Atlas is local-first and its CSP allows no remote stylesheets, so every
 * option here is a font Windows ships (or Office adds). The list is a
 * catalogue, not a promise: the app measures which ones this machine actually
 * has (`fontInstalled` in the web app) and offers only those. `probe` is the
 * family name that measurement checks for.
 *
 * ── Colours are pairs, and every pair is contrast-checked ───────────────────
 * A reply colour is chosen once and read in both themes, so each carries a
 * light and a dark value. `test/text-style.test.ts` holds every one of them to
 * WCAG AA (4.5:1) against the page *and* card surfaces of the theme it is for
 * — the same bar tokens.css's own text colours were rebuilt to meet.
 */

export type FontCategory = 'sans' | 'serif' | 'mono' | 'casual';

export interface FontOption {
  id: string;
  label: string;
  category: FontCategory;
  /** The family name used to detect whether this machine has it. Null for the system default. */
  probe: string | null;
  /** The CSS stack. Always ends in a generic family, so a missing font degrades rather than breaks. */
  stack: string;
}

const sans = (family: string) => `'${family}', 'Segoe UI', system-ui, sans-serif`;
const serif = (family: string) => `'${family}', Georgia, serif`;
const mono = (family: string) => `'${family}', Consolas, ui-monospace, monospace`;

export const FONTS: readonly FontOption[] = [
  {
    id: 'system',
    label: 'System',
    category: 'sans',
    probe: null,
    stack: "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif",
  },
  { id: 'segoe', label: 'Segoe UI', category: 'sans', probe: 'Segoe UI', stack: sans('Segoe UI') },
  { id: 'aptos', label: 'Aptos', category: 'sans', probe: 'Aptos', stack: sans('Aptos') },
  { id: 'bahnschrift', label: 'Bahnschrift', category: 'sans', probe: 'Bahnschrift', stack: sans('Bahnschrift') },
  { id: 'calibri', label: 'Calibri', category: 'sans', probe: 'Calibri', stack: sans('Calibri') },
  { id: 'candara', label: 'Candara', category: 'sans', probe: 'Candara', stack: sans('Candara') },
  { id: 'corbel', label: 'Corbel', category: 'sans', probe: 'Corbel', stack: sans('Corbel') },
  {
    id: 'franklin',
    label: 'Franklin Gothic',
    category: 'sans',
    probe: 'Franklin Gothic Medium',
    stack: sans('Franklin Gothic Medium'),
  },
  { id: 'tahoma', label: 'Tahoma', category: 'sans', probe: 'Tahoma', stack: sans('Tahoma') },
  { id: 'trebuchet', label: 'Trebuchet', category: 'sans', probe: 'Trebuchet MS', stack: sans('Trebuchet MS') },
  { id: 'verdana', label: 'Verdana', category: 'sans', probe: 'Verdana', stack: sans('Verdana') },
  { id: 'georgia', label: 'Georgia', category: 'serif', probe: 'Georgia', stack: serif('Georgia') },
  { id: 'cambria', label: 'Cambria', category: 'serif', probe: 'Cambria', stack: serif('Cambria') },
  { id: 'constantia', label: 'Constantia', category: 'serif', probe: 'Constantia', stack: serif('Constantia') },
  {
    id: 'palatino',
    label: 'Palatino',
    category: 'serif',
    probe: 'Palatino Linotype',
    stack: serif('Palatino Linotype'),
  },
  { id: 'sitka', label: 'Sitka', category: 'serif', probe: 'Sitka Text', stack: serif('Sitka Text') },
  { id: 'cascadia-code', label: 'Cascadia Code', category: 'mono', probe: 'Cascadia Code', stack: mono('Cascadia Code') },
  { id: 'cascadia-mono', label: 'Cascadia Mono', category: 'mono', probe: 'Cascadia Mono', stack: mono('Cascadia Mono') },
  { id: 'consolas', label: 'Consolas', category: 'mono', probe: 'Consolas', stack: mono('Consolas') },
  { id: 'lucida-console', label: 'Lucida Console', category: 'mono', probe: 'Lucida Console', stack: mono('Lucida Console') },
  { id: 'comic', label: 'Comic Sans', category: 'casual', probe: 'Comic Sans MS', stack: sans('Comic Sans MS') },
  { id: 'ink-free', label: 'Ink Free', category: 'casual', probe: 'Ink Free', stack: sans('Ink Free') },
  { id: 'segoe-print', label: 'Segoe Print', category: 'casual', probe: 'Segoe Print', stack: sans('Segoe Print') },
];

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  mono: 'Monospace',
  casual: 'Casual',
};

export interface TextColorOption {
  id: string;
  label: string;
  /** RGB channels, like every colour token. Null means the theme's own foreground. */
  dark: string | null;
  light: string | null;
}

export const TEXT_COLORS: readonly TextColorOption[] = [
  { id: 'default', label: 'Default', dark: null, light: null },
  { id: 'soft', label: 'Soft', dark: '206 206 216', light: '58 61 72' },
  { id: 'warm', label: 'Warm', dark: '240 226 204', light: '84 58 34' },
  { id: 'sepia', label: 'Sepia', dark: '222 204 176', light: '101 74 46' },
  { id: 'rose', label: 'Rose', dark: '244 208 218', light: '122 40 66' },
  { id: 'lavender', label: 'Lavender', dark: '220 212 250', light: '70 48 128' },
  { id: 'cool', label: 'Cool', dark: '204 222 244', light: '30 56 92' },
  { id: 'mint', label: 'Mint', dark: '196 236 220', light: '22 84 64' },
];

export type TextSize = 'small' | 'default' | 'large' | 'larger';
export const TEXT_SIZES: readonly { id: TextSize; label: string; px: number }[] = [
  { id: 'small', label: 'Small', px: 13 },
  { id: 'default', label: 'Default', px: 14 },
  { id: 'large', label: 'Large', px: 16 },
  { id: 'larger', label: 'Larger', px: 18 },
];

/**
 * How a reply arrives. `words` is the default: it reads like being written,
 * the way Claude's does, without the slow-motion feel of a typewriter.
 */
export type ReplyAnimation = 'off' | 'fade' | 'words' | 'typewriter';
export const REPLY_ANIMATIONS: readonly { id: ReplyAnimation; label: string; description: string }[] = [
  { id: 'words', label: 'Word by word', description: 'Words fade in as the reply is written.' },
  { id: 'typewriter', label: 'Typewriter', description: 'Letter by letter, with a cursor.' },
  { id: 'fade', label: 'Fade in', description: 'The whole reply fades in at once.' },
  { id: 'off', label: 'Off', description: 'Replies appear instantly.' },
];

export type AnimationSpeed = 'relaxed' | 'normal' | 'quick';
export const ANIMATION_SPEEDS: readonly { id: AnimationSpeed; label: string }[] = [
  { id: 'relaxed', label: 'Relaxed' },
  { id: 'normal', label: 'Normal' },
  { id: 'quick', label: 'Quick' },
];

/**
 * Per-unit delay and the ceiling for one whole reply. The ceiling is what
 * keeps a long answer from becoming a wait: a 400-word reply gets the same
 * total time as a 60-word one, just with faster steps.
 */
export const ANIMATION_TIMING: Record<AnimationSpeed, { wordMs: number; charMs: number; maxMs: number }> = {
  relaxed: { wordMs: 55, charMs: 22, maxMs: 2600 },
  normal: { wordMs: 32, charMs: 12, maxMs: 1600 },
  quick: { wordMs: 16, charMs: 6, maxMs: 850 },
};

export type YourMessageStyle = 'accent' | 'subtle';

export interface TextStyle {
  font: string;
  size: TextSize;
  replyColor: string;
  yourMessages: YourMessageStyle;
  animation: ReplyAnimation;
  speed: AnimationSpeed;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'system',
  size: 'default',
  replyColor: 'default',
  yourMessages: 'accent',
  animation: 'words',
  speed: 'normal',
};

/**
 * Whatever was stored, made safe to apply. Field by field, so one stale value
 * (a font id from an older build) costs that one field, not the whole style.
 */
export function readTextStyle(raw: unknown): TextStyle {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TextStyle, unknown>>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  return {
    font: pick(v.font, FONTS.map((f) => f.id), DEFAULT_TEXT_STYLE.font),
    size: pick(v.size, TEXT_SIZES.map((s) => s.id), DEFAULT_TEXT_STYLE.size),
    replyColor: pick(v.replyColor, TEXT_COLORS.map((c) => c.id), DEFAULT_TEXT_STYLE.replyColor),
    yourMessages: pick(v.yourMessages, ['accent', 'subtle'] as const, DEFAULT_TEXT_STYLE.yourMessages),
    animation: pick(v.animation, REPLY_ANIMATIONS.map((a) => a.id), DEFAULT_TEXT_STYLE.animation),
    speed: pick(v.speed, ANIMATION_SPEEDS.map((s) => s.id), DEFAULT_TEXT_STYLE.speed),
  };
}

export function fontById(id: string): FontOption {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]!;
}

export function textColorById(id: string): TextColorOption {
  return TEXT_COLORS.find((c) => c.id === id) ?? TEXT_COLORS[0]!;
}

/**
 * How many steps a reply is revealed in, and how long each one takes.
 * Pure, so the pacing rules are testable without a browser.
 */
export function revealPlan(
  units: number,
  animation: ReplyAnimation,
  speed: AnimationSpeed,
): { stepMs: number; totalMs: number } {
  if (animation === 'off' || animation === 'fade' || units <= 1) return { stepMs: 0, totalMs: 0 };
  const timing = ANIMATION_TIMING[speed];
  const perUnit = animation === 'typewriter' ? timing.charMs : timing.wordMs;
  const totalMs = Math.min(units * perUnit, timing.maxMs);
  return { stepMs: totalMs / units, totalMs };
}
