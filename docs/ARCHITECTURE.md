# Atlas — Architecture

> A local-first desktop assistant.
> Today: understand, act, and stay on your machine. Tomorrow: memory, routines,
> and awareness of what you're working on.

This document explains **why** Atlas is shaped the way it is. Every decision
below is written with its alternative, because a choice without a rejected
option is just a description.

---

## 1. The thesis

Most assistants are a chat box in front of a language model. That makes them
fluent and unreliable at the same time: fluent because the model is good at
words, unreliable because *everything* — including "open my downloads folder" —
takes a network round trip through a probabilistic system.

Atlas inverts it. **The engine is the product; a model is an optional
accessory.** Commands are recognised by deterministic rules that run in
microseconds, offline, with no chance of a creative misreading. An external
model is consulted only for genuinely novel phrasing, and never for anything the
grammar already understands.

Three consequences shape everything else:

1. **It works with nothing connected.** No account, no key, no network. That
   isn't a degraded mode — it's the normal one. A Nova Account can be added
   (Settings → Account) and is a shell concern: nothing in `core` or `engine`
   knows it exists, no skill consults it, and signing in moves no data in either
   direction. See `apps/web/src/account/novaAccount.ts`.
2. **It's fast in the way that matters.** The common case never pays for the
   rare one.
3. **It's auditable.** Because actions are declared rather than generated, "what
   can this program do to my machine?" has a finite answer.

---

## 2. Principles

1. **Dependencies point inward.** `core` imports nothing. `engine` imports only
   `core`. UI may import anything. Enforced by eslint, not by good intentions.
2. **The domain doesn't know about the framework.** Skills, plans and memory are
   pure TypeScript with no React, no Tauri, no HTTP. That is what lets the same
   engine run in a window, a browser tab, and a test.
3. **Native capability is a port, not a special case.** Skills call
   `platform.openPath(...)`; they never learn which platform they're on.
4. **Capability absence is data, not an exception.** A platform reports what it
   can do; skills needing something absent are *hidden*, not broken.
5. **Every action is declared.** Nothing happens except through a registered
   skill with typed arguments and a risk rating.

---

## 3. Stack

| Layer | Choice | Why | Rejected |
|---|---|---|---|
| **Desktop shell** | **Tauri 2 (Rust)** | The shipped binary is 3.6 MB and the installer builds in minutes. An assistant summoned by a keystroke has to feel instant, and a 150 MB runtime with a Chromium per window cuts directly against that. | Electron — familiar, but the size and memory cost are the exact thing this product can't afford |
| **UI** | React 18 + Vite + Tailwind | The UI is a conversation and two panes; the value is in the engine, so the UI layer should be boring, fast to iterate, and well-understood | A native Rust UI (egui/slint) — smaller still, but every design change becomes a research project |
| **Language (logic)** | TypeScript, `strict` | The engine is the part that must be *correct*, and its bugs are type-shaped: a plan with a bad argument, a skill that doesn't exist | JS — this is precisely the code that benefits from a compiler |
| **Language (system)** | Rust, in `apps/desktop` | File indexing, process enumeration and app launching want a real systems language, and Tauri commands are the natural boundary | Node sidecar — another runtime to ship and supervise |
| **Monorepo** | pnpm + Turborepo | Already in place, and the package boundaries *are* the architecture | A single package — the boundaries would exist only in comments |
| **Tests** | Vitest | Resolves modules exactly as Vite does, so tests import the same graph the app does | `node --test` — needs explicit `.ts` extensions, which fights bundler resolution |
| **Styling** | Tokens → CSS variables → Tailwind | One source of truth for colour and motion, theme switching for free | Hard-coded classes |

### Why not keep Supabase?

The wallpaper product needed a backend because its content came from elsewhere.
An assistant that runs on your machine and reads your files needs the opposite:
**no server at all**. Adding one would create a privacy story to defend for
features nobody asked for. Sync, if it ever arrives, enters through a
repository port the way content did — as an implementation detail behind an
interface.

---

## 4. The shape

```
┌──────────────────────────────────────────────────────────────┐
│  apps/desktop            Tauri 2                             │
│    src-tauri/                                                │
│      lib.rs              window, tray, global shortcut       │
│      platform.rs         the Rust half of the Platform port  │
│                          — validated, narrow, no exec        │
├──────────────────────────────────────────────────────────────┤
│  apps/web                the canonical UI (also runs alone)  │
│    AtlasApp              two screens, no router               │
│    useAtlas              the engine's io, as React state      │
├──────────────────────────────────────────────────────────────┤
│  packages/platform       Platform impls: tauri | web         │
│                          detectPlatform() picks one          │
├──────────────────────────────────────────────────────────────┤
│  packages/engine         bus · registry · grammar            │
│                          planner · executor · kernel         │
│                          depends only on core                │
├──────────────────────────────────────────────────────────────┤
│  packages/core           Skill · Plan · memory               │
│                          ports: Platform, Intelligence       │
│                          depends on NOTHING                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. The pipeline

```
"open steam"
     │
     ▼
┌─────────────┐  deterministic, microseconds, offline.
│ 1. grammar  │  Handles the large majority of real input.
└─────┬───────┘
      │ no match
      ▼
┌─────────────┐  Is this an instruction at all, or a question?
│ 2. triage   │  Questions never reach the planner.
└─────┬───────┘
      │ actionable
      ▼
┌─────────────┐  Only for novel phrasing. Strict JSON.
│ 3. AI plan  │  EVERY step validated against the registry.
└─────┬───────┘
      │
      ▼
┌─────────────┐  Confirms risky steps. Aborts on failure
│  executor   │  or refusal. Never silently continues.
└─────┬───────┘
      ▼
    skills ──▶ Platform ──▶ the machine
