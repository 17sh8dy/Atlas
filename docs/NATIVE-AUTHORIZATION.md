# Native authorization — design (tier A implemented; see SECURITY-HARDENING-2.0.md)

Status: **design for review**, written 2026-10-14 on `atlas-2.0`. Nothing here is built. It answers
one question: *how should Atlas make persistent, sensitive changes need a decision that a
compromised renderer cannot make for the person?*

## 1. Where the trust boundary actually is

Atlas's safety story reads "the engine asks before it acts". The facts that matter for this design:

1. **The engine runs in the renderer.** The grammar, planner, executor, risk model and the
   confirmation cards are TypeScript in the webview. A confirmation is a UI element.
2. **Native commands are the real capability surface.** Rust exposes ~300 `#[tauri::command]`s.
   Tauri 2 capability files do not restrict an app's own commands, so any script running in the
   webview can call any of them directly, without going through the executor.
3. **What native code enforces today** is narrow and structural: paths must sit in Allowed Folders,
   `run_devtool` takes a closed enum, a halt latches below the engine, the model endpoint is
   loopback-only, a SearXNG address is validated. None of it is a *consent*: it constrains what a
   call may name, not whether the person agreed to the change.
4. **The renderer's only barrier is the CSP** (`script-src 'self'`, no inline script, no eval) and
   the usual supply-chain care. If script runs there, every command above is callable.

So an assessment of "is the confirmation card a security boundary?" is: against a *compromised
renderer*, no. It is a boundary against *the model and against mistakes*, which is its job. This
document is about the other threat.

## 2. What a compromised renderer can do today

Grouped by consequence (command names from `lib.rs`; the list is a sample, the categories are the point):

| Class | Examples | Native check today | Persistent? |
|---|---|---|---|
| **Trust changes** | `add_allowed_folder`, `save_secret`, `delete_secret`, `searxng_configure`, `storage_set` of trust-bearing keys, `ask_cloud_provider` with a chosen base URL | validation of the value only | **Yes** |
| File changes | `create_file`, `delete_path`, `move_path`, `write_text` | path ∈ Allowed Folders | Yes (on disk) |
| Input synthesis | `mouse_click`, `type_text`, `hotkey`, `press_key` | halt latch; protected-target guard | No |
| Process / system | `run_devtool` (closed enum), service, power, environment | per-command validation | Mixed |
| Network egress | `fetch_page`, `web_search_with`, cloud commands | private-address guard on fetch | No |
| Updater | `updater_*` | https + SHA-256 + policy | Yes |

Two findings that shape the design:

- **`storage_set` is a bypass for any per-command gate.** It writes arbitrary `atlas.*` keys from
  the renderer. `atlas.allowed-folders`, `atlas.halt-shortcut` and `atlas.searxng-endpoint` are
  read natively at startup, so a write there takes effect on the next launch with no command that
  is "the" place to ask. The preferences that decide which model is used, which cloud base URL is
  trusted, the execution mode, and what is enabled (`atlas.preferences`) are read by the renderer
  and shape the engine it builds.
- **Destructive file operations are not gated by consent natively.** Allowed Folders limits
  *where*; the card limits *whether*, in the renderer.

## 3. Goals and non-goals

Goals
- A change to **what Atlas is trusted to reach or use** (folders, secrets, network endpoints,
  providers, updater policy, the stop key) needs an answer from the person that **renderer code
  cannot give**.
- The question is built **natively** from validated fields, so a renderer cannot word it
  misleadingly.
- Ordinary use is unaffected: nothing here appears while someone chats, runs tasks, or approves
  actions under their execution mode.

Non-goals
- Protecting against an attacker who already controls the person's OS session (UI Automation can
  click a native dialog; Windows gives no process-level answer to that).
- Replacing the executor's confirmations. This is **additional** and orthogonal to the four modes.
- Gating reads, or ordinary per-step actions inside Allowed Folders.

## 4. Mechanism

**A native consent step, owned by Rust, called from inside the commands that need it.**

- `tauri-plugin-dialog` is already in the tree and already registered (`lib.rs`, allow-open only
  for the renderer). Rust can show a blocking message dialog itself
  (`app.dialog().message(…).kind(Warning).buttons(YesNo).blocking_show()`); the renderer has no
  permission to drive it and cannot read its result. **No new dependency.**
- `consent::require(app, Request) -> Result<(), String>` is called **inside** the command, before
  it changes anything. If the answer is no, a timeout, or the app is halted, the command returns
  an error and nothing changed. There is no token for the renderer to forge, because the renderer
  is never asked to supply proof of consent: the command itself asks.
