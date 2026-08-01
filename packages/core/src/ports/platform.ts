/**
 * The platform port — everything Atlas needs from the machine underneath it.
 *
 * This is the seam that lets one assistant run as a Tauri desktop app with real
 * OS access, as a browser tab with almost none, and as a test double with a
 * scripted machine. Skills call these methods; they never import a platform
 * module, so no skill has to know which of the three it is running on.
 *
 * ── Why every method is optional ────────────────────────────────────────────
 * A browser cannot list running processes. Rather than have the web build throw
 * at runtime, or ship a second set of skills, an unimplemented method is simply
 * absent — and `capabilities()` says so up front. The engine hides skills whose
 * capabilities are missing, so an impossible action never reaches the planner
 * and never has to fail politely. Capability *presence* is the contract, not
 * exception handling.
 *
 * ── The privacy line, drawn here and not by convention ──────────────────────
 * There is deliberately no `exec(command: string)`. Atlas can open a path,
 * reveal a path, launch a *registered* application, and read metadata — each a
 * narrow, validated operation. It cannot be asked to run an arbitrary string,
 * because that capability, once present, is impossible to reason about and
 * makes every other guarantee on this interface decorative.
 */

/** Names the engine checks before offering a skill. */
export type CapabilityName =
  | 'files' // read the file index
  | 'fs' // open/reveal paths on disk
  | 'apps' // enumerate and launch installed applications
  | 'system' // CPU/memory/disk/battery readings
  | 'processes' // what's running
  | 'clipboard'
  | 'notifications'
  | 'windows' // Atlas's own window: show, hide, position
  | 'ai'; // an intelligence provider is connected

export interface FileEntry {
  path: string;
  name: string;
  /** Lowercased, no dot. Empty for folders. */
  ext: string;
  isDirectory: boolean;
  sizeBytes?: number;
  modifiedAt?: number;
}

export interface AppEntry {
  id: string;
  name: string;
  /** What the platform needs to launch it. Opaque to everything above. */
  target: string;
  icon?: string;
}

export interface SystemSnapshot {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  disks: Array<{ mount: string; usedBytes: number; totalBytes: number }>;
  battery?: { percent: number; charging: boolean };
  uptimeSeconds: number;
}

export interface ProcessEntry {
  pid: number;
  name: string;
  cpuPercent?: number;
  memoryBytes?: number;
}

/**
 * Every method is optional. Ask `capabilities()` what this platform can do
 * rather than probing for methods — that keeps the answer in one place and
 * lets a platform report a capability as unavailable for reasons other than
 * "the function is missing" (no permission, a service not running).
 */
export interface Platform {
  /** Stable id for logging and for platform-specific behaviour in the UI. */
  readonly id: 'tauri' | 'web' | 'test';

  capabilities(): Promise<CapabilityName[]>;

  /**
   * Search the file index by name.
   *
   * Names and paths only — never contents. The index exists to answer "where
   * is that thing called…", and reading file bodies to improve that answer
   * would trade the entire privacy story for a marginally better match.
   */
  searchFiles?(query: string, opts?: { kind?: string; limit?: number }): Promise<FileEntry[]>;
  recentFiles?(limit?: number): Promise<FileEntry[]>;

  /** Open a path with its default handler. */
  openPath?(path: string): Promise<boolean>;
  /** Show a path in the system file manager. */
  revealPath?(path: string): Promise<boolean>;
  /** Open an http(s) URL. Other schemes are refused by the implementation. */
  openUrl?(url: string): Promise<boolean>;

  listApps?(): Promise<AppEntry[]>;
  launchApp?(id: string): Promise<boolean>;

  systemInfo?(): Promise<SystemSnapshot>;
  runningProcesses?(limit?: number): Promise<ProcessEntry[]>;

  readClipboard?(): Promise<string>;
  writeClipboard?(text: string): Promise<boolean>;

  notify?(title: string, body?: string): Promise<boolean>;

  /** Atlas's own window. */
  showWindow?(): Promise<void>;
  hideWindow?(): Promise<void>;
  toggleWindow?(): Promise<void>;
}
