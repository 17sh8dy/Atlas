# Atlas — Roadmap

Phases are completed one at a time, in full. A phase is done when it typechecks,
lints, has tests where the logic is non-trivial, and actually runs — not when
the code exists.

## Where things stand (2026-08-19)

**Done:** Phases 0, 1, 2, plus **6 and 7 delivered early** on 2026-08-17 and an
unnumbered interlude that took the catalog to **100 actions** and rebuilt the
window chrome and app resolution. Phase 4 is **half-built**: Claude and ChatGPT
are real, local models are not.

**Next:** Phase 3 — persistence. Conversation history still dies with the
process, and `files.find` still walks the disk on every query.

**Version:** still `0.1.0`, and deliberately so until Phase 8 — see
[Versioning](#versioning).

**Open question blocking nothing yet, but real:** every file command is limited
to `%USERPROFILE%` (`is_permitted` in `platform.rs`), and the index only covers
Desktop/Documents/Downloads/Pictures/Videos/Music. So `D:\Dev` — where all the
user's actual projects live — is refused. This is the security model working as
designed, not a bug, so widening it is a decision to make deliberately (a
user-managed allowed-folders list is the obvious shape) rather than a limit to
quietly raise.

**Baseline, verified 2026-08-19 before commit `790ee7d`:** `pnpm typecheck`
(7 packages), `pnpm lint` clean, **129 engine tests + 13 data tests**.

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

---

## Interlude — catalog, shell, and app resolution ✅ (2026-08-17)

Not a numbered phase: this work cut across several, and pulled Phases 6 and 7
forward with it. Recorded here so the phase list below stays honest.

- **Catalog 25 → 50 → 100 actions.** Worth stating plainly, because the count
  invites the wrong reading: skills here are **broad and parameterised**, not
  canned commands. `app.open` takes any app name, so 100 actions is 100
  capabilities. New pure packs that need no capabilities and therefore work in
  the browser build too: `utility-skills.ts` (password/uuid/random/coin/dice/
  base64/colour/word-count/case/percent/average/time-in-zone/days-until),
  `text-skills.ts` (14: replace/sort/dedupe/tidy/extract/slug/frequency/lorem,
  urlEncode/hash/hex/json/jwt/roman), `calc-skills.ts` (11: tip/interest/
  aspect/bytes/primes/fraction, zoneDiff/age/between/weekday/unix). Every one
  has a deterministic rule in `core-grammar.ts` or the new
  `planner/extra-grammar.ts`, so **none of them needs a model**.
- **Grammar rule order is the whole game.** `webImages` sits at −10.5, ahead of
  `filesFind` (whose noun list contains "images"), and declines possessives so
  "find pictures of my wedding" stays a disk search; `timeInZone` must precede
  `timeNow`; `mathPercent` and `colorConvert` must precede `mathCalculate` and
  `unitConvert`. Adding a rule means placing it, not just writing it.
- **Window chrome** — Windows-11-native caption buttons (46px, full-height,
  flush to the corner, red close, colour-only 120ms hover/press) and a
  Full screen toggle.
- **Full screen is borderless, deliberately not OS fullscreen.** An exactly
  monitor-sized borderless window gets promoted by the compositor to a
  fullscreen flip, which produced a stuttery doubled cursor (visible only while
  hovering, when the two pointers disagree about shape). The fix sizes the
  window to the monitor **minus 1px of height**, leaving the bottom screen row
  uncovered — and the obvious guess is wrong, monitor **+1px did not help**,
  since overhanging a monitor still counts as covering it. Cost: Atlas is
  `alwaysOnTop` while full screen. Note that Tauri's `setSize` sets the *inner*
  size while `outerPosition`/`outerSize` report the frame, so mixing them grows
  the window 16px per round trip.
- **Accent schemes** — 5 in `packages/tokens/src/accents.ts` (Purple default,
  Red, Orange, and two gradient ones, Sunset and Ocean), each with separate
  dark and light variants, applied as inline CSS vars on `<html>`. A gradient
  cannot live in `--color-primary` because `bg-primary/10` tints depend on it
  being flat: gradients go in `--gradient-primary` and are painted only by
  `.accent-surface`.
- **App resolution rebuilt**, after two real failures — "open CrosshairX" found
  nothing, and "Open Steelseires.GG" opened a *website*.
  1. The index only saw Start Menu `.lnk` files. `list_apps` now also reads
     Desktop (user and public), `.url` shortcuts (launcher games often have
     only one), Steam (`libraryfolders.vdf` → `appmanifest_*.acf` →
     `steam://rungameid/`), and Epic (`Manifests\*.item`).
  2. A bare `name.tld` was claimed by the URL grammar rule before apps were
     ever consulted. The design rule that came out of it: **only the layer that
     can see the installed apps can tell an app name from a domain**, so the
     decision belongs in the skill, not the grammar.
  3. Matching is now `appKey()` normalisation → alias table →
     Damerau-Levenshtein on a length-scaled budget. Several close matches show
     a "did you mean" list rather than guessing.

**Verified:** 129 engine tests, and live against the built app — "open
crosshairx" launched the real game, "Open Steelseires.GG" correctly offered the
app rather than the URL, and the full-screen cursor fix was confirmed by the
user directly (a GDI screen capture never contains the pointer, so that class
of bug can only be verified by a human looking at the screen).

---

## Phase 3 — Persistence

- Conversation history across restarts, using the `Storage` port Phase 1
  already built.
- Command history — small, now that Storage exists.
- A real background file index, so `files.find` stops walking the disk per
  query. Names and paths only — the privacy line does not move.
- **Settle the allowed-folders question first** (see "Where things stand"):
  building an index is the natural moment to decide *what it is allowed to
  index*, and shipping one scoped to the six home folders would bake the
  current `%USERPROFILE%` limit in deeper.

## Phase 4 — Intelligence providers 🟡 half-built

**Built:** Claude and ChatGPT register for real. A key saved in Settings →
Developer goes through the same `Storage` port as everything else
(`packages/data/src/provider-keys.ts`), and "Connected" reflects
`isConfigured()` on the actually-registered provider rather than a static
label. Supporting pieces: `intelligence-registry.ts`, `research.ts`,
`intelligence.rs`, `web.rs`.

**Not built, and it's the wrong half to be missing:** **Local models (Ollama)
are still "Planned."** The plan was local first, *because the private option
should be the easy one and the default recommendation* — shipping the cloud
providers first inverted that. Closing this phase means making Ollama real.

**Also outstanding:** Gemini, and a generic provider contract for endpoints
that don't exist yet (the Developer tab already documents the contract).

**Escalation is now visible (2026-08-20).** The engine always decided, tier by
tier, when a request needed a model — but it did so silently, and every request
showed the same `Working…` whether it opened an app in 40ms or waited four
seconds on a network round trip. `packages/engine/src/status.ts` adds an
`EngineStatus` channel: the engine announces a **stage** (`working` /
`searching` / `switching` / `thinking`) whenever the *kind* of work changes, and
`EngineIO.status` carries it to whatever surface is driving. It replaces the
`typing?(on: boolean)` hook, which the engine called and no surface ever
implemented.

Design notes worth keeping:

- The label comes from **`phrasing.ts`**, not the UI, so a personalised Atlas
  stays consistent — and the switch line **names the provider**
  ("Switching to Claude…"). In a local-first assistant, the moment a question
  leaves the machine is exactly the moment worth showing rather than hiding.
- Statuses are mirrored onto the **bus** (`engine:status`), so anything else can
  react to an escalation without being wired into the io object.
- The engine emits **stages, not durations**. The minimum display time that
  stops a fast hand-off flickering (`MIN_STATUS_MS` in `useAtlas.ts`) is a
  presentation concern and lives in the surface; tests wait for nothing.
- ⚠️ A provider may call `onDone` **synchronously** inside `ask` — the in-memory
  test providers do. Both announcement sites are guarded by a `settled` flag,
  or `Thinking…` would be announced *after* the clear and stranded on screen
  forever, on precisely the fast path where it should never appear.

## Phase 5 — Routines

- "Save that as my morning routine", then "run my morning routine".
- Stores *validated steps*, never free text — so a routine can't become a way
  to smuggle an unvalidated instruction past the registry later.

## Phase 6 — Native OS controls ✅ mostly (delivered early, 2026-08-17)

**Built** — `apps/desktop/src-tauri/src/os.rs` on the `windows` crate 0.58,
compiled first try, exposed as the new `os` capability and seven skills in
`skills/os-skills.ts`:

| Rust | Skill |
| --- | --- |
| `lock_workstation` | `system.lock` |
| `power_action` (`ExitWindowsEx` + `SeShutdownPrivilege`) | `system.power` |
| `media_key`, `set_volume`, `toggle_mute` | `media.control`, `system.volume`, `system.mute` |
| `display_off` (`SC_MONITORPOWER`) | `system.displayOff` |
| `empty_recycle_bin` | `system.emptyRecycleBin` |

Volume went through `keybd_event` with `VK_MEDIA_*`/`VK_VOLUME_*` rather than
Core Audio COM: no COM to manage, and it routes to whatever actually owns
playback. Everything destructive (restart, shutdown, lock) is `risk: 'confirm'`,
the same safety model as file delete.

**Still open in this phase:** **brightness** (WMI methods) and **screenshots**
(needs a capture crate). Both were the parts with no obvious cheap path, which
is exactly why they're the leftovers.

## Phase 7 — Reminders, to-dos, and notes 🟡 (delivered early, 2026-08-17)

**Built** — `skills/notes-skills.ts`: `notes.add`, `notes.list`, `notes.clear`,
`todo.add`, `todo.list`, `todo.done`. Waiting for Phase 2 paid off exactly as
intended: these ride the **`Memory` port** with two new `note` and `todo` fact
kinds, so the feature added **no new store**.

**Still open: reminders.** Notes and to-dos are things you ask for; a reminder
has to *fire on its own later*, which needs scheduling and a process that is
running when the moment arrives — a genuinely different problem, and one that
brushes against "an agent that acts unprompted" in the not-doing list below.
(`time.timer` exists, but it is in-session only.) Design this before building
it.

## Phase 8 — Voice 🟡 speaking built, listening deferred

**The undecided question got decided, and only half of it got built.**

**Speaking — done.** Atlas reads its replies aloud through a bundled neural
engine. The three options considered were Windows SAPI voices, a networked
cloud voice, and a local neural engine; the first was rejected because this
machine ships only American voices and a British one needs a language pack
the user installs by hand — an assistant that sounds right only after a
system-settings detour sounds wrong. The second breaks local-first outright.

- **Engine:** Piper, pinned to the **archived MIT release** (`2023.11.14-2`).
  Development moved to `OHF-Voice/piper1-gpl`, which is GPL and would dictate
  Atlas's own licensing — do not "update" without deciding that first.
- **Model:** `en_GB-vctk-medium`, **CC BY 4.0**, 109 speakers in one file.
  Chosen over the obvious `en_GB-alan-medium`, whose training data traces to
  `MycroftAI/mimic3-voices` and carries "All Rights Reserved" with no grant to
  redistribute. Attribution belongs in Settings → About.
- **Personas are speakers, not sliders.** Pitch is not a parameter a neural
  model exposes, and faking it by resampling sounds broken rather than
  different. The five male options are five *regions* — Surrey, London,
  Birmingham, Yorkshire, Newcastle — because options that sound alike are not
  options. Pace is real (the model's length scale) and is the one slider.
- **Playback** is `PlaySoundW` from the `windows` crate already used by
  `os.rs`, not an audio crate: asynchronous, one utterance at a time, and
  passing null stops it. No volume control, which the system mixer already has.
- **Off by default.** An assistant that starts talking unasked is startling.
- Cost: the installer goes from 3.6 MB to ~88 MB. That was a deliberate trade
  for a voice that works offline and sounds right.

**Still open in this phase:**

- **Listening (STT)** — unchanged and still deferred. Speech recognition in
  this engine wants a network round trip, which sits badly beside working with
  nothing connected. Not half-built.
- **Weather** — deferred, and the one item on the original list that
  conflicts with local-first-by-default. If it ships, it's opt-in with the
  user's own API key, disclosed in Settings → Privacy — never on by default.
- A "stop talking" skill, so speech can be cut from the conversation rather
  than only from Settings.
- **Weather** — deferred, and the one item on the original list that
  conflicts with local-first-by-default. If it ships, it's opt-in with the
  user's own API key, disclosed in Settings → Privacy (the placeholder shell
  for this already exists from Phase 1) — never on by default.
- Multiple voice options, speed/volume, push-to-talk, interrupt-while-speaking
  all sit behind the TTS/STT decision above.
- **Ship this as 0.5.0** — see Versioning below.

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

## Versioning

**Decision (2026-08-19): when Phase 8 — Voice ships, the version goes to
0.5.0, at minimum.**

`0.1.0` is the number the project was created with and it has not moved since,
which now badly understates the build: Phases 0, 1 and 2 are complete, 6 and 7
landed early, half of 4 exists, and the catalog is a hundred actions deep. The
About screen reading "Version 0.1.0" tells a first-time user this is a sketch.

Voice is the right moment to correct it rather than doing it now, because a
version number should mark something a user can feel. Speaking and being
spoken to is that; a quiet renumber between builds is not.

**Three files have to move together**, or the app and its installer disagree
about what they are:

| File | Why it matters |
| --- | --- |
| `apps/desktop/src-tauri/tauri.conf.json` | Authoritative. Feeds `getVersion()`, which is what Settings → About actually displays, and names the installer (`Atlas_0.1.0_x64-setup.exe`). |
| `apps/desktop/src-tauri/Cargo.toml` | The crate version. |
| `apps/desktop/package.json` | Keeps the workspace honest. |

The root `package.json` stays at `0.0.0` — it is a private workspace root and
is not a shipped artifact.

Nothing reads the version at runtime beyond the About screen, so this is a
rename, not a migration. Do it as its own commit, so `git log` has one place
that says when and why the number changed.

---

## Deliberately not doing

- **A general `exec`.** Discussed and rejected in ARCHITECTURE §6.1.
- **Cloud sync by default.** Local-first means the local case is the whole
  product, not the offline mode of a server product.
- **An agent that acts unprompted.** Atlas does what you ask. Proactivity in
  Phase 9 means *noticing*, not deciding.
- **Weather, by default.** See Phase 8 — the one exception to "no network
  calls," and only ever opt-in.
