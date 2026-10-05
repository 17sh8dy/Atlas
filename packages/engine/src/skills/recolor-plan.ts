/**
 * Recolouring a project, with no model: the pure half.
 *
 * "Switch the whole app look to red" is an ordinary request that used to end in "I couldn't reach
 * your language model" — but for a project Atlas built itself, or any project whose look lives in
 * CSS colours, nothing needs a model. A theme is a handful of colours that were chosen to go
 * together, so recolouring it is ROTATING THEIR HUE: every colour of the theme's own family moves
 * to the new hue, and keeps its lightness and saturation, which is what keeps contrast, dark
 * backgrounds and readable text exactly as they were.
 *
 * WHAT STAYS PUT, ON PURPOSE: colours outside the theme's family. A purple theme with a gold
 * "hot" chip and a green "good" badge stays a red theme with a gold chip and a green badge, because
 * those two are saying something (warm, success), not decorating. Pure greys have no hue and are
 * left alone too.
 *
 * NOTHING HERE TOUCHES A FILE. It takes text and returns text, so what Atlas shows on the
 * confirmation card and what it writes afterwards are produced by the same function.
 *
 * WHERE A COLOUR IS TRUSTED TO BE A COLOUR, because `#add`, `#bad` and `#face` are valid hex and
 * also very plausible element ids:
 *   · CSS: only inside a declaration's value (`prop: value;`), never in a selector.
 *   · HTML: `<style>` blocks, `style="…"` attributes, and `<meta name="theme-color">`.
 *   · JS/TS: a hex only when it is a whole quoted string (`'#a855f7'`), plus `rgb()`/`rgba()`.
 * `hsl()` and colour keywords (`purple`) are not rewritten; the report says so when one is seen.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** Undefined for a colour written without an alpha. */
  a?: number;
}

/** A hue in degrees [0, 360), with saturation and lightness in [0, 1]. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Named targets. Hues are the ones a person means by the word, not CSS's own keyword values. */
export const COLOR_HUES: Readonly<Record<string, number>> = {
  red: 0,
  crimson: 350,
  scarlet: 5,
  orange: 28,
  amber: 40,
  gold: 45,
  yellow: 52,
  lime: 90,
  green: 135,
  emerald: 150,
  mint: 160,
  teal: 175,
  turquoise: 178,
  cyan: 188,
  aqua: 188,
  blue: 218,
  navy: 225,
  indigo: 245,
  violet: 262,
  purple: 275,
  magenta: 300,
  fuchsia: 305,
  pink: 330,
};

/** A hue back to the nearest name, for the card ("purple → red"). */
export function hueName(hue: number): string {
  let best = 'red';
  let bestGap = 999;
  for (const [name, h] of Object.entries(COLOR_HUES)) {
    // Aliases that would read oddly as the answer to "what colour is this theme".
    if (['scarlet', 'aqua', 'fuchsia', 'turquoise', 'navy', 'gold', 'emerald', 'violet', 'crimson'].includes(name)) continue;
    const gap = hueGap(hue, h);
    if (gap < bestGap) {
      bestGap = gap;
      best = name;
    }
  }
  return best;
}

/** Shortest distance round the colour wheel. */
export function hueGap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

/**
 * What the person asked for, as a hue: "red", "dark red" (the modifier is dropped, the hue is what
 * matters), or a hex like "#e11d48". Null when it is not a colour Atlas knows.
 */
export function parseTargetHue(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (hex && (t.startsWith('#') || /[0-9]/.test(t)) && !(t in COLOR_HUES)) {
    const rgb = parseHex(`#${hex[1]}`);
    if (rgb) {
      const hsl = rgbToHsl(rgb);
      return hsl.s < 0.05 ? null : hsl.h;
    }
  }
  const words = t.split(/[\s-]+/).filter((w) => !MODIFIERS.has(w));
  for (const w of words.reverse()) {
    if (w in COLOR_HUES) return COLOR_HUES[w]!;
  }
  return null;
}

const MODIFIERS = new Set([
  'dark', 'darker', 'light', 'lighter', 'bright', 'brighter', 'deep', 'pale', 'soft', 'vivid', 'neon',
  'hot', 'dull', 'muted', 'rich', 'a', 'an', 'the', 'more', 'bit', 'little', 'slightly',
]);

/* ── Colour maths ────────────────────────────────────────────────────────────────────────── */

export function parseHex(literal: string): Rgba | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(literal);
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    ...(h.length === 8 ? { a: parseInt(h.slice(6, 8), 16) / 255 } : {}),
  };
}

export function rgbToHsl({ r, g, b }: Rgba): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  const sector = Math.floor((((h % 360) + 360) % 360) / 60);
  if (sector === 0) [rp, gp, bp] = [c, x, 0];
  else if (sector === 1) [rp, gp, bp] = [x, c, 0];
  else if (sector === 2) [rp, gp, bp] = [0, c, x];
  else if (sector === 3) [rp, gp, bp] = [0, x, c];
  else if (sector === 4) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  const to = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return { r: to(rp), g: to(gp), b: to(bp) };
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/* ── Finding colours in text ─────────────────────────────────────────────────────────────── */