```

**Why triage exists.** Without it, "what's the capital of Peru?" reaches a
planner that dutifully hunts for a matching skill. A question is conversation;
only an imperative is worth planning over. It costs one regex and removes an
entire category of absurd behaviour.

**Why an AI plan is all-or-nothing.** If any step fails validation, the whole
plan is discarded and the message falls through to conversation. A
half-understood instruction must never become a half-executed plan.

---

## 6. The three seams

Everything on the roadmap survives because of these.

### 6.1 The Platform port (`core/ports/platform.ts`)

Every reach outside the process goes through one interface. Methods are optional
and `capabilities()` declares what's real, so:

- the **desktop** build gets files, apps, system, processes, windows;
- the **browser** build gets clipboard and notifications, and the engine simply
  *hides* the rest — a web Atlas is honestly smaller rather than subtly broken;
- **tests** get a scripted machine, which is why the engine suite runs in
  milliseconds without touching a disk.

There is deliberately **no `exec(command: string)`**. Atlas can open a path,
reveal a path, launch a *registered* app, and read metadata. Once a general
"run this string" capability exists, no other guarantee on the interface means
anything.

**Reaffirmed 2026-08-21, under exactly the pressure that usually breaks this
rule.** The ask was for Atlas to do "almost everything PowerShell can do,"
which reads at first like a request for a shell. It was settled the other way:
the goal is to *perform the things people use PowerShell for*, as narrow
validated skills — not to run PowerShell. See Phase 11 in `ROADMAP.md`.

The rule does not forbid running a program: `speech.rs` runs piper,
`open_system_tool` runs `taskmgr.exe`. What it forbids is a **variable command
string**. A skill may invoke a fixed executable with a fixed argument shape
whose only variable parts are validated against a closed set. The test is
whether a reader can enumerate everything the program will ever execute — with
`exec` they cannot, and that is the whole difference.

**The tier above `confirm` (added 2026-08-22 with the services group).** The
risk model had two levels and the roadmap's had three: read, confirm, and
*refused outright*. Nothing expressed the third, so the only way to express
"this must not happen" was a confirmation card — which is precisely the
mechanism by which people learn to click through the cards that matter.

`Skill.guard(args)` is that third tier: it returns either `null` or the
sentence explaining why this particular call will not happen. The executor
checks it **before drawing a card**, so no card appears in front of a refusal,
and `SkillRegistry.invoke` checks it again — the same layering the content
policy uses, and for the same reason: the executor is skippable, `invoke` is
not.

A guard is synchronous and sees only the arguments, which for a skill that
resolves a friendly name into a real one means it is judging what the person
typed rather than what it turned out to mean. So a guard is a *pre-empt*, and
the authoritative refusal belongs next to the machine, against the resolved
value — `services.rs` refuses the same set again, and it is the one that
decides. Both exist because they catch different things: "stop rpcss" never
reaches a card, and "stop the remote procedure call service" never reaches
`sc`.

### 6.2 The skill registry (`engine/skills/registry.ts`)

The only door to action. `invoke()` validates arguments against the declared
schema, drops parameters the skill never declared, checks capabilities, and
catches throws. There is no second path — including for plans a model wrote.

Adding a capability is one `register()` call; it becomes available to the
planner, to search, and to help, with no other edit.

### 6.3 The intelligence port (`core/ports/intelligence.ts`)

Providers register, one may be active, and `active()` returning `null` is the
normal supported state. The engine depends on this port but needs nothing from
it — which is the architectural expression of "the engine is the brain, models
are accessories". Nothing about this section gates Atlas's skills, tools, or
execution — `Engine.planWithAI`/`Executor` never ask which provider is
active; they validate a plan against the registry the same way regardless of
who proposed it. A provider is conversation-only, by construction.

**Three kinds of provider, one rule: each is inert until the user turns it on.**
`apps/web/src/atlas/buildIntelligence.ts` is the one place providers are
registered, through `SimpleIntelligenceRegistry`
(`engine/src/intelligence-registry.ts`):

- **Local models** (2026-09-19) run on this machine through Ollama.
  `packages/core/src/models/local-model.ts` is the catalogue — **Qwen3-8B**
  (`qwen3:8b`, the default, everyday conversation, thinking off so a home PC
  answers in seconds), **Qwen3-30B-A3B** (`qwen3:30b`, deeper reasoning) and
  **Qwen3.5-35B** (`qwen3.5:35b`, newest generation, replaced Qwen3-Coder-30B
  2026-09-20). **GPT-OSS 20B** (`gpt-oss:20b`, OpenAI's open-weight model, ~14 GB, added 2026-09-20). The large models are optional ~14–24 GB downloads; nothing assumes a PC can run them.
  Each is its own provider with its own id, and its `ask()` puts *its own*
  Ollama tag on the wire (`apps/web/test/model-routing.test.ts` proves it for
  every model, and through the real `Engine`). Any other model Ollama reports
  is registered too, so what is installed is usable without a code change.
  `platform/src/providers.ts` calls `ask_local_model_stream` in
  `intelligence.rs`, which streams Ollama's `/api/chat` NDJSON and forwards only
  `message.content` as `atlas://intelligence/{streamId}` events — a thinking
  model's reasoning is never shown, stored or logged.
- **Nova Intelligence** is Nova's own from-scratch model, served by its own
  local process (`NovaIntelligence/phase4_nova/server.py`) over a small SSE
  protocol. It is experimental — it continues text but cannot hold a
  conversation or follow instructions yet — and Settings says so.
- **Cloud providers**, below.

There is no key field for the local ones, because there is nothing to
authenticate to; the only stored settings are whether each is on and where it
listens (`data/src/local-ai-settings.ts`). Which provider is in use is
`resolveActiveProviderId` (`core/src/models/local-model.ts`): a pick that still
exists wins; one that does not (a removed cloud provider, an id from an older
version) is treated as no pick, never as a failure; with none, turning local
models on means Qwen3-8B, and with everything off Atlas simply runs on its
own tiers.

**The old Cortex bridge is gone** (2026-09-19). It was a separate Python server
sitting between Atlas and Ollama, speaking a private protocol; Atlas now talks
to Ollama directly. `cloud-providers-stay-opt-in.test.ts` scans the source and
fails if the old bridge's name ever reappears in code.

**Models are the conversation layer, never the control layer.** Nothing in
`intelligence.rs` or `buildIntelligence.ts` can run a command, touch a file or
press a key — `intelligence.rs` carries a test that fails if such code appears
in it, and a guard test checks the registry wiring imports no executor, skill
registry or platform. PowerShell, window control, files, permissions and
confirmations are Atlas's own deterministic skills, which never ask which model
is selected. Choosing a different model changes how Atlas talks and reasons,
never what it may do.

**Zero or more cloud providers may additionally be registered — never
instead of the local models, never without a person configuring one.** Reversed on
2026-09-11, deliberately, on Brandon's own instruction: from 2026-08-23 to
then, one local model really was the only one, Claude/ChatGPT having been deleted for
being an unwanted, always-on privacy story (below). That reasoning wasn't
wrong; it was superseded by the person who set it asking for the opposite —
strong local-first defaults, one opt-in door for someone who wants a cloud
model's quality badly enough to bring their own account. Four things keep the
door narrow:

1. **`CloudProviderKind` is a wire format, not a provider list.**
   `apps/desktop/src-tauri/src/cloud_intelligence.rs` implements exactly
   three request/response shapes — `openai-compatible` (also covers Kimi and
   any "Custom Provider" endpoint; differs only by `baseUrl`), `anthropic`,
   `gemini` — never a general HTTP client. Every error message is built from
   the provider's *response*; none is built from the request, so a key can
   never leak into something shown on screen.
