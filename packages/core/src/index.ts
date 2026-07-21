/**
 * @atlas/core — the pure-TypeScript domain layer.
 *
 * Contains the canonical models and rules Atlas is built on. It imports NO
 * framework or infrastructure (no React, Supabase, Tauri). Everything else in
 * the monorepo may depend on core; core depends on nothing. This inward-pointing
 * dependency rule is enforced by eslint (see eslint.config.mjs).
 */

export * from './models/wallpaper';
export * from './models/taxonomy';
export * from './models/collection';
export * from './models/search';
export * from './ports/catalog-repository';
