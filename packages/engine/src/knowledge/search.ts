/**
 * Local search over the knowledge pack: BM25 on a few thousand short chunks. No model, no network, no
 * stored index: it is built in memory from the verified pack when needed (a few milliseconds).
 *
 * Title and heading words count for more than body words, and a chunk about the product a question
 * names counts for more than one that merely mentions it. Everything is deterministic.
 */

import type { KnowledgeHit, KnowledgeChunk, KnowledgePack } from './types';

const STOP = new Set(
  ('a an and are as at be but by do does did for from has have how i if in into is it its me my of on or our so than that the their ' +
    'them then there these they this to us was we were what when where which who whom why will with would you your about can could ' +
    'should tell please').split(' '),
);

/** Lower-case word tokens, with a very light plural/suffix fold so "tokens" finds "token". */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(fold(raw));
  }
  return out;
}

function fold(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Words that name a product, so a question about "Replay.GG" prefers Replay.GG chunks. */
const PRODUCT_WORDS: Record<string, string[]> = {
  nova: ['nova'],
  atlas: ['atlas'],
  'replay-gg': ['replay', 'replaygg'],
  'nova-cut': ['cut', 'novacut'],
  novaos: ['novaos'],
  'nova-help': ['help', 'novahelp'],
  'nova-review': ['review', 'novareview'],
  'nova-legal': ['legal', 'novalegal'],
};

const K1 = 1.4;
const B = 0.75;
const TITLE_BOOST = 3;
const PRODUCT_BOOST = 1.6;

interface Doc {
  chunk: KnowledgeChunk;
  tf: Map<string, number>;
  len: number;
}

export class KnowledgeIndex {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 1;

  constructor(pack: KnowledgePack) {
    let total = 0;
    for (const chunk of pack.chunks) {
      const tf = new Map<string, number>();
      const add = (tokens: string[], weight: number) => {
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
      };
      add(tokenize(chunk.text), 1);
      add(tokenize(`${chunk.title} ${chunk.headingPath.join(' ')}`), TITLE_BOOST);
      let len = 0;
      for (const n of tf.values()) len += n;
      this.docs.push({ chunk, tf, len });
      total += len;
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.docs.length ? Math.max(1, total / this.docs.length) : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** The best chunks for a question, highest score first. Empty when nothing shares a meaningful word. */
  search(question: string, opts: { limit?: number; product?: string } = {}): KnowledgeHit[] {
    const q = tokenize(question);
    if (q.length === 0) return [];
    const unique = [...new Set(q)];
    const n = this.docs.length;
    const named = namedProducts(question);
    const hits: KnowledgeHit[] = [];
    for (const d of this.docs) {
      if (opts.product && d.chunk.product !== opts.product) continue;
      let score = 0;
      for (const t of unique) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.len) / this.avgLen));
      }
      if (score <= 0) continue;
      if (named.has(d.chunk.product)) score *= PRODUCT_BOOST;
      hits.push({ chunk: d.chunk, score });
    }
    hits.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    return hits.slice(0, opts.limit ?? 5);
  }
}

function namedProducts(question: string): Set<string> {
  const words = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const out = new Set<string>();
  for (const [product, names] of Object.entries(PRODUCT_WORDS)) {
    if (names.some((n) => words.has(n))) out.add(product);
  }
  return out;
}
