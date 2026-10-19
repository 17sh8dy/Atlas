# Real-app test drivers

These scripts drive the real Atlas app (WebView2 remote-debugging port). They exist because passing unit tests are
not proof a UI flow works. They are also dangerous in one specific way: a driver that clicks "Yes" can approve a real
action on the real machine. That has happened once (`docs/INCIDENT-2026-10-18-TEMP-CLEANUP.md`). The rules:

1. **Only disposable resources.** Create folders with `lib/sandbox.mjs` (`.e2e-sandbox/` inside the repo,
   git-ignored). It refuses anything under Temp, Downloads, Documents, Desktop, Pictures, Videos, Music, AppData,
   Windows or Program Files, and `destroy()` refuses to delete anything outside the sandbox root.
2. **The default answer to a card is NO.** `lib/policy.mjs` approves a card only if every path in it is inside the
   sandbox and it is not destructive, not a permission/setting change, and names a checkable target. Destructive
   cards are approved only with `--allow-destructive` *and* only when every path is inside the sandbox.
3. **Never auto-approve against the user's own files, folders, settings, accounts or services.** If a test needs
   something real, ask the person.
4. **Snapshot and restore** `%APPDATA%\dev.atlas.assistant\storage.json` around any run (Tauri ignores APPDATA
   redirects, so the real data folder is always used), and delete only what the run created.
5. Tell the person immediately if anything unexpected ran.

Typical run:

```
node -e "import('./scripts/e2e/lib/sandbox.mjs').then(m=>{const s=m.createSandbox('demo',{'a.log':'x'});console.log(s.slash)})"
node scripts/e2e/drive.mjs "create a folder called reports in <that path> and then move a.log into it" --sandbox <that path>
```

The policy is unit-tested in `packages/engine/test/e2e-policy.test.ts`.
