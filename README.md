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

you    clean up my downloads, put installers in Software
Atlas  Tidy up Downloads?  47 files into 5 folders — the list, then
       Nothing is deleted or overwritten.       [Yes, do it] [Cancel]
       Moved 47 of 47 files. Say “undo that” to put it all back.

you    when this build finishes, run the tests, package it, and open the result
Atlas  Set up this watch?  When: the build finishes (cargo.exe exits)
       Then: 1. Run tests  2. Package  3. Open the result
       Approving now lets these run when it happens, even if you’re away.
       👁 Watching until the build finishes.

you    get my PC ready for recording
Atlas  Recording setup complete. OBS is running, Shure MV7+ is your
       microphone, 347 GB free on D:, and Discord is on the left.
```

Press **Ctrl+Space** anywhere to summon it. **F8** is the emergency stop.

## Install

Download `Atlas_<version>_x64-setup.exe` from the
[latest release](https://github.com/17sh8dy/Atlas/releases/latest) and run it —
Windows 10 or 11, 64-bit, no administrator rights needed. The first-run guide,
including the SmartScreen warning (builds are not code-signed yet) and the
optional local model, is [`docs/INSTALL.md`](docs/INSTALL.md).

Atlas **updates itself**: it checks the releases page shortly after launch and
every six hours, shows what changed, and installs on your say-so, rolling back
to the version that worked if the new one fails to start. That check is the one
network request Atlas makes on its own; turn it off in Settings → About.

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
  data/         Storage-backed preferences and settings.
  updater/      The in-app update service (pure TS, no UI, no platform).
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
pnpm lint                           # eslint, including the dependency rule
pnpm test                           # every package's test suite
pnpm build                          # production build
pnpm release --dry-run              # build the installer + update manifest, publish nothing
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

**Version 1.0.3**, the “doing, not answering” update. Built and working:

- **The engine and shell** — the kernel, the Tauri app, memory, and over 150
  skills, every one declared with its arguments, risk and required capabilities.
- **Operating your machine** — other windows, synthetic mouse and keyboard, UI
  Automation, screen capture, services, environment variables, networking,
  storage, and a developer agent (project scaffolding, builds, tests, git).
- **Bulk file changes you can see and undo** — "clean up my downloads" sorts a
  folder by type, shows the exact list first, asks once, never deletes or
  overwrites, and every move or rename is journaled so "undo that" works.
- **Atlas Watch** — “watch this download”, “let me know when OBS closes”, “when the
  build finishes, run the tests and open the result”. Atlas waits for the condition,
  then runs the follow-up steps you approved when you set it up — and only those.
  Watches survive a restart: nothing is repeated blind, anything uncertain stops and
  asks, and the emergency stop pauses them all. Settings → Watches shows every one.
- **Setups that check their work** — “get my PC ready for recording” opens and closes
  apps, puts windows where you want them, and checks your microphone, free space and
  internet, then reports what it *verified*, not what it tried. The first time, it asks
  what that setup should mean. Settings → Setups keeps them editable.
- **Voice, fully offline** — speaking (Piper and refined Kokoro voices) and
  listening (Whisper), both on this machine.
- **Safety you can rely on** — no `exec`; confirmation keyed to consequence
  rather than mechanism (Do It mode asks only about genuinely consequential
  actions); an emergency stop (F8) that halts everything at once.
- **Local models, optional** — Qwen3-8B by default, up to Qwen3.5-35B and
  GPT-OSS 20B, through [Ollama](https://ollama.com) (Settings → Intelligence).
  Ordinary conversation is deliberately stiff until you turn one on. Cloud
  providers are opt-in too.
- **Self-updating**, with rollback (see Install above).

**Being considered, not built:** optional subscriptions that add things (never fence
off what Atlas already does): memory that follows you across devices, and **Atlas
Mobile**, which talks to your PC's Atlas from your phone to check status, approve a
waiting step, or start a saved setup. See the ROADMAP's “Ideas for later”.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for exactly what's done, what's next,
and what's deliberately not built yet, and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for why any of it is shaped the
way it is.

> Atlas was previously a wallpaper and personalization platform. That work is
> preserved on the `archive/wallpaper-platform` branch.
