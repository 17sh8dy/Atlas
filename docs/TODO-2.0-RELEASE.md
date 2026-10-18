# Atlas 2.0 - what is left before it can be published

Written 2026-10-14. Branch `atlas-2.0`, local commits only. Nothing is pushed, tagged or released,
and nothing may be until Brandon says so.

## A. Blocks publishing (must be done)

1. **Provision the update signing key.** `PUBLIC_KEY_HEX` in `update_signature.rs` is empty, so no
   update verifies and `release.mjs` refuses to publish.
   - Run `node scripts/update-signing.mjs keygen --out <folder outside the repo>`.
   - Paste the public half into `update_signature.rs`, keep the private half safe and backed up,
     and set `ATLAS_UPDATE_SIGNING_KEY` for the release.
2. **The first 2.0 install is manual.** 1.0.x updaters do not check signatures, so existing users
   install 2.0 by hand once. Decide how the site and release notes say this.
3. **Windows Security Notice / code signing.** There is no Authenticode certificate. Decide: buy one,
   or keep the existing notice in the site footer.
4. **Version bump and release notes.** `package.json`, `tauri.conf.json`, `Cargo.toml`, the site
   (Atlas-Site) and the changelog. 2.0 is a compatibility step (signed updates, session now in
   Credential Manager, provider list now native): say so.
5. **Full suites on a clean machine state**, then a final real-app pass on the release build.
   `pnpm release` runs everything and publishes, so run the suites separately first.

## B. Decide / ask first (public or irreversible)

- NovaHelp's deployed registry still lists the `sync` scope for atlas. Trimming it is a public deploy.
- NovaLegal `atlas-terms` and privacy text: needs to mention local Stats, cloud limits, and the
  signed-update check. Pushed + deployed text, so ask first.
- Site copy for 2.0 (Atlas-Site). Not pushed until approved.

## C. Not yet verified in the real app

- Settings pages not all visually checked (Tasks, Stats layout at narrow width, Intelligence card
  at the limit-paused state with other themes).
- Updater end to end against a real signed release (needs the key from A1).
- Gemini function calling stays text-only until a model is measured.
- Per-model capability override in Settings (descriptor is declared or reported, never inferred).

## D. Known residual risks (documented in SECURITY-HARDENING-2.0.md)

`run_powershell`, devtools, input synthesis and the network commands are still gated by the
renderer only. Do not claim Tier A protects against a fully compromised renderer.

## E. Optional / later

- Phase E retrieval: **not authorized**, not started.
- Workflow-executor unification (plan only: docs/WORKFLOW-UNIFICATION.md).

## F. Brandon's extra ideas for 2.0

_To be added: Brandon said he has a couple more ideas to include before publishing. Write them here
verbatim when given, then scope each (size, risk, which phase) before building._

1.
2.

## Status 2026-10-18 (decision: NOT pushing yet; working the to-do and fixing bugs first)

- A1 done locally: key generated (`atlas-release-1`), public half pasted into `update_signature.rs`.
  **The private key is `C:\Users\Brandon\.atlas-signing\atlas-release-1.pem` and has no backup yet.**
- A2 resolved by reading 1.0.10's `packages/updater/src/manifest.ts`: it parses a signed manifest
  (`ed25519` + string keyId + string value is accepted) and ignores the signature, so a 1.0.x install
  should be offered 2.0 in-app (it still checks SHA-256, size, product name and version). Code-read,
  not run end to end. The in-app note stays; the site should say "first signed version", not "manual".
- A4 done locally: version 2.0.0 in `tauri.conf.json`, `package.json`, `Cargo.toml`;
  `release-notes/2.0.0.txt` written. Site (Atlas-Site `script.js` VERSION) NOT bumped.
- A5: typecheck, lint, `pnpm test` all green; `cargo test --lib` 445 passed, 0 failed (38 ignored).
  Final release-build real-app pass still to do.
- B: NovaLegal wording drafted on local branch `atlas-2.0-legal` (NOT pushed; main auto-deploys).
  NovaHelp `sync` scope left alone.
- F: Brandon's extra ideas still to be given.

## Verification pass 2026-10-18 (release build, real app)

Release build = `pnpm bundle` output (`Atlas_2.0.0_x64-setup.exe` / `target/release/atlas-desktop.exe`), driven
over CDP with real mouse events (synthetic `.click()` does not trigger the Settings tabs - harness quirk, not a bug).

- **All 13 Settings pages** inspected at the 560px minimum window width, no console errors.
  Found + FIXED (839bb16): Notifications sound picker overflowed (the 6th option "Windows" was fully clipped);
  Setups header squeezed its text; the cloud provider's "sends to <host>" line was truncated.
- **Spend-limit-paused state** verified: provider returns 402 `insufficient_quota` -> chat shows
  "Cloud AI Limit Reached", Atlas answers itself, Settings shows the paused banner + Resume, request
  counted, nothing switched. Mock provider on loopback.
- **Persistence** verified across a HARD KILL and a normal close + relaunch: execution mode, name, role,
  notification sound, monthly cap, provider (and its paused state), theme, chat transcript, the finished
  task ("Done 3 of 3 steps"), and statistics (counts incl. a message sent seconds before closing).
  Stats are flushed every 15 s and on close, so a crash can lose at most the last ~15 s of counts.
- **Migration on a real 1.0.10 data folder** worked: 1 cloud provider adopted with label/model/address kept,
  session moved out of storage.json.
- **Consent boxes**: default button is No; an explicit No saves nothing; Stats counts approved/declined correctly.
- Still NOT done: updater end to end against a real signed release; Gemini function calling; the signing-key
  backup (Brandon must run `scripts/signing-key-backup.mjs backup` himself - it needs a passphrase typed
  into his own terminal).

### Test-harness trap (read before driving the real app)
Tauri ignores an `APPDATA`/`LOCALAPPDATA` override: the app ALWAYS uses the real
`%APPDATA%\dev.atlas.assistant`. Launching the release build for a test touches the person's real data
(first launch migrates it and creates `storage.json.pre-2.0-providers.bak`). Snapshot first, run on a clean
`{}` store, restore byte-for-byte, delete any `Atlas:cloudProvider:*` credentials the test created (keep the
real ones), and answer the native consent boxes with a script (`answer-dialog.ps1`) - otherwise the box pops
up on the person's screen and they may click Yes themselves.
