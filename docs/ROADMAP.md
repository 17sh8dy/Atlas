# Atlas — Roadmap

Phases are completed one at a time, in full. A phase is done when it typechecks,
lints, has tests where the logic is non-trivial, and actually runs — not when
the code exists.

---

## Phase 0 — Foundations ✅

The engine, the seam, and a desktop app that launches.

- `@atlas/core` — `Skill`, `Plan`, memory models, and the `Platform` /
  `Intelligence` ports. Depends on nothing.
- `@atlas/engine` — bus, skill registry, grammar, triage, executor, kernel.
  Depends only on core. **26 tests** against a scripted platform.
- `@atlas/platform` — Tauri and browser implementations, `detectPlatform()`.
- `apps/desktop` — Tauri 2 shell: frameless window, tray, `Ctrl+Space` summon,
  hide-on-close, and the Rust half of the port (files, apps, system, processes).
- `apps/web` — conversation UI, inline confirmation cards, actionable result
  rows, Settings.
- Icons generated from code, not committed as opaque binaries.

**Verified:** `pnpm typecheck` (6 packages), `pnpm lint`, `pnpm test` (26/26),
`pnpm build` (67.7 kB gzipped), `cargo check`, and a real
`Atlas_0.1.0_x64-setup.exe` at 3.6 MB.

**Clicked through, 2026-08-09:** launched the release build directly. Window
renders with the custom title bar (theme toggle, settings, minimize, close);
the welcome screen shows five live suggested actions. Typed "system status"
into the conversation input and got real CPU/memory/disk numbers back through
`platform.rs` — the whole grammar → skill → Platform → machine path works.
Settings opens and matches the documented Intelligence Providers hierarchy
(Navigator Engine always-on, Local Models/Claude/Gemini all "Planned"). Closing
the window hides it rather than quitting — the process, tray icon, and global
hotkey window all stay registered. `Ctrl+Space` is a real OS-level global
hotkey (verified with a simulated hardware keypress, independent of focus) and
correctly re-summons the window with the conversation state still there.
Nothing broken found.

---

## Phase 1 — Settings, personalization, and the first capability batch ✅

The engine can act, but it can't be *configured*, doesn't know your name, and
its catalog was 9 skills deep. This phase doesn't wait for full memory (Phase
2) to give Atlas the smallest amount of "yours" — the storage it needs is
pulled forward from Phase 3, minimally, so this doesn't get blocked on that.

- **`Storage` port** — `packages/core/src/ports/storage.ts` (async
  get/set/remove), a Tauri implementation writing one JSON file to the app's
  data directory (`storage.rs`, no new plugin), and a `localStorage` one for
  the web build. Lives in a new `packages/data` package. (Theme persistence
  deliberately stays on its own `localStorage` key — routing it through an
  async port would flash the wrong theme on launch.)
- **Phrasing, centralized** — `packages/engine/src/phrasing.ts` closes the
  item this document used to list under the old Phase 1. Every "Opening
  Steam."-style message and the executor's own lines now come from one place,
  which is also what makes personalization possible.
- **Personalization** — what Atlas calls you, what it calls itself, a custom
  greeting. Backed by the existing `Fact` model through a small preferences
  module in `packages/data`, not a new memory store.
