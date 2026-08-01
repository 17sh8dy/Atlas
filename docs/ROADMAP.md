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

**Not yet done:** nobody has clicked through the running app. The desktop binary
builds and launches; its behaviour beyond that is unverified.

---

## Phase 1 — Make it feel like an assistant

The engine can act. It can't yet *remember* or *explain itself*.

- **Memory** — episodic (what happened), semantic (facts, preferences, and the
  names you use for things), working (what "it" refers to). The models are
  already in `core`; this phase gives them a storage port and an implementation.
- **`engine.help`** — "what can you do?" answered from the live registry rather
  than a written list that drifts.
- **Aliases** — "remember my work folder is D:\Dev", then "open my work folder".
  The single feature that most makes an assistant feel like *yours*.
- **Voice** — one place that owns phrasing, so Atlas sounds like one thing.
  Present tense, naming the subject: "Opening Steam", never "Executing command".
- **Ordinals** — "open the second one" against the last result list.

## Phase 2 — Persistence

- A `Storage` port in core; a Tauri implementation writing to the app's own
  data directory, and a `localStorage` one for the web build.
- Conversation history across restarts.
- A real background file index, so `files.find` stops walking the disk per
  query. Names and paths only — the privacy line does not move.

## Phase 3 — Intelligence providers

- Local models first (Ollama), because the private option should be the easy
  one and the default recommendation.
- Then Claude via a user-hosted proxy; then a generic provider contract.
- The Settings screen already states the hierarchy; this phase makes the rows
  real rather than "Planned".

## Phase 4 — Routines

- "Save that as my morning routine", then "run my morning routine".
- Stores *validated steps*, never free text — so a routine can't become a way
  to smuggle an unvalidated instruction past the registry later.

## Phase 5 — Awareness

- What's focused, what changed, what you've been doing.
- Proactive notices, sparingly: a build finished, a download completed. The bar
  is high — an assistant that interrupts is worse than one that waits.

## Phase 6 — Polish and ship

- Configurable summon shortcut (see the open question in ARCHITECTURE §8).
- Autostart, updater, code signing.
- First-run experience: the app should teach `Ctrl+Space` without a tour.

---

## Deliberately not doing

- **A general `exec`.** Discussed and rejected in ARCHITECTURE §6.1.
- **Cloud sync by default.** Local-first means the local case is the whole
  product, not the offline mode of a server product.
- **An agent that acts unprompted.** Atlas does what you ask. Proactivity in
  Phase 5 means *noticing*, not deciding.