2. **The key never touches `storage.json`, and never comes back to the
   renderer.** `secrets.rs` holds it in Windows Credential Manager
   (`CredWriteW`/`CredReadW`/`CredDeleteW` — the `windows` crate already
   vendored here, no new dependency). `read_secret` isn't a
   `#[tauri::command]` at all; the only caller is `cloud_intelligence.rs`,
   building one outbound request. `CloudProviderConfig` (`@atlas/core`) —
   the shape that *does* go through the plain `Storage` port, alongside
   the local-model settings — has no field that could hold one.
   `cloud-providers-stay-opt-in.test.ts` (below) checks both halves of that
   by reading the source, not by trusting the design.
3. **A cloud provider's `isConfigured()` is that provider's own `enabled`
   flag, the same shape a local model's toggle uses** — adding one doesn't
   activate it, and `SimpleIntelligenceRegistry.active()` already treats a
   registered-but-unconfigured provider as nothing selected.
4. **The required disclosure is shown before anyone has even added a
   provider**, not after: Settings → Intelligence → Cloud Models leads with
   the fact that Nova neither provides nor pays for any of this, and that a
   provider may charge separately under its own terms.

Cloud providers are non-streaming for now (`ask()` calls `onDone` once) —
`Engine.converseWithProvider` already degrades a non-streaming provider
cleanly, the exact property that made streaming a local model a
config-only change rather than an engine rewrite; adding cloud streaming
later is the same shape of change, confined to `cloud_intelligence.rs`.

**The local-model endpoints are loopback-only, enforced in Rust.**
`validate_base_url` accepts `127.0.0.1`, `localhost` and `::1` and nothing
else, parsing the host rather than substring-matching it
(`localhost.evil.com` is refused) — cloud providers are, by contrast,
*meant* to leave the machine, which is the whole reason they need the
disclosure and the Credential Manager guarantee above rather than a loopback
check.

### 6.4 Web search (`platform.rs::web`, `engine/skills/web-search-skills.ts`)

The one deliberate exception to "no network calls" — gated by a `network`
capability the same way disk access is gated by `fs`, so a browser build or a
locked-down environment simply doesn't offer it. Two commands, `web_search`
and `fetch_page`, follow the same narrow-validated-command shape as the rest
of `platform.rs`: no raw "fetch anything with any headers," everything they
return is plain text, and neither executes anything found on a page.

The backend is DuckDuckGo's no-JS HTML results page — no API key, no
account, matching "works with nothing connected." Parsing is isolated in one
function (`parse_search_results`) specifically so it can be swapped for a
different backend (a paid API, a self-hosted SearxNG instance) without
touching anything above it; see §8 for why that may become necessary sooner
than later.

`fetch_page`'s target is untrusted in a way `web_search`'s query isn't — it
can come from a search result Atlas didn't choose — so it gets an extra guard
`web_search` doesn't need: `is_safe_fetch_target` blocks loopback, private,
and link-local addresses, so a manipulated result pointing at
`http://192.168.1.1/` or `http://localhost:PORT/` doesn't get an answer.

The conversational path (`engine/research.ts`) decides *when* to search with
a small keyword heuristic (`needsWebSearch`), not a real model decision —
Atlas doesn't have a tool-calling-capable provider yet (§6.3, §8). That
function is the one thing to replace once it does; nothing else in the
search path depends on how the decision gets made.

### 6.5 Speech — two engines, one seam (`speech.rs`, `kokoro.rs`)

Atlas has two local voices, and the split is worth understanding because they
are opposite architectures serving the same port method.

**piper (`speech.rs`)** spawns `piper.exe` per utterance. Tiny, MIT, RTF
~0.067, and it works the moment the app is installed. It is the default and
the fallback.

**Kokoro (`kokoro.rs`)** is an 82M-parameter model (Apache 2.0) run *in
process* through ONNX Runtime, with espeak-ng for phonemisation — both loaded
at runtime from vendored DLLs, neither linked. It sounds considerably better:
it carries intonation across a whole sentence rather than word by word. It
costs ~163 MB of weights and RTF ~0.15–0.23.

Three decisions hold this together:

1. **The voice id chooses the engine.** There is no engine setting. A voice
   belongs to exactly one engine, so picking a voice is the whole decision and
   a broken pairing cannot be expressed. Refined ids are prefixed `kokoro-`;
   `speech_voices` omits them entirely when the model is not installed, and
   `synthesize_speech` falls back to piper if one is somehow requested anyway.

2. **Kokoro is resident, piper is not.** This follows from the pipeline below:
   a reply is synthesised a sentence at a time, and a per-utterance process
   launch would mean paying the model load four times for a four-sentence
   answer. The session is built once and kept; `kokoro_warm` pays that cost
   when the voice screen opens rather than in front of the first sentence.

3. **A reply is cut into sentences and pipelined** (`core/models/segment.ts`,
   `speech/player.ts`). The first sentence starts playing while the rest is
   still being synthesised, so the wait is the length of one sentence rather
   than of the whole answer. Pieces are *scheduled* on the `AudioContext`
   clock, not chained on `onended` — a main-thread event cannot deliver a seam
   you cannot hear. This is engine-agnostic and is the single largest thing
   making the voice feel responsive; it matters more than which model runs.

