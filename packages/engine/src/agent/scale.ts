/**
 * How big a job a model is given.
 *
 * Atlas used to size every agent task for the smallest model it supports: 16,384 tokens of working memory, a history of about
 * 7,000 characters, twelve steps. That is right for a small local model and far too little for a big one — Qwen3.5 alone ships at
 * 0.8B to 122B parameters with a native 262,144-token context (Ollama's library page for `qwen3.5`; the Qwen3.5 model card:
 * "262,144 natively and extensible up to 1,010,000"). A bigger model on a bigger machine should be handed a longer job: more of
 * the project in view, more steps, more research kept at hand.
 *
 * `chooseWorkingMemory` picks how many tokens to ask for — never more than the model's own limit, and by default sized to the
 * model (a larger model implies a larger machine behind it; memory for the context is the cost, so it is not simply "the maximum").
 * `scaleFor` turns that into the loop's budgets. Both are pure and deterministic. A person can pin the working memory (the
 * `atlas.agent.context-tokens` setting) and it is still held to the model's limit.
 *
 * What this does NOT claim: that a bigger context makes a model better at long tasks. The Qwen3.5 card itself advises keeping at
 * least 128K of context when *thinking* is on, and warns that stretching past the native length (YaRN) can hurt short-text
 * quality. More room is an opportunity, not an improvement — measure before believing it.
 */

import type { ModelCapacity } from '@atlas/core';

/** What Atlas has always assumed when it does not know better. */
export const DEFAULT_TOKENS = 16_384;
export const MIN_TOKENS = 8_192;
/** Matches the native ceiling (`MAX_TASK_CTX` in intelligence.rs). */
export const MAX_TOKENS = 262_144;

export interface AgentScale {
  /** Working memory to ask the model for, in tokens. */
  contextTokens: number;
  /** How much of the prompt the running history may take, in characters. */
  historyChars: number;
  /** How many of the newest steps are shown whole. */
  keepFull: number;
  /** The task's step budget. */
  maxIterations: number;
  /** How much room the research notes get, in characters. */
  researchChars: number;
  /** One line saying why, for the log and the report. */
  basis: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Working memory to request, in tokens. */
export function chooseWorkingMemory(capacity: ModelCapacity | null | undefined, pinned?: number | null): number {
  const limit = capacity?.contextTokens ? clamp(capacity.contextTokens, MIN_TOKENS, MAX_TOKENS) : DEFAULT_TOKENS;
  if (pinned && Number.isFinite(pinned)) return clamp(pinned, MIN_TOKENS, limit);
  // Unknown model: stay at what has always worked. Known: size to the model.
  if (!capacity?.contextTokens) return DEFAULT_TOKENS;
  const b = capacity.billions;
  const target = b === undefined ? 32_768 : b < 5 ? 24_576 : b < 16 ? 32_768 : b < 40 ? 65_536 : b < 100 ? 131_072 : 262_144;
  return Math.min(target, limit);
}

export function scaleFor(capacity: ModelCapacity | null | undefined, pinned?: number | null): AgentScale {
  const tokens = chooseWorkingMemory(capacity, pinned);
  const chars = tokens * 3; // about three characters a token for code and logs
  const maxIterations = tokens <= 16_384 ? 12 : tokens < 40_000 ? 24 : tokens < 80_000 ? 36 : tokens < 160_000 ? 48 : 64;
  const keepFull = tokens <= 16_384 ? 3 : tokens < 40_000 ? 5 : tokens < 100_000 ? 7 : 10;
  const why = capacity?.contextTokens
    ? `${(capacity.billions ? `${capacity.billions}B-parameter ` : '')}model with a ${capacity.contextTokens.toLocaleString('en-US')}-token limit${pinned ? `, pinned to ${pinned.toLocaleString('en-US')}` : ''}`
    : 'model size unknown, so the standard size';
  return {
    contextTokens: tokens,
    historyChars: tokens <= 16_384 ? 7_000 : Math.floor(chars * 0.35),
    keepFull,
    maxIterations,
    researchChars: clamp(chars * 0.08, 3_500, 24_000),
    basis: `${tokens.toLocaleString('en-US')} tokens of working memory, ${maxIterations} steps (${why})`,
  };
}
