# Atlas

Premium desktop + web (+ future mobile) wallpaper & personalization platform.

> See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full design.

## Monorepo layout

```
apps/
  web/          The canonical UI (Vite + React). Desktop/mobile wrap this.
  desktop/      (Phase 5) Tauri shell + native platform impl.
packages/
  core/         Pure-TS domain (models, use-cases). Depends on nothing.
  tokens/       Design tokens → CSS variables (dark-first) + Tailwind mapping.
  ui/           Design-system components built on tokens.
  config/       Shared tsconfig, eslint, prettier, tailwind preset.
```

## Getting started

```bash
pnpm install
pnpm dev        # runs apps/web on http://localhost:5173
pnpm typecheck  # type-check every package
pnpm lint       # eslint (+ core boundary enforcement)
pnpm build      # production build
```

## Conventions

- **TypeScript strict** everywhere; the domain (`core`) is framework-free.
- **Dark-mode-first**, token-driven design — components read CSS variables, never hardcoded colors.
- Every new capability enters through `core` (domain), a repository (`data`), or a
  platform impl — never as a special case in UI code.