⚠️ Two traps are documented at length in `kokoro.rs` because both cost real
debugging: the int8 build of the model is **five times slower** than fp16 on a
CPU without VNNI (which includes every Zen 3 machine), and `resource_dir()`
returns a `\\?\` verbatim path that espeak cannot use — it responded by
calling `exit()` and taking the whole app down with it.

### 6.6 Operating other applications (`window.rs`, `input.rs`, `uia.rs`, `screen.rs`)

Phase 12 (`ROADMAP.md`) added three domains Phase 11's original ten didn't
anticipate: controlling *other* windows on the desktop, synthesizing mouse and
keyboard input, and UI Automation — reading and acting on another app's actual
controls. All three still answer to the rules already established above; this
section records the two decisions that were genuinely new.

**Risk stayed two-tier, and the existing test decided every case.** "Does this
change something closing a window won't undo?" turns out to answer this whole
surface without inventing a third tier: enumerating/inspecting windows,
reading the UI tree, reading what's focused, moving the mouse and scrolling
are `safe`; closing a window and ending a process are `confirm`.

⚠️ **Revised 2026-09-07 — raw input and UI Automation are `safe` too, not
uniformly `confirm`.** The original call here was that a click, a keypress or
typed text could do anything the target application would let a human at the
keyboard do, and there was no way to know in advance which — so every one of
them asked. That reasoning is still true and still the reason Atlas cannot, in
general, assess what a specific click or keystroke will do. What it got wrong
is the conclusion: **input method is not consequence.** `input.click` and
`window.focus` are both "operate something outside Atlas by a mechanism that
could theoretically do anything" — the same shape of uncertainty already
priced into `window.focus`, `window.move` and every other `safe` skill in this
file — yet only the input pack answered it by asking every time. Two things
followed from actually applying the codebase's own test:

- The confirm card this produced was uninformative on its own terms. It can
  only ever show a coordinate or a key name (`phrasing.confirmPrompt` reads
  `skill.description` and the raw args — there is no semantic target to name),
  so a person approving "click at 500, 300" knows exactly as much about the
  consequence as Atlas does: nothing. It wasn't protecting against a bad
  outcome; it was friction in front of "press enter" and "click Save" that
  happened to also sit in front of the rare bad case, indistinguishably.
- The actual protection against something destructive was never the input
  layer's confirm card — it was always the *named* skill for that thing.
  `window.close`, `files.delete`, `system.emptyRecycleBin`,
  `system.endProcess` are unchanged by this revision and remain `confirm`;
  they are what "delete", "empty the recycle bin", "shut down" and "end a
  process that would lose work" actually route to, regardless of whether
  Atlas reaches them through a Rust command or, one day, a UI Automation
  click on the same button by hand.

So `input.click`, `input.drag`, `input.pressKey`, `input.hotkey`,
`input.typeText`, and every UI Automation action (`uia.invoke`, `expand`,
`collapse`, `setValue`, `typeInto`) are now `safe` — mechanisms, not a
consequence category of their own. The one case that needed a real answer
rather than a blanket default: **Alt+F4 closes the foreground application**,
the identical consequence `window.close` already gates, just reached by a
keystroke instead of an API call. Making the whole `input.hotkey` skill ask
again to cover one combination would reintroduce exactly the friction this
revision removes, so instead `Skill.riskFor?(args): SkillRisk | undefined`
(`packages/core/src/models/skill.ts`) lets a skill escalate risk for a
*specific* call while staying `safe` in general — `input.hotkey`'s
implementation normalizes case and modifier order and treats only that one
combination as `confirm`. The executor checks `riskFor` ahead of the static
`risk` at all three places risk is read (the per-step gate, and both of Plan
First's checks — whether a plan needs an upfront card at all, and which of
its steps that card marks with a warning), through one shared
`effectiveRisk()` helper, so the three can never drift into disagreeing about
which steps count.

No general per-call risk engine follows from this: `riskFor` exists for a
skill whose mechanism is usually safe but has one well-known, statically
checkable equivalent of an already-gated named action — not for guessing at
what an arbitrary UI Automation target or screen coordinate does, which
remains genuinely impossible without a vision-capable provider Atlas does not
have (see the OCR/`screen.describe` note below). That residual is accepted,
consciously, the same way a human operator you hand a keyboard to is trusted
not to need "are you sure?" before every keystroke.

**An element is addressed as a path, never held as a live pointer.**
`window.rs` already re-resolves a window handle by id on every call, checked
with `IsWindow`, because a window can close between being listed and being
acted on. `uia.rs` extends the same discipline to something a COM pointer
can't do at all — cross the IPC boundary — by addressing a UI Automation
element as the sequence of child indices from its window's root (`UiaNode.path`
in `core/models/uia.ts`). Every action re-walks that path fresh from the root
immediately before acting, and fails cleanly ("that part of the window has
changed") if the shape underneath no longer matches, rather than acting on
whatever happens to be there now. `uia.typeInto` tries `ValuePattern` first
and falls back to focusing the element plus `input.rs`'s keystrokes only when
the control doesn't support direct entry — the "API → UIA → input" preference
order expressed as one skill instead of three the caller has to sequence.

⚠️ **No local OCR, no pixel-level vision, and no cloud "describe the screen"
skill.** `screen.rs` captures real pixels (GDI `BitBlt`/`PrintWindow`, encoded
to PNG), but "understanding" what's in them is deliberately left to UI
Automation's bounding rectangles, which already say what and where a control
is more reliably than pixel guessing would. A vision-based `screen.describe`
was planned and then dropped once it became clear the intelligence port
(`core/ports/intelligence.ts`) is text-prompt-only — `ask`
has no channel for an image, and the local models are text models. Building
a "describe" skill on top of that would have been exactly the kind of
placeholder function this project refuses to ship; it waits for a real
vision-capable provider to exist. See Phase 12 in `ROADMAP.md` for what that
leaves deferred.

### 6.7 The developer agent (`devtools.rs`, `devagent/loop.ts`)

Phase 13 (`ROADMAP.md`) is what lets Atlas be asked to inspect a project, find
a build error, fix it, rebuild, and run the tests — the same "execute →
observe → replan" shape §6.6 named as deferred, deliberately narrowed to
something an iteration budget can actually reason about: every observation
here is *text* a build or a search produced, never a UI Automation tree or a
screen coordinate.

**`run_devtool` is the sharpest instance yet of the rule that opens this
document's §6.1.** `tool` is a closed enum naming one fixed executable and
subcommand shape; `arg` is the only variable part, and it is either checked
against real project state (an npm script must be a key `package.json`
already has) or restricted to an injection-inert character set. The one
documented exception: npm and pnpm ship as `.cmd` files on Windows, which
`CreateProcess` cannot launch directly, so those two alone route through
`cmd.exe /C` — the reason the script-name slot is validated twice rather than
once. See `devtools.rs`'s module doc for the full reasoning.

**The agent loop adds no second door to action.** Each iteration asks the selected model
for exactly one next step, validates it against the registry exactly like
`planWithAI` does, and runs it through a second `Executor` instance built from
the *same* `SkillRegistry` — so guard, confirm, risk and the content policy
all apply to a dev-agent step exactly as they do to any other plan. What is
genuinely new is bounding the *loop*, not the step: `MAX_DEV_ITERATIONS`
(mirroring `attemptGoal`'s `MAX_ATTEMPTS`, sized for a real task rather than
one skill's ladder), a fixed set of domains a step may touch
(`project`/`git`/`build`/`code`/`test`/`files` — the model cannot steer it into
`os.*` just because that domain exists elsewhere in the catalog), and a rule
that the identical failed call is never retried — proposing it again ends the
task with an explanation rather than spinning.

Build and test execution starts at `confirm`, not `safe` — the one place this
phase chose caution over the precedent `app.open` eventually set (§7's "risk
is consequence, never mechanism" table), because an npm script or a CMake
rule is the closest thing this catalog has ever run to arbitrary
developer-authored code. Worth revisiting with real use behind it, the same
way input's blanket `confirm` was.

---

### 6.8 Bulk changes: preview, one approval, a journal, an undo (`Skill.preview`, `organize-skills.ts`)

"Clean up my Downloads" is two hundred moves. The per-step safety model was
built for one action at a time, and stretched over a batch it gives two bad
answers: two hundred confirmation cards (which teaches people to hold Enter), or
one card that says "downloads" (which asks for approval of something neither
side can see). This is the pattern that replaces both, and it is the template
for every bulk capability that follows.

```
request → grammar → files.organize
            ├─ preview()        read-only: list, classify, plan     ← no card yet
            ├─ ONE card         the actual list of moves            ← the approval
            ├─ run()            re-derives the plan, checks the fingerprint,
            │                   moves, journalling as it goes
            └─ files.undo       reads the journal, previews, puts it back
