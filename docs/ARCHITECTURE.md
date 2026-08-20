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
   isn't a degraded mode — it's the normal one.
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

Two real, working implementations exist: Claude and ChatGPT
(`platform/src/providers.ts`, calling `ask_claude`/`ask_openai` in
`intelligence.rs`), registered through `SimpleIntelligenceRegistry`
(`engine/src/intelligence-registry.ts`) — the concrete registry the port
described but nothing implemented before this. Both are bring-your-own-key:
Atlas never pays for or supplies API access, and Settings → Developer says so
explicitly. Keys are stored through the same `Storage` port as everything
else (`data/src/provider-keys.ts`) — one local JSON file, not a separate
encrypted keychain; see §8. `active()` treats a selected-but-unconfigured
provider (a key removed after being chosen) as no provider at all, so the
engine's offline path handles it correctly without a separate check anywhere
else.

Both providers are non-streaming: one request, one complete answer, calling
`onDone` directly and never `onDelta`. `Engine.converseWithProvider` was
already written to degrade cleanly for a provider that never streams, so a
real token-streaming version can replace the Rust side later without the
engine changing.

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
| API keys never enter the webview's own network stack | `intelligence.rs` | Same reasoning as web search — the request (and the key on it) goes out from Rust, never a webview `fetch()` |
| A provider is bring-your-own-key, always | `Developer.tsx`, disclaimer text | Atlas never pays for or supplies AI access — stated on the same screen that collects the key, not buried in a ToS |

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
- **API keys are stored in the same plain local JSON file as everything
  else, not an OS keychain.** Reasonable for a personal, single-user local
  app, and consistent with how the rest of Atlas's settings already work —
  but a key is more sensitive than a theme preference, and this file has no
  special protection beyond normal filesystem permissions. Worth revisiting
  with real OS-keychain integration (Windows Credential Manager, macOS
  Keychain) if this app is ever used somewhere that bar matters more.
- **Claude and ChatGPT integrations were never tested against the real
  Anthropic/OpenAI APIs — no API keys were available during development.**
  Request/response handling is covered by unit tests against fixtures built
  from each provider's documented API shape (`intelligence.rs`'s test
  module), the same rigor as `web_search`'s tests, but unlike `web_search`
  (which *was* verified live against the real DuckDuckGo — see the entry
  above) there is no equivalent live proof here yet. Model ids
  (`claude-3-5-sonnet-20241022`, `gpt-4o-mini`) are hardcoded and will need
  updating as providers retire old snapshots. First real use should
  double-check both.
