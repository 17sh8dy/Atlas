# Atlas — Roadmap

Phases are completed one at a time, in full. A phase is done when it typechecks,
lints, has tests where the logic is non-trivial, and actually runs — not when
the code exists.

## Where things stand (2026-09-19)

**Read this block first; the dated paragraphs after it are history and some of
their claims (Cortex, "the only provider") are superseded here.**

**Intelligence layer, rebuilt (2026-09-19).** Cortex is gone. Atlas talks to
local Qwen3 models through Ollama directly (default Qwen3-8B with thinking
off, ~10x faster; 30B and Coder variants optional), the Nova Intelligence
sandbox has its own section, and cloud providers remain opt-in. Settings →
Intelligence lists every local model with **Install** (opens a download guide)
for any that is missing. Models are the conversation/reasoning layer only —
skills, permissions, PowerShell-style tools and confirmations are unchanged.

**Web research (committed).** Router → query rewrite → `SearchManager`
(Tavily → DuckDuckGo → Wikipedia, with cooldowns) → evidence packet with
code-computed verification → answer with inline citations and a Sources
footer. Tavily key lives only in Credential Manager. DuckDuckGo is
CAPTCHA-blocked on this machine, which is why the key matters.

**Conversation UX (committed).** Streaming replies with a live counter,
"Think longer" bubble, expandable composer, and **replies are now spoken
sentence-by-sentence as they stream** (`useSpeech.speakStream`) instead of
after the whole answer.

**Clarifying questions (committed, `e2bff4a`).** Vague requests are asked
about *before anything runs* — not just Steam: every action with a required
detail (~102 of 146), fixed-choice details as buttons, a way out always
present. A survey of 49 vague requests went 4 → 38 asked.

**Chained requests (2026-09-19).** A sentence may now chain any number of
clauses ("open notepad, open calculator and open paint"; connectors: `and`,
`then`, `and then`, `after that`, commas). Every clause must still match a
real rule on its own. A browser named first is aimed at the site that follows
("open chrome and go to a website" → asks which site → opens it *in Chrome*).

**In-app updates (2026-09-19).** `@atlas/updater` (pure TS: manifest,
version compare, verification rules, an 9-state service) + `updater.rs`
(download with progress, SHA-256 / product / version / Authenticode checks,
backup, a helper process that replaces the running program, automatic
rollback) + the top-right `UpdateBubble` and Settings → About → Updates.
Reusable: a second Nova app supplies its own `UpdateBackend` and manifest URL.
**To ship an update:** build the installer, run
`node scripts/make-update-manifest.mjs <installer> --note "..."`, create a
GitHub release `v<version>` and attach the installer **and** `latest.json`.
Tested by 38 service tests, 13 Rust tests (including the real helper's success,
failed-installer and wrong-version paths against a sandbox) and the bubble's
tests — **but never run end to end against a real published release**: no
release with a manifest exists yet, and the installed build predates the
updater, so the first update has to be installed by hand once. Not done:
code-signing (measured and reported, not required), signed manifests (the
seam exists), delta updates, and a build that cannot start at all cannot roll
itself back.

### Still open (the honest list)

- **Settings persistence (added 2026-09-20):** theme, accent, text style and effects are saved in the
  webview's `localStorage` (`app/theme.tsx`, `text-style.tsx`, `effects.tsx`), not the `Storage` port /
  `storage.json`. They are per-build-origin and cannot follow a Nova Account. Move them onto `Storage`
  (one-time import from `localStorage`), or fold into Nova Accounts settings sync when that lands.
- **More local runtimes (added 2026-09-20):** Local Models and "Also installed on this PC" only speak
  Ollama (`intelligence.rs` streams `/api/chat` NDJSON). Add LM Studio / llama.cpp server / Jan through
  their OpenAI-compatible `/v1` endpoint (SSE) behind a runtime seam. Cline is a VS Code agent, not a
  model runtime, so it is not a target. Also possible: an Install button that runs `ollama pull`.
- **Not started:** Phase 5 Routines · Phase 9 Awareness · Phase 10 (configurable
  summon shortcut, autostart, code signing, first-run experience — the
  updater is built, see above).
- **Partial:** Phase 11 (2 of 10 skill groups: Storage, Audio, Display, Tasks,
  Users, Firewall, Environment, Windows remain) · Phase 3 (`files.find` still
  walks the disk per query; no background index) · Phase 7 · Phase 8 loose
  ends ("stop talking" command, richer visualiser, opt-in weather).
- **1.0.0 debt:** settings copy that promises the future ("always will"); six
  phrasings needing referents ("format this json"); two that reach the wrong
  skill ("open the first result and summarize it", "convert 0xff to decimal");
  "click play" without a named window.
- **Chains, what is still missing:** clauses that need *live UI state* ("go to
  the Nova server, start a call in Hangout") still need the observe-and-replan
  loop (see Ideas §7); a relevant-skill shortlist for small-model planning is
  proposed, not built; an approval-gated PowerShell action is proposed, not built.
- **Missing actions:** alarm, email, message, call, brightness.
- **Owed:** a real-app click-through of streaming speech, chains and the
  Install button (all verified by tests only). Ollama does not autostart, so
  Atlas shows no models until it is running — a "Start Ollama" button is unbuilt.

### Earlier status (2026-09-11)

**2026-09-11: Phase 14 — cloud model providers + conversation streaming —
built.** Cortex streams for real now (Ollama's NDJSON → SSE →
`atlas://intelligence` events), and Atlas can optionally reach
OpenAI-compatible/Anthropic/Gemini providers a person configures themselves,
keys held in Windows Credential Manager, never in `storage.json`. This is a
deliberate, Brandon-directed reversal of Phase 4's "Cortex is the only cloud
AI" — see that phase's own section for the full reasoning and what's still
deferred (cloud streaming, a model upgrade, clicking it through in the built
app).

**2026-09-11: Phase 13 — the developer agent — built.** Project detection,
content search, git reads/writes, a build/test dispatch across seven
ecosystems, and a bounded observe-and-replan loop (`devagent.run`) that
reuses the existing executor/risk/confirm/content-policy pipeline rather than
adding a second one. See that phase's own section, below "Ideas from product
feedback," for what shipped and what's deliberately still deferred (MSBuild,
streaming build output, clicking it through against a real build).

**Done:** Phases 0, 1, 2, 6, 7, 8, **12**, **13**, and **14** — operating other windows,
synthetic input, UI Automation and screen capture, clicked through against
the real built app the same day (see Phase 12 below). Phase 11 is still only
**two of its original ten groups** built (network, services) — Phase 12
covered three domains that phase's own list didn't anticipate and is complete
on its own terms, which is why it's marked done while Phase 11 isn't.

