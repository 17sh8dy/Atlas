/**
 * What the updater needs from the machine it runs on.
 *
 * The service in `service.ts` decides *when* and *whether*; a backend does the
 * things only the operating system can: fetch, write files, hash them, replace
 * the running program. Atlas's backend is Rust (`updater.rs`); the tests use a
 * fake. NovaCut or Replay.GG would supply their own and change nothing else.
 */

export interface DownloadedPackage {
  /** Opaque to the service: whatever the backend needs to find the file again. */
  path: string;
  sizeBytes: number;
}

/** What a backend measured about a downloaded file. Judged in `verify.ts`, never here. */
export interface VerifyReport {
  sha256: string;
  sizeBytes: number;
  /** The product name inside the installer's own version resource; null if unreadable. */
  product: string | null;
  /** The version inside that resource; null if unreadable. */
  version: string | null;
  /**
   * Authenticode state. `unsigned` is a normal answer for a build that has not
   * been code-signed yet; `invalid` means a signature is present and wrong,
   * which is always a refusal.
   */
  signature: 'valid' | 'unsigned' | 'invalid' | 'unchecked';
}

export interface StartupStatus {
  /** What happened to the last update, if there was one. */
  outcome: 'none' | 'updated' | 'rolled-back';
  fromVersion?: string;
  toVersion?: string;
  /** Why it was rolled back, in words. */
  detail?: string;
}

export interface UpdateBackend {
  /** The manifest, as text. Refuses anything but https. */
  fetchManifest(url: string): Promise<string>;
  /** Download to a private folder, reporting progress. Removes partial files on failure. */
  download(
    url: string,
    onProgress: (received: number, total: number | null) => void,
  ): Promise<DownloadedPackage>;
  /** Stop a download in progress. */
  cancelDownload(): Promise<void>;
  /** Measure the file. */
  verify(pkg: DownloadedPackage): Promise<VerifyReport>;
  /**
   * Keep the running version safe and hand the package to the installer.
   * Resolves once the handoff is armed — the program is still running.
   */
  install(
    pkg: DownloadedPackage,
    expect: { sha256: string; product: string; version: string; fromVersion: string },
  ): Promise<void>;
  /** Quit so the installer can replace the program; it reopens on its own. */
  restart(): Promise<void>;
  /** What happened at the last startup, and mark this launch. */
  startupStatus(): Promise<StartupStatus>;
  /** The new version came up healthy: the safety copy is no longer needed. */
  confirmLaunch(): Promise<void>;
}
