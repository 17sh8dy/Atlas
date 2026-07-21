# Atlas — Phased Roadmap

Build order is chosen so each phase ships something **usable and correct** before the next, and so the hardest architectural seams (content, platform, persistence) are proven early with cheap versions. No phase is "throwaway" — early impls sit behind the same interfaces the mature ones will.

Legend: 🎯 goal · ✅ done-when · ⚠️ risk proven this phase

---

## Phase 0 — Foundations
🎯 The skeleton everything hangs on.
- pnpm workspaces + Turborepo; shared `config` (tsconfig strict, eslint, prettier, tailwind preset).
- `packages/tokens` (dark-first CSS variables) + `packages/ui` seed (Button, Icon, Surface, Skeleton).
- `apps/web` boots with Vite + React + Tailwind + router + theme provider.
- CI: typecheck + lint + build, Turbo-cached.
- Lint boundaries enforcing the dependency rule.

✅ `pnpm dev` renders a themed empty shell; CI green.
⚠️ Proves the monorepo + token pipeline.

## Phase 1 — App shell & navigation (mocked data)
🎯 The product's *shape* and feel, on fake data.
- Layout: sidebar/topbar nav, page transitions (Framer Motion), command palette (⌘K) scaffold.
- Routes: Home, Search, Categories, Library, Settings, Wallpaper detail.
- `packages/core` domain models (`Wallpaper`, `Collection`, `Category`, filters) + in-memory fixtures.
- Virtualized wallpaper grid + responsive image component (blurhash placeholder).

✅ You can click through the whole app on mock data; it *feels* like Atlas.
⚠️ Proves the UI-once shell + performance grid early.

## Phase 2 — Content pipeline (real wallpapers)
🎯 Replace mocks with real, normalized content.
- `packages/content`: Unsplash/Pexels/Wallhaven adapters → canonical `Wallpaper`.
- Supabase schema (`supabase/migrations`): wallpapers, assets, categories, tags, collections.
- Edge function: scheduled sync → normalize → cache into Postgres + generate `wallpaper_assets` variants.
- `packages/data`: `WallpaperRepository` + TanStack Query hooks. Home sections (Featured/Trending/New/Staff Picks) + Categories now render real data.

✅ Home & Categories show real wallpapers served from *our* DB/CDN.
⚠️ Proves the content abstraction + bandwidth strategy (variants/CDN) — the biggest risk.

## Phase 3 — Wallpaper page & Search
🎯 Discovery depth.
- Detail page: large preview, screenshots/variants, resolution options, metadata, related wallpapers, share.
- Search: instant query, filters for tags, colors, resolution, orientation, device; Postgres FTS behind `SearchRepository`.

✅ Find any wallpaper by text/filters; open a rich detail page.

## Phase 4 — Library (local-first)
🎯 Personal organization, no account required yet.
- Favorites, download history, recently viewed, collections — stored locally (IndexedDB/SQLite) via `LibraryRepository`.
- Optimistic UI, offline-safe.

✅ Favorite, collect, and revisit wallpapers fully offline.
⚠️ Proves the persistence abstraction + local-first before cloud complexity.

## Phase 5 — Desktop native (Tauri)
🎯 The thing a web app can't do.
- `apps/desktop`: Tauri 2 shell wrapping the web build.
- `platform-tauri`: set-as-wallpaper (Rust), download-to-disk with resolution, system tray, autostart, "wallpaper of the day".
- Web keeps `platform-web` (download-only) — same UI.

✅ Set any wallpaper as your desktop background from Atlas; tray + downloads work.
⚠️ Proves the platform abstraction end-to-end.

## Phase 6 — Accounts & cloud sync
🎯 Continuity across devices.
- Supabase Auth; profiles; RLS on all user tables.
- `LibraryRepository` gains a synced backend; local mirror syncs on sign-in. Conflict-safe merge.
- Settings: Account, Privacy.

✅ Sign in on another device → favorites/collections follow you.

## Phase 7 — Settings, polish, a11y, performance
🎯 Ship-quality.
- Settings: Theme (dark/light/system), Appearance, Performance (motion/quality), Downloads (path/default res).
- Full reduced-motion, keyboard nav, focus states, screen-reader labels.
- Animation polish pass; image loading/perf audit; light theme completion.

✅ Meets the premium/accessible/fast bar across the board. **MVP complete.**

---

## Post-MVP tracks (architecture already supports these)

Each is a new source/module behind an existing seam — not a rewrite.

- **Creator platform**: `apps/admin` CMS + moderation; `source='creator'` uploads; creator profiles, follows.
- **AI generation**: edge function that writes generated `Wallpaper` rows (`is_ai`), gated by Atlas Pro.
- **Live / video wallpapers**: `LiveRenderer` in `platform-tauri`; `is_live` assets.
- **Social**: ratings, comments, wallpaper requests, community challenges (schema stubbed).
- **Mobile**: `apps/mobile` (Expo) reusing `core`/`data`/`tokens` + `platform-mobile`.
- **Theme marketplace / icon packs / widgets**: token-set + asset-pack products — the design system already reads from swappable token sets.
- **Atlas Pro**: `profiles.plan` gate on AI-gen, exclusive collections, higher-res, cloud storage.

---

## Working agreement
Per the brief: architecture first (this doc + ARCHITECTURE.md), then **implement each phase carefully and completely before moving on**. Every new capability enters through `core` (domain), a repository (data), or a platform impl — never as a special case in UI code.
