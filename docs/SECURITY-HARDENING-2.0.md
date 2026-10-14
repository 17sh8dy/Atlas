# Security hardening for Atlas 2.0 — what was built, what is left

Status: **implemented on `atlas-2.0`, 2026-10-14, local commits only** (nothing pushed, tagged or
released). Follows `NATIVE-AUTHORIZATION.md` (the design, tier A) and
`NATIVE-AUTHORIZATION-INVENTORY.md` (the inventory and findings this answers).

The one-sentence version: **Atlas's own state, the places a saved key may go, and the question
"may Atlas reach further?" are now decided by the Rust side and, where it is the person's call,
by the person, in a Windows box the webview can neither write nor answer.** It is **not** a
defence against a fully compromised webview (see §7).

## 1. Stage 1 — Atlas's own folders (`protected_paths.rs`)

`allowed_folders::is_permitted` — the one gate every file command passes through — now also
refuses anything that **resolves** inside:

- `%APPDATA%\dev.atlas.assistant` (`storage.json`, plugins folder),
- `%LOCALAPPDATA%\dev.atlas.assistant` (downloaded updates, WebView data),
- the running program's folder, and the default per-user install folders
  (`%LOCALAPPDATA%\Atlas`, `%LOCALAPPDATA%\Programs\Atlas`).

How it is decided (not by string prefix):