```

**`Skill.preview(args, ctx)` is a read-only hook the executor calls instead of
the generic prompt.** It returns `ask` (detail text for the card, plus a
fingerprint), `nothing` (no card at all — a question with no consequence is how
people learn to click through the ones that matter), or `refuse`. Contract: it
may list and compute; it must never change anything, because it is the one hook
that runs *before* the person has said yes. That is enforced by review and by
tests over a fake disk that count every mutating call, not by the type.

**An approval is for the list that was shown.** `run` rebuilds the plan and
compares its fingerprint with `ctx.approvedPreview`; if a file arrived or left
in the seconds between the card and the click, nothing moves and Atlas says why.
A stale approval is a different action from the one consented to.

**Never softened.** Do It mode and Allowed-Folder preapproval were agreed for one
file at a time. A skill with a `preview` always shows it and always asks, in every
mode, and `PREAPPROVABLE_PATH_ARGS` is pinned not to contain these skills.

**The journal (`atlas.file-journal`, Storage port).** Every batch is recorded
*as it happens* — flushed every twenty moves, not only at the end — so a run that
dies at file 300 is still reportable and undoable. It keeps the last 20 batches,
never loses a batch by marking it undone (history says what happened, including
that), and a journal write failing never undoes a move that already landed.

**Undo reverses what it can and says what it can't.** Each move is re-checked:
gone from where Atlas put it, or something new sitting in its old place, and it is
left alone and counted. Undo never overwrites. A partly finished undo stays open
and remembers what it already restored, so a second "undo that" resumes.
Folders Atlas created are left in place, empty — Atlas does not delete folders on
its own initiative.

**What the organizer will not do, on purpose.** It has *no delete in it* — "ask me
before deleting anything" is satisfied the strong way, by there being no version of
a tidy-up that removes anything. It moves loose files only, never folders, never
recursing (a project directory in Downloads is one unit). It leaves alone what it
doesn't recognise, rather than inventing an "Other" junk drawer, and counts it on
the card. It skips unfinished downloads (`.crdownload`, `.part`…) and anything
modified in the last two minutes — half a download filed as an installer is a
corrupt installer. A name clash becomes `name (2).ext`; nothing is overwritten.
A clause it cannot follow ("gibberish in Stuff") refuses the whole request rather
than carrying out the half it understood.

**Every single-file skill is journaled too (`withFileJournal`).** The single-file skills
(`files.move`, `rename`, `copy`, `create`, `createFolder`, `delete`, `append`) are wrapped at
registration, so each successful one lands in the same journal — the skills stay ignorant of
it, only fire after the change has really happened, and a journal that fails to write never
turns a finished move into an error. Only `move` and `rename` are pure reversals and can be
undone. The rest are recorded (so "what did you just change" is true) but carry a
`cannotUndo` sentence, because undoing a create or a copy means deleting something and a
recycle-bin delete can only be reversed from the bin, which Atlas cannot reach. **"Undo that"
means the newest change, of any kind** — never "the newest one that happens to be undoable":
if the last thing done was a delete, it says so rather than quietly reversing an older move
nobody meant.

**`move_path_to(from, to)`** (`platform.rs`) exists because `move_path` keeps the
source's file name and so cannot express the `(2)` rename. Both ends are checked
against the allowed folders (the destination by its parent, since it does not yet
exist), a destination that is not a bare name is refused, and it never overwrites.
It is covered by the halt sweep like every other acting command.

**`storage.emptyFolder` is the second consumer** — its card used to say only the
folder's name and now lists what is about to go to the recycle bin.

### 6.9 Atlas Watch: wait for something, then carry on (`watch/manager.ts`, `watch/conditions.ts`, `watch-skills.ts`)

"Watch this download." "Let me know when OBS closes." "When this build finishes, run
the tests, package it, and open the result." A watch is a **condition** Atlas can read
off the machine, an optional **continuation** of validated plan steps, and the
**approval** the person gave for exactly those steps.

**Conditions are a closed set of reads.** `process-exits`, `process-starts`,
`downloads-finish`, `path-exists`, `online`, `after`. Each one is checked with a Platform
call Atlas already had (`runningProcesses`, `listDir`, `pathInfo`, `networkReachable`),
every few seconds, only while an active watch exists. A probe that throws counts as "not
yet". It never counts as "it happened". `watch.create` resolves the condition against the
machine while the person is still there to answer: "the build" becomes whichever of cargo,
MSBuild, dotnet, CMake, Ninja or make is running (it asks if there are several), "OBS"
becomes `obs64.exe` (`text/processes.ts`), and "this download" becomes the `.crdownload` /
`.part` files in Downloads right now. Watching something that isn't running is refused
with the fix ("if you mean when it starts, say …").

**The continuation is understood up front and approved once.** The "then …" text goes
through `Engine.planFor`: the same grammar tiers `ask` uses, then the AI planner. Nothing
runs at that point. The steps are validated, a project folder is asked for once if the steps
need one, and the result goes on one card: *When: … Then: 1, 2, 3. Approving now lets these
steps run when it happens, even if you're away.* `devagent.run`, `uiagent.run`, power
actions and the watch controls themselves are refused as continuation steps. An open-ended
agent choosing its own next steps is exactly what should not run unattended.

**Only what was approved runs without a card.** The approval is `fingerprintSteps(steps)`
(FNV-1a over canonical JSON). Each continuation step runs as its own one-step plan through
`Engine.run(plan, io, { approvedStep })`, and `ExecutorOptions.approvedStep` skips the
generic confirmation only when the step matches an approved one exactly and the stored steps
still hash to the approval. It never skips a `guard`, the content policy, or a `Skill.preview`
card. A bulk skill's list is read at run time, and nobody has seen it yet. That kind of step,
and any card at all during an unattended run, puts the watch into **awaiting-approval**: a
notification, a line in the conversation, and a question on the watch in Settings → Watches.
Nothing more runs until it's answered. There is no `clarify` while the person is away, so a
step that needs a choice stops and says so rather than guessing.

**Crashes, shutdowns and restarts.** Watches are stored (`atlas.watches`, local storage, no
account and no server) and restored at launch. The recovery rules:

| Found on restart | What Atlas does |
| --- | --- |
| Past its expiry | Marked **expired**. It never fires, and the startup note says so. |
| Steps no longer hash to the approval (edited on disk) | Marked **failed**. Nothing runs. |
| A step still marked `started` | That step was mid-flight when Atlas stopped, so there's no way to know whether it happened. **Asks**: run it again, treat it as done, or cancel. It never repeats it blind. Each step is written `started` *before* it runs and `done`/`failed` after, and that ordering is what makes this answerable. |
| Stopped cleanly between steps | Continues with the next approved step, and says so. |
| Active, and the condition is now true | Depends on the kind of fact. A **state** (the download's file is there, the path exists, the app is running, the network is up) is acted on, and the startup note says it resumed. An **event** ("cargo exited") seen across a gap may be a reboot rather than a finished build, so Atlas **asks** instead of acting. A timer is trusted only if it's at most five minutes late. See `reliableAfterGap`. |
| Waiting for the person | Still waiting. A card that was up before the restart asks again with the details as they are now, never the stale ones. |

The first thing Atlas says after a restart is one line naming every watch it picked up and
its state. The same states are always visible in Settings → Watches: active, paused, running
its steps, waiting for you, done, stopped, expired, cancelled. That page shows each step's
state and the log, and it can pause, resume, cancel and delete.

**The emergency stop pauses every watch** (`WatchManager.haltAll`), including one running its
steps. The step in flight is aborted by the engine's own halt and stays `started`, so resuming
asks about it rather than assuming. Nothing resumes by itself. A revoked allowed folder or a
missing capability fails the step the ordinary way, because every step goes through the
registry and the Rust-side checks exactly as a typed request would.

**Lifetime.** Default 24 hours, maximum 7 days. Finished watches are kept for the list (the
newest 30), and a live one is never dropped.

### 6.10 Setups: act, then verify, then report what was verified (`setup/runner.ts`, `setup-skills.ts`)

"Get my PC ready for recording" should end with *"Recording setup complete. OBS is running,
Shure MV7+ is your microphone, 347 GB free on D:, and Discord is on the left."* Every clause
there is a reading taken after the action. None of them is a note that something was clicked.

**A setup is a saved list of `SetupItem`s**, a closed set: `open`, `close`, `place` (a
window's position), `mic` (optionally the one it should be), `storage` (a drive and a
minimum), `online`. Each kind is an action paired with the check that proves it worked.

**Unknown goal → ask, don't guess.** The first time a setup is named, `setup.run` asks five
short questions (what to open, what to close, whether to check the mic, where to check
space, where to put windows), offering what's actually there: the real default mic by name,
the real drives with their free space. Then one card shows the whole setup: save and run?
"Get my PC ready" with no goal asks "ready for what?" and offers the saved names. An inline
spec ("… for streaming: open OBS, close Chrome") skips the questions, and anything it can't
read is repeated back rather than saved as a guess (`setup/spec.ts`).

**Cards only when something closes.** Opening, arranging and checking are all `safe`, so a
known setup with nothing to close runs straight away (`SkillPreview` kind `proceed`, added for
this). If it would close something, the card lists which apps and how many windows. `run`
re-reads the machine and refuses if the list changed after the card was shown (Chrome opened
in between), so an approval only ever closes what it listed.

**Order:** close → open (then wait, up to 90 s, for each process to actually appear; games
are slow) → place (once a window exists, then re-read where it landed) → mic, space and
internet. Opening and placing go through the executor as ordinary `app.open` /
`window.place` steps. Closing is done window by window under the setup's own card, the
one-card-per-batch rule from §6.8. The report lists what didn't work first ("⚠️ Fortnite
didn't start within 90 seconds"), then what did, and never claims a check it didn't make.

**The microphone is read, never set.** `audio.rs` reads the default capture and render
devices' friendly names through `IMMDeviceEnumerator`. Changing the default has no documented
API (`IPolicyConfig` is undocumented), so a wrong mic is reported with a pointer to Sound
settings. A virtual device (SteelSeries Sonar, Voicemeeter, Wave Link) is named as one, since
the physical mic sits behind it.

Setups are in `atlas.setups` and editable in Settings → Setups, which uses the same parser as
the conversation. A setup can also be a watch's continuation ("when Fortnite updates, get
ready for recording"). It then stops at its card like any preview step.

## 7. Safety

| Rule | Where | Why |
|---|---|---|
| Risky steps ask, every time | `executor.ts` | One approval covers one step, never the session |
| Risk is consequence, never input method | `Skill.risk`, `Skill.riskFor` | A click, a keypress and typed text are mechanisms; `input.*`/`uia.*` are `safe` like everything else that reaches outside Atlas without changing something closing a window won't undo |
| Alt+F4 still confirms, however it's spelled | `input-skills.ts::isCloseAppHotkey` | Closes the foreground app — the same consequence `window.close` gates — reached by a keystroke instead of an API call |
| A refusal ends the plan | `executor.ts` | Continuing after "no" is the most alarming thing an agent can do |
| A failure stops what follows | `executor.ts` | Step two against nothing is worse than stopping |
| Paths must sit under the user's home | `platform.rs` | The renderer is web content — the least trusted part of the app. A path from it is a claim, not a fact |
| Apps launch by registered id | `platform.rs` | "One of these known apps" ≠ "whatever string I'm given" |
| http(s) links only | both | Otherwise `file://` reopens the door the path checks closed |
| The index reads names, never contents | `platform.rs` | Better matching isn't worth the entire privacy story |
| Only the user's own folders | `platform.rs` | An index that quietly grew to `C:\` is a different product |
| Tauri capabilities allow-list | `capabilities/default.json` | Tauri 2 denies by default; the grant is short and contains no shell permission |
| Network calls happen in Rust, never as a webview `fetch()` | `web.rs` | Outside the CSP entirely; same narrow-command shape as everything else |
| `fetch_page` refuses loopback/private/link-local targets | `web.rs::is_safe_fetch_target` | A manipulated search result shouldn't be able to make Atlas probe the user's own LAN |
| Retrieved page content is framed as untrusted reference material, never instructions | `engine/research.ts` | The whole security boundary for what a search result or fetched page can make Atlas do: read it, never obey it |
| The local-model endpoints are loopback-only | `intelligence.rs::validate_base_url` | Host is parsed, not substring-matched, so `localhost.evil.com` is refused. Otherwise the endpoint setting is a route off the machine |
| Local models need no key; a cloud provider's key never reaches `storage.json` or the renderer | `providers.ts`, `local-ai-settings.ts`, `secrets.rs` | A credential Atlas doesn't hold in the open is a credential that can't leak from there |
| A cloud provider exists only because a person configured one, checked by reading the source | `cloud-providers-stay-opt-in.test.ts` | A unit test of the registry would pass while a hard-coded provider sat in `useAtlas.ts` waiting to be activated |
| `run_devtool` takes a closed enum, never a command string | `devtools.rs::DevTool` | A reader can enumerate every program the developer agent will ever run |
| A dev-agent step may only touch `project`/`git`/`build`/`code`/`test`/`files` | `devagent/loop.ts::DEV_AGENT_DOMAINS` | The model proposes each step; it cannot steer the loop into `os.*` or `service.*` just because they exist in the wider catalog |
| Every command that acts checks the stop first | `halt.rs::check`, enforced by `every_command_that_acts_refuses_while_halted` | The guarantee is only as good as the command that forgot; a source sweep fails the build instead of the field |
| The stop needs nothing from the engine, the model or the webview | `halt.rs` | It is those that are being stopped — see §7a |
| Storage keys are lowercase, swept repo-wide | `storage.rs::is_valid_key`, `every_storage_key_literal_in_the_repo_is_one_storage_accepts` | A capital letter is refused silently: `storage_set` errors into a log and `storage_get` reads back as "never saved". It cost three settings before the sweep existed |

