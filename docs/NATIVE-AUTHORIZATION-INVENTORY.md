# Native authorization — inventory and TRUST_KEYS sweep

> **Update 2026-10-14:** the findings below were acted on in five stages; see
> `SECURITY-HARDENING-2.0.md` for what was built, how it was verified in the real app, and the
> residual risks that remain. The findings text here is kept as the record of what was found.

Status: **complete, 2026-10-13, `atlas-2.0`.** Preparation for `docs/NATIVE-AUTHORIZATION.md`
phase 1. **No behaviour changed**: no dialog, no migration, no permission change. The only code
added is a test-only module, `apps/desktop/src-tauri/src/authz_inventory.rs`, which is not
compiled into the app.

Method: every `#[tauri::command]` in `src-tauri/src` was parsed and reconciled with
`generate_handler!` in `lib.rs` (**246 declared = 246 registered**); every storage-key literal in
`packages/`, `apps/web/src` and `src-tauri/src` was collected and compared with what the store
actually holds; the file, secret, updater and cloud commands were then read for how they use
trust-bearing values. The classifications are reviewable data in `authz_inventory.rs` and are
guarded by tests (section 5).

## 1. Native commands by what they can do

| Class | Count | Commands |
|---|---|---|
| **Trust change** | 6 | `add_allowed_folder`, `remove_allowed_folder`, `searxng_configure`, `set_halt_shortcut`, `storage_set`, `storage_remove` |
| Secret | 3 | `save_secret`, `delete_secret`, `has_secret` |
| Updater | 8 | `updater_fetch_manifest`, `updater_download`, `updater_cancel`, `updater_verify`, `updater_install`, `updater_restart`, `updater_startup_status`, `updater_confirm_launch` |
| Halt plumbing | 4 | `halt_now`, `halt_status`, `halt_set_working`, `halt_reset` |
| File change (Allowed Folders) | 26 | `create_file`, `create_folder`, `rename_path`, `move_path`, `move_path_to`, `copy_path`, `delete_path`, `append_file`, `write_text_file`, `patch_text_file`, `duplicate_path`, `create_shortcut`, `create_url_shortcut`, `zip_path`, `unzip_path`, `set_file_attributes`, `recycle_bin_restore`, `cleanup_clean`, `set_wallpaper`, `compress_video`, `convert_media`, `resize_image`, `edit_media`, `open_plugins_folder`, `scaffold_project`, `empty_recycle_bin` |
| Input synthesis | 14 | `move_mouse`, `mouse_click`, `mouse_scroll`, `mouse_drag`, `press_key`, `hold_key`, `hotkey`, `type_text`, `uia_invoke`, `uia_set_expanded`, `uia_set_value`, `uia_focus`, `uia_append_value`, `uia_scroll` |
| Process / system / settings | 66 | `run_powershell`, `run_devtool`, git (`git_add`/`commit`/`checkout`/`pull`/`push`/`stash`/`more`), `deploy_project`, `install_dependency`, `winget_install`/`uninstall`/`upgrade`, environment, start-up, service, power, window, volume/mic/theme/mouse/Explorer/radio, elevation, launch/open commands, Nova Intelligence start/stop, … (full list in the table) |
| Network egress | 14 | `ask_cloud_provider`, `test_cloud_provider`, `fetch_page`, `fetch_doc_page`, `web_search`, `web_search_with`, `searxng_test`, `ask_local_model_stream`, `ask_nova_intelligence_stream`, `transcribe_speech`, `ping_host`, `dns_lookup`, `trace_route`, `speed_test` |
| Sensitive read | 10 | `storage_get`, `read_text_file`, `document_text`, `verify_file`, `registry_read`, `capture_screen`, `capture_window`, `capture_display`, `uia_tree`, `uia_focused_element` |
| Own window | 3 | `show_window`, `hide_window`, `toggle_window` |
| Read-only inspection | 92 | the rest |

Total 246. The per-command table lives in `authz_inventory.rs::COMMANDS`.

## 2. Trust-bearing storage keys (`TRUST_KEYS` candidates)

