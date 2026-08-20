/**
 * @atlas/core — the pure-TypeScript domain layer.
 *
 * The vocabulary Atlas is built from: what a skill is, what a plan is, what it
 * remembers, and the two ports through which it reaches anything outside
 * itself — the machine (`Platform`) and optional external reasoning
 * (`IntelligenceProvider`).
 *
 * It imports NO framework or infrastructure (no React, Tauri, HTTP). Everything
 * else in the monorepo may depend on core; core depends on nothing. This
 * inward-pointing dependency rule is enforced by eslint (see eslint.config.mjs),
 * and it is what lets the same engine run in a desktop window, a browser tab,
 * and a test.
 */

export * from './models/skill';
export * from './models/plan';
export * from './models/memory';
export * from './models/voice';
export * from './ports/platform';
export * from './ports/intelligence';
export * from './ports/storage';
export * from './ports/memory';
