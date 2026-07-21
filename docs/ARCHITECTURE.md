# Atlas — Architecture

> Premium desktop + web (+ future mobile) personalization platform.
> Today: wallpaper discovery, organization, creation. Tomorrow: themes, icons, widgets, AI generation, creator communities, full device personalization.

This document is the source of truth for **how Atlas is built and why**. Read it before making any structural decision. It is written to survive years of feature growth.

---

## 1. Core principles

These are the constraints every decision is measured against.

1. **Write the UI once.** The interface is a single React codebase. Desktop (Tauri), web, and later mobile all render the same components. Platform differences are pushed behind interfaces, never sprinkled through UI code.
2. **The domain doesn't know about the framework.** Wallpapers, collections, users, and the rules that govern them live in a pure-TypeScript core with zero React/Tauri/Supabase imports. UI and infrastructure are replaceable; the domain is not.
3. **Content source is an implementation detail.** The app never talks to Unsplash/Pexels directly. It talks to a normalized `Wallpaper` model. Swapping API → owned CMS → creator uploads is a backend change, not an app rewrite. (This is why the "hybrid" choice is safe.)
4. **Native capability is abstracted.** "Set as wallpaper", "download to disk", "system tray", "live wallpaper renderer" are all defined as interfaces. Web gets a limited impl, Tauri gets the full native impl, mobile gets its own — the UI just calls `platform.setWallpaper(...)`.
5. **Dark-mode-first, token-driven design.** All color/spacing/motion flows from design tokens (CSS variables). Theming, light mode, and future "theme marketplace" skins are just token sets.
6. **No premature backend.** MVP ships fast on Supabase (managed Postgres + Auth + Storage). We stay on **standard Postgres** with a repository layer so we're never locked in.
7. **Performance is a feature, not a phase.** Virtualized grids, responsive image variants, progressive loading, and Turborepo-cached builds are baked in from Phase 0.

---

## 2. Technology decisions (and why)

| Layer | Choice | Why | Rejected alternative |
|---|---|---|---|
| **Monorepo** | pnpm workspaces + **Turborepo** | Share `core`/`ui`/`data` across desktop/web/mobile with one dependency graph; Turbo caches builds so CI/local stays fast as it grows | Nx (heavier), multi-repo (sync hell) |
| **Language** | **TypeScript** everywhere, `strict` | One language across UI, domain, edge functions; strong typing is an explicit requirement | — |
| **Build/dev** | **Vite** | Fastest HMR, first-class Tauri + React support | Webpack/CRA (slow, dead) |
| **UI framework** | **React 18** | Ecosystem, your team already knows it, works in Tauri + web + RN | Svelte/Solid (smaller ecosystem for a multi-year platform) |
| **Styling** | **Tailwind CSS** + CSS-variable token layer | Fast, consistent, themeable; tokens enable dark-first + theme marketplace | CSS-in-JS (runtime cost) |
| **Primitives** | **Radix UI** | Accessible, unstyled headless components — a11y is a requirement | Building modals/menus by hand |
| **Animation** | **Framer Motion** | The "beautiful animations / Linear-Arc feel" bar; declarative, GPU-friendly | Hand-rolled CSS for complex sequences |
| **Server state** | **TanStack Query** | Caching, background refetch, infinite scroll for wallpaper feeds | Redux for server data (boilerplate) |
| **Client state** | **Zustand** | Tiny, unopinionated UI/session state (filters, theme, panels) | Redux (overkill) |
| **Desktop shell** | **Tauri 2 (Rust core)** | ~10MB bundle, low RAM, native wallpaper-setting, tray, autostart — matches "extremely fast / premium" | Electron (~150MB, heavy — cuts against the goal) |
| **Web build** | Same React app → static SPA | Chosen "Tauri + shared web build": UI is web-native, desktop wraps it | Separate web rewrite |
| **Mobile (future)** | **Expo / React Native** | Reuses `core`/`data`/design tokens; own `platform` impl | Flutter (Dart = second language, no code reuse) |
| **Backend** | **Supabase** (Postgres, Auth, Storage, Edge Functions, RLS) | Real accounts, cloud sync, storage, and SQL ownership on day one; scales far; self-hostable later | Firebase (NoSQL, lock-in), custom Node (slow to first value) |
| **Search** | Postgres FTS (MVP) → **Meilisearch/Typesense** (scale) | Start free with `tsvector`; graduate to instant search engine behind the same `SearchRepository` interface | Elasticsearch (ops-heavy) |
| **Media/CDN** | Supabase Storage + image transforms → **Cloudflare Images/R2** at scale | Wallpapers are huge (4K/8K); need thumbnails + responsive variants + CDN | Serving originals directly (bandwidth death) |

