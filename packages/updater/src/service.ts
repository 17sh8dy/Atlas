/**
 * The updater as a service — no UI, no platform.
 *
 * The bubble subscribes and calls; everything that decides lives here. States
 * move one way, and every failure names the stage it happened in:
 *
 *   hidden → checking → available → downloading → verifying → installing
 *          → restarting → (the app closes, is replaced, reopens) → complete
 *
 *   any stage may end in `failed`; "Try again" re-enters at the download.
 *
 * "Later" hides an update for the version it was said about, not forever: the
 * next version is offered again. A mandatory update has no "Later".
 */

import type { DownloadedPackage, StartupStatus, UpdateBackend } from './backend';
import { parseManifest, type UpdateManifest } from './manifest';
import { judgeVerification, type ManifestSignatureVerifier, type VerifyPolicy } from './verify';
import { compareVersions } from './version';

export type UpdateStage = 'check' | 'download' | 'verify' | 'install' | 'restart';

export type UpdateState =
  | { status: 'hidden' }
  | { status: 'checking' }
  | { status: 'available'; manifest: UpdateManifest }
  | { status: 'downloading'; manifest: UpdateManifest; received: number; total: number | null }
  | { status: 'verifying'; manifest: UpdateManifest }
  | { status: 'installing'; manifest: UpdateManifest }
  | { status: 'restarting'; manifest: UpdateManifest }
  | { status: 'complete'; version: string }
  | {
      status: 'failed';
      stage: UpdateStage;
      error: string;
      /** Present when the update itself is still worth retrying. */
      manifest: UpdateManifest | null;
      /** True when a bad new version was rolled back to the one that worked. */
      rolledBack: boolean;
    };

export type CheckResult = 'available' | 'up-to-date' | 'dismissed' | 'error' | 'busy';

/** Where "Later" is remembered. Optional: without it, "Later" lasts until restart. */
export interface UpdateMemory {
  dismissedVersion(): Promise<string | null>;
  dismiss(version: string): Promise<void>;
}

export interface UpdateServiceOptions {
  backend: UpdateBackend;
  /** The one place the manifest address lives. */
  manifestUrl: string;
  /** Lowercase product id in the manifest, e.g. "atlas". */
  product: string;
  currentVersion: string;
  policy: VerifyPolicy;
  memory?: UpdateMemory;
  signatureVerifier?: ManifestSignatureVerifier;
}

type Listener = (state: UpdateState) => void;

export class UpdateService {
  private state: UpdateState = { status: 'hidden' };
  private readonly listeners = new Set<Listener>();
  private pkg: DownloadedPackage | null = null;
  private dismissedThisRun: string | null = null;
  private cancelled = false;
  private working = false;

  constructor(private readonly o: UpdateServiceOptions) {}

  // ---- state -------------------------------------------------------------

