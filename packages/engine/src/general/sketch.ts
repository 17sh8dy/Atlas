/**
 * Sketches: "draw me a house" answered with a picture the connected model writes as SVG code.
 *
 * ── What this is and is not ──────────────────────────────────────────────────────────────────────────
 * Atlas has no image-generation model and downloads none. A model that is already connected is asked to
 * write a small SVG; Atlas checks it, rebuilds it from an allowlist and shows it. It is always shown with
 * a note that the model drew it as code, because how good it looks depends entirely on that model. No
 * photo-style images, no editing of images, no extra network traffic beyond the model's normal request.
 *
 * ── Why the SVG is rebuilt instead of cleaned ─────────────────────────────────────────────────────────
 * The SVG is untrusted output of a model that may itself have read untrusted text. Removing "bad" parts
 * with patterns always loses to the next trick (an event handler spelled oddly, a nested reference, an
 * entity). So nothing is removed: the text is PARSED, every element and attribute is checked against a
 * short list of what a drawing needs, and the result is WRITTEN from what passed. Anything that does not
 * parse, uses an element or attribute outside the list, or points anywhere outside the drawing makes the
 * whole thing invalid (the model is told why and asked once more). The output is displayed only as an
 * image (`<img>` of a data URL), never inserted into the page, so even a mistake here cannot run code.
 */

export interface SketchRequest {
  /** What to draw, as the person said it ("a house", "a flowchart for logging in"). */
  subject: string;
  /** The ask is for a photo-style image, which Atlas cannot make. */
  photo: boolean;
}

const PICTURE_NOUN = String.raw`(?:picture|drawing|image|illustration|sketch|diagram|flow\s?chart|logo|icon|doodle|chart|graphic|poster|mock-?up|svg|cartoon)`;

