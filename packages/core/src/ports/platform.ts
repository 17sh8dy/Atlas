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

import type { SpeechOptions, SpeechVoice } from '../models/speech';
import type { Transcript } from '../models/listening';

/** Names the engine checks before offering a skill. */
export type CapabilityName =
  | 'files' // read the file index
  | 'fs' // open/reveal paths on disk
  | 'apps' // enumerate and launch installed applications
  | 'system' // CPU/memory/disk/battery readings
  | 'processes' // what's running
  | 'clipboard'
  | 'notifications'
  | 'os' // the machine itself: lock, power, volume, media keys
  | 'windows' // Atlas's own window: show, hide, position
  | 'network' // search the web, fetch a page
  | 'speech' // say things out loud, locally
  | 'listening' // transcribe what you say, locally
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

/** What a single path is: a file or a folder, how big, when it changed. */
export interface PathInfo {
  path: string;
  name: string;
  ext: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt?: number;
  /** Entries directly inside, for a folder. Absent for a file. */
  entryCount?: number;
}

/** The folders every machine has, addressed by name rather than by path. */
export type KnownFolder =
  'home' | 'downloads' | 'documents' | 'desktop' | 'pictures' | 'music' | 'videos';

export type PowerAction = 'shutdown' | 'restart' | 'sign-out';
export type MediaKey = 'play-pause' | 'next' | 'previous' | 'stop';

export interface ProcessEntry {
  pid: number;
  name: string;
  cpuPercent?: number;
  memoryBytes?: number;
}

/** One hit from a web search. Titles, links and snippets only — never executable. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A page's readable text, for when a search snippet alone isn't enough. */
export interface WebPage {
  title: string;
  url: string;
  /** Headings/paragraphs/list items only — not a full article extractor. */
  text: string;
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

  /**
   * Speech, gated by the `speech` capability. Synthesis happens on this
   * machine, so it resolves without a network call and keeps working with
   * nothing connected — the same rule every other method here follows.
   *
   * ── Why this returns audio instead of playing it ────────────────────────
   * The platform's job is the part that needs the machine: a neural model and
   * a CPU. Playback needs speakers, which the surface already has, and a
   * surface that holds the audio can analyse it — which is what lets a
   * visualiser react to Atlas's actual voice rather than to a guess. An
   * earlier version played the sound in Rust and the page could not see a
   * single sample of it.
   */
  synthesizeSpeech?(text: string, options?: SpeechOptions): Promise<ArrayBuffer>;
  /** The voices this machine can actually produce. */
  speechVoices?(): Promise<SpeechVoice[]>;

  /**
   * Listening, gated by the `listening` capability.
   *
   * ── Why this takes audio instead of opening the microphone ──────────────
   * The mirror of `synthesizeSpeech`, and split for the mirror of its reason.
   * The platform's job is the part that needs the machine: a neural model and
   * a CPU. Recording needs a microphone, which the surface already has along
   * with the echo cancellation, the level meter and the silence detection
   * that decides when a sentence ended — none of which an implementation
   * behind this port could see.
   *
   * It also means no implementation of this port can start listening. It can
   * only be handed something already recorded, by a surface the user has
   * given permission to. That property is worth more than the convenience of
   * a `startListening()` would have been.
   *
   * Audio is 16 kHz mono WAV. `hints` is extra vocabulary — the names of
   * installed apps, say — appended to whatever the engine already expects to
   * hear, because a transcriber that mishears the thing you own is a
   * transcriber you stop using.
   */
  transcribeSpeech?(audio: ArrayBuffer, hints?: string): Promise<Transcript>;

  /**
   * Write a line to the app's diagnostics file.
   *
   * A second channel out of the webview, for failures the UI cannot be
   * trusted to show — because twice now the thing that broke was the code
   * that would have displayed the breakage. Never leaves the machine, and
   * nothing reads it back automatically.
   */
  logDiagnostic?(scope: string, message: string): Promise<void>;

  /** Atlas's own window. */
  showWindow?(): Promise<void>;
  hideWindow?(): Promise<void>;
  toggleWindow?(): Promise<void>;

  /**
   * File and folder operations, gated by `fs` like `openPath`/`revealPath`.
   * Every implementation re-validates the path server-side — a path from the
   * renderer is a claim, not a fact, the same rule that governs `openPath`.
   */
  createFile?(path: string, content?: string): Promise<boolean>;
  createFolder?(path: string): Promise<boolean>;
  renamePath?(path: string, newName: string): Promise<boolean>;
  movePath?(path: string, destDir: string): Promise<boolean>;
  copyPath?(path: string, destDir: string): Promise<boolean>;
  /** Sends to the OS recycle bin, never a permanent delete. */
  deletePath?(path: string): Promise<boolean>;
  /** Plain text only, size-capped. Rejects binary content and huge files. */
  readTextFile?(path: string): Promise<string>;

  /** What a path is, without opening it. */
  pathInfo?(path: string): Promise<PathInfo>;
  /** Add a line to a file, creating it if it isn't there yet. */
  appendFile?(path: string, content: string): Promise<boolean>;
  /** One folder's direct contents — not a recursive walk. */
  listDir?(path: string, limit?: number): Promise<FileEntry[]>;
  /** Resolve "Downloads" and friends against this machine. */
  knownFolder?(id: KnownFolder): Promise<string>;

  /**
   * Launch a known Windows system utility (Task Manager, Device Manager, …)
   * by id — the same "resolve by id against a server-enumerated list" shape
   * as `launchApp`, not a path or command string.
   */
  openSystemTool?(id: string): Promise<boolean>;

  /**
   * The machine itself, gated by `os`.
   *
   * Every one of these is a single named operation with an enumerated
   * argument — there is no "send this key" or "run this command", because a
   * general version of any of them would undo the point of having no `exec`.
   */
  lockWorkstation?(): Promise<boolean>;
  powerAction?(action: PowerAction): Promise<boolean>;
  mediaKey?(key: MediaKey): Promise<boolean>;
  /** Nudge the volume by notches, the way the keyboard keys do. */
  setVolume?(direction: 'up' | 'down', steps?: number): Promise<boolean>;
  toggleMute?(): Promise<boolean>;
  displayOff?(): Promise<boolean>;
  emptyRecycleBin?(): Promise<boolean>;

  /**
   * Search the web and fetch a page's readable text. The only two methods on
   * this port that leave the machine entirely, gated by `network` the same
   * way disk access is gated by `fs` — a browser build or a locked-down
   * environment can decline it, and the affected skills simply disappear
   * rather than fail. Both return plain text: neither is a way to run
   * anything found on a page, only to read it.
   */
  searchWeb?(query: string): Promise<WebSearchResult[]>;
  fetchPage?(url: string): Promise<WebPage>;
}