**Phase 4 was inverted, and has been corrected by subtraction (2026-08-23).**
Cortex is the only provider Atlas will ever have, it runs on loopback, and
there is no API key anywhere in the product. Speaking and listening are Piper
and whisper.cpp with no branch at all. (Cortex's own repo has since grown a
real server and a `ConversationEngine` — see that phase's note below.
**2026-09-10:** `cortex/server.py`'s `/v1/ask` now answers through that
engine, so a running Cortex remembers a conversation across turns. The wire
contract Atlas already speaks (`{"prompt"} -> {"text"}`, no session field) did
not change, so nothing on Atlas's side needed touching — this file still only
tracks what's actually wired into Atlas, and the answer is now "the memory
too, transparently.")

**A polish pass landed 2026-09-07**, alongside Phase 12's revisions below:
Home's suggestion list traded `uppercase "hello world"` and a clipboard
transform — the two chips this session's own feedback called out as things
"not many people care about" — for what Phase 11/12 actually built: a real
screenshot, locking the PC, listing open windows; **Enhanced Effects now
reaches the composer bar and its buttons**, not just `Button`/`Surface`,
triggering on focus as well as hover since typing into a bar is not hovering
it; **a rows-only reply now speaks a summary in both chat and voice** — window
lists, "which one did you mean" cards and the like used to render a card and
say nothing at all, which was silence in voice mode and looked answered-but-
mute in chat; and **Settings remembers whether it was opened from the voice
screen or the chat**, with a back arrow that returns to exactly that instead
of always landing in chat.

**Next:** Phase 11's other eight groups (Storage, Audio, Display, Tasks,
Users, Firewall, Environment, Windows) are still what's actually next for
Atlas's own catalog — see that phase for the elevation question the services
pack already raised. Separately: [Cortex](file:///D:/Dev/Cortex) grew a
`ConversationEngine` on 2026-09-07 — session history, multi-turn context, a
`Backend`-agnostic response seam — and on 2026-09-10 `cortex/server.py`'s
`/v1/ask` was wired to answer through it instead of the backend directly, so a
running Cortex now has memory across turns. Nothing in this repo changed —
Atlas's contract with Cortex was already just `{"prompt"} -> {"text"}`, no
session field, and still is; see `cortex/conversation.py`'s own module doc for
what the engine does and doesn't do.

**Also outstanding:** Phase 3 — persistence. Conversation history still dies
with the process, and `files.find` still walks the disk on every query.

**2026-09-08:** a voice-naturalness pass shipped (`prepareForSpeech` in
`@atlas/core`, plus two small skill-message fixes and two new Rust tests
measuring the model's own trailing silence — see that commit for the full
before/after). The same conversation raised five bigger directions —
generalizing `attemptGoal()` beyond `app.open`, cross-turn context, a spoken
reply that differs from the screen one, instant acknowledgement before a
skill runs, and auditing the risk model further — recorded under "Ideas from
product feedback" near the end of this file rather than started; each needs
its own decision first.

**Version:** **`0.5.0`**, taken on 2026-08-21 when Phase 8 completed — the
trigger the [Versioning](#versioning) section names.

**Resolved (Brandon, 2026-09-10): widen it, with a user-managed allowed-folders
list.** Every file command used to be limited to `%USERPROFILE%`
(`is_permitted` in `platform.rs`), and the index only covered
Desktop/Documents/Downloads/Pictures/Videos/Music — so `D:\Dev`, where the
user's actual projects live, was refused. See Phase 3 below for what shipped:
`allowed_folders.rs`, defaulting to today's exact reach, editable in
Settings → General.

**Baseline, verified 2026-09-07:** `pnpm -r typecheck` (9 packages), root
`eslint .` clean, `pnpm test` (root script) — **397 tests** across
`core`/`data`/`engine`/`tokens`/`web` — plus the existing Rust suite
(`cargo test`, untouched today). Engine alone is 307 (up from 293 this
morning: 2 for the window-disambiguation fix, 12 for the risk-model revision).

**The window's middle caption button maximises** rather than filling the
monitor, as of 2026-08-21. tao already trims a maximised borderless window to
the work area in its own `WM_NCCALCSIZE` handler, so it needs no geometry of
our own, and it agrees with the double-click on the drag region — which was
already invoking `internal_toggle_maximize` while the button did something
else entirely.

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
(Navigator Engine always-on, Local Models/Claude/Gemini all "Planned" — that
whole hierarchy was deleted on 2026-08-23; see Phase 4). Closing
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

- ✅ **Conversation history across restarts (2026-09-10)**, using the
  `Storage` port Phase 1 already built. `useAtlas.ts` loads the transcript on
  mount and writes it back debounced (500ms — a whole turn lands as one write,
  not three) and capped at 200 entries, the same cap `MemoryStore` already
  uses for the episodic log. `Entry` needed no serialiser of its own: it was
  already a plain, JSON-safe shape, since a captured screenshot rides in a
  `SkillResult`'s own `data` field as a data: URL string, never as binary in
  an `Entry`. The one real hazard was a race — a slow first read losing to an
  early write of `[]` and silently erasing a real transcript — closed by a
  `loaded` ref gating the write effect until the read actually lands.
- ✅ **The allowed-folders question, settled (2026-09-10): widen it.**
  `is_permitted` (`platform.rs`) is no longer a hard-coded `%USERPROFILE%` —
  `allowed_folders.rs` is a user-editable list, defaulting to exactly what was
  already allowed so nobody's reach changes until they add to it, surfaced in
  Settings → General. `indexed_roots()` (what `files.find` actually walks)
  now follows the same list: the home folder still expands to its six named
  subfolders exactly as before, and anything added beyond it — `D:\Dev`, the
  motivating case — is walked directly. See that module's doc comment for why
  this is a process-wide `RwLock` rather than an `AppHandle` threaded through
  the ~20 call sites that check it.
- Command history — small, now that Storage exists.
- Still open: `files.find` still walks the disk fresh on every query — the
  allowed-folders decision above was the blocker for *what* to index; a real
  background index over that same list is the remaining work.

## Phase 4 — Intelligence: Cortex, and only Cortex 🟡 seam built, model missing

**Resolved by subtraction (2026-08-23).** This phase was half-built in the
wrong half: Claude and ChatGPT were real while local was "Planned", inverting
the rule that *the private option should be the easy one*. Rather than adding
Ollama alongside them, the cloud providers were deleted.

**Built:** one provider. `createCortexProvider` (`platform/src/providers.ts`)
calls `ask_cortex` / `cortex_reachable` (`intelligence.rs`), which accept
loopback only — host parsed, not substring-matched. Settings → Developer is
now Settings → **Intelligence**: one switch, a live Running / Not running
state, and an endpoint field that refuses anything off this machine. No key
field, because there is nothing to authenticate to. `cortex-settings.ts`
replaced `provider-keys.ts`; the API-key storage is gone entirely.

**Guarded:** `no-other-cloud-ai.test.ts` reads every `.ts`/`.tsx`/`.rs` file
in the repo and fails on a cloud hostname or a removed symbol. Confirmed to
fail when a violation is introduced — a guard nobody has watched fail is not
a guard.

**Not built:** the thing on the other end. Cortex v0.1 is a character-level
GPT with no HTTP server, so the switch reads *Not running*. Closing this phase
means Cortex serving `POST /v1/ask` `{prompt}` → `{text}` and `GET /health`,
and a model behind it that can actually answer.

**Decision (Brandon, 2026-08-21): ordinary conversation waits for Cortex.**
Saying "hello" to Atlas today gets a deterministic reply from `phrasing.ts`,
and that is where it stays. The obvious shortcut — route small talk to
whichever cloud provider happens to be configured — is refused, because it
would make the *most common* thing anyone says to an assistant the one thing
that needs a key and a network, which inverts the thesis at the exact point a
first-time user meets it.

[Cortex](file:///D:/Dev/Cortex) is the intended answer: a local model, on this
machine, for the conversational tail that grammar cannot cover. It is not
ready — v0.1 is explicitly educational and is not wired to anything — so the
sequence is Ollama or Cortex first, conversation second. Until then, small
talk being a little stiff is the honest cost of not having a local model yet,
and is preferable to it being fluent only for people who have paid for one.

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

## Phase 8 — Voice ✅ speaking and listening both built

**Both halves are in.** Atlas reads its replies aloud and hears you, and
neither needs a network.

### Speaking — done

The three options considered were Windows SAPI voices, a networked cloud
voice, and a local neural engine. The first was rejected because this machine
ships only American voices and a British one needs a language pack the user
installs by hand — an assistant that sounds right only after a system-settings
detour sounds wrong. The second broke local-first outright.

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
- **Playback happens in the webview**, not in Rust. It was `PlaySoundW`
  originally; that failed silently, because asynchronous winmm playback does
  not outlive the `spawn_blocking` thread that starts it, and it was the wrong
  seam anyway — audio played by the OS is audio the page cannot analyse.
  `speech.rs` returns WAV bytes and `speech/player.ts` owns the rest.
- **Off by default.** An assistant that starts talking unasked is startling.

⚠️ **The bug that cost a session, written down so it is not rediscovered:**
a Tauri command returning `tauri::ipc::Response` only arrives as an
`ArrayBuffer` over the custom-protocol IPC, which the page reaches by
`fetch`ing `http://ipc.localhost`. Our CSP declared no `connect-src`, so it
inherited `default-src 'self'`, that fetch was blocked, and Tauri silently
fell back to the postMessage transport — where a raw body over 1 KB is
serialised into a JSON array of numbers. `decodeAudioData` rejects an `Array`,
the rejection was swallowed, and a 97 KB utterance became silence with no
error anywhere. **Tauri does not add the ipc source to a custom CSP.** If
`app.security.csp` is set at all, it must include
`connect-src ipc: http://ipc.localhost`.

### Listening — done

The deferral reason was real and no longer holds: every convenient
speech-recognition API is a microphone with a network cable on it, which an
assistant whose thesis is "nothing is sent anywhere" cannot ship. whisper.cpp
settles it locally.

- **Engine:** whisper.cpp (`ggml-org/whisper.cpp`, MIT), pinned to build tag
  `b4938`, plain x64 CPU build. Not the cuBLAS builds (670 MB, and this is an
  AMD machine) and not the BLAS one — it is already faster than real time.
- **Model:** `ggml-base.en.bin` (~148 MB, MIT). Chosen over `tiny.en`, which
  mishears names and technical words often enough that you stop trusting it.
  An assistant you have to repeat yourself to is worse than a text box.
- **Rust transcribes; the webview records.** The mirror of speaking, split for
  the mirror of its reason: the model needs the machine, the microphone needs
  echo cancellation, a resampler, a level meter and a silence gate that the
  browser already has. It also means the Rust half of the app has no way to
  start listening — it can only be handed something already recorded.
- **Two ways in, because they are different acts.** The composer's mic button
  dictates into the text box, where you read it before sending — a transcriber
  that acts on what it *thinks* it heard eventually deletes something. The
  voice screen is a place you go: it listens, answers aloud, listens again,
  and talking over Atlas cuts him off. Listening is confined to that screen
  and the microphone closes when you leave it.
- **The prompt is part of the engine.** Without a vocabulary line whisper
  hears the product's own name as "at this"; with one, the same audio
  transcribes correctly. The names of installed apps are appended to it,
  fetched only when the microphone is first wanted, so "open CrosshairX"
  survives the trip. Bounded, because the initial prompt shares the model's
  224-token context with the audio.
- **The gate is measured, not fixed.** A headset and a laptop array differ by
  more than speech differs from silence, so the noise floor is sampled for
  400 ms and the threshold sits a multiple above it. 300 ms of pre-roll is
  kept, because detection necessarily lags the first syllable.
- **Off by default, and enforced.** While `listening.enabled` is false nothing
  calls `getUserMedia`, the button that opens the voice screen is absent
  rather than disabled, and the stored value must read exactly `"true"` — a
  half-written preferences file cannot open a microphone.

⚠️ **WebView2 asks for microphone permission itself**, with its own prompt
("http://tauri.localhost wants to use your microphones") drawn in the
webview's process and anchored to the window's top-left. wry only registers a
`PermissionRequested` handler for clipboard, so everything else falls through
to WebView2's default UI. If that prompt turns out not to persist between
launches, the fix is a `PermissionRequested` handler consulting Atlas's own
setting — deliberately not built yet, because the setting is the consent and
duplicating it before knowing it is needed adds COM plumbing for nothing.

### Online voices — opt-in, and not a speed feature

Speaking and listening can go through a connected service instead. Off by
default and unreachable unless both the switch is on and a key is saved.

The obvious pitch is speed and it is **false on this hardware, measured**:
Piper synthesises a sentence in ~0.2 s (RTF 0.067) and whisper `base.en`
transcribes a three-second clip in 0.9 s including model load. A round trip
cannot match either. What a service offers is a different voice and a larger
transcription model that copes better with accents, noise and unfamiliar
names — so that, plus a plain statement that audio is sent, is what the
setting says. On a slower machine the argument may invert; that is why it is
a preference rather than a recommendation.

The network path lives in `voice_cloud.rs` alone, and the port exposes
`synthesizeSpeechOnline` / `transcribeSpeechOnline` as separate methods rather
than a flag, so a call site shows which one it is without following anything.

⚠️ **Both methods, and `voice_cloud.rs` behind them, were deleted on
2026-08-23.** They posted recordings and reply text to OpenAI and shared the
ChatGPT API key, so "no OpenAI" could not be true while they stood. Voice is
Piper and whisper.cpp with no branch: nothing said to or by Atlas leaves the
machine, and that is now a property of the code rather than of a switch. The
cost is the larger transcription model that coped better with accents and
noise; the local one is what there is.

### Still open in this phase

- **Weather** — deferred, and the one item on the original list that conflicts
  with local-first-by-default. If it ships, it's opt-in with the user's own
  API key — never on by default. ⚠️ It can no longer be "disclosed in Settings
  → Privacy": that tab was a placeholder and was deleted on 2026-08-23. The
  disclosure now belongs wherever the feature's own switch lives.
- A "stop talking" skill, so speech can be cut from the conversation rather
  than only from Settings or by talking over it.
- The voice screen's visualiser reads real amplitude but is a plain pair of
  rings; it was specified as something richer.
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

## Phase 11 — The desktop assistant

**Decision (Brandon, 2026-08-21). Binding, and the reasoning matters more than
the list.**

The goal is *not* "Atlas can run PowerShell." It is:

> Atlas can perform the useful things a person would normally use PowerShell
> for.

Those are different architectures, and only one of them survives contact with
this project's first never-undo rule. **`exec(command)` is still refused.** No
arbitrary command string ever reaches Windows. Every operation keeps the shape
everything else already has:

```
request → planner → SkillRegistry → validated skill → platform implementation
```

The distinction is what makes the ambition affordable. "Run PowerShell" is one
capability that can do anything, including everything nobody sanctioned; "do
the things people use PowerShell for" is sixty capabilities that each do one
reviewable thing. The second is more work and less power, and the trade is the
entire security story of the product.

### 1. Expand the narrow skill layer (~40–60 skills)

Grouped roughly as:

| Group | What it covers | Mostly |
| --- | --- | --- |
| 🖥️ System | processes, services, uptime, system info | read + start/stop |
| 💾 Storage | disks, folders, cleanup, free space | read + destructive |
| 🌐 Network | Wi-Fi, adapters, IP/DNS, connectivity | read |
| 🔊 Audio | volume, output/input device selection | read + set |
| 🖼️ Display | resolution, monitor info, brightness where supported | read + set |
| 📅 Tasks | scheduled tasks | read + destructive |
| 👤 Users | account info, basic management | read + destructive |
| 🔥 Firewall | inspect and manage rules | read + destructive |
| ⚙️ Environment | environment variables | read + set |
| 🪟 Windows | settings, installed apps, startup items | read + set |

Already built and not to be rebuilt: `system.info`, `system.processes`,
`system.battery`, `system.disk`, `system.uptime`, `system.openTool`,
`system.lock`, `system.power`, `system.volume`, `system.mute`,
`system.displayOff`, `system.emptyRecycleBin`.

⚠️ **Implementation note that decides how much of this is even possible.**
Several of these have no ergonomic Win32 API and are genuinely shaped like
"run a command" — enumerating Wi-Fi profiles, listing scheduled tasks,
reading firewall rules. The answer is *not* to relax the exec rule for them.
It is that a skill may invoke a **fixed executable with a fixed argument
shape** whose only variable parts are validated against a closed set — the
same pattern `open_system_tool` already uses, and the same one `speech.rs`
uses to run piper. `netsh wlan show profiles` is a constant. `netsh wlan show
profile name="<validated-ssid>"` is a constant plus one checked parameter.
Neither is a command runner, and the difference is that a reader can
enumerate everything the program can ever execute.

### 2. Risk stays keyed to consequence, not to input method

The existing `SkillRisk` model already carries this, with the tightening from
2026-08-21: the test is whether an action changes something closing a window
will not undo.

- **Read** → runs. Listing services, adapters, tasks, rules, variables.
- **Reversible change** → runs. Volume, a display setting, an env var for the
  session.
- **System-changing or destructive** → confirms. Stopping a service, deleting
  a scheduled task, changing a firewall rule, removing an account.
- **Beyond that** → refused outright, not confirmed. There is no confirmation
  card that makes disabling the firewall wholesale a good idea.

⚠️ **Voice does not get its own security model,** and this is settled: the app
reaches the engine through exactly two screened seams, `engine.ask` and
`engine.run`, and voice arrives through `ask` like a keystroke does. A
capability that is dangerous when spoken is dangerous when typed.

### 3. AI becomes the fallback, not the hands

```
request
  ↓
can a local skill do it?  ── yes ──▶ run it
  ↓ no
AI works out what to do
```

**AI is not Atlas's hands. It is the reasoning layer for the cases Atlas has
no capability for yet.** That inverts the usual assistant design, where a
model is the executor and tools are its appendages, and it is the reason this
one works with nothing connected: the hands are always present, and only the
reasoning is optional.

The tiering already exists in `Engine.ask`; what was missing was saying so out
loud, which is the `feat/model-escalation-status` branch (`8f5b753`,
`d1be8ea`). **Merging that is part of this phase**, because "commands first,
AI for the rest" is exactly what it makes visible.

⚠️ Ordinary conversation is a separate question and waits for a *local* model
— see Phase 4. The fallback tier being real does not mean "hello" should
travel to a datacentre.

### 4. What "done" looks like

Not a skill count. The phase is done when a person who reaches for PowerShell
out of habit can ask for the same thing in words and get it — and when the
list of executables Atlas can ever run is still short enough to read in one
sitting.

### 5. Built so far

| Group | Skills | State |
| --- | --- | --- |
| 🌐 Network | `net.adapters`, `net.ip`, `net.wifi`, `net.savedNetworks`, `net.online` | ✅ 2026-08-21 (`0cb6f5a`) |
| 🖥️ System — services | `service.list`, `service.status`, `service.start`, `service.stop`, `service.restart` | ✅ 2026-08-22 |
| ⚙️ Environment | `environment.list`, `environment.get`, `environment.set`, `environment.setSystem`, `environment.delete`, `environment.deleteSystem` | ✅ 2026-09-10 |
| 💾 Storage | `storage.folderSize`, `storage.largestFiles`, `storage.emptyFolder` | ✅ 2026-09-10 |
| 🔊 Audio · 🖼️ Display · 📅 Tasks · 👤 Users · 🔥 Firewall · 🪟 Windows | — | not started |

**The environment pack is the template for a group whose risk tier depends on
an argument rather than the verb.** `environment.rs` has exactly two scopes —
the user's own registry key, which needs nothing, and the machine's, which
needs administrator rights the same way `services.rs` earns them (ordinary
call first, `reg.exe` re-run elevated via `ShellExecuteEx` only once Windows
has refused) — and rather than one skill with a badge that changes per call,
each scope gets its own skill id (`environment.set` vs `environment.setSystem`)
so `Skill.risk`, which is checked before anything runs, stays a fact rather
than a guess. Also the first pack to trip the grammar's path guard on
purpose: an environment variable's *value* is routinely a path (`PATH` is the
extreme case), and every rule in the block declares `pathSafe: true` because
without it a value like `C:\Program Files\Java` would silently reroute the
whole request to the AI-plan path instead of the skill that was actually
named — caught by a real test failure, not by inspection, which is why it's
worth knowing about before writing the next pack's grammar.

**The storage pack is the first destructive verb built from zero new platform
methods.** `storage.emptyFolder` needed nothing beyond `listDir` (what's
directly inside) and `deletePath` (already routes through the OS recycle bin)
— the two primitives `platform.rs` already had, composed rather than
duplicated. `folder_size` and `largest_files` are new (`disk_usage.rs`), and
both cap how much of a folder they'll walk and report `truncated: true`
rather than silently returning a number for only part of a tree too big to
finish — the same "absence is an answer" property `net.rs` established for a
machine with no Wi-Fi, applied here to a folder instead of a network.

**The network pack is the template** for a read-only group: reads are `safe`,
the answer is a sentence rather than a table dump, and absence is an answer.

**The services pack is the template for a group that can act**, and it added
the two properties the first one had no need of:

- **The friendly name is resolved before anything is asked.** People say "the
  print spooler", not "Spooler". Resolution runs against the live list, and an
  ambiguous name produces the candidates rather than a guess — a resolver that
  silently picks the first of six is indistinguishable from a correct one until
  the day it stops the wrong service.
- **Some calls are refused, not confirmed** — the tier this phase's risk model
  named and the skill model had no way to express. `Skill.guard` is that tier
  now; see §6.1 of `ARCHITECTURE.md`. `NEVER_STOP` in `services.rs` is the
  list, and stopping RPC draws no card at all.

**Elevation, decided by Brandon 2026-08-22.** Starting and stopping a service
needs administrator rights, and Atlas deliberately does not run elevated —
every capability it has, including future ones, would inherit those rights for
the sake of two verbs. So elevation is **per action**: the ordinary call is
tried first, and only once Windows has refused does the verb go back through
`ShellExecuteEx` with the `runas` verb. Windows shows its own consent dialog,
naming `sc.exe`; Atlas cannot draw it, suppress it or answer it, and the
elevated process exits when the verb is done. The rule still holds — one
constant file, two constant verbs, a validated name — what changes is the
rights that short list runs with, and who grants them.

The two alternatives were considered and declined: reporting the failure and
doing nothing (leaves three skills decorative), and running the whole app
elevated (buys convenience by giving every capability admin, forever).

⚠️ **Grammar ordering is load-bearing here.** `systemPower` claims
`/restart.*windows/`, so "restart the Windows Update service" would reboot the
machine at any order below it. The service rules sit at −6.92/−6.91, above it,
and a test is named after the collision.

---

## Phase 12 — Operating the machine

Three domains Phase 11's original ten groups didn't anticipate: controlling
*other* windows on the desktop, synthesizing mouse and keyboard input, and UI
Automation — reading and acting on another application's real controls rather
than guessing at screen coordinates. Same governing rule as Phase 11: no
`exec`, every capability a narrow validated skill, risk keyed to consequence.
See §6.6 of `ARCHITECTURE.md` for the two decisions that were genuinely new
(risk stays two-tier; an element is addressed as a path, never held live).

### Built

| Group | Skills | Risk | State |
| --- | --- | --- | --- |
| 🪟 Window control | `window.list/active/focus/minimize/maximize/restore/move/close`, `system.endProcess` | reads + move = safe; close/end = confirm, guarded against OS-critical processes | ✅ |
| 🖱️⌨️ Input | `input.moveMouse/cursorPosition/scroll/click/drag/pressKey/hotkey/typeText` | all `safe` — a click/keypress/typed string is a mechanism, not a consequence; `input.hotkey` escalates to `confirm` only for Alt+F4, via `riskFor` — see §6.6 | ✅ (revised 2026-09-07) |
| 🧩 UI Automation | `uia.tree/focusedElement/invoke/expand/collapse/setValue/typeInto` | all `safe`, for the same reason as Input — UIA is the *more* precise way to click/type, so it can't ask more than the raw-input fallback it's preferred over | ✅ (revised 2026-09-07) |
| 🖥️ Screen | `screen.capture/captureWindow/listDisplays` | all safe (read-only) | ✅ |
| ℹ️ Compatibility | `windows_compatibility` (Rust command, not a skill — informational, surfaced in About) | n/a | ✅ |

All four skill packs plus `compat.rs` shipped together, each with real Rust
unit tests (including live ones against this actual desktop — a real window
enumerated, a real UI Automation tree walked against whatever had focus, a
real screenshot encoded to a real PNG, a real Windows build number read from
the registry) and engine tests against the scripted-`Platform` double.
`pnpm -r typecheck`, root `eslint .`, and `pnpm test` all clean.

**Clicked through against the real built app, 2026-09-07** — the thing the
original commit still owed. Rebuilt with this phase's code (the prior
`atlas-desktop.exe` predated it by four days), summoned, and driven through
the composer: "what windows do I have open" listed the real desktop,
Settings → About showed a real registry read for the Windows build number,
and — the two-window "Calculator" repro that also turned up the disambiguation
bug fixed the same day (below) — a real `press enter` and a real
`close the calculator window` each drew a real confirm card, were approved,
and executed for real (the process actually exited). Nothing here was faked
or assumed from tests alone.

**Fixed the same day: a disambiguation card was speakable but not clickable.**
When a name matched more than one window (two windows both titled
"Calculator" — `CalculatorApp.exe` and its `ApplicationFrameHost.exe` shell —
found live, not hypothetically), the "which one?" card rendered plain rows
with no `actions`, so a person could only retype an exact name that didn't
exist. `resolveWindow` (`text/windows.ts`) now also matches a candidate's own
opaque `id` exactly, and every one of the four places that offers a
disambiguation list (`window.*`, `uia.*`, `screen.captureWindow`) attaches a
real click action addressed by that `id` rather than by the ambiguous name —
which also makes "the second one" work by voice or text, since ordinal
resolution (`WorkingMemory.resolveOrdinal`) reads the same `actions` field.

**Grammar stayed deliberately narrow.** Only the one-shot phrasings people
actually type in a single sentence got a rule — list/focus/minimize/maximize/
restore/close a named window, end a process, press a named key or hotkey,
type quoted text, scroll, take a screenshot, list displays. Anything needing
free-form argument extraction across multiple fields ("click the Save button
in the dialog that's open", "type X into the search field in window Y") has
no one-liner grammar and is left to the AI-plan path, which is exactly the
case that tier exists for — confirmed by the engine tests for those skills,
which invoke the registry directly the same way `window.move`'s own test does
rather than pretending a grammar rule exists.

**Decision (Brandon, 2026-09-07): risk is consequence, never input method —
raw input and UI Automation reclassified from uniform `confirm` to `safe`.**
The original call — every click, keypress and typed string asks, because
there's no way to know in advance what one will do — was real but led to the
wrong conclusion for Do It mode: a click is a *mechanism*, the same way
window-focusing is, not a consequence category of its own, and the resulting
confirm card could only ever show a coordinate or a key name, never what was
actually behind it. It protected nothing that the *named* skills for actually
destructive things (`window.close`, `files.delete`,
`system.emptyRecycleBin`, `system.endProcess` — all unchanged, still
`confirm`) didn't already cover, and it made "press enter" and "click Save"
ask "are you sure?" on the strength of the rare case they can't be told apart
from. `input.click/drag/pressKey/hotkey/typeText` and every `uia.*` action are
now `safe`. The one keystroke that is a *known* equivalent of an
already-gated named action — Alt+F4, same consequence as `window.close` —
still confirms, via a new `Skill.riskFor?(args)` escalation hook rather than
by making the whole hotkey skill ask again; see §6.6 of `ARCHITECTURE.md` for
the full reasoning and exactly what changed.

### Deferred, and why — not built as placeholders

- **Local OCR.** `screen.rs` captures real pixels; reading text out of them
  isn't built. UI Automation's bounding rectangles already say what and where
  a control is, which is what the request itself asks to prefer — OCR is a
  clean, cheap follow-up (Windows ships one), just not part of this pass.
- **A vision-based `screen.describe` skill.** Planned, then dropped: the
  intelligence port is Cortex-only and text-prompt-only (`ask(prompt: string,
  ...)` has no image channel), so there is currently no provider this skill
  could actually call. Building it anyway would have been exactly the
  placeholder-function shape this project refuses to ship. Waits for a real
  vision-capable provider.
- **An autonomous observe-and-replan loop.** The request describes "execute →
  observe → replan"; that's already true *between* turns and *within* one
  AI plan's fixed step sequence, but not *within* a single step reacting live
  to what just appeared on screen. That would be a new agentic loop — a
  separate architectural decision (iteration budget, cost if a cloud model is
  doing the looking) — and wasn't part of what this phase built.
  `attemptGoal()` (`planner/attempts.ts`, built for `app.open`) is a
  same-skill retry ladder and doesn't generalize to it.

---

## Phase 13 — The developer agent (2026-09-11)

**Brandon's brief:** evolve Atlas toward a Claude-Code-like capability — tell
it to inspect a project, find a build error, fix it, rebuild, run the tests,
and explain what changed — while staying Atlas: deterministic tools first, a
model for reasoning only, every action still declared, risk-rated and
confirmable. Explicitly **not** a request to bolt on a raw shell or a second
execution path; the brief itself named the same constraints §6 of
`ARCHITECTURE.md` already holds to.

This is the "autonomous observe-and-replan loop" Phase 12 named and deferred,
and item 7's third gap from "Ideas from product feedback" below — but scoped
down to something tractable, the same way that section's own note anticipated:
the loop only ever observes *text* (a build's stdout, a git diff, a search
result), never a UI Automation tree or a screen coordinate. That is what makes
an iteration budget something you can actually reason about.

**Built:**

1. **A devtools surface** (`apps/desktop/src-tauri/src/devtools.rs`, new
   `devtools` capability): project detection (which of cmake/cargo/npm/
   pnpm/dotnet/make/pytest a folder actually has, from its marker files —
   never a guess), a bounded recursive directory tree, content search
   (ripgrep if it's on PATH, a scoped fallback walk if not), git reads
   (status/diff/log) and two git writes (add/commit), and one dispatch point
   for build/test tooling — `run_devtool(cwd, tool, arg)`, where `tool` is a
   **closed enum naming one fixed executable and subcommand shape** (the same
   `net.rs`/`services.rs` discipline: "a reader can enumerate every program
   this file will ever run"), and `arg` is the one validated slot (a target,
   an npm script checked against `package.json`'s real keys, a test filter) —
   never a command string. Plus `writeTextFile` (overwrite an existing file)
   and `patchTextFile` (exact-substring replace, refusing an ambiguous match
   unless `replaceAll` is set — the same discipline a precise editor uses,
   not a whole-file regenerate). See `devtools.rs`'s module doc for the one
   real exception (npm/pnpm route through `cmd.exe /C` on Windows because
   they ship as `.cmd`, not `.exe` — CreateProcess can't launch those
   directly — and why the script name is validated twice over because of it).
2. **Thirteen new skills** (`packages/engine/src/skills/devtools-skills.ts`):
   `project.detect`, `project.tree`, `code.search`, `git.status`, `git.diff`,
   `git.log` (all `safe` — reads), and `git.add`, `git.commit`,
   `build.configure`, `build.run`, `test.run`, `code.write`, `code.edit` (all
   `confirm`). Build/test execution is the closest thing this catalog has run
   to arbitrary developer-authored code — an npm script or a CMake rule can do
   anything — so it starts conservative rather than reasoning its way to
   `safe` the way `app.open` eventually did; a candidate for the same audit
   Phase 12's "invisible safety" note already flags, once it has real use
   behind it.
3. **The loop itself** (`packages/engine/src/devagent/loop.ts` +
   `skills/devagent-skill.ts`, one new skill: `devagent.run`). Understand →
   inspect → act → observe → verify → continue/finish, bounded at
   **`MAX_DEV_ITERATIONS = 12`** (the same shape as `attemptGoal`'s
   `MAX_ATTEMPTS`, just sized for a real multi-step task rather than one
   skill's strategy ladder). Every iteration: build a prompt from the goal,
   the project folder, a catalog filtered to **only** the
   `project`/`git`/`build`/`test`/`code`/`files` domains, and a compact log of
   what already happened; ask Cortex for exactly one next action as strict
   JSON; validate it against the registry; run it as a one-step `Plan` through
   the **same `Executor.run`** every other plan in this engine uses — so
   guard, confirm, risk and the content policy all apply unchanged, and this
   loop adds no second door to action. Stops and says why on: the goal
   reported done, the step budget running out, Cortex not being connected, two
   malformed replies in a row, the exact same failed call being proposed
   again (never retried — the "avoid repeating identical failures" requirement
   this phase asked for), or the user declining a confirm-tier step (ends the
   whole task immediately, matching `Executor.run`'s own rule for declining
   within a plan).
4. **A `ctest` tool** was added to the dispatch enum specifically because
   CMake projects test via `ctest`, not `cmake --build --target test` — Nova
   Engine (this phase's own worked example) already uses it, per
   [[nova-engine]].

**Reused, not rebuilt:** the skill registry, `Executor` (a second instance,
same `skills`, same risk/guard/confirm/content-policy pipeline — not a
competing one), the `Plan`/`SkillContext` shapes, the allowed-folders list
(every devtools path check goes through `allowed_folders::is_permitted`, so
`D:\Dev` — widened in Phase 3 — is what makes this phase's own worked example
reachable at all), and the exact promise-wrapping `Engine.planWithAI` already
used for a one-shot AI plan, extended here to run in a loop instead of once.

**Verified:** `pnpm -r typecheck` (9 packages), root `eslint .` clean, `cargo
clippy --lib --no-deps` clean on the new file, **506 TS tests** (17 new: 14 in
`devtools-skills.test.ts` against a scripted `Platform`, plus `devagent.test.ts`
exercising the loop's real contract — a step actually reaches the real
executor, a repeated failure is refused without re-running, a skill outside
the allowed domains is never invoked even when proposed, a decline ends the
task, the budget is never exceeded — against a real `SkillRegistry` and
`Executor`, not a mocked one), **92 Rust tests** (15 new — git porcelain
parsing including a path containing a colon, ripgrep line parsing, project
detection against a real temp folder including the pnpm-over-npm preference,
the dependency-folder skip list, and the shell-metacharacter rejection the
npm/pnpm `cmd.exe` path depends on).

⚠️ **Not built, and not a placeholder — deferred honestly:**

- **MSBuild/`vswhere`.** Visual Studio's build tooling needs locating the
  install via `vswhere.exe` before it can be invoked at all, which is a real
  extra module, not a line in the dispatch table. cmake/cargo/npm/pnpm/
  dotnet/make/ctest/pytest cover this phase's own worked example (Nova
  Engine, CMake) and a wide swath of ordinary projects; MSBuild is next if a
  `.sln`-only project actually comes up.
- **A real background project index / streaming build output.** `run_devtool`
  is request/response — it waits for the whole build or test run to finish
  and returns the captured (size-capped) stdout/stderr, the same shape every
  other Rust command on this port already has. A long build blocks that one
  call; nothing here streams partial output the way Phase 4's provider
  streaming does for a chat reply. Worth revisiting if a real build turns out
  to run long enough for that to matter in practice.
- **`cargo build --bin`/`--target`, `dotnet build` project selection, `make`
  without a `Makefile` at the exact root.** The dispatch table covers the
  ordinary case of each tool; multi-binary or multi-project layouts need a
  richer argument shape than one validated string slot, deliberately not
  guessed at here.
- **Clicked through in the real app.** Verified by type checking, linting,
  and both test suites — not by building the bundle and watching
  `devagent.run` actually fix a real build error end to end. See
  [[verify-in-the-real-app]]: this is real-test-verified, not
  human-verified, same caveat Phase 12 carried at first. The npm/pnpm
  `cmd.exe /C` path in particular has never run against a real npm project on
  this machine — it follows documented Windows `CreateProcess` behavior
  (`.cmd` files need `cmd.exe` as their interpreter) but hasn't been watched
  build something real.

---

## Phase 14 — Cloud model providers + conversation streaming (2026-09-11)

**Brandon's brief:** upgrade voice/chat conversation quality — better context,
streaming, error handling — and add *optional* cloud model support
(OpenAI-compatible/Anthropic/Gemini, "Custom Provider" required) behind
proper secret storage and a clear Nova/Atlas disclosure. Explicitly not
required, and explicitly not allowed to touch Atlas's coding tools, desktop
skills, or permissions — conversation and execution stay separate, the same
line Decision 4 (`docs/ATLAS_INTEGRATION.md`, Cortex's repo) already drew.

**This reverses a binding decision, deliberately, on Brandon's own
instruction.** Phase 4 (2026-08-23) deleted Claude/ChatGPT and built
`no-other-cloud-ai.test.ts` specifically to keep a second cloud provider from
coming back "in good faith by someone who did not know the rule." That rule
was never wrong for what it was guarding against then; it is superseded now
because the person who set it is the one asking for the opposite, explicitly,
with the same safeguards this file names moved into the new design instead of
dropped. The guard test is not deleted — it's rewritten
(`cloud-providers-stay-opt-in.test.ts`) to check the new invariants: Cortex
still registers unconditionally, a cloud provider exists only because a
person configured one, and an API key can never reach `storage.json`.

**Built:**

1. **Cortex now streams** (`D:\Dev\Cortex`: `backends.py`, `conversation.py`,
   `server.py`). `OllamaBackend.ask_stream` reads Ollama's own NDJSON stream
   token-by-token; `ThinkingFilter` strips a `<think>` block that arrives
   split across chunks (with a `flush()` for the trailing text `feed` alone
   would otherwise hold back forever — a real bug, caught by its own test);
   `ConversationEngine.process_message_stream` yields `StreamChunk`s then one
   final `ConversationResponse`, degrading to a single chunk for a backend
   that can't stream; `POST /v1/ask/stream` on the server is Server-Sent
   Events, additive alongside the unchanged `/v1/ask`. **Verified against the
   real running stack** — `curl` against a live Cortex + Ollama + qwen3.5:9b
   produced real token-by-token deltas ending in a `done` event carrying the
   complete, correctly-assembled answer.
2. **Atlas consumes it for real** (`intelligence.rs::ask_cortex_stream` +
   `consume_cortex_sse`, `providers.ts::streamCortex`). A new Tauri command
   opens the SSE response, forwards each delta as an
   `atlas://intelligence/{streamId}` event, and resolves with the complete
   text once Cortex's own `done` event says so — the same "the promise stays
   the source of truth" shape the old (deleted) Claude/OpenAI streaming code
   used, rebuilt here for Cortex. `createCortexProvider`'s `ask()` now always
   takes this path.
3. **A secure secret store that didn't exist before**
   (`apps/desktop/src-tauri/src/secrets.rs`): Windows Credential Manager
   (`CredWriteW`/`CredReadW`/`CredDeleteW`), zero new dependencies — the
   `windows` crate already in this project. `read_secret` is deliberately
   **not** a `#[tauri::command]`; the only caller is `cloud_intelligence.rs`,
   and there is no path back to the renderer at all, not even transiently.
4. **Three real cloud backends, one abstraction**
   (`apps/desktop/src-tauri/src/cloud_intelligence.rs`): `OpenaiCompatible`
   (covers OpenAI, Kimi/Moonshot, and "Custom Provider" — one wire format,
   distinguished only by `baseUrl`), `Anthropic`, `Gemini`. Non-streaming,
   deliberately — see the module's own doc for why this pass stops at
   "correct and foundational" rather than also streaming three providers at
   once. Every error path is built from the *response*, never the request, so
   a key can never appear in a message shown to the user.
5. **Settings → Intelligence → Cloud Models**
   (`apps/web/src/pages/settings/intelligence/CloudProviders.tsx`): add a
   provider (five presets, all resolving to the three real kinds), enable/
   disable, test connection, choose which one is "in use," remove — and the
   required disclosure, shown before anyone has even added a provider:
   *"Nova does not provide, pay for, include, or maintain subscriptions or
   API access for these cloud AI providers…"* Config (kind/label/model/
   `baseUrl`/`enabled`) goes through the existing plain-JSON `Storage` port,
   the same `MemoryStore`-backed pattern `cortex-settings.ts` already used;
   the key never does.
6. **`IntelligenceRegistry` needed no changes at all** — it already supported
   multiple `.register()` calls and `setActive(id)`; only `useAtlas.ts`
   gained a loop over a new `cloudProviders` prop, registered *after* Cortex,
   never instead of it.

**Reused, not rebuilt:** `IntelligenceProvider`/`ProviderStreamHandlers`
(cloud providers are non-streaming today, so `ask()` just never calls
`onDelta` — `Engine.converseWithProvider` already degrades cleanly, unchanged
since the day it was written for exactly this reason), `SimpleIntelligenceRegistry`,
the `MemoryStore`/`Fact` settings pattern, and the `windows` crate already
vendored for every other native surface in this crate.

**Verified:** Python — 60 new/updated tests across `test_streaming.py` (19),
`test_server.py` (+4), all passing, plus the full existing Cortex suite (102
total) green; a real end-to-end `curl` against live Ollama. Rust — `cargo
check`/`clippy` clean, **99 tests** (22 new: 3 `secrets.rs`, 12
`cloud_intelligence.rs`, 6 `intelligence.rs` streaming/parsing, 1 `ctest`
serialization). TypeScript — `pnpm -r typecheck`/`lint` clean, **412 tests**
(10 new in `cloud-providers-stay-opt-in.test.ts`, replacing the 4 the old
guard had).

⚠️ **A real, unrelated bug found and fixed along the way, worth recording
because it's exactly what Brandon asked about**: Ollama's own Windows app had
`D:\Ollama Models` (missing a backslash) saved as its models path — not an
Atlas or `OLLAMA_MODELS` env-var problem, a typo in Ollama's own settings
database (`%LOCALAPPDATA%\Ollama\db.sqlite`, `settings.models` column) — so
it was silently falling back to `C:\Users\Brandon\.ollama\models` and had
already put 6.6 GB — the same `qwen3.5:9b` already correctly sitting under
`D:\Ollama\Models` — half-duplicated there as 3.5 GB. Fixed by editing that
one field directly (Ollama was stopped first) and confirmed by relaunch: no
more "models path not accessible" warning, `ollama list` reads from `D:`.
**The stray 3.5 GB on `C:` was deliberately left alone** — not this session's
call to delete. Also confirmed while investigating: this machine's RX 7800 XT
is already doing real GPU inference for Ollama (ROCm 7.1, all 34/34 layers of
qwen3.5:9b offloaded) — no WSL2, nothing further needed.

⚠️ **Deferred, not built as a placeholder:**

- **Cloud provider streaming.** `ask()` calls `onDone` once; see
  `cloud_intelligence.rs`'s module doc. Adding it is a change to that file
  alone — the abstraction and the TS-side degrade-cleanly path are both
  already in place.
- **A model upgrade.** Brandon chose to keep `qwen3.5:9b` rather than also
  pull `gpt-oss:20b` this pass, specifically to keep this phase's scope to
  streaming + the provider foundation. The VRAM headroom for it is confirmed
  real (16 GB card, ~4.9 GB used by qwen3.5:9b today).
- **Clicked through in the real app.** Verified by the real Cortex+Ollama
  stack directly (the Python/HTTP layer) and by type checking, linting and
  both test suites on the Atlas side — not by building the bundle and
  watching Settings → Intelligence → Cloud Models actually save a key, test a
  real OpenAI/Anthropic/Gemini account, and hold a streamed Cortex
  conversation inside the running app. See [[verify-in-the-real-app]].

---

## Ideas from product feedback (Brandon, 2026-09-08) — not yet phased

Five directions raised together in one conversation, ranging from "partly
built already" to "a real architectural decision nobody's made yet." None of
this was acted on the day it was raised — each is substantial enough to
deserve its own decision before code starts, the same way every other
"Decision (Brandon, …)" in this file was made before its phase began. Recorded
here so the reasoning survives to whichever session picks one up, numbered as
they were raised (there was no "4").

### 1. Goal understanding — generalizing what already exists

The request: "Open Fortnite" should mean *get Fortnite running*, tried through
several relevant approaches in order, rather than either a single fixed
strategy or an unbounded search. That is not a proposal for new
architecture — it is `attemptGoal()` (`planner/attempts.ts`), built for
`app.open` already: a small, ordered, skill-declared strategy list, each entry
relevant to that skill's own purpose by construction, that stops the instant
one *commits* (takes a real action) rather than trying the rest. It is
explicitly not a general retry loop or "let Atlas improvise" — see that
file's own module doc, which draws exactly the "check known locations, try
the launcher, try the shortcut" vs. "randomly search the PC, try unrelated
things" line this feedback draws independently.

What's real and undecided is generalizing it *beyond* `app.open` — the exact
gap this file already named while Phase 12 was being written (see "Deferred,
and why" just above). The design question isn't "should other skills get
this," it's *which ones*, and what their strategy ladders would actually be:
`files.find` failing an exact match could fall back to a fuzzy one; a web
skill failing a direct fetch could fall back to a search. Each ladder has to
be written deliberately by the skill that owns it, the same way `app.open`'s
was — this is not a mechanism that generalizes itself.

### 2. Context and memory across turns

Two different things are bundled under "memory" here, and they're at very
different distances from done:

- **Referring to what was just shown.** "Open the second one," "the last
  one," bare "it" against a result list — this is `WorkingMemory` and
  `resolveOrdinal`, built in Phase 2 and extended in Phase 12 so a window
  disambiguation card's rows carry the same `actions` an ordinal resolves
  against. If "Find my Atlas project… Open it" doesn't already work, it's
  because `files.find`'s result isn't wired into that same mechanism, not
  because the mechanism doesn't exist — worth checking before assuming this
  needs new infrastructure.
- **Carrying an implicit target forward.** "Open Chrome," then "search for
  Fortnite tournaments" — nothing here refers back to a shown result; it's
  reusing the *subject of a previous command* as a default argument for one
  that's missing it. That's genuinely new: it needs something that remembers
  "the last thing I opened/acted on," separate from `WorkingMemory`'s
  last-shown-list, and a grammar rule willing to consult it only when the
  sentence is otherwise incomplete — never overriding an explicit target.
  Cortex's own repo grew session history and a `ConversationEngine` on
  2026-09-07 (see "Where things stand" above), which is a plausible
  foundation, but it's LLM-context-window memory, not the deterministic kind
  the rest of Atlas's grammar tier relies on — reconciling those two is
  itself a design question.

### 3. A spoken response is not a screen response, read aloud

This is the direct sequel to today's speech-naturalness pass. `prepareForSpeech`
(`@atlas/core`) cleans up *how* the existing message is pronounced — strips
icons, naturalises a path, turns a `·` into a pause — but it is still the same
words, in the same order, that the transcript shows. What's being asked for
here is a different message: "I found 3 matching files in your Downloads
folder." on screen, "Yep, I found three matching files. They're in your
Downloads folder." out loud. That means a skill result would need to carry a
spoken variant, or `Phrasing` would need to generate one — a materially bigger
change than cleanup, because it's rewriting content and length, not
symbols.

The rest of that list sorts into what already exists and what doesn't:

- **Interruption ("stop talking")** partly exists — barge-in
  (`useListening.ts`, `Voice.tsx`'s "Talking over Atlas stops him") already
  stops speech the instant the microphone hears you start talking, while
  listening is on. A typed "stop" while Atlas is mid-sentence and the mic is
  off is a different, smaller, and currently unbuilt path.
- **Faster response start** is already a designed property of the speech
  pipeline specifically — `segmentForSpeech` ships the first sentence the
  moment it's ready rather than waiting on the whole reply, and Kokoro's
  engine stays warm for exactly this reason (see `kokoro.rs`'s module doc).
  What is *not* fast yet is the reply text itself when a request needs
  Cortex — that's item 5, below.
- **Natural response lengths, better follow-ups, context awareness** overlap
  heavily with item 2 and with whatever "spoken variant" ends up meaning —
  worth deciding together rather than separately.
- **Natural silence** wasn't concrete enough here to scope; worth a real
  example the next time this comes up.

### 5. Response tiers — acknowledge, then work

"Sure." → does the thing → "Discord's open." The instant/working/finished/
needs-clarification/needs-confirmation split described here is a good
description of states the executor and `ExecutionMode` already model
internally (a plan is safe, consequential, or blocked; a step is running or
done) — what doesn't exist is surfacing an *early*, separate acknowledgement
before a skill's `run()` resolves, rather than one message after it. Today
`io.say` fires once, synchronously, with the result. An instant "Sure." would
mean the executor speaking *before* invoking a skill, for requests where doing
so is honest — never for one where "sure" would be a promise the subsequent
attempt might not keep. That "never" is the real design work: which requests
get a pre-ack, and how that interacts with Plan First's up-front approval,
which already shows the whole plan before anything runs specifically so
approval is never split across two moments.

### 6. Invisible safety — already the direction; no new decision needed today

This one isn't a request for new work so much as an endorsement of a decision
already made and dated in this file: "risk is consequence, never input
method" (2026-09-07, above; §6.6 of `ARCHITECTURE.md`), and the same day's fix
making a disambiguation card check the guard before it ever renders one. The
concrete next step in this direction, whenever it's picked up, is auditing
whether any of the skills still marked `confirm` are actually gated by
*mechanism* rather than *consequence* the way raw input used to be — not a big
lift, but a real one, and worth doing deliberately rather than by hunting.

### 7. Multi-step, app-specific chains (Brandon, 2026-09-10) — three separate gaps, not one

> **Update 2026-09-19:** the second gap below is partly closed — chains of any
> length now split, and a named browser is carried into the site step. What
> remains is the third gap: clauses whose target only exists in live UI state.

The concrete test case: *"Open Discord on Brave, go to the Nova server, and
start a call in the Hangout voice channel."* Asked directly rather than
guessed at from feedback, so recorded slightly differently from 1–6 above,
but it's the same kind of thing — three already-named gaps meeting in one
sentence, not a new capability to design from scratch:

- **No named-browser targeting.** `platform.openUrl` (`platform.rs`) opens
  an http(s) URL through `open::that_detached`, which is the OS's *default*
  handler — there is no "open this URL in Brave specifically" today. If
  Brave isn't the default browser, "on Brave" cannot be honoured at all; if
  it is, saying so is redundant. A real fix needs a skill that resolves
  "Brave" against `listApps()` the way `app.open` already does, then either
  launches it with the URL as an argument or launches it first and calls
  `openUrl` while the resolved app is what's in front — a small, real
  design question, not a placeholder.
- **The grammar chains at most two clauses, each independently complete.**
  `COMPOUND_CONNECTOR` (`grammar.ts`) splits on one "and"/"and then" and
  requires *both* halves to match a grammar rule standing alone — "go to the
  Nova server" and "start a call in the Hangout channel" have no such rule
  and never will, because which server and which channel depends on what
  Discord actually renders at that moment, not on fixed phrasing.
- **That's item 3 from "Deferred, and why" (Phase 12, above) by another
  name: an autonomous observe-and-replan loop.** "Go to the Nova server"
  means *read the UI Automation tree, find the element that says Nova among
  however many servers are listed, click it* — and the same again for the
  voice channel. `attemptGoal()` doesn't generalize to this (it's a
  same-skill retry ladder, not a look-then-act cycle), and building it means
  deciding an iteration budget and what happens when nothing matches, the
  same open questions that deferred it the first time. It also means the
  AI-plan path actually carrying out a multi-step plan against *live,
  re-observed* state rather than a fixed sequence decided once up front —
  which depends on Cortex being capable of that kind of reasoning at all;
  untested against anything this specific as of tonight.

Today's honest answer, asked of the app directly rather than inferred:
keyboard/mouse control and UI Automation are real and verified (Phase 12,
clicked through against the real desktop) for *named, one-shot* targets —
closing a window, typing into a focused field, pressing a hotkey. A chain
that requires finding a specific server and a specific channel inside
another application's own UI, live, is the gap above, and doesn't exist yet.

---

## Versioning

**Decision (2026-08-19): when Phase 8 — Voice ships, the version goes to
0.5.0, at minimum. ✅ Taken on 2026-08-21**, once both halves of Voice were
built — Atlas speaks and listens, which is the "something a user can feel"
the decision was waiting for.

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
| `apps/desktop/src-tauri/tauri.conf.json` | Authoritative. Feeds `getVersion()`, which is what Settings → About actually displays, and names the installer (now `Atlas_0.5.0_x64-setup.exe`). |
| `apps/desktop/src-tauri/Cargo.toml` | The crate version. |
| `apps/desktop/package.json` | Keeps the workspace honest. |

The root `package.json` stays at `0.0.0` — it is a private workspace root and
is not a shipped artifact.

Nothing reads the version at runtime beyond the About screen, so this is a
rename, not a migration. Do it as its own commit, so `git log` has one place
that says when and why the number changed.

`Cargo.lock` moves too — it records the crate's own version, so it is part of
the same commit rather than a stray diff in the next one.

**2026-09-10: 0.85.0.** What it marks: three new Phase 11 skill packs
(Environment, Storage — see that phase's own table), Phase 3's first two
pieces (the conversation transcript surviving a restart, and the
allowed-folders list widening past `%USERPROFILE%`), Cortex actually
remembering a conversation across turns now that `/v1/ask` answers through
its `ConversationEngine`, and the Nova product switcher finished and given a
full-screen "View all" view. Same three files, same reasoning: a lot to feel
in one sitting, not a quiet renumber.

---

## Toward 1.0.0 — settings copy, and the reachability debt (2026-09-17)

Two lists. The first is Brandon's, from reading the settings screens. The
second is what an honest audit of "can Atlas actually do what it says"
turned up — the fixed half is already done and described below it.

### 1. Settings copy that promises too much

The problem with all three is the same: they are written as permanent
guarantees about the future, and the future is not ours to promise. A
statement that stops being true is worse than a weaker one that stays true.

- **Account → "Atlas does not need an account"** — and the body's "all of it
  runs signed out, **and always will**." Today's truth is that nothing
  requires an account. "Always will" is a forward promise about a product
  that has barely shipped. Rewrite as a present-tense fact about what is
  true now, not a vow.
- **Account → "Your memory stays here"** — "Atlas does not sync what it
  remembers about you, signed in or not." Same shape, and this one is
  likelier to change: sync is a reasonable thing to want, and the paragraph
  currently forecloses it in the user's mind. Say what is true today, and say
  that if it ever changes it will be something you turn on, never something
  that happens because an account exists.
- **Intelligence → "it needs no account or key"** (Cortex) is fine and
  factual. The page around it is not: it presents Cortex, cloud providers and
  the "nothing above is required" footnote as three peers, and it reads as
  unfinished because **Brandon is undecided whether Cortex stays at all** —
  [[Nova Intelligence]] may replace the Navigator Engine's reasoning layer.
  Do not restructure this page until that decision is made; rewriting it
  twice is worse than leaving it once. The decision is the blocker, not the
  markup.

### 2. What Atlas says it can do, versus what it can

Audited 2026-09-17 by sweeping every skill's advertised `examples` against
the grammar, and by running the live Rust tests against this machine.

**The native layer is real.** All 21 live tests pass against real hardware:
the mouse really moves (`GetCursorPos` measured after `SendInput`), keys
really fire, the UI Automation tree really walks the foreground window, the
screen really captures to a real PNG, windows really enumerate. Nothing in
`platform.rs`, `input.rs`, `uia.rs`, `window.rs` or `screen.rs` is a stub.

**What was not real was the reachability.** A capability you cannot ask for
does not exist, and 24 of the phrasings Atlas *prints to the user as
examples* reached nothing. The intended route for those was the AI planner —
but Atlas is built to be fully useful with no provider connected, and on this
machine Cortex is switched on with nothing listening on its port. So the
rule, now enforced by `advertised-examples.test.ts`: **the AI tier may make a
phrasing better understood; it may never be the only thing that makes a
documented one work.**

Fixed in this pass:

| Was broken | Now |
|---|---|
| Store/UWP apps invisible — "open Calculator" failed, as did Settings, Paint, Photos, Snipping Tool, Terminal, Clock, Camera, Sticky Notes, Mail, Maps | `shell:AppsFolder` enumerated via COM; **56 more apps**, 226 → 282 |
| Mouse unreachable: no rule for click, move or drag | `click at 500, 300`, `right-click at …`, `double click at …`, `move the mouse to …`, `drag from … to …` |
| The whole `uia.*` pack unreachable — and its examples named controls ("the save button") that the skills could not accept, since they only took the numeric path `uia.tree` prints | Skills take a `control` **name**, resolved against a freshly-read tree (exact → automationId → access-key-stripped → contains, enabled first). Grammar for activate/expand/collapse/set/type-into |
| `calculate 200 / 8 + 1` understood by nothing, while `200/8+1` worked | A lone `/` between spaces was matching the file-path detector, putting the whole grammar into path-safe mode |
| `where is the mouse` — question-shaped, so filtered out | opted in via `questionSafe` |
| 3 of 4 environment-variable skills unreachable | get / set / delete / deleteSystem all have rules; system scope matched first so it cannot be mistaken for the per-user one |
| `window.move` (both forms) and per-window screenshots unreachable | `move the X window to 0, 0`, `resize the X window to 800 by 600`, `take a screenshot of the X window` |

Still owed, and recorded in the test's own `NOT_YET_REACHABLE` and
`REACHES_ANOTHER_SKILL` lists rather than here, so they cannot rot:

- **Six phrasings need conversational referents** — "format this json",
  "decode this jwt", "most common words in this" all mean *the clipboard*;
  "read that article" means *the last search result*. That is a real feature
  (a notion of what "this" and "that" point at), not a missing regex, which
  is why none of them got a bodged rule. `turn it down a bit` needs a sense
  of degree. `where are my screenshots` is question-shaped and `files.find`
  is not question-safe for it.
- **Five examples reach the wrong skill**, which is worse than reaching none
  — a confident wrong action instead of an honest miss. Two are genuine
  misfires worth fixing before 1.0.0: `open the first result and summarize
  it` goes to `app.open` and hunts for an application called "the first
  result", and `convert 0xff to decimal` is claimed by unit conversion.

Not started, and the honest gap in the "operate any app" story:

- **Finding a control on screen without naming its window.** "click play"
  cannot work today and deliberately does not guess — clicking wherever the
  pointer happens to sit would be worse than not understanding. Doing it
  properly means searching the foreground window's UIA tree by name, which
  the resolver added above already does; what is missing is the decision
  about *which* window, and that is a design question, not a regex.

---

## Deliberately not doing

- **A general `exec`.** Discussed and rejected in ARCHITECTURE §6.1.
- **Cloud sync by default.** Local-first means the local case is the whole
  product, not the offline mode of a server product.
- **An agent that acts unprompted.** Atlas does what you ask. Proactivity in
  Phase 9 means *noticing*, not deciding.
- **Weather, by default.** See Phase 8 — the one exception to "no network
  calls," and only ever opt-in.