"Native-startup" means Rust reads the key once at launch and holds the value in memory: a write
through `storage_set` is persistent but takes effect at the **next launch**.

| Key | Trust | Who consumes it |
|---|---|---|
| `atlas.allowed-folders` | **High** | native-startup: `allowed_folders::init`; checked by every path command |
| `atlas.searxng-endpoint` | **High** | native-startup: `searxng::init`; the only address `web_search_with` uses |
| `atlas.nova.account` | **High** | renderer; the sign-in token, returned by `storage_get` |
| `atlas.preferences` | **High** | renderer `MemoryStore`: `provider.active`, `cloudProviders.list` (base URL, model, enabled), `local.baseUrl`, `nova.baseUrl`, `nova.folder`, enable flags. They become *parameters* of `ask_cloud_provider`, `ask_local_model_stream`, `nova_intelligence_start` |
| `atlas.watches` | **High** | engine: continuation steps run unattended with their saved approval |
| `routines.items` | **High** | engine: saved plans replayed on a schedule. **Not `atlas.`-prefixed** |
| `atlas.halt-shortcut` | Medium | native-startup: `halt::start`; `set_halt_shortcut` rebinds the stop key |
| `atlas.setups`, `atlas.tasks`, `atlas.workflow.transactions`, `atlas.file-journal` | Medium | engine/renderer: saved steps or undo steps that re-run **through the executor** (which still asks as its mode requires) |
| `reminders.items` | Low | engine scheduler. **Not `atlas.`-prefixed** |
| `atlas.update.autocheck`, `atlas.update.dismissed`, `atlas.settings.alerts`, `atlas.settings.notifications-enabled`, `atlas.settings.scroll`, `atlas.accent`, `atlas.theme`, `atlas.text-style`, `atlas.effects.enhanced`, `atlas.agent.context-tokens`, `atlas.selftest.probe` | Low | renderer preferences and bookkeeping |
| `atlas.transcript`, `atlas.memory.episodes`, `atlas.settings.clipboard-history` | Privacy | not authority, but private |

`atlas.hide` and `atlas.name` look like keys but are a skill id and a fact subject inside
`atlas.preferences`; they are listed separately so they are never mistaken for keys.

Secrets (provider API keys, the Tavily key) are **not** in the store at all: they live in Windows
Credential Manager behind `save_secret` / `delete_secret` / `has_secret`, and the value never
returns to the renderer. That part of the design is already sound; the finding in 3.2 is about
*where a saved key can be sent*, not where it is kept.

## 3. Findings: commands that can bypass native authorization

Ordered by how directly each defeats the design in `NATIVE-AUTHORIZATION.md`. None is changed by
this inventory.

### 3.1 Atlas's own data and install folders are inside the Allowed Folders — **confirmed**

