/**
 * About — what this build is, and what it does with your data.
 *
 * The second half arrived from the deleted Privacy tab. As a tab it was a
 * page with nothing on it, headed "Nothing to configure yet", which read as
 * an unfinished feature. It is not a feature — it is the single most
 * important fact about Atlas, and stated here, next to the version, it reads
 * as the plain claim it is.
 *
 * Version is read from Tauri's own app metadata (already available via
 * `@tauri-apps/api`, no new plugin); the web build has no version to show,
 * since web isn't the shipping target.
 *
 * ── "{n} capabilities · Local-first · No account required" ─────────────────
 * Used to sit under Atlas's name on Home, restated every time the app was
 * opened. It reads here now instead — right under the version, in the one
 * section that is already about what this build *is* — because a scale
 * claim and a trust claim are both something you check once, not chrome a
 * screen you open constantly should keep repeating at you.
 */

import { useEffect, useState } from 'react';
import type { Platform, WindowsCompatibility } from '@atlas/core';
import { AtlasMark, Button, Icons, Switch } from '@atlas/ui';
import type { Updater } from '../../update/useUpdater';

/**
 * Before 1.0, "0.85.0" reads as "0.85" here — a trailing zero patch is Cargo/semver's own
 * requirement (`Cargo.toml`'s `version` must be a full `major.minor.patch`,
 * and every release so far has left patch at 0), not information anyone
 * reads this page to learn. Anything with a real patch number — "0.85.3" —
 * is shown in full; this only drops the part that's never actually meant
 * anything yet.
 */
export function formatVersion(raw: string): string {
  return raw.replace(/^(0\.\d+)\.0$/, '$1');
}

/** What the last "Check for updates" found, in words. */
function updateLine(updater: Updater, lastCheck: string | null): string {
  const s = updater.state;
  switch (s.status) {
    case 'checking':
      return 'Checking…';
    case 'available':
      return `Version ${formatVersion(s.manifest.version)} is available.`;
    case 'downloading':
    case 'verifying':
    case 'installing':
    case 'restarting':
      return 'Updating…';
    case 'failed':
      return s.error;
    default:
      return lastCheck ?? 'Atlas checks for updates on its own, and you can check now.';
  }
}

export function About({
  platform,
  skillCount,
  updater,
}: {
  platform: Platform;
  skillCount: number;
  updater?: Updater;
}) {
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [windows, setWindows] = useState<WindowsCompatibility | null>(null);

  useEffect(() => {
    if (platform.id !== 'tauri') return;
    let alive = true;
    void (async () => {
      const { getVersion } = await import('@tauri-apps/api/app');
      const v = await getVersion();
      if (alive) setVersion(v);
    })();
    return () => {
      alive = false;
    };
  }, [platform.id]);

  useEffect(() => {
    let alive = true;
    void platform.windowsCompatibility?.().then((info) => {
      if (alive) setWindows(info);
    });
    return () => {
      alive = false;
    };
  }, [platform]);

  return (
    <div className="flex flex-col gap-3">
      <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <AtlasMark className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Atlas</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            {platform.id === 'tauri'
              ? `Version ${version ? formatVersion(version) : '…'} — desktop build`
              : 'Browser build — a test bed and fallback, not the shipping target.'}
          </p>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            {skillCount} capabilities · Local-first · No account required
          </p>
        </div>
      </section>

      <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <Icons.Lock className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Everything stays here</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            No account needed, no API key, nothing uploaded. Atlas speaks and listens on this
            machine, and what it remembers sits in a file on this disk. It reaches the network
            when you ask it to — a web search, opening a link, or signing in to the optional Nova
            Account — and to check for updates, which you can switch off below. Signing in uploads
            nothing; see Account.
          </p>
        </div>
      </section>

      {/* CC BY 4.0 requires attribution wherever the work is distributed — this is that notice,
          not decoration. Piper and whisper.cpp are MIT and need no credit here. */}
      <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <Icons.Mic className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Voice</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            Speaking uses the <span className="text-foreground">en_GB-vctk-medium</span> voice
            (Piper), trained on the University of Edinburgh Centre for Speech Technology Research's
            VCTK Corpus, licensed <span className="text-foreground">CC BY 4.0</span>. Listening uses{' '}
            <span className="text-foreground">whisper.cpp</span> and OpenAI's Whisper{' '}
            <span className="text-foreground">base.en</span> model. Both run on this machine.
          </p>
        </div>
      </section>

      {updater?.supported && (
        <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
          <Icons.Download className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-foreground text-sm font-medium">Updates</h2>
              <Button
                size="sm"
                variant="secondary"
                disabled={['checking', 'downloading', 'verifying', 'installing', 'restarting'].includes(
                  updater.state.status,
                )}
                onClick={() =>
                  void updater.checkNow().then((r) => {
                    if (r === 'up-to-date') setLastCheck('You’re on the latest version.');
                    else if (r === 'error') setLastCheck(null);
                  })
                }
              >
                Check for updates
              </Button>
            </div>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              {updateLine(updater, lastCheck)}
            </p>
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <span className="text-foreground-muted text-xs">Check automatically</span>
              <Switch
                checked={updater.autoCheck}
                onCheckedChange={updater.setAutoCheck}
                aria-label="Check for updates automatically"
              />
            </div>
            <p className="text-foreground-subtle mt-1.5 text-xs leading-relaxed">
              A check asks GitHub for one small file that lists the newest version. Nothing about
              you is sent, and nothing is downloaded until you press Update.
            </p>
          </div>
        </section>
      )}

      {platform.id === 'tauri' && (
        <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
          <Icons.MonitorSmartphone className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h2 className="text-foreground text-sm font-medium">Compatibility</h2>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              For the best Atlas experience, keeping Windows up to date is highly recommended. Some
              Atlas capabilities rely on Windows features and APIs that may vary between versions.
              An up-to-date system helps ensure I can provide the widest range of functionality.
              {windows && (
                <>
                  {' '}
                  This machine is running{' '}
                  <span className="text-foreground">
                    {windows.productName}
                    {windows.displayVersion ? ` (${windows.displayVersion})` : ''}, build{' '}
                    {windows.build}
                    {windows.ubr !== undefined ? `.${windows.ubr}` : ''}
                  </span>
                  .
                </>
              )}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
