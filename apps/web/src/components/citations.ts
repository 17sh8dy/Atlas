/**
 * Turning an answer's `[1]` markers and its Sources footer into something a
 * person can click, and the live counter's text.
 *
 * ── Where the data comes from ───────────────────────────────────────────────
 * The engine appends a deterministic footer to every web-researched answer
 * (`formatEvidenceFooter`): a header line, one `[n] Title — url` line per
 * source, and `· note` lines. That footer is the guarantee that sources are
 * visible whatever a model wrote; this file reads it back so the same facts
 * can also sit *beside the words they support*, as small numbered links,
 * without the model or the engine having to emit anything new.
 *
 * Nothing here trusts the model's text for a link: a `[2]` becomes a link only
 * when the engine's own footer has a source 2, and the address comes from that
 * footer. A model that writes `[7]` with no source 7 gets a plain marker, and
 * one that invents a URL in its prose gets nothing clickable at all.
 */

export interface Source {
  n: number;
  title: string;
  url: string;
  host: string;
}

export interface ParsedAnswer {
  /** The answer as written, without the Sources footer. */
  body: string;
  /** The footer's header line, e.g. "Sources (2026-09-20, via Tavily) — 4 independent sites agree:" */
  heading: string;
  sources: Source[];
  /** The `· …` lines: what the source check found. */
  notes: string[];
}

const FOOTER_START = /\n{1,2}Sources \(/;
const SOURCE_LINE = /^\[(\d+)\]\s+(.*?)\s+—\s+(https?:\/\/\S+)\s*$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Splits an answer from its Sources footer. No footer means no sources and the text untouched. */
export function parseAnswer(text: string): ParsedAnswer {
  const at = text.search(FOOTER_START);
  if (at === -1) return { body: text, heading: '', sources: [], notes: [] };

  const lines = text
    .slice(at)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const heading = lines[0] ?? '';
  const sources: Source[] = [];
  const notes: string[] = [];
  for (const line of lines.slice(1)) {
    const m = SOURCE_LINE.exec(line);
    if (m) {
      const url = m[3]!;
      sources.push({ n: Number(m[1]), title: m[2]!, url, host: hostOf(url) });
    } else if (line.startsWith('·')) {
      notes.push(line.replace(/^·\s*/, ''));
    }
  }
  // A "Sources (" that is not the engine's footer (no source lines) is prose.
  if (!sources.length) return { body: text, heading: '', sources: [], notes: [] };
  return { body: text.slice(0, at).trimEnd(), heading, sources, notes };
}

export type Segment = { type: 'text'; text: string } | { type: 'cite'; n: number };

/** `... season 4 [1][3].` → text, cite 1, cite 3, text. */
export function segmentCitations(body: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ type: 'text', text: body.slice(last, index) });
    out.push({ type: 'cite', n: Number(m[1]) });
    last = index + m[0].length;
  }
  if (last < body.length) out.push({ type: 'text', text: body.slice(last) });
  return out;
}

/** True when this text has a Sources footer worth rendering as links. */
export function hasSources(text: string): boolean {
  return parseAnswer(text).sources.length > 0;
}

/**
 * The live counter: tenths of a second under ten seconds, whole seconds up to
 * a minute, then m:ss. Never negative, never NaN.
 */
export function formatLive(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const s = safe / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  return `${m}:${String(rest).padStart(2, '0')}`;
}
