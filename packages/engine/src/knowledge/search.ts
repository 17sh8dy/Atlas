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

/**
 * A deliberately crude stem, applied the same way to questions and to pack text: "count", "counts", "counted"
 * and "counting" meet; so do "update", "updated" and "updating". It only has to be consistent.
 */
function fold(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
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

/** The folded tokens that merely name a product; they say which product, not what is being asked. */
const PRODUCT_TOKENS = new Set(Object.values(PRODUCT_WORDS).flat().flatMap((w) => tokenize(w)));
/** A question about how Atlas is built, which is allowed to land in the developer documentation. */
const DEVELOPER_QUESTION = /(?:architecture|source code|code|api|rust|typescript|tauri|implement(?:ed|ation)?|internals?|modules?|functions?|repo(?:sitory)?|developers?|contribut\w*|build it)/i;
/** Developer documentation answers a person's question less directly, so it ranks below user documentation. */
const DEVELOPER_WEIGHT = 0.7;

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
    // What is being asked, apart from which product it is about.
    const content = unique.filter((t) => !PRODUCT_TOKENS.has(t));
    const developer = DEVELOPER_QUESTION.test(question);
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
      if (d.chunk.audience === 'developer' && !developer) score *= DEVELOPER_WEIGHT;
      // Coverage is judged on what was asked, not on the product's name (which appears everywhere). A question
      // that only names a product is covered by a chunk about that product.
      const coverage = content.length > 0 ? content.filter((t) => d.tf.has(t)).length / content.length : named.has(d.chunk.product) ? 1 : 0;
      hits.push({ chunk: d.chunk, score, coverage });
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
