/**
 * The knowledge pack as the engine sees it (docs/PLAN-2.0.3.md §B3). The pack arrives already
 * signature-checked by the native side (`knowledge.rs`), but its text is still DATA: nothing here
 * interprets it, and nothing in it can give Atlas an instruction.
 */

export type KnowledgeStatus = 'Released' | 'Planned' | 'Unknown';
export type KnowledgeOrigin = 'nova-knowledge' | 'repo-docs' | 'faq';
export type PackSource = 'bundled' | 'refreshed';

export interface KnowledgeChunk {
  id: string;
  product: string;
  title: string;
  headingPath: string[];
  text: string;
  /** Public address of the page the text came from. */
  sourceUrl: string;
  sourcePath: string;
  /** Last day the text was checked or changed (YYYY-MM-DD). */
  updated: string;
  status: KnowledgeStatus;
  availableIn?: string;
  origin: KnowledgeOrigin;
  anchor: string;
  /** Only `approved` text is ever used; a pack that carries anything else is not trusted for it. */
  review: 'approved';
  /** Who the text is written for: `user` answers a person's question; `developer` is internals, which rank lower. */
  audience: 'user' | 'developer';
  /** Only on `origin: 'faq'`: what the verified answer matches and since when it is true. */
  faq?: { topic: string; aspects: string[]; match: string[]; since: string };
}

export interface KnowledgePack {
  schema: 1;
  seq: number;
  builtAt: string;
  chunks: KnowledgeChunk[];
}

/** Where the pack in use came from, as `knowledge_pack` reports it. */
export interface PackInfo {
  source: PackSource;
  seq: number;
  builtAt: string;
}

export interface KnowledgeHit {
  chunk: KnowledgeChunk;
  score: number;
  /** Share of the question's meaningful words that appear in the chunk (0..1). */
  coverage?: number;
}