---

### 7a. The emergency stop — what it does and does not promise

The stop (`F8` by default, rebindable in Settings → General) is the one control
that has to work when everything else is busy, wedged, or wrong. It is worth
being exact about what "stop" means, because it means two different things and
only one of them is absolute.

**Promise 1 — Atlas issues no new actions. This one is absolute.**

`halt.rs` owns it, deliberately *below* the engine, the planner, the model and
the chat UI. A stop routed through any of those would be a *request* to stop,
handled by the machinery you are trying to stop. Instead:

- The latch is an `AtomicBool`, set in sub-millisecond time, and
  `Halt::check()` sits in front of **every** command that touches the machine
  — typing, clicking, dragging, launching, writing, renaming, deleting,
  killing a process, spending money at a cloud provider, even speaking. A
  command the webview had *already dispatched* still refuses, because the
  refusal happens in the shell after the message arrives, not in the renderer
  before it is sent.
- Queued steps cannot begin. The executor unwinds through `untilHalted`, so a
  plan abandons whatever it was waiting on — a confirm card nobody answered, a
  model that never replied, a step ignoring its signal — rather than waiting
  for it to finish. And if the renderer were somehow to send the next step
  anyway, the shell would refuse it: two independent guarantees, not one.
- **Cancellation does not depend on the AI or the chat UI.** No model is
  consulted, no engine method is awaited, and a wedged or crashed webview
  changes nothing: the key is registered by a dedicated Win32 thread of its
  own, and every gate is in the process that owns the hands. The on-screen
  stop button takes the identical path (`halt_now`), so the two can never
  disagree about what stopping means.