| Bypass attempt | Handled by |
|---|---|
| `..` segments, `\\?\` and short (8.3) names | canonicalised before comparing |
| junction or symlink pointing in | resolved by canonicalisation; tested with a real `mklink /J` |
| hard link to `storage.json` under another name | the file's other names are enumerated (`FindFirstFileNameW`) and any inside a protected folder refuses it; tested with a real hard link |
| case (`DEV.ATLAS.ASSISTANT`) | component-wise, case-insensitive comparison |
| `dev.atlas.assistant-evil` sibling | whole-component comparison, not `starts_with` on text |
| rename/move/delete of the *parent* (`AppData\Roaming`, or the home folder) | `is_permitted_to_change` refuses a path that **contains** a protected folder; used by `rename_path`, `move_path`, `move_path_to`, `delete_path` |
| a folder that does not exist yet (the updates folder before the first download) | nearest existing ancestor is canonicalised and the rest appended |
| saving the data folder as an Allowed Folder, or a poisoned saved list | `add_allowed_folder` refuses it; `init` drops such entries from the saved list |
| search walking into it | the file index skips protected folders; `probe_path` answers "No such path." |

Plugins: `plugin_manifests` and `open_plugins_folder` compute the plugins folder natively and
never took a renderer path, so they are unchanged; a person still drops files there with
Explorer. There is deliberately no *renderer-callable* way to write into it.

**Limits (stated, not hidden).** A check-then-use race (a junction created between the check and
the operation) is not closable with path-based APIs; a program running as the same Windows user
(including `run_powershell`, below) is outside this gate entirely.

## 2. Stage 2 — cloud destination binding (`provider_bindings.rs`)

`ask_cloud_provider(providerId, model, prompt)` and `test_cloud_provider(providerId, model)` no
longer take `kind` or `baseUrl`. The destination comes from a **native table** keyed by provider
id; an id with no entry is refused, and so is any `search-*` id (the Tavily key can never be
sent to a model endpoint). Each request re-validates the stored address: https, or plain http to
this machine only; no link-local, unspecified or multicast addresses (the cloud-metadata
address); no embedded user name, query or fragment. Requests never follow redirects. The
webview-supplied `baseUrl` is simply not an input (tested in the real app: a request that
supplied one was delivered to the bound address).

## 3. Stage 3 — native consent (`consent.rs`)

A Windows message box, raised and read by Rust. Asks before: adding or removing an Allowed
Folder; saving or deleting a credential; setting or clearing the SearXNG address; adding a cloud
provider (one question covers address + key); moving a provider's destination; changing the stop
key. **Does not ask** when nothing changes (same address, folder already listed, no key saved)
or when switching between providers already approved.

| Property | How |
|---|---|
| wording not controlled by the page | fixed templates; values are canonical and stripped of control, bidirectional-override and zero-width characters, truncated to 160 chars |
| answer not visible to the page | consumed inside the command that asked |
| denial is the default | default button is **No**; a stray or synthesized Enter denies |
| Atlas cannot click its own Yes | while a question is open, `input_guard` refuses every synthesized click, key and UI-Automation action (`BLOCKED:consent-open`) |
| F8 denies | an open question counts as "something to stop" for the stop key (this was a real bug found by driving the app: the idle-press rule ignored it); the box is closed with No |
| silence denies | two minutes |
| one at a time | a second request is refused, not queued |
| temporary pause | three refusals in two minutes pause new questions for one minute; a Yes clears the count; F8 and timeouts do not count against the person |

## 4. Stage 4 — trust storage

`storage_get`/`storage_set`/`storage_remove` refuse the trust keys in both directions
(`TRUST_KEYS` in `storage.rs`): `atlas.allowed-folders`, `atlas.searxng-endpoint`,
`atlas.halt-shortcut`, `atlas.provider-bindings`, `atlas.migrations`. Native code uses
`get_trusted`/`set_trusted`. Tests tie that list to the inventory and fail if a TypeScript source
names one.

**The narrow `atlas.preferences` split.** Only the cloud-provider list moved (label, model, enabled,
address). Everything else in `atlas.preferences` is untouched. The provider list is now read with
`provider_list` and changed with `provider_add` / `provider_bind` / `provider_update` /
`provider_unbind`.

**Migration** (first start of this version only):

1. copy `storage.json` → `storage.json.pre-2.0-providers.bak` (never overwritten);
2. re-validate every old entry's address; keep valid ones;
3. write the table and a marker, read the store back, and require that **every other key is
   unchanged** and the new keys say what was intended;
4. on any mismatch the backup is restored and nothing is adopted.

Rollback: the old `cloudProviders.list` fact is never edited or deleted, so Atlas 1.0.x keeps
working from it; to undo by hand, delete the two new keys or restore the `.bak`.
**Skew to know about:** a provider added with 2.0 is not visible to 1.0.x, and one added by
1.0.x *after* migration is not adopted by 2.0 (adoption is a single trust-on-first-use step, by
design, so the renderer's list is never a standing channel into the table).

Verified on the real shared store (backup byte-identical to the pre-run copy; exactly two keys
added; the Hugging Face provider carried over with its address, model and flag).

## 5. Stage 5 — updater (`update_signature.rs`)

- The manifest is fetched only from the pinned address; the installer must be under
  `github.com/17sh8dy/Atlas/releases/download/` (not "any github.com").
- The manifest must carry an **Ed25519 signature** over a fixed text of its own fields
  (product, version, address, SHA-256, size, mandatory, minimum, published, notes), verified
  against a key **compiled into the program**.
- The *program* keeps the verified record. Download is allowed only for exactly that address;
  install only if the **measured** file's SHA-256 and version equal the signed ones and the
  version is newer than the running one (no replay of an old signed release). The hash and
  version the webview passes are cross-checked, never trusted.
- `PUBLIC_KEY_HEX` is **empty until the release owner provisions a key**, and an empty key
  verifies nothing: this build refuses all updates and says to reinstall from the website.
  `scripts/update-signing.mjs keygen --out <file outside the repo>` makes the key;
  `make-update-manifest.mjs` signs and refuses a key that does not match the compiled-in one;
  `release.mjs` refuses to publish with no compiled-in key or no private key.
- A Node-signed manifest (throwaway key) is verified by a Rust test, so the two implementations
  provably sign and check the same bytes.

**Before Atlas 2.0 is distributed** (gate, not done): generate the key, back it up, paste the
public half into `update_signature.rs`, rebuild, and publish through `pnpm release` with
`ATLAS_UPDATE_SIGNING_KEY` set. Authenticode code-signing of the installer is a separate, still
open item (it needs a certificate); the signature above authenticates *which installer Atlas will
run*, not what Windows SmartScreen shows. Copies of Atlas that already exist run the old updater
and will accept an unsigned update from the pinned host: the first installation of 2.0 has to be
manual (the website download), and that cannot be fixed from inside 2.0.

## 6. Tests added

Rust (`cargo test --lib`, 422 passing): `protected_paths` (10: containment, siblings, case,
ancestors, `..`, junction, hard link, not-yet-existing, defaults, real store refused),
`allowed_folders` (2 end-to-end refusals), `provider_bindings` (13: destination rules, adoption,
migration plan and verification, unbound refusal), `consent` (11: hostile text, length, wording,
yes/no, halt, pause, single-flight, stop-key counts an open question, sweep that every
trust-changing command asks *before* it writes, a real box closed by halt and by the clock),
`update_signature` (11: tampering with each signed field, wrong key, unsigned, algorithm, key id,
unprovisioned build, pinned addresses, install authorisation, version order, Node vector),
`authz_inventory` (9: every command and key classified, TRUST_KEYS agrees with the inventory, no
TypeScript names a trust key). TypeScript: the two web tests that asserted the old request shape
now assert it is gone. **Real application** (release build, CDP + native-dialog driver): 42
checks across all five stages, including the box text, answering Yes/No/F8, and the migration.

## 7. Residual risk — read this before claiming anything

Tier A protects **durable trust changes**. It does not make a compromised webview harmless,
because these native commands remain directly callable and are covered only by the executor in
the renderer:

| Commands | What a compromised webview can still do | Why it is not closed here |
|---|---|---|
| **`run_powershell`** | run any script as the user (the literal drive paths in a script are checked; a computed path is not; the app's own folders can be reached from inside a script) | it is the "last resort" tool; its consent is the card the person reads, which is renderer-side |
| **`run_devtool`, `git_*`, `install_dependency`, `deploy_project`, `scaffold_project`, `open_project_terminal/editor`** | run build tools, project scripts, git hooks, package installs in any allowed folder | closed argument lists, but `npm run`/hooks execute project code by nature |
| **`winget_install/upgrade/uninstall`, `launch_app`, `open_path`, `open_url*`, `open_system_tool`, `elevation_*`** | install or start software; ask for admin (a real UAC prompt still appears, and input is refused on it) | each is a person-level action the executor confirms; none is a trust *setting* |
| **`set_environment_variable`, `set_startup_app`, `service_control`, `set_default_printer`, registry/theme/radio/wallpaper/display/power commands** | persistence and system settings changes | same: gated by the executor, not natively |
| **input synthesis** (`mouse_*`, `press_key`, `hotkey`, `type_text`, `uia_*`) | drive any non-elevated window, including a browser that is signed in | `input_guard` blocks UAC, elevated and credential UIs, and (now) an open consent box; nothing can stop it driving ordinary windows |
| **network**: `fetch_page`, `fetch_doc_page`, `web_search*`, `ping_host`, `dns_lookup`, `trace_route`, `ask_local_model_stream`, `transcribe_speech` | send a few hundred characters per call to chosen hosts (private ranges are refused) — an exfiltration channel | needed for the features; rate/size limits only |
| **file commands inside granted folders** | read, change, delete anything the person's folders contain | by design; Tier B (per-operation native consent) was deferred |
| **`nova_intelligence_start`** | start the interpreter found in the chosen Nova folder (which is a stored preference) | a program-selection preference; recommend making the folder native + consented in a later pass |
| **the Nova account token** (`atlas.nova.account`) | readable by the webview, because the sign-in client lives there | by design; reducing it means moving the client native |
| **`halt_reset`, `halt_set_working`** | clear a latched stop | by design (the engine clears it after a halt) |

So the accurate claim is: *a compromised webview can no longer widen Atlas's reach, redirect a
saved key, rewrite Atlas's own state or install an unsigned update without the person answering a
native box — and it still has everything the commands above give it.* "Atlas cannot be
hijacked by script in its window" would be false and is not claimed.

Also open: the first-install gap for existing 1.0.x copies, code signing of the installer, the
`nova.folder` preference, and the `.bak` file (delete it once you are satisfied with the
migration; it holds a copy of the store, token included, in the same protected folder).