- The dialog text is generated in Rust from the canonicalised arguments ("Let Atlas use
  `D:\Dev\Projects` and everything inside it?", "Send your searches to `searx.example.org`
  (the internet, over https)?"). Renderer-supplied strings are never shown as the question.
- **One dialog at a time; no stacking.** After a refusal there is a cool-down; three refusals
  within a short window lock the commands for a few minutes with a quiet notice in Settings. A
  compromised renderer therefore cannot spam the person into agreeing.
- **F8 / halt dismisses and denies** any open consent request.
- A request is shown at most as often as the person is plausibly acting: Settings controls that
  the person is operating are the only normal source. A request with no preceding Settings
  interaction is itself a signal (see §7).

### What it covers (tier A — recommended)

| Change | Where | Question shows |
|---|---|---|
| Add an Allowed Folder | `add_allowed_folder` | the canonical path |
| Save or delete a provider secret | `save_secret`, `delete_secret` | the provider name (never the secret) |
| Set a SearXNG address, or confirm a private network | `searxng_configure` | scheme, host, reach class |
| Add or change a cloud provider's base URL, or enable it | new `provider_configure` | host and that queries leave the PC |
| Change the stop key | halt shortcut command | the new key |
| Write a trust-bearing storage key | `storage_set` | refused: see below |
| Install an update | `updater_install` | version and source (already person-initiated; optional) |

### Closing the `storage_set` bypass

Move trust-bearing state out of the generic store:

1. Define `TRUST_KEYS` in Rust (`atlas.allowed-folders`, `atlas.searxng-endpoint`,
   `atlas.halt-shortcut`, and the preference facts that choose providers and base URLs).
2. `storage_set`/`storage_remove` **refuse** those keys. Each has exactly one dedicated command,
   and that command calls `consent::require`.
3. A source sweep test (the same shape as the halt and storage-key sweeps) fails the build if a
   `TRUST_KEYS` literal is written through the generic path.

The preferences blob (`atlas.preferences`) mixes harmless facts (theme-like) with trust-bearing
ones; it needs splitting, which is the largest piece of work in this design.

### Tier B — not recommended yet, recorded for completeness

A native *session grant* for destructive file operations ("let Atlas delete inside `D:\Dev` until
you quit"). It would make Allowed Folders a consent rather than just a scope, but it adds a
second approval path beside the executor's, and a dialog per destructive batch is real friction.
Revisit only if tier A lands and the remaining exposure is judged unacceptable.

## 5. Interaction with what exists

- **Execution modes** are untouched. Do It +, Plan First, etc. decide when an *action* asks;
  native consent decides whether a *trust change* happens at all.
- **The executor/task kernel** never needs to know. Tier A commands are not skills the executor
  runs; they are Settings operations.
- **Halt:** consent dialogs are part of what F8 ends.
- **Allowed Folders default** (`%USERPROFILE%`) is unchanged.

## 6. Tests and acceptance

- Per command: with consent denied (stubbed), nothing changed; with timeout, nothing changed;
  with approval, the change is exactly the canonical value shown.
- Sweep: every command in the tier A list calls `consent::require`; no `TRUST_KEYS` literal is
  written via `storage_set`.
- Rate limit: three denials lock; lock expires; a halt denies an open request.
- Text: the question is built from canonical fields (tests assert a hostile Unicode or very long
  path is shown safely truncated, never as a spoofed second line).
- Real-app check: drive Settings, confirm the native dialog appears and a simulated renderer call
  with no Settings interaction gets the same dialog (not a silent change).

## 7. Residual risk, stated plainly

- **Dialog fatigue and timing.** A compromised renderer can raise a request when the person is
  expecting some dialog. Mitigation is the rate limit, the native wording, and the fact that the
  question is about a *durable* change, not a routine one. It is not a guarantee.
- **Same-user automation** can click the dialog. Out of scope (non-goal above).
- **Tier A does not stop** a compromised renderer from using already-granted reach: it can still
  call file commands inside existing Allowed Folders, synthesize input, or use `fetch_page`
  (including as a data-exfiltration channel of a few hundred characters per call). It stops it
  from *widening* that reach or *redirecting* trust without the person.
- **Supply-chain compromise of the renderer's dependencies** remains the more likely route to
  needing this at all; keeping the CSP strict and the dependency set small is the first line.

## 8. Phasing

1. Inventory and `TRUST_KEYS` + sweep test (no behaviour change; fails the build on drift).
2. `consent` module + dedicated commands for allowed folders, secrets, SearXNG (smallest set).
3. Split the preferences blob; move provider/base-URL facts behind `provider_configure`.
4. Rate limit, halt integration, real-app verification.

## 9. Decisions for the owner

1. Is "durable trust changes need a native yes" the right line, or should some tier B protection
   (destructive file ops) be in scope for 2.0?
2. Accept the friction of a dialog on **every** Allowed Folder addition and provider change?
3. Is splitting `atlas.preferences` acceptable as a migration (one-time, reversible)?