---

## 3. Monorepo structure

```
D:\Dev\Atlas\
├─ apps/
│  ├─ web/            # THE UI. Vite + React SPA. The canonical interface.
│  ├─ desktop/        # Tauri shell. Loads the web UI, adds native impls.
│  ├─ mobile/         # (future) Expo app. Reuses core/data/ui-tokens.
│  └─ admin/          # (future) CMS for owned content + moderation.
│
├─ packages/
│  ├─ core/           # Pure TS domain. Types + use-cases. NO framework deps.
│  │                  #   models: Wallpaper, Collection, Category, User, Tag...
│  │                  #   use-cases: favorite(), buildFeed(), filterSearch()...
│  ├─ platform/       # Interfaces for native capability + impls:
│  │                  #   setWallpaper, downloadFile, fs, tray, notifications
│  │                  #   platform-web | platform-tauri | platform-mobile
│  ├─ data/           # Supabase client + repositories + TanStack Query hooks.
│  │                  #   WallpaperRepository, LibraryRepository, SearchRepo...
│  ├─ content/        # Provider adapters (Unsplash/Pexels/Wallhaven) →
│  │                  #   normalize to core Wallpaper. Runs in edge functions.
│  ├─ ui/             # Design system: components built on Radix + tokens.
│  ├─ tokens/         # Design tokens (color/space/type/motion) → CSS vars.
│  ├─ icons/          # Icon set.
│  └─ config/         # Shared tsconfig, eslint, tailwind preset, prettier.
│
├─ supabase/
│  ├─ migrations/     # Versioned SQL schema.
│  └─ functions/      # Edge functions (content sync, image variants, AI-gen).
│
└─ docs/              # This file, ROADMAP.md, decisions.
```

**The load-bearing idea:** `apps/web` is the entire interface. `apps/desktop` is a *thin Tauri wrapper* that serves that same build and injects `platform-tauri`. Mobile later injects `platform-mobile`. You never fork the UI.

### Dependency rule (enforced by lint boundaries)

```
apps/*  ──►  packages/ui, packages/data, packages/platform
packages/ui   ──►  packages/tokens, packages/icons, packages/core (types only)
packages/data ──►  packages/core, packages/content
packages/core ──►  (nothing — pure domain)
```

`core` depends on nothing. Everything can depend on `core`. Dependencies point inward. This is what keeps Atlas rewritable in pieces for years.

---

## 4. The three abstraction layers that make Atlas future-proof

Everything the future features list needs (AI gen, creators, live wallpapers, mobile, marketplace) survives because of these three seams:

### 4.1 Content abstraction (`packages/content` + `WallpaperRepository`)
The app requests wallpapers by intent ("trending", "category: space", "search: neon city"). A repository resolves that against whatever source is configured:
- **Now:** provider adapters normalize Unsplash/Pexels/Wallhaven responses into the canonical `Wallpaper` model; results are cached into Postgres so the app reads from *our* DB, not their API (rate-limit + offline safety).
- **Later:** owned CMS rows and creator uploads land in the *same* `wallpapers` table with `source = 'atlas' | 'creator'`. Zero UI change.
- **AI gen:** just another source that writes a `Wallpaper` row.

### 4.2 Platform abstraction (`packages/platform`)
```ts
interface Platform {
  setWallpaper(path: string, opts): Promise<void>   // native only
  downloadWallpaper(w: Wallpaper, res): Promise<Path>
  fs: FileStore                                       // local library cache
  tray?: TrayController
  liveWallpaper?: LiveRenderer                        // video/live, native
}
```
Web ships a limited impl (download via browser, no set-wallpaper). Tauri ships the full Rust-backed impl. Mobile ships its own. **UI code is identical across all three.**