export type Kind = 'css' | 'html' | 'js';

export function kindOf(path: string): Kind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === 'css' || ext === 'scss') return 'css';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'js';
  return null;
}

const HEX = String.raw`#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])`;
const RGB = String.raw`rgba?\(\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?(?:\s*[,/]\s*[\d.]+%?)?\s*\)`;
const COLOR = new RegExp(`${HEX}|${RGB}`, 'g');
/** The few calls whose string argument is a CSS selector, so `'#abc123'` there is an id. */
const SELECTOR_CALL = /(?:querySelector(?:All)?|closest|matches|getElementById|\$)\s*\(\s*$/;

/** A colour literal, parsed. Null for anything that merely looks like one (a 5-digit "hex"). */
export function parseLiteral(literal: string): Rgba | null {
  if (literal.startsWith('#')) return parseHex(literal);
  const m = /^rgba?\(\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(
    literal,
  );
  if (!m) return null;
  const chan = (v: string, pct: string) => (pct ? Math.round((Number(v) / 100) * 255) : Number(v));
  const a = m[7] === undefined ? undefined : m[8] ? Number(m[7]) / 100 : Number(m[7]);
  return { r: chan(m[1]!, m[2]!), g: chan(m[3]!, m[4]!), b: chan(m[5]!, m[6]!), ...(a === undefined ? {} : { a }) };
}

/**
 * Rewrite a literal at a new hue, in the same notation it came in: `#abc` stays a hex, `rgba()`
 * stays `rgba()` with its alpha untouched.
 */
function rewriteLiteral(literal: string, rgba: Rgba, hue: number): string {
  const hsl = rgbToHsl(rgba);
  const { r, g, b } = hslToRgb({ h: hue, s: hsl.s, l: hsl.l });
  if (literal.startsWith('#')) {
    const alpha = rgba.a === undefined ? '' : hex2(Math.round(rgba.a * 255));
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha}`;
  }
  const alpha = rgba.a === undefined ? '' : `, ${trimNumber(rgba.a)}`;
  return `${/^rgba/i.test(literal) ? 'rgba' : 'rgb'}(${r}, ${g}, ${b}${alpha})`;
}

const trimNumber = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * Walk the colours Atlas trusts in this file and let `visit` replace each one. Everything else in
 * the text passes through byte for byte.
 */
export function mapColors(text: string, kind: Kind, visit: (literal: string, rgba: Rgba) => string | null): string {
  const swap = (chunk: string) =>
    chunk.replace(COLOR, (literal) => {
      const rgba = parseLiteral(literal);
      if (!rgba) return literal;
      return visit(literal, rgba) ?? literal;
    });

  if (kind === 'css') return mapCssDeclarations(text, swap);

  if (kind === 'html') {
    let out = text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) =>
      open + mapCssDeclarations(css, swap) + close,
    );
    out = out.replace(/(\bstyle\s*=\s*")([^"]*)(")/gi, (_m, open: string, decls: string, close: string) =>
      open + mapInlineDeclarations(decls, swap) + close,
    );
    out = out.replace(/(<meta\b[^>]*\bname\s*=\s*["']theme-color["'][^>]*\bcontent\s*=\s*")([^"]*)(")/gi, (_m, open: string, v: string, close: string) =>
      open + swap(v) + close,
    );
    return out;
  }

  // JS / TS: a hex only when it is the whole of a quoted string; rgb()/rgba() anywhere.
  //
  // SIX OR EIGHT DIGITS ONLY, and never as the argument of a selector call: `'#add'`, `'#bad'` and
  // `'#face'` are valid three-digit hex and also exactly what code passes to `querySelector`. A
  // real theme colour in code is written out in full; a shorthand one is left for the person.
  let out = text.replace(/(['"`])(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))\1/g, (whole, q: string, literal: string, at: number) => {
    if (SELECTOR_CALL.test(text.slice(Math.max(0, at - 24), at))) return whole;
    const rgba = parseHex(literal);
    if (!rgba) return whole;
    const next = visit(literal, rgba);
    return next === null ? whole : `${q}${next}${q}`;
  });
  out = out.replace(new RegExp(RGB, 'gi'), (literal) => {
    const rgba = parseLiteral(literal);
    if (!rgba) return literal;
    return visit(literal, rgba) ?? literal;
  });
  return out;
}

/** A declaration value in a stylesheet: `: value ;` or `: value }`, never up to a `{`. */
function mapCssDeclarations(css: string, swap: (chunk: string) => string): string {
  return css.replace(/(:\s*)([^;{}]*?)(\s*(?=[;}]))/g, (_m, colon: string, value: string, tail: string) => colon + swap(value) + tail);
}