- Which commands are exempt — and why each one is — is not a matter of
  discipline. `every_command_that_acts_refuses_while_halted` reads the source
  of every `#[tauri::command]` in the shell and fails the build if a new one
  acts without checking. The exemptions are reads, Atlas's own window,
  Settings controls the *person* operates, and the stop's own controls, which
  must work precisely while halted.

The one thing this promise does *not* cover: an action already delivered to
Windows. A single synthetic input is one `SendInput` batch, queued atomically,
and nothing can recall events the OS already has. The stop point for input is
therefore *between* actions — which is exactly where the latch sits.

**Promise 2 — a process Atlas started is terminated. This one is weaker, and
differently shaped.**

Stopping Atlas from *issuing* actions is instant and complete. Terminating
something already running is neither, because the process is not Atlas:

| | Stopping Atlas's own actions | Terminating an external process |
|---|---|---|
| Mechanism | An atomic latch checked before each action | Ctrl+C on the process's own console, then `TerminateJobObject` |
| Timing | Immediate — the next action never starts | Up to `GRACEFUL_WINDOW` (400 ms), then forced |
| Completeness | Total: nothing further is issued | The process is gone, grandchildren included (Job Object) |
| Side effects | None — the action never happened | **Whatever it already wrote stays written** |

That last row is the distinction that matters. A halted `pnpm build` stops
building; the files it had already emitted are still on disk, and a half-written
one stays half-written. A halted `git commit` may already have committed.
**Halting stops Atlas from doing more. It does not undo.** Nothing in Atlas
rolls back, and nothing claims to.

Ctrl+C first rather than straight to termination because that is how `cargo`,
`node` and `pytest` expect to be interrupted — they clean up their own
temporary state given the chance. A process that has not begun exiting within
400 ms is not going to, so the whole Job Object goes, which is what takes
`cmd → pnpm → node → workers` down together instead of orphaning three of them.

**Idle is a no-op, on purpose.**

The stop key is registered system-wide: while Atlas runs, that key is swallowed
in every application. So a press with nothing to stop does nothing at all — no
latch, no "halted" banner, no window pulled in front of what you were doing. A
control that exists to prevent interruptions must not become one. The shell
cannot work this out alone (a plan mid-flight, an open confirm card and a model
being waited on are all renderer state), so the surface reports it through
`halt.setWorking`, and the shell ORs that with its own supervised-process list.
Both can only fail towards "the key still works": a stale `true` costs an
idle press that halts, which is simply the old behaviour, and a renderer that
hung or crashed mid-run is covered by the process list regardless of what it
last said.

While Atlas *is* working, the key is global in the full sense — it fires
whichever application has focus, which is the entire point when Atlas is
driving a window that is not its own.
---

## 7b. Context: attachments, captures and screen sharing

### An attachment is a reference

Attaching a file records **what you pointed at** — path, name, kind, size — and
nothing else. It is never read on attach. That single rule is what lets a 4 GB
video and a `.pdf` both be attachable without either producing nonsense, and
what keeps `files.readText`'s 256 KB cap a real limit rather than one the newer
feature quietly routes around.

