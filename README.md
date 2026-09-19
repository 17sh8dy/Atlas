# Atlas

A local-first desktop assistant. Ask plainly, and it happens.

> Powered by the Navigator Engine.

Atlas understands what you ask, drives your machine, and keeps everything on it.
It needs no account, no API key, and makes no network call to do its job.
Connecting an external model is optional and adds exactly one thing: open-ended
reasoning about the wider world.

A **Nova Account** is optional too, and unlocks nothing: every skill, your memory,
voice and the file index all run signed out, forever. Signing in makes Atlas the
same identity as the other Nova products, and nothing on this machine is uploaded
— see Settings → Account.

```
you    find my tax pdf
Atlas  📄 tax-2025.pdf   D:\Documents\tax-2025.pdf   [Open] [Show in folder]

you    open steam
Atlas  Open an app?  ·  steam            [Yes, do it] [Cancel]
       Opening Steam.

you    system status
Atlas  📊 CPU 12% · memory 8.4/32.0 GB · C: 402/1024 GB.
```

Press **Ctrl+Space** anywhere to summon it.

## Why it's built this way

Three claims, each of which shaped the architecture rather than decorating it:

**The engine is the product, not a model.** Commands are recognised by
deterministic rules first. An AI is the fallback for genuinely novel phrasing,
never the thing standing between you and your own computer. Turn every provider
off and Atlas still runs every action it has.

**Every capability is declared.** Skills are the only way anything happens, and
each one names its arguments, its risk, and the capabilities it requires. "What
can this program do to my machine?" is a question with a finite, enumerable
answer — see `packages/engine/src/skills/`.

**There is no `exec`.** The Rust side exposes narrow, validated operations —
open *this* path, launch *this* registered app — and deliberately no way to run
an arbitrary string. A capability that general is impossible to reason about and
would make every other guarantee decorative.

## Monorepo layout

```
apps/
  desktop/      Tauri 2 shell. Global shortcut, tray, and the Rust half of
                the Platform port. Thin by design.
  web/          The canonical UI. Runs inside Tauri and standalone.
packages/
  core/         Pure-TS domain: Skill, Plan, memory, and the two ports.
                Depends on nothing.
  engine/       The assistant runtime: bus, registry, grammar, planner,
                executor. Depends only on core.
  platform/     Concrete Platform impls — Tauri and browser.
  tokens/       Design tokens → CSS variables (dark-first).
  ui/           Design-system components built on tokens.
  config/       Shared tsconfig, eslint, prettier, tailwind preset.
```

The dependency rule points inward and is enforced by eslint: `core` imports
nothing, `engine` imports only `core`, UI may import anything. That is what lets
the same engine run in a window, a tab, and a test.

## Getting started

```bash
pnpm install

pnpm dev                            # the UI alone, in a browser, on :5173
pnpm --filter @atlas/desktop dev    # the real desktop app

pnpm typecheck                      # every package
pnpm test                           # engine test suite
pnpm build                          # production build
```

The desktop app additionally needs a Rust toolchain (`rustup`), and on Windows
the WebView2 runtime, which ships with Windows 11.

To regenerate the app icon after changing it:

```bash
pnpm --filter @atlas/desktop icons
```

The mark is drawn in code (`apps/desktop/scripts/generate-icons.mjs`) rather
than committed as opaque binaries, so it can be re-rendered at any size and
reviewed in a diff.

## Where things stand

**Version 0.5.0.** The engine kernel, the Tauri shell, memory, 137 skills
(including operating other windows, synthetic input, UI Automation and screen
capture — Phase 12), and voice (speaking and listening, both fully offline)
are all built and working. Do It mode now asks only about genuinely
consequential actions, never about the mechanism used to perform them — a
click, a keystroke and typed text run immediately; deleting, shutting down or
closing something still confirms. Ordinary conversation is deliberately stiff
until you turn on a local model (Settings → Intelligence; Qwen3-8B is the default) — see
[`docs/ROADMAP.md`](docs/ROADMAP.md) for exactly what's done, what's next
(Phase 11's remaining eight groups), and what's deliberately not built yet.
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains why any of it is
shaped the way it is.

> Atlas was previously a wallpaper and personalization platform. That work is
> preserved on the `archive/wallpaper-platform` branch.
