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
are accessories".

**There is exactly one implementation, and it runs on this machine:
Cortex.** `platform/src/providers.ts` calls `ask_cortex` in
`intelligence.rs`, registered through `SimpleIntelligenceRegistry`
(`engine/src/intelligence-registry.ts`).

Until 2026-08-23 there were two — Claude and ChatGPT, posting to
`api.anthropic.com` and `api.openai.com` with a user-supplied key — plus
three more (Local Models, Gemini, Custom Provider) advertised as *Planned*
that did nothing. All five are gone. The reason is the one that removed
Supabase from this project: an assistant that reads your files, watches your
processes and knows your habits should not also hold a credential for
somebody else's datacentre and a habit of posting your questions to it. Every
provider added is a privacy story that has to be defended forever; one local
provider is a story that defends itself.

There is no key field, because there is nothing to authenticate to. The only
stored settings are whether Cortex is on and where it listens
(`data/src/cortex-settings.ts`). `isConfigured()` reports whether the user
switched it *on* — reachability is discovered at call time and reported
through the port's existing `offline` reason, so a stopped service reads as
stopped rather than as a feature nobody set up.

**The endpoint is loopback-only, enforced in Rust.** `validate_base_url`
accepts `127.0.0.1`, `localhost` and `::1` and nothing else, parsing the host
rather than substring-matching it (`localhost.evil.com` is refused). Without
that check, "the Cortex endpoint" would be a settings field that let a
request go anywhere — precisely the cloud fallback this was rewritten to
remove. `no-other-cloud-ai.test.ts` scans every source file in the repo for
cloud hostnames and for the removed symbols, so the guarantee is checked
rather than asserted.

Cortex is non-streaming: one request, one complete answer, calling `onDone`
directly and never `onDelta`. `Engine.converseWithProvider` was already
written to degrade cleanly for a provider that never streams, so a real
token-streaming version can replace the Rust side later without the engine
changing.

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
are `safe`; closing a window, ending a process, and every UI-Automation action
or synthesized click/keypress/typed string are `confirm`. The one addition is
that raw input is *uniformly* on the `confirm` side — there is no `safe`
click, because a click can do anything the target application would let a
human at the keyboard do, and there is no way to know in advance which.

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
(`core/ports/intelligence.ts`) is Cortex-only and text-prompt-only — `ask`
has no channel for an image, and Cortex itself has no vision model. Building
a "describe" skill on top of that would have been exactly the kind of
placeholder function this project refuses to ship; it waits for a real
vision-capable provider to exist. See Phase 12 in `ROADMAP.md` for what that
leaves deferred.

---

## 7. Safety

| Rule | Where | Why |
|---|---|---|
| Risky steps ask, every time | `executor.ts` | One approval covers one step, never the session |
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
| The AI endpoint is loopback-only | `intelligence.rs::validate_base_url` | Host is parsed, not substring-matched, so `localhost.evil.com` is refused. Otherwise the endpoint setting is a route off the machine |
| There is exactly one provider, and no key to store | `providers.ts`, `cortex-settings.ts` | A credential Atlas never holds is a credential that cannot leak |
| No other cloud AI, checked by reading the source | `no-other-cloud-ai.test.ts` | A unit test of the registry would pass while a second provider sat in `platform/` waiting to be wired |

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
- **~~API keys are stored in the same plain local JSON file~~ — settled by
  deleting the feature.** This entry used to worry about provider keys
  sitting in the same unencrypted JSON as a theme preference, and proposed
  OS-keychain integration. Removing cloud providers removed the only
  genuinely sensitive value Atlas stored, which settles it better than
  encrypting it would have. Nothing in the preferences file is now more
  sensitive than the rest of it.
- **Atlas has no working model until Cortex serves `/v1/ask`.** The seam is
  real and tested against a fake provider, and the deterministic tiers —
  grammar, planner, small talk, web search — cover everything they always
  did. But an open-ended question with Cortex stopped gets an honest "I can't
  answer that from what's on this machine" rather than an answer. That is the
  accepted cost of the removal, not an oversight.