- **A real tabbed Settings page** — General (unchanged), Appearance (the
  theme system's "system" mode, previously unreachable, is now a control),
  Voice (an honest "coming soon," see Phase 8), Personalization, Startup
  (UI only — see Phase 10), Notifications (a real toggle, backed by a real
  `platform.notify`), Privacy (placeholder — see Phase 8's weather note),
  Default apps (placeholder), About.
- **A capability batch**, all following the existing narrow/validated Rust
  command pattern:
  - Pure logic, no native code: calculator, unit conversion, time/date.
  - File CRUD (create/rename/move/copy/delete/read a text file) — delete uses
    the OS recycle bin, never a permanent removal.
  - A small system-tool launcher (Task Manager, Device Manager, Windows
    Settings, Control Panel) — a fixed allow-list, not a general launcher.
  - Search the web / search YouTube — reuses the existing URL-opening skill.
  - Real OS notifications — this also fixes a pre-existing bug where
    `capabilities()` claimed `"notifications"` with no implementation behind
    it.
  - A colloquial-name alias table for `app.open` ("vscode" → Visual Studio
    Code) — Discord/VS Code/Steam/Fortnite/Epic Games already worked via the
    existing Start Menu scrape; this just covers how people actually type
    the names.

**Verified, 2026-08-09:** `pnpm typecheck` (9 packages), `pnpm lint`,
`pnpm test` (**48/48** — the original 26 plus 22 new), `pnpm build`
(85.2 kB gzipped main bundle), `cargo check`, a full `cargo build`, and a
real click-through against the built app: the catalog grew from 9 to
**22 actions**; Settings opens with all nine tabs; saving a name in
Personalization round-trips through the real `Storage` port (Rust JSON
file → `readVoiceProfile` → UI) and the conversation greeting picks it up
("Hey Brandon — I'm Atlas."); "what's 12 * 7", "convert 10 miles to km",
and "what time is it" all returned correct live answers; "open task
manager" showed the confirm card, and approving it launched the real
Windows Task Manager process. Nothing broken found.

## Phase 2 — Memory and vocabulary ✅

- **Memory** — a real `MemoryStore` (`packages/data`) replaces Phase 1's flat
  preferences blob: semantic facts queryable by kind/subject (`fact`,
  `preference`, `alias` share one store), and a capped (200, oldest dropped
  first), repeat-collapsing episodic timeline. A new `Memory` port in
  `@atlas/core` mirrors the `Platform`/`Storage` seam so `packages/engine`
  depends on the port, never the concrete store.
- **`engine.help`** — "what can you do?" now answers from `SkillRegistry`
  live (via a registry reference threaded into `createCoreSkills`), rendered
  as a result-row list, rather than a written list that could drift. Fixed
  a real dead end in the process: the offline reply already told users to
  say "what can you do?", but nothing had ever handled that phrase.
- **Aliases** — "remember my work folder is D:\Dev" (new `memory.remember`
  skill + grammar rule), then "open my work folder" (new `files.openAlias`
  skill + grammar rule). Mirrors `app.open`'s hardcoded alias table exactly,
  just user-defined.
- **Working memory + ordinals** — a new in-process (never persisted —
  deliberately outside Phase 3's cross-restart scope) `WorkingMemory` class
  tracks the last shown result list and current focus. Since it's pure
  in-memory state rather than storage-backed, a grammar rule can read it
  *synchronously* — resolving "open the second one," "the last one," and
  bare "it" against a result row's own `actions`, the same data a UI click
  on that row would use. Fixed a real latent bug found along the way:
  `appOpen`'s own referential guard checked the phrase *after* `clean()`
  stripped a leading "the," so "open the second one" (with nothing shown
  yet) was silently misread as an attempt to launch an app named "second
  one" instead of being declined.
- **Episodic recording** — a new `recordEpisodes(bus, memory, skills)`
  subscribes to the existing `engine:done` bus event and turns each
  successful step into an episode, keyed by skill id. Neither the engine
  nor any skill knows this exists — it only listens, per `Bus`'s own
  documented design intent for how memory should work.

**Verified, 2026-08-09:** `pnpm typecheck` (9 packages), `pnpm lint`,
`pnpm test` (**62/62** in `@atlas/engine` — the 48 from Phase 1 plus 14 new;
**9/9** in the new `@atlas/data` test suite covering `MemoryStore`'s
fact/episode logic directly), `pnpm build` (86.7 kB gzipped main bundle),
`cargo check` + full `cargo build`, and a real `Atlas_0.1.0_x64-setup.exe`.
Click-tested via a direct capture of the running window (`PrintWindow`,
independent of OS focus): the app launches showing **25 actions** (22 from
Phase 1 + `memory.remember`, `files.openAlias`, `engine.help`), and the
Settings/Personalization path from Phase 1 is untouched. The interactive
alias/ordinal/help scenarios are covered end-to-end by the engine test
suite; live OS-level keystroke automation wasn't completed this session
(the automation couldn't safely win window focus away from another
foreground app without risking stray input landing in the wrong window) —
worth a manual pass.

## Phase 3 — Persistence

- Conversation history across restarts, using the `Storage` port Phase 1
  already built.
- Command history — small, now that Storage exists.
- A real background file index, so `files.find` stops walking the disk per
  query. Names and paths only — the privacy line does not move.

## Phase 4 — Intelligence providers

- Local models first (Ollama), because the private option should be the easy
  one and the default recommendation.
- Then Claude via a user-hosted proxy; then a generic provider contract.
- The Settings screen already states the hierarchy; this phase makes the rows
  real rather than "Planned." Also what finally lets "answer normal
  questions" mean more than the offline fallback reply.

## Phase 5 — Routines

- "Save that as my morning routine", then "run my morning routine".
- Stores *validated steps*, never free text — so a routine can't become a way
  to smuggle an unvalidated instruction past the registry later.

## Phase 6 — Native OS controls

- Volume/mute, brightness, screenshots, media play/pause, lock the PC,
  restart/shut down with confirmation.
- None of this has a Tauri plugin or an existing crate behind it yet — it
  needs the `windows` crate (Core Audio APIs, WMI brightness methods, SMTC
  media control, `LockWorkStation`/`ExitWindowsEx`) or a screenshot crate.
  Bigger and more native than anything shipped so far; deliberately kept
  separate from the narrow-custom-command work in Phase 1.
- Everything destructive here (restart, shutdown, lock) is `risk: 'confirm'`,
  same safety model as file delete.

## Phase 7 — Reminders, to-dos, and notes

- Set reminders, create/read/complete to-do items, keep and read notes.
- Waits for real memory (Phase 2) rather than building its own storage
  schema on top of Phase 1's flat preferences module, which was never meant
  to grow into this.

## Phase 8 — Voice

- **Audio (TTS/STT)** — approach undecided, revisit here. The WebView can do
  offline text-to-speech using installed Windows voices today; speech
  recognition in a Chromium engine typically wants a network round-trip,
  which sits uneasily next to "works with nothing connected." Options: ship
  TTS now and best-effort networked STT as v1, or hold voice input entirely
  for a fully local STT engine. Settings → Voice already has its placeholder
  tab waiting.
- **Weather** — deferred, and the one item on the original list that
  conflicts with local-first-by-default. If it ships, it's opt-in with the
  user's own API key, disclosed in Settings → Privacy (the placeholder shell
  for this already exists from Phase 1) — never on by default.
- Multiple voice options, speed/volume, push-to-talk, interrupt-while-speaking
  all sit behind the TTS/STT decision above.

## Phase 9 — Awareness

- What's focused, what changed, what you've been doing.
- Proactive notices, sparingly: a build finished, a download completed. The bar
  is high — an assistant that interrupts is worse than one that waits.

## Phase 10 — Polish and ship

- Configurable summon shortcut (see the open question in ARCHITECTURE §8).
- Autostart (Settings → Startup already has its disabled placeholder from
  Phase 1), updater, code signing.
- First-run experience: the app should teach `Ctrl+Space` without a tour.

---

## Deliberately not doing

- **A general `exec`.** Discussed and rejected in ARCHITECTURE §6.1.
- **Cloud sync by default.** Local-first means the local case is the whole
  product, not the offline mode of a server product.
- **An agent that acts unprompted.** Atlas does what you ask. Proactivity in
  Phase 9 means *noticing*, not deciding.
- **Weather, by default.** See Phase 8 — the one exception to "no network
  calls," and only ever opt-in.