`allowed_folders::is_permitted` is "canonical path starts with a root"; the default root is
`%USERPROFILE%`; there is no exclusion anywhere in `src-tauri/src`. `%APPDATA%\dev.atlas.assistant\`
(where `storage.json` lives) and the per-user install folder (NSIS defaults to current-user) are
both under the home folder. Consequence, for a compromised renderer:

- **Write:** `append_file`, `write_text_file` and `patch_text_file` all check only
  `is_permitted(path)` and edit an existing file in place, so they can edit `storage.json`
  directly. Moving it aside (`rename_path`/`move_path_to`, no overwrite needed) and then
  `create_file` writes a fresh one. Any dedicated-command gating of `atlas.allowed-folders`,
  `atlas.searxng-endpoint` or `atlas.halt-shortcut` is moot while this is open; the change lands at
  next launch.
- **Read:** `read_text_file` (up to 256 KiB) and `document_text` can read `storage.json`, including
  `atlas.nova.account`'s token, without going through `storage_get`.
- **Install folder:** `delete_path` and the move/copy commands can remove or add files in the
  install folder that the running app does not lock.

**This must be closed for tier A to mean anything, and it is cheap**: a small native deny list
(app-data dir, install dir, updates dir, plus `.ssh`-style credential folders if wanted) checked
inside `is_permitted`, with one carve-out: `app_data_dir\plugins` is read by `plugin_manifests` and
opened by `open_plugins_folder`.

### 3.2 `ask_cloud_provider` / `test_cloud_provider` take `base_url` from the caller

`ask_cloud_provider(provider_id, kind, base_url, model, prompt)` reads the saved key by
`provider_id` and sends it to whatever `https` URL the caller supplies (`resolve_base_url` checks
the *scheme*, not the *destination*). The destination is not bound to the key when the key is
saved. A compromised renderer can therefore send a saved key to a host of its choosing, and the
prompt with it. The base URL is also one of the facts in `atlas.preferences`, so tier A as written
(gate the *storage* of the URL) is not enough: the call has to stop taking it.

### 3.3 `storage_set` / `storage_remove` / `storage_get` are fully generic

Any valid key, any value. `storage_remove("atlas.allowed-folders")` resets the boundary to the
home default; `storage_set` can write every High key. This is the bypass the existing design
already names.

### 3.4 Updater trust is a host allowlist, not a publisher

`updater_download(url)` accepts any URL on `github.com` or `githubusercontent.com` (not one
repository). `updater_install` refuses an *invalid* signature but accepts *unsigned*, and the
`product`/`version` it compares against are renderer-supplied strings checked against the file's
own metadata. The SHA-256 is also renderer-supplied and is compared with the file's measured hash,
so it proves integrity between two steps, not authenticity. Install is person-initiated in the UI;
natively, nothing checks that.

### 3.5 Commands whose reach is the point

`run_powershell` (only `cwd` is checked), `run_devtool`, `set_environment_variable`,
`set_startup_app`, `winget_install`, `git_push`, input synthesis. These execute whatever the
caller says within the user's own rights; a native consent for *trust changes* does not and cannot
cover them. They are covered only by the executor, which is in the renderer. This is the residual
risk already recorded in `NATIVE-AUTHORIZATION.md` §7, and tier B is the only thing that would
touch it.

### 3.6 Halt state

`halt_reset(epoch)` and `halt_set_working` are callable by the renderer by design (the engine
clears a latch after it has stopped). A compromised renderer can clear it too. The latch is a
guard against runaway *engine* work, not against hostile script.

### 3.7 Smaller points

- `reminders.items` and `routines.items` are not `atlas.`-prefixed, so the older storage-key sweep
  (`atlas.…` literals) never covered them. The new guard does.
- `atlas.preferences` mixes trust-bearing facts with cosmetic ones (the splitting problem in
  `NATIVE-AUTHORIZATION.md` §4).
- `has_secret` is classed with the secret commands but only reports presence.

## 4. What changed in this pass

| Change | Behaviour effect |
|---|---|
| `src-tauri/src/authz_inventory.rs` (new, `#[cfg(test)]`) | none; not in the binary |
| `lib.rs`: `#[cfg(test)] mod authz_inventory;` | none |
| this document | none |

## 5. The drift guard

`cargo test --lib authz_inventory` runs seven tests that fail the build when:

1. a `#[tauri::command]` exists that is not in the table, or the table names one that is gone;
2. a classified command is not registered in `generate_handler!`;
3. the set of `TrustChange` commands changes (forces a review against the design);
4. a storage-key literal (`atlas.…` or `….items`) appears in `packages/`, `apps/web/src` or
   `src-tauri/src` that is not classified, or a classified key no longer appears;
5. the three natively-read keys stop being High/Medium or stop saying they are read at startup;
6. a key that changes what runs or where data goes is demoted from High;
7. a listed bypass is not a real command.

## 6. Suggested order for the next phase (not started)

0. **Deny list inside `is_permitted`** (3.1). Small, testable, no dialog, no migration.
1. Bind a provider's destination natively; stop `ask_cloud_provider` taking `base_url` (3.2).
2. `consent` + dedicated commands for allowed folders, secrets, SearXNG (per the design).
3. Refuse `TRUST_KEYS` in the generic `storage_set`/`storage_remove`; split `atlas.preferences`.
4. Pin the updater to the project's repository path and require a valid signature once
   installers are signed (3.4).