/** "draw me a house", "sketch a logo for my bakery", "make me a diagram of how login works". Null for anything else. */
export function readSketchRequest(raw: string): SketchRequest | null {
  const text = raw.trim().replace(/[.!?]+$/, '');
  if (text.length < 6 || text.length > 300) return null;
  const lead = String.raw`^\s*(?:(?:hey|ok(?:ay)?|please|atlas)[\s,]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
  // draw / sketch / doodle / illustrate are always about a picture, except the figures of speech.
  const always = new RegExp(
    `${lead}(?:draw|sketch|doodle|illustrate)\\s+(?:me\\s+|us\\s+)?(.+)$`,
    'i',
  ).exec(text);
  if (always) {
    const subject = always[1]!.trim();
    if (
      /^(?:a\s+)?(?:card|cards|lots|straws|conclusions?|attention|a blank|the (?:curtains?|blinds?|line)|water|blood|breath|a breath)\b/i.test(
        subject,
      )
    )
      return null;
    if (/^(?:a\s+)?(?:file|folder|path|directory)\b/i.test(subject)) return null;
    return { subject: tidySubject(subject), photo: wantsPhoto(text) };
  }
  // make / create / generate / design need a picture noun, or they are a build or a plain request.
  const made = new RegExp(
    `${lead}(?:make|create|generate|design|produce)\\s+(?:me\\s+|us\\s+)?(?:an?\\s+|the\\s+|some\\s+)?(?:(?:simple|small|quick|basic|cute|little|svg)\\s+)*${PICTURE_NOUN}\\s*(?:of|for|showing|about|with)?\\s*(.*)$`,
    'i',
  ).exec(text);
  if (made) {
    const subject =
      tidySubject(made[1] ?? '') ||
      tidySubject(text.replace(new RegExp(`^.*?${PICTURE_NOUN}`, 'i'), ''));
    if (!subject) return null;
    // "create a logo for my game folder" is still a picture; "create an image file in D:\\x" is not.
    if (/[a-z]:[\\/]/i.test(text)) return null;
    return { subject, photo: wantsPhoto(text) };
  }
  return null;
}

function tidySubject(s: string): string {
  return s
    .replace(/^(?:of|for|me|us)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wantsPhoto(text: string): boolean {
  return /\b(?:photo|photograph|photo-?realistic|realistic|lifelike|4k|8k|hd|hyper-?real\w*|dslr|portrait of a real)\b/i.test(
    text,
  );
}

/** The prompt that asks a model for the drawing. */
export function sketchPrompt(subject: string): string {
  return [
    `Draw this as one SVG image: ${subject}`,
    '',
    'Rules for the SVG:',
    '- Reply with ONLY the <svg> element, nothing before or after it, no explanation.',
    '- Use viewBox="0 0 400 400". Keep it simple and clear: shapes and paths, flat colours, a light background rectangle.',
    '- Only these elements: svg, g, defs, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, linearGradient, radialGradient, stop, clipPath, title, desc.',
    '- No scripts, no images, no links, no external references, no CSS style blocks, no animation.',
    '- Any words in the drawing must be short and drawn with <text>.',
    '- At most about 80 elements.',
  ].join('\n');
}

/** The follow-up when the first answer was not a valid drawing. */
export function sketchRetryPrompt(subject: string, why: string): string {
  return `${sketchPrompt(subject)}\n\nYour previous answer could not be used: ${why}\nReply again with ONLY a valid, simple <svg> element.`;
}

// ---- the allowlist ------------------------------------------------------------------------------------

const ELEMENTS: Record<string, string> = Object.fromEntries(
  [
    'svg',
    'g',
    'defs',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'title',
    'desc',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
  ].map((n) => [n.toLowerCase(), n]),
);

const ATTRIBUTES: Record<string, string> = Object.fromEntries(
  [
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'fx',
    'fy',
    'width',
    'height',
    'd',
    'points',
    'transform',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-miterlimit',
    'stroke-opacity',
    'fill-opacity',
    'opacity',
    'fill-rule',
    'clip-rule',
    'clip-path',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'letter-spacing',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'clipPathUnits',
    'id',
    'viewBox',
    'preserveAspectRatio',
    'xmlns',
    'version',
    'dx',
    'dy',
  ].map((n) => [n.toLowerCase(), n]),
);

const TEXT_PARENTS = new Set(['text', 'tspan', 'title', 'desc']);
const MAX_INPUT = 200_000;
const MAX_OUTPUT = 64_000;
const MAX_ELEMENTS = 800;
const MAX_DEPTH = 12;
const MAX_ATTR = 6000;

interface Node {
  name: string;
  attrs: Array<[string, string]>;
  children: Array<Node | string>;
}

export type SvgResult = { ok: true; svg: string; elements: number } | { ok: false; reason: string };

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** The few entities a drawing can need. Anything else is refused rather than guessed at. */
function decodeSafe(value: string): string | null {
  let bad = false;
  const out = value.replace(
    /&(amp|lt|gt|quot|apos);|&#(?:\d+|x[0-9a-f]+);|&[a-z0-9]+;/gi,
    (_m, name: string | undefined) => {
      if (!name) {
        bad = true;
        return '';
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()]!;
    },
  );
  return bad ? null : out;
}

/** The pieces of an attribute value that could reach outside the drawing or run something. */
function valueIsSafe(value: string): boolean {
  // Control characters are removed on purpose: "java\nscript:" must be read as "javascript:".
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase();
  if (/(?:javascript|vbscript|data|file|http|https|ftp|blob):/.test(v)) return false;
  if (/expression\(|@import|<|>/.test(v)) return false;
  // url(...) may only point at something inside the drawing: url(#id).
  for (const m of v.matchAll(/url\(([^)]*)\)/g)) {
    if (!/^['"]?#[a-z0-9_-]+['"]?$/.test(m[1]!)) return false;
  }
  return true;
}

function parseAttributes(
  source: string,
): { ok: true; attrs: Array<[string, string]> } | { ok: false; reason: string } {
  const attrs: Array<[string, string]> = [];
  const re = /\s+([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/gy;
  let consumed = 0;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(source)) !== null) {
    consumed = re.lastIndex;
    const rawName = m[1]!;
    const lower = rawName.toLowerCase();
    if (/^on/.test(lower))
      return { ok: false, reason: `an event handler (${rawName}) is not allowed` };
    if (lower === 'style')
      return {
        ok: false,
        reason: 'style attributes are not allowed; use fill and stroke attributes',
      };
    if (/^xmlns:|^xlink:|href$/.test(lower))
      return {
        ok: false,
        reason: `${rawName} is not allowed (no links or references to outside the drawing)`,
      };
    const name = ATTRIBUTES[lower];
    if (!name) return { ok: false, reason: `the attribute "${rawName}" is not allowed` };
    if (seen.has(name)) return { ok: false, reason: `the attribute "${name}" is repeated` };
    seen.add(name);
    // The namespace and version are always rewritten by us, so whatever was written is simply dropped.
    if (name === 'xmlns' || name === 'version') continue;
    const decoded = decodeSafe(m[2] ?? m[3] ?? '');
    if (decoded === null)
      return { ok: false, reason: `an unsupported character reference in ${name}` };
    if (decoded.length > MAX_ATTR) return { ok: false, reason: `the value of ${name} is too long` };
    if (!valueIsSafe(decoded))
      return {
        ok: false,
        reason: `the value of ${name} points outside the drawing or is not plain`,
      };
    attrs.push([name, decoded]);
  }
  if (consumed !== source.length) return { ok: false, reason: 'an element could not be read' };
  return { ok: true, attrs };
}

/** Pull the <svg>…</svg> out of whatever the model wrote around it (a code fence, a sentence). */
export function extractSvg(reply: string): string | null {
  const start = reply.search(/<svg[\s>]/i);
  if (start < 0) return null;
  const end = reply.toLowerCase().lastIndexOf('</svg>');
  if (end < start) return null;
  return reply.slice(start, end + 6);
}

/**
 * Parse an SVG and write it back from the allowlist, or say why it cannot be used.
 */
export function sanitizeSvg(input: string): SvgResult {
  if (input.length > MAX_INPUT) return { ok: false, reason: 'the drawing is far too large' };
  let source = input.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!doctype|<!entity|<!\[cdata\[|<\?/i.test(source))
    return { ok: false, reason: 'it contains a DOCTYPE, entity, CDATA or processing instruction' };
  source = source.trim();

  const root: Node = { name: '#root', attrs: [], children: [] };
  const stack: Node[] = [root];
  let elements = 0;
  const tag =
    /<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s=/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '<') {
      const next = source.indexOf('<', i);
      const raw = source.slice(i, next < 0 ? source.length : next);
      i = next < 0 ? source.length : next;
      if (!raw.trim()) continue;
      const top = stack[stack.length - 1]!;
      if (!TEXT_PARENTS.has(top.name))
        return { ok: false, reason: 'text appears outside a <text> element' };
      const decoded = decodeSafe(raw);
      if (decoded === null)
        return { ok: false, reason: 'an unsupported character reference in text' };
      top.children.push(decoded);
      continue;
    }
    tag.lastIndex = i;
    const m = tag.exec(source);
    if (!m)
      return { ok: false, reason: 'something between < and > could not be read as an element' };
    i = tag.lastIndex;
    const closing = m[1] === '/';
    const lower = m[2]!.toLowerCase();
    const name = ELEMENTS[lower];
    if (!name) return { ok: false, reason: `the element <${m[2]}> is not allowed` };
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name || stack.length === 0)
        return { ok: false, reason: `</${name}> does not match` };
      continue;
    }
    elements += 1;
    if (elements > MAX_ELEMENTS) return { ok: false, reason: 'too many elements' };
    const parsed = parseAttributes(m[3] ?? '');
    if (!parsed.ok) return parsed;
    const node: Node = { name, attrs: parsed.attrs, children: [] };
    const parent = stack[stack.length - 1]!;
    if (parent === root && (name !== 'svg' || root.children.length > 0))
      return { ok: false, reason: 'the drawing must be one <svg> element' };
    if (TEXT_PARENTS.has(parent.name) && !['tspan'].includes(name))
      return { ok: false, reason: `<${name}> cannot go inside <${parent.name}>` };
    parent.children.push(node);
    if (m[4] !== '/') {
      stack.push(node);
      if (stack.length > MAX_DEPTH) return { ok: false, reason: 'elements are nested too deeply' };
    }
  }
  if (stack.length !== 1) return { ok: false, reason: 'an element is never closed' };
  const svg = root.children[0];
  if (!svg || typeof svg === 'string') return { ok: false, reason: 'no <svg> element found' };

  // The root: always the standard namespace, always a viewBox, never a fixed pixel size.
  const rootAttrs = new Map(svg.attrs);
  rootAttrs.delete('width');
  rootAttrs.delete('height');
  rootAttrs.delete('xmlns');
  rootAttrs.delete('version');
  let viewBox = rootAttrs.get('viewBox');
  if (!viewBox || !/^\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+\s*$/.test(viewBox))
    viewBox = '0 0 400 400';
  rootAttrs.set('viewBox', viewBox.trim());
  svg.attrs = [['xmlns', 'http://www.w3.org/2000/svg'], ...rootAttrs.entries()];

  const write = (n: Node): string => {
    const attrs = n.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    if (!n.children.length) return `<${n.name}${attrs}/>`;
    return `<${n.name}${attrs}>${n.children.map((c) => (typeof c === 'string' ? escapeText(c) : write(c))).join('')}</${n.name}>`;
  };
  const out = write(svg);
  if (out.length > MAX_OUTPUT) return { ok: false, reason: 'the drawing is too large' };
  return { ok: true, svg: out, elements };
}

/** The data URL a sanitised drawing is shown as. Only ever used as an image source. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const SKETCH_NOTE =
  'Drawn by your connected model as code. How good it looks depends on the model.';
export const SKETCH_NO_MODEL =
  'I can draw simple pictures as code (SVG), but that needs a language model, and none is connected. Start one in Settings → Intelligence and ask again.';
export const SKETCH_NO_PHOTOS =
  "I can't make photo-style images. I can draw a simple picture as code (SVG) with your connected model, though: say “draw me …” without asking for a photo.";