/** The inside of a `style="…"` attribute: no braces, the last declaration has no `;`. */
function mapInlineDeclarations(decls: string, swap: (chunk: string) => string): string {
  return decls.replace(/(:\s*)([^;]*?)(\s*(?:;|$))/g, (_m, colon: string, value: string, tail: string) => colon + swap(value) + tail);
}

/* ── The plan ────────────────────────────────────────────────────────────────────────────── */

/** How close to the theme's hue a colour has to be to count as part of the theme. */
const FAMILY_DEGREES = 45;
/** Below this a colour is grey: it has no hue to rotate. */
const GREY_SATURATION = 0.06;

/**
 * The hue the theme is built around: the most common hue, weighted by how colourful each colour
 * is (a vivid accent says more about a theme than a near-black with a faint tint). Null when
 * there is nothing colourful at all.
 */
export function dominantHue(colors: readonly Rgba[]): number | null {
  const bins = new Array<number>(24).fill(0);
  for (const c of colors) {
    const { h, s, l } = rgbToHsl(c);
    if (s < GREY_SATURATION) continue;
    const chroma = s * (1 - Math.abs(2 * l - 1));
    // A tinted near-black or near-white still votes, just quietly.
    const weight = 0.15 + chroma;
    bins[Math.floor(h / 15) % 24]! += weight;
  }
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < 24; i++) {
    const score = bins[i]! + 0.5 * (bins[(i + 23) % 24]! + bins[(i + 1) % 24]!);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;

  // The bin only says WHERE the theme is. The hue it is rotated from is the vivid accent inside
  // it, so that colour lands exactly on the target ("make it red" gives a red accent, not one
  // that is a few degrees off because of where a histogram bin happened to fall).
  const centre = best * 15 + 7.5;
  let accent: { h: number; chroma: number } | null = null;
  for (const c of colors) {
    const { h, s, l } = rgbToHsl(c);
    if (s < GREY_SATURATION || hueGap(h, centre) > 30) continue;
    const chroma = s * (1 - Math.abs(2 * l - 1));
    if (!accent || chroma > accent.chroma) accent = { h, chroma };
  }
  return accent ? accent.h : centre;
}

export interface FileRecolor {
  path: string;
  /** How many colours changed. */
  changed: number;
  before: string;
  after: string;
}

export interface RecolorPlan {
  /** The hue the theme was built around, and the hue it is moving to. */
  from: number;
  to: number;
  files: FileRecolor[];
  /** Colours in the family that moved, and ones left alone because they are a different colour. */
  moved: number;
  keptApart: number;
  /** `hsl()` / keyword colours seen but not rewritten. */
  notRewritten: number;
}

export type RecolorResult =
  | { kind: 'plan'; plan: RecolorPlan }
  | { kind: 'nothing'; reason: 'no-colours' | 'already' | 'no-files'; from?: number };

/**
 * Work out the whole recolour from the files' text. Pure: give it the same files and the same
 * target and it gives the same answer, which is what lets the card's fingerprint mean something.
 */
export function planRecolor(files: ReadonlyArray<{ path: string; text: string }>, targetHue: number): RecolorResult {
  const eligible = files.map((f) => ({ ...f, kind: kindOf(f.path) })).filter((f): f is { path: string; text: string; kind: Kind } => f.kind !== null);
  if (!eligible.length) return { kind: 'nothing', reason: 'no-files' };

  const seen: Rgba[] = [];
  let notRewritten = 0;
  for (const f of eligible) {
    mapColors(f.text, f.kind, (_l, rgba) => {
      seen.push(rgba);
      return null;
    });
    if (f.kind !== 'js') notRewritten += (f.text.match(/\bhsla?\(/gi) ?? []).length;
  }
  const from = dominantHue(seen);
  if (from === null) return { kind: 'nothing', reason: 'no-colours' };
  if (hueGap(from, targetHue) < 15) return { kind: 'nothing', reason: 'already', from };

  const shift = targetHue - from;
  let moved = 0;
  let keptApart = 0;
  const out: FileRecolor[] = [];
  for (const f of eligible) {
    let changed = 0;
    const after = mapColors(f.text, f.kind, (literal, rgba) => {
      const hsl = rgbToHsl(rgba);
      if (hsl.s < GREY_SATURATION) return null;
      if (hueGap(hsl.h, from) > FAMILY_DEGREES) {
        keptApart += 1;
        return null;
      }
      const next = rewriteLiteral(literal, rgba, (((hsl.h + shift) % 360) + 360) % 360);
      if (next.toLowerCase() === literal.toLowerCase()) return null;
      changed += 1;
      return next;
    });
    if (changed) {
      moved += changed;
      out.push({ path: f.path, changed, before: f.text, after });
    }
  }
  if (!out.length) return { kind: 'nothing', reason: 'already', from };
  return { kind: 'plan', plan: { from, to: targetHue, files: out, moved, keptApart, notRewritten } };
}