Reading is a separate, deliberate action: the "Add contents" button on the chip,
offered only where `extractionStateFor` says text can honestly be produced. A
format with no extractor is labelled as such **before** you send — a PDF says
"text not extractable yet", which is a gap being worked on, rather than
"unsupported", which is a shrug. `EXTRACTION_NOT_BUILT_YET` names those formats
specifically so the gap stays visible instead of dissolving into a default.

Because the attachment is a path, every file skill Atlas already has applies to
it without a model being involved at all: `files.move`, `files.info`,
`files.peek`, `files.readText`.

⚠️ **Picking a file does not widen the allowed-folders boundary.** `readTextFile`
still refuses a path outside it, and the chip says so and points at Settings.
Treating an OS picker as a per-file grant would be defensible — that is how
every other application treats it — but it is a real loosening of the boundary
every file command shares, so it is a decision to take on purpose rather than as
a side effect of adding an attach button.

### Screen sharing is repeated stills, and says so

There is no video pipeline here. A share is a `BitBlt` of the chosen target
every ~1.5 s, through the same path `screen.capture` has always used. That is
the honest shape of what `screen.rs` can do, and it is enough for "look at this
error", where the screen is not moving. It is not called a frame rate anywhere.

`capture_display` was added for it: `capture_screen` takes the whole virtual
desktop in one image, which is right for a screenshot and wrong for sharing —
on a multi-monitor machine it hands over the monitor nobody chose.

Consent is the feature, and it is expressed in the UI rather than in a setting:

- nothing starts without an explicit pick of an explicit target;
- the status bar is visible for as long as the share runs, and shows the live
  frame — a bar that says "sharing" and shows nothing asks to be trusted; one
  that shows the frame proves it, and catches the wrong-monitor mistake;
- every control **reduces** what Atlas can see. "Share something else" reopens
  the picker rather than cycling, so a share can never silently become a share
  of something different;
- pausing stops capturing rather than freezing a preview over a live feed;
- **the emergency stop pauses a share.** "Stop everything" has to include the
  one thing Atlas does on a timer. Paused rather than stopped, so it is
  recoverable in one click — revoking the choice outright is harsher than the
  key promises.

### Nothing can see the images, and nothing pretends to

`IntelligenceProvider.ask` takes a string. The local models are text models. The cloud
providers in `cloud_intelligence.rs` post a text-only body. **There is therefore
no send path for a capture to travel down**, and this is a property of the code
rather than a policy: a screenshot is shown, it is a referent for Atlas's own
skills, and it stays on the machine.

`VisionContext` / `VisionProvider` in `models/attachment.ts` declare the seam a
vision provider would implement, so it is typed rather than imagined.
`isLocal()` is on the interface deliberately: the first vision provider Atlas
accepts is intended to be a local one (Nova Intelligence), and a surface can
refuse a remote implementation by reading one field instead of every caller
remembering the rule.

---

## 7c. Activity: observable actions, never reasoning

The expandable panel beside "Searching the web ▸" shows **what Atlas did to the
world**: the query it sent, the hosts that answered, the folder it walked, the
file it read. Every entry corresponds to something that happened outside the
process.

It is deliberately not a thinking-out-loud channel, and the data model has no
field one could arrive in — no plan under consideration, no hypothesis, no
intermediate tokens. `every activity event carries no channel for reasoning` in
`activity.test.ts` asserts the exact key set, so adding one is a conversation
rather than a commit.

The reason is as much product as privacy: a panel that mixes "searched
Microsoft's docs for this error" with "I wonder whether they meant…" trains
people to read speculation as fact.

Mechanically: the executor reports each step's life to `onActivity`, the engine
republishes on the bus as `activity:step`, and the surface renders. A skill can
report its own sub-steps through `ctx.activity` — one level of nesting, because
two is deeper than anyone reads. A step is announced as `running` only once
every gate in front of it has passed, so a step you are still being *asked*
about never shows as already under way.

---

## 8. Decisions worth revisiting

Honest uncertainty, recorded rather than buried:

- **Ctrl+Space as the summon key** is free on most systems but not all. It should
  become configurable before anyone else uses this.
- **Start-menu scraping for the app list** finds what the user can already see,
  which is the right privacy posture, but misses Store apps.
- **No persistence yet.** Memory models exist in `core`; nothing writes them.
  That's Phase 2, and the storage port should land before the first feature that
  wants it, not after.
- **The web build is a real target or it isn't.** Right now it's a useful test
  bed and a graceful fallback. If it's never going to be a product, the honest
  move is to say so and delete the branch in `detectPlatform()`.
- **DuckDuckGo's HTML endpoint is scraped, not an API — confirmed fragile
  during development, not just in theory.** It answered a real request with a
  literal CAPTCHA ("select all squares containing a duck") after a handful of
  requests in a short window. Atlas recognises that page and reports it
  honestly rather than returning an empty result list, but the underlying
  reliability question is real: a user who searches often enough in a
  session may hit it. `parse_search_results` and `is_anomaly_challenge` are
  isolated specifically so a more reliable backend — a self-hosted SearxNG
  instance, or an optional user-provided API key for a paid search API — can
  replace it without the rest of the search path changing. Worth revisiting
  once real usage shows how often it actually bites.
- **`needsWebSearch` is a keyword heuristic standing in for a real decision.**
  It works for the phrasings it was built for ("latest," "current," "news," …)
  and will both over-trigger (a question that happens to contain "today" but
  needs no search) and under-trigger (a stale-info question with no freshness
  word) versus what a model given real tool-calling could decide. Replacing it
  is Phase 4's job, once a provider exists that can request tool calls itself
  — see `research.ts`'s own doc comment for the exact seam.
- **~~API keys are stored in the same plain local JSON file~~ — settled twice
  now, differently each time.** This entry used to worry about provider keys
  sitting in the same unencrypted JSON as a theme preference, and proposed
  OS-keychain integration; deleting cloud providers entirely (2026-08-23)
  settled it by removing the only sensitive value Atlas stored. Cloud
  providers came back on 2026-09-11 with the keychain integration this entry
  originally proposed actually built: Windows Credential Manager
  (`secrets.rs`), not `storage.json` — see §6.3. Nothing in the preferences
  file is more sensitive than the rest of it today for the same reason as
  before; this time because the sensitive value lives somewhere else
  entirely, not because it doesn't exist.
- **Atlas has no working model until a local model is installed and Ollama is running.** The seam is
  real and tested against a fake provider, and the deterministic tiers —
  grammar, planner, small talk, web search — cover everything they always
  did. But an open-ended question with no model running gets an honest "I can't
  answer that from what's on this machine" rather than an answer. That is the
  accepted cost of the removal, not an oversight.