### 4.3 Persistence abstraction (repository layer in `packages/data`)
UI/domain never import the Supabase SDK. They call repositories. This means: Supabase today, self-hosted Postgres or a custom API later, and a **local-first** library (favorites/history/collections cached in SQLite/IndexedDB, synced when signed in) — all behind the same interfaces.

---

## 5. Data model (Postgres / Supabase)

Core tables (MVP), designed so future features slot in without migrations that break things:

```
wallpapers        id, title, source, source_id, source_url, author,
                  license, attribution, width, height, dominant_color,
                  blurhash, colors[], orientation, is_ai, is_live,
                  created_at, popularity_score
wallpaper_assets  wallpaper_id, kind(thumb|preview|full|4k|video),
                  url, width, height, bytes
categories        id, slug, name, icon, sort
wallpaper_tags    wallpaper_id, tag_id            tags: id, slug, name
collections       id, owner_id?, title, is_staff_pick, is_featured, cover
collection_items  collection_id, wallpaper_id, sort

-- user-scoped (RLS: owner-only), local-first mirror on device
users             (Supabase auth) + profiles(display_name, avatar, plan)
favorites         user_id, wallpaper_id, created_at
downloads         user_id, wallpaper_id, resolution, created_at
recently_viewed   user_id, wallpaper_id, viewed_at

-- future, schema stubbed now
creators          user_id, handle, bio, verified
ratings           user_id, wallpaper_id, stars
comments          user_id, wallpaper_id, body, created_at
follows           follower_id, creator_id
```

**Why these choices:** `source`/`source_id`/`license`/`attribution` from day one makes the API→owned→creator migration a data operation. `wallpaper_assets` as a separate table is what lets us serve thumbnails/responsive variants/video from a CDN instead of the original (the #1 bandwidth trap). `blurhash`/`dominant_color` power instant progressive loading and color-filter search. Row-Level Security scopes all user tables to their owner automatically.

---

## 6. Scaling risks identified up front (and the mitigation already in the design)

| Risk | Why it bites | Mitigation baked in |
|---|---|---|
| **Content licensing / API rate limits** | Third-party APIs throttle & can revoke; attribution rules | Content abstraction + cache-to-Postgres; owned CMS path; `license`/`attribution` columns |
| **Bandwidth (4K/8K images are massive)** | Serving originals bankrupts you and feels slow | `wallpaper_assets` variants + CDN + thumbnails + progressive `blurhash` loading |
| **Set-wallpaper is inherently native** | Can't be done from a web sandbox | Platform abstraction; Tauri Rust impl; web degrades to download |
| **Search at scale** | `LIKE %...%` dies past ~100k rows | Postgres FTS now → Meilisearch/Typesense behind `SearchRepository` |
| **Offline / local library** | Users expect favorites without a round-trip | Local-first repositories, sync on auth |
| **Live/video wallpapers** | GPU-heavy, OS-specific | Isolated `LiveRenderer` in platform layer; opt-in phase |
| **Creator uploads** | Storage cost, moderation, abuse | Separate storage bucket + moderation queue in `admin`; stubbed schema now |
| **Vendor lock-in (Supabase)** | Managed BaaS risk | Standard Postgres + repository layer; self-hostable |
| **Monorepo build times** | Grows with packages | Turborepo remote+local cache from Phase 0 |
| **Cross-platform UI drift** | Desktop/web/mobile diverge | Single UI codebase; only `platform` impls differ |

---

## 7. Theming & design system

- `packages/tokens` emits CSS variables for **color, space, radius, typography, shadow, motion**. Dark theme is the default token set; light + future marketplace themes are alternate sets swapped at the `:root` level.
- `packages/ui` components read tokens only — never hardcoded hex. This is what makes the "theme marketplace" future feature a data feature, not a rewrite.
- Motion tokens (durations, easings) centralize the Linear/Arc feel so animations are consistent, not per-component guesses.
- Accessibility: Radix primitives + focus management + reduced-motion token respected globally.

See `ROADMAP.md` for the phased build order.