  getState(): UpdateState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: UpdateState): void {
    this.state = next;
    for (const fn of [...this.listeners]) fn(next);
  }

  private fail(
    stage: UpdateStage,
    error: unknown,
    manifest: UpdateManifest | null,
    rolledBack = false,
  ): void {
    const text = error instanceof Error ? error.message : String(error);
    this.set({ status: 'failed', stage, error: text, manifest, rolledBack });
  }

  // ---- the five steps ----------------------------------------------------

  /**
   * Ask whether a newer version exists.
   *
   * `manual` is the person pressing "Check for updates": it ignores an earlier
   * "Later" and reports errors, where an automatic check stays silent about
   * being offline — nobody wants a bubble that says the internet is down.
   */
  async checkForUpdate(opts: { manual?: boolean } = {}): Promise<CheckResult> {
    if (this.working) return 'busy';
    const s = this.state.status;
    if (s !== 'hidden' && s !== 'available' && s !== 'failed' && s !== 'complete') return 'busy';

    this.working = true;
    if (opts.manual) this.set({ status: 'checking' });
    try {
      const text = await this.o.backend.fetchManifest(this.o.manifestUrl);
      const parsed = parseManifest(text, this.o.product);
      if (!parsed.ok) throw new Error(parsed.reason);
      const manifest = parsed.manifest;

      const order = compareVersions(manifest.version, this.o.currentVersion);
      if (order === null) throw new Error('Could not compare versions.');
      if (order <= 0) {
        this.set({ status: 'hidden' });
        return 'up-to-date';
      }
      if (
        manifest.minimumVersion &&
        (compareVersions(this.o.currentVersion, manifest.minimumVersion) ?? 0) < 0
      ) {
        throw new Error(
          `Version ${this.o.currentVersion} is too old to update in place. Please install ${manifest.version} from the website.`,
        );
      }

      if (!opts.manual && !manifest.mandatory) {
        const said =
          this.dismissedThisRun ?? (await this.o.memory?.dismissedVersion().catch(() => null));
        if (said === manifest.version) {
          this.set({ status: 'hidden' });
          return 'dismissed';
        }
      }
      this.set({ status: 'available', manifest });
      return 'available';
    } catch (err) {
      if (opts.manual) this.fail('check', err, null);
      else this.set({ status: 'hidden' });
      return 'error';
    } finally {
      this.working = false;
    }
  }

  /** Download the package. Progress arrives as state changes. */
  async downloadUpdate(): Promise<boolean> {
    const manifest = this.manifestOf();
    if (!manifest) return false;
    this.cancelled = false;
    this.set({ status: 'downloading', manifest, received: 0, total: manifest.sizeBytes });
    try {
      this.pkg = await this.o.backend.download(manifest.downloadUrl, (received, total) => {
        if (this.state.status === 'downloading') {
          this.set({
            status: 'downloading',
            manifest,
            received,
            total: total ?? manifest.sizeBytes,
          });
        }
      });
      return true;
    } catch (err) {
      if (this.cancelled) this.set({ status: 'available', manifest });
      else this.fail('download', err, manifest);
      return false;
    }
  }

  /** Check the downloaded package against the manifest. Nothing installs without this. */
  async verifyUpdate(): Promise<boolean> {
    const manifest = this.manifestOf();
    if (!manifest || !this.pkg) return false;
    this.set({ status: 'verifying', manifest });
    try {
      const report = await this.o.backend.verify(this.pkg);
      const verdict = await judgeVerification(
        report,
        manifest,
        this.o.policy,
        this.o.signatureVerifier,
      );
      if (!verdict.ok) {
        this.fail('verify', verdict.reason, manifest);
        return false;
      }
      return true;
    } catch (err) {
      this.fail('verify', err, manifest);
      return false;
    }
  }

  /** Keep the current version safe and arm the installer. The app is still running. */
  async installUpdate(): Promise<boolean> {
    const manifest = this.manifestOf();
    if (!manifest || !this.pkg) return false;
    this.set({ status: 'installing', manifest });
    try {
      await this.o.backend.install(this.pkg, {
        sha256: manifest.sha256,
        product: this.o.policy.expectedProduct,
        version: manifest.version,
        fromVersion: this.o.currentVersion,
      });
      return true;
    } catch (err) {
      this.fail('install', err, manifest);
      return false;
    }
  }

  /** Close so the installer can replace the program; it reopens by itself. */
  async restartApp(): Promise<void> {
    const manifest = this.manifestOf();
    if (!manifest) return;
    this.set({ status: 'restarting', manifest });
    try {
      await this.o.backend.restart();
    } catch (err) {
      this.fail('restart', err, manifest);
    }
  }

  // ---- the whole thing ---------------------------------------------------

  /** "Update": download, verify, install, restart — stopping cleanly at the first failure. */
  async update(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      if (!(await this.downloadUpdate())) return;
      if (!(await this.verifyUpdate())) return;
      if (!(await this.installUpdate())) return;
      await this.restartApp();
    } finally {
      this.working = false;
    }
  }

  /** Stop a download in progress. */
  async cancel(): Promise<void> {
    if (this.state.status !== 'downloading') return;
    this.cancelled = true;
    await this.o.backend.cancelDownload().catch(() => {});
  }

  /** "Later". Not available for a mandatory update. */
  async dismiss(): Promise<void> {
    const s = this.state;
    if (s.status === 'available') {
      if (s.manifest.mandatory) return;
      this.dismissedThisRun = s.manifest.version;
      await this.o.memory?.dismiss(s.manifest.version).catch(() => {});
    }
    this.set({ status: 'hidden' });
  }

  /** Try a failed update again, from the download. */
  async retry(): Promise<void> {
    const s = this.state;
    if (s.status !== 'failed' || !s.manifest) return;
    this.set({ status: 'available', manifest: s.manifest });
    await this.update();
  }

  // ---- after a restart ---------------------------------------------------

  /**
   * Call once at startup. Reports how the last update ended, and tells the
   * backend this launch is healthy so its safety copy can go.
   */
  async announceStartup(): Promise<StartupStatus> {
    let status: StartupStatus = { outcome: 'none' };
    try {
      status = await this.o.backend.startupStatus();
    } catch {
      return status;
    }
    if (status.outcome === 'updated' && status.toVersion) {
      this.set({ status: 'complete', version: status.toVersion });
      await this.o.backend.confirmLaunch().catch(() => {});
    } else if (status.outcome === 'rolled-back') {
      this.set({
        status: 'failed',
        stage: 'install',
        error:
          status.detail ??
          `Version ${status.toVersion ?? 'the new one'} did not start properly, so Atlas went back to ${status.fromVersion ?? 'the previous version'}.`,
        manifest: null,
        rolledBack: true,
      });
    } else {
      await this.o.backend.confirmLaunch().catch(() => {});
    }
    return status;
  }

  /** "Done" / "Dismiss" on the complete and failed bubbles. */
  acknowledge(): void {
    if (this.state.status === 'complete' || this.state.status === 'failed') {
      this.set({ status: 'hidden' });
    }
  }

  private manifestOf(): UpdateManifest | null {
    const s = this.state;
    return 'manifest' in s ? s.manifest : null;
  }
}
