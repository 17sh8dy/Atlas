import type { KnowledgeChunk, KnowledgePack, KnowledgeStatus } from './types';

const STATUSES: KnowledgeStatus[] = ['Released', 'Planned', 'Unknown'];
/** Generous, but bounded: a pack that claims more than this is not one Atlas built. */
const MAX_CHUNKS = 5_000;
const MAX_TEXT = 4_000;

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length <= max ? v : null);

function parseChunk(v: unknown): KnowledgeChunk | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const id = str(c.id, 300);
  const product = str(c.product, 60);
  const title = str(c.title, 300);
  const text = str(c.text, MAX_TEXT);
  const sourceUrl = str(c.sourceUrl, 600);
  const sourcePath = str(c.sourcePath, 400);
  const updated = str(c.updated, 10);
  const anchor = str(c.anchor, 300) ?? '';
  const status = typeof c.status === 'string' && (STATUSES as string[]).includes(c.status) ? (c.status as KnowledgeStatus) : null;
  const origin = c.origin === 'nova-knowledge' || c.origin === 'repo-docs' ? c.origin : null;
  const path = Array.isArray(c.headingPath) && c.headingPath.every((h) => typeof h === 'string' && h.length <= 300) ? (c.headingPath as string[]) : null;
  if (!id || !product || !title || !text || !sourceUrl || !sourcePath || !updated || !status || !origin || !path) return null;
  // A source address that is not https is not something Atlas will cite as a link.
  if (!/^https:\/\//.test(sourceUrl)) return null;
  const availableIn = str(c.availableIn, 20) ?? undefined;
  return { id, product, title, headingPath: path, text, sourceUrl, sourcePath, updated, status, ...(availableIn ? { availableIn } : {}), origin, anchor };
}

/**
 * Reads the pack text the native side hands over. Anything that does not have the expected shape is
 * dropped chunk by chunk; a pack with the wrong schema is refused whole. Returns null if nothing usable.
 */
export function parsePack(text: string): KnowledgePack | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1 || typeof o.seq !== 'number' || typeof o.builtAt !== 'string' || !Array.isArray(o.chunks)) return null;
  const chunks: KnowledgeChunk[] = [];
  for (const c of o.chunks.slice(0, MAX_CHUNKS)) {
    const parsed = parseChunk(c);
    if (parsed) chunks.push(parsed);
  }
  if (chunks.length === 0) return null;
  return { schema: 1, seq: o.seq, builtAt: o.builtAt, chunks };
}
