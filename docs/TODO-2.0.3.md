# Atlas 2.0.3 - what is left

Written 2026-10-24 (night). Branch `atlas-2.0.3`, local commits only. **Nothing is pushed, tagged or released, and
nothing may be until Brandon says so.** Plan: `docs/PLAN-2.0.3.md`. Workstreams A (token accounting), B (signed
knowledge pack, refresh, live lookups) and K (knowledge-first answering) are built and real-app verified; C (private
folders) is 2.0.4.

## Done 2026-10-24

- Knowledge settings tab built (`settings/Knowledge.tsx`, `knowledgeView.ts`, test `knowledge-tab.test.ts`); real-app drive pending.
- K7 built: `knowledge/verify.ts`; a model's knowledge reply is held (not streamed), numbers and `code` names must appear in the passages, else the passages are shown instead.
- `release.mjs` now builds and requires the signed pack before bundling (publishing the pack stays manual).

## Still to do, in this order

1. ~~**Knowledge settings tab**~~ (built, see above; keep for the spec) (`apps/web/src/pages/settings/Knowledge.tsx`). The native side and the
   `@atlas/platform` bindings already exist (`knowledgeStatus`, `knowledgeCheckNow`, `knowledgeSetAutoRefresh`,
   `knowledgeSetLiveLookups`, `calibrationStatus`, `calibrationReset`). The tab needs:
   - Auto-refresh toggle (default on) and "Look up current information from Nova's public pages" toggle (default on).
   - Read-only rows: pack version and date, source (bundled or refreshed), last checked, last updated, last error.
   - "Check now" button (a failed check shows in `lastError`, it does not throw).
   - Advanced: the "Token accuracy" table (model, samples, ratio, in use) and "Reset calibration".
   - Say plainly what each switch contacts (GitHub for the pack, Nova's public pages for lookups) and that nothing
     about the person or their message is sent.
   - A test per control, and drive it in the real app.
2. **Review gates (Brandon).** Nothing below ships until read and approved:
   - `knowledge/faq.md`: 8 answers, all `review: draft`. Read each against its source. Read the "account required"
     and "needs an AI model" answers most carefully.
   - The 11 draft pages in the Nova-Knowledge repo (`pages/*.md`, public already, all `review: draft`). Approve a page
     by setting `review: approved`, then rebuild the pack.
   - Still to be written: `docs/PUBLIC-ROADMAP.md` (the only source of "Planned") and
     `knowledge/nova-engine-overview.md` (every sentence approved).
3. **Choose a licence** for the Nova-Knowledge repo (the README says none has been chosen yet).

## Known limits to close (found in the real-app run)

- **Answer quality depends on reviewed text.** With no approved FAQ or pages, most questions about Nova correctly get
  "isn't in my documentation", and "how do you count tokens?" returns a related passage rather than the ideal one.
  Approving the FAQ and pages is the fix, not more search tuning.
- **Only reviewed user-written text answers on its own.** Developer documentation (architecture, READMEs) is read by a
  connected model only and is never shown to a person. If a model is not connected, those questions are declined.
  Decide whether more docs should be rewritten for users and marked `audience: user` in `knowledge/sources.json`.
- **K7 built (2026-10-24), limits:** it catches invented numbers and code names only, not a wrong sentence made of right words. Original note: a model's reply is not yet checked against the passages (numbers, version strings and setting names
  in the reply should appear in the reference, else the reply is replaced by the verbatim passage).
- **Live lookups seen only failing safe.** The network was blocked on purpose in the real-app run, so a successful live
  read of a release page was never seen in the app (the unit tests and `cargo test --lib knowledge_live -- --ignored`
  do read all 10 sources). Check it once online, and check the daily pack refresh succeeds once a pack is published.
- **Nova.Review is a script-only page**, so a live read of it is "too thin" and falls back to the pack.
- **"Planned" / "update to get it" wording** (plan K9) is not built: nothing can say Planned until the public roadmap
  exists, and a pack newer than the running Atlas is not yet called out.
- **Gemini thinking tokens** follow Google's documented behaviour but were never checked against a real response.
- **Token estimator tuned and measured on the same 23 samples, one model (`qwen3.5:9b`).** Treat the accuracy table as
  optimistic. Per-family default weights (Qwen, Llama, Claude, GPT, Gemini) are not built; the learned per-model
  correction is meant to cover it.
- **Stale docs in the pack:** `docs/INSTALL.md` (the 1.0.2 guide) is deliberately not packed. Rewrite it for 2.0.x
  before it goes back in.
- **Flaky test:** `updater::tests::helper_success_path_installs_and_records_it` failed once with exit code `0xc0000142`
  while the whole suite ran. It passes alone. Probably load, but watch for it.
- **Real-app testing left test Q&A in Brandon's Atlas history** (the test build used the real profile).

## Release steps (when approved)

1. Approve pages and `faq.md`; commit; `ATLAS_KNOWLEDGE_SIGNING_KEY=<key file> node scripts/build-knowledge.mjs`.
   The builder reads committed content only, and refuses any non-approved chunk.
2. (`release.mjs` pack step is done.) Publish with `node scripts/build-knowledge.mjs --publish` (attaches the pack to the
   `knowledge` release of the Nova-Knowledge repo; this is what the daily refresh reads).
3. **Back up the knowledge signing key** (`C:\Users\Brandon\.atlas-keys\atlas-knowledge-1.pem`) with
   `node scripts/signing-key-backup.mjs backup` and copy it off this PC. Lose it and installed copies can never verify
   a refreshed pack.
4. Version bump to 2.0.3 (`apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml`), `release-notes/2.0.3.txt`,
   the Atlas site, and run ALL tests (`cargo test --lib`, `pnpm -r test`) and a real-app pass.
5. **NovaLegal:** Atlas Terms 2.2 and the Privacy Policy line about the knowledge copy, the daily refresh and live
   lookups are committed locally in `D:\Dev\NovaLegal` (fa4b356) and NOT pushed. A push deploys the live site, so push
   it together with the Atlas release, not before.
6. Nothing in this branch has been pushed. Ask before any push, tag or release.

## Where things are

- Pack builder: `scripts/build-knowledge.mjs`, `scripts/knowledge-lib.mjs`, `scripts/knowledge-signing.mjs`,
  allowlist `knowledge/sources.json` (each file has an `audience`), verified answers `knowledge/faq.md`.
- Native: `knowledge_signature.rs`, `knowledge.rs`, `knowledge_live.rs`, `usage.rs`, `tokens.rs`, `calibration.rs`.
- Engine: `packages/engine/src/knowledge/`, tier 3b1/2 and the product-news hook in `engine.ts`, app wiring in
  `apps/web/src/atlas/knowledgeDeps.ts`.
- Nova-Knowledge repo: github.com/17sh8dy/Nova-Knowledge, local clone `D:\Dev\NovaKnowledge`.
- Driving the real app: set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444`, build with
  `pnpm exec tauri build --no-bundle` in `apps/desktop`, then use the Chrome DevTools protocol (type with
  `Input.insertText`, press Enter). A dead `HTTPS_PROXY` (with `NO_PROXY=127.0.0.1`) simulates no network for native calls.
- Trap: in this repo's tooling, a python edit with `\b` inside a bash heredoc silently writes a backspace character
  into a JS regex. Use the Edit or Write tool for regexes, and `grep -P '\x08'` to check.
