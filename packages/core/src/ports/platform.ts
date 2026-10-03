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
import type { HaltEvent, HaltStatus } from '../models/halt';
import type { NetworkAdapter, WifiStatus } from '../models/network';
import type { ServiceAction, ServiceDetail, ServiceEntry, ServiceOutcome } from '../models/service';
import type { EnvironmentScope, EnvVar } from '../models/environment';
import type { FolderSize, LargestFiles } from '../models/disk-usage';
import type { WindowEntry } from '../models/window';
import type { CursorPosition, MouseButton } from '../models/input';
import type { UiaNode } from '../models/uia';
import type {
  ElevationOperation,
  ElevationOutcome,
  ElevationRequest,
  InputProbe,
  InputTarget,
} from '../models/elevation';
import type { DisplayInfo } from '../models/screen';
import type { WindowsCompatibility } from '../models/compat';
import type {
  DepManager,
  DevTool,
  GitLogEntry,
  GitStatus,
  ProjectInfo,
  SearchMatch,
  ToolResult,
  TreeEntry,
} from '../models/devtools';

/** Names the engine checks before offering a skill. */
export type CapabilityName =
  | 'files' // read the file index
  | 'fs' // open/reveal paths on disk
  | 'apps' // enumerate and launch installed applications
  | 'system' // CPU/memory/disk/battery readings
  | 'processes' // what's running
  | 'audio-devices' // which microphone and speakers are the defaults (read-only)
  | 'clipboard'
  | 'notifications'
  | 'os' // the machine itself: lock, power, volume, media keys
  | 'windows' // Atlas's own window: show, hide, position
  | 'window-control' // OTHER windows on the desktop: list, focus, move, close
  | 'input' // synthetic mouse and keyboard, for when nothing else can reach it
  | 'ui-automation' // inspect and operate other apps' actual controls
  | 'screen' // capture what's on screen, and read display information
  | 'network' // search the web, fetch a page
  | 'services' // Windows services: list, inspect, start/stop
  | 'environment' // environment variables: list, set, delete
  | 'storage' // what's using space inside a folder: size, largest files
  | 'devtools' // inspect a software project, search its text, drive its build/test tooling
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
/** One step of an OS file drag over the window. `over` and `leave` carry no paths. */
export interface FileDragEvent {
  phase: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
  /** Window-relative, in CSS pixels. */
  x: number;
  y: number;
}

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
export interface DuplicateGroup {
  sizeBytes: number;
  paths: string[];
}
export interface Duplicates {
  groups: DuplicateGroup[];
  /** Bytes freed by keeping one copy of each group. */
  wastedBytes: number;
  truncated: boolean;
}
export interface ChangedFile {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}
export interface FileAttributes {
  readOnly: boolean;
  hidden: boolean;
  system: boolean;
}
export interface GitBranches {
  current: string;
  branches: string[];
}
export interface PingResult {
  address: string;
  sent: number;
  received: number;
  timesMs: number[];
}
export interface CleanupScan {
  kind: string;
  folder: string;
  files: number;
  bytes: number;
  largest: Array<{ path: string; sizeBytes: number }>;
  truncated: boolean;
  /** True when cleaning sends these to the Recycle Bin rather than removing them for good. */
  recoverable: boolean;
}
export interface CleanupDone {
  kind: string;
  removedFiles: number;
  removedBytes: number;
  skippedFiles: number;
  recoverable: boolean;
}
export interface ProcessDetails {
  pid: number;
  name: string;
  path: string | null;
  memoryBytes: number;
  runningSeconds: number;
  parentPid: number | null;
}
export interface FirmwareInfo {
  computerName: string;
  userName: string;
  biosVendor: string | null;
  biosVersion: string | null;
  biosDate: string | null;
  systemMaker: string | null;
  systemModel: string | null;
  boardMaker: string | null;
  boardModel: string | null;
}
export interface SecurityStatus {
  firewallDomain: boolean | null;
  firewallPrivate: boolean | null;
  firewallPublic: boolean | null;
  defenderRealtime: boolean | null;
  atlasElevated: boolean;
}
export interface ArchiveListing {
  entries: Array<{ name: string; sizeBytes: number; isDir: boolean }>;
  totalEntries: number;
  totalBytes: number;
}
export interface FindFilesQuery {
  path: string;
  ext?: string;
  minBytes?: number;
  maxBytes?: number;
  modifiedWithinDays?: number;
  olderThanDays?: number;
  /** Look for empty ones instead. */
  empty?: 'files' | 'folders' | 'any';
  limit?: number;
}
export interface FoundFiles {
  items: Array<{ path: string; name: string; sizeBytes: number; isDir: boolean; modifiedAt: number }>;
  total: number;
  truncated: boolean;
}
export interface FolderComparison {
  onlyInA: string[];
  onlyInB: string[];
  different: string[];
  same: number;
  truncated: boolean;
}
export interface FileComparison {
  identical: boolean;
  sizeA: number;
  sizeB: number;
}
export interface BrightnessInfo {
  level: number;
  monitors: number;
}
export interface AppVolume {
  app: string;
  pid: number;
  level: number;
  muted: boolean;
}
export type PowerPlan = 'balanced' | 'high-performance' | 'power-saver' | 'custom';
export type ProjectionMode = 'pc-only' | 'duplicate' | 'extend' | 'second-only';
export interface BinItem {
  name: string;
  original: string;
  sizeBytes: number;
  deletedAt: number;
  isDir: boolean;
}
export interface StartupApp {
  name: string;
  command: string;
  enabled: boolean;
  scope: 'user' | 'machine';
}
export interface PrinterList {
  default: string | null;
  names: string[];
}
export interface SpeedResult {
  downloadMbps: number;
  latencyMs: number;
  bytes: number;
}
export interface MediaInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateKbps: number | null;
  sizeBytes: number;
}
export interface MediaResult {
  output: string;
  inputBytes: number;
  outputBytes: number;
}
export interface WingetPackage {
  name: string;
  id: string;
  version: string;
}
export interface Specs {
  cpu: string;
  cores: number;
  threads: number;
  memoryGb: number;
  os: string;
  computer: string;
  gpus: string[];
}
export interface SubfolderSize {
  name: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
}
export interface LargestSubfolders {
  folders: SubfolderSize[];
  looseBytes: number;
  totalBytes: number;
  truncated: boolean;
}
export interface RadioInfo {
  kind: 'wifi' | 'bluetooth' | 'other';
  name: string;
  on: boolean;
}
export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  status: 'playing' | 'paused' | 'stopped' | 'other';
  /** The app's own identifier, e.g. "Spotify.exe". */
  app: string;
  shuffle: boolean | null;
}
export interface ExplorerOptions {
  fileExtensions: boolean;
  hiddenFiles: boolean;
}
/** A speaker or microphone's state: 0–100 and whether it is muted. */
export interface AudioLevel {
  level: number;
  muted: boolean;
}

/**
 * The default audio devices, by the name Windows shows for them — "Shure MV7+"
 * — or null when there is no such device. Read-only: Atlas reports which
 * microphone is in use; changing the default device has no documented API.
 */
export interface AudioDevices {
  input: string | null;
  output: string | null;
}

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
  /** Which provider returned it — set by the search manager, not by the provider's own code. */
  provider?: string;
  /** As the source reported it, when it did. Providers differ; never assume it is present or parseable. */
  publishedDate?: string;
}

/**
 * The search backends Atlas knows how to call. A fixed list on purpose: the
 * native side dispatches on it, so this is an allowlist of named backends
 * and not a general "make an HTTP request" door. Adding one (SearXNG, Brave,
 * a crawler of our own) is one new arm natively and one new provider in the
 * engine — nothing above the search manager changes.
 */
export type SearchProviderId = 'tavily' | 'duckduckgo' | 'wikipedia';

/** What kind of results a query wants; a hint, and every provider may ignore it. */
export interface WebSearchOptions {
  topic?: 'general' | 'news';
}

/**
 * Why a search backend refused, as a category the manager can act on rather
 * than a message it would have to parse. The native side prefixes its errors
 * with one of these (see `classifySearchError` in the engine).
 */
export type SearchFailureKind =
  | 'quota' // the plan's allowance is used up: stop asking for a while
  | 'auth' // the key is missing, wrong or revoked
  | 'rate' // too many requests right now: brief back-off
  | 'blocked' // the engine wants a human (a CAPTCHA): back off longer
  | 'offline' // could not reach it at all
  | 'error'; // anything else

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
  /**
   * Open an http(s) URL with a *named* installed app — resolved against
   * `listApps()`, the same trust boundary `launchApp` rests on — rather than
   * whichever browser the OS default-handler association happens to prefer.
   * `openUrl` stays the right call when no browser was named explicitly.
   */
  openUrlWithApp?(appId: string, url: string): Promise<boolean>;

  systemInfo?(): Promise<SystemSnapshot>;
  runningProcesses?(limit?: number): Promise<ProcessEntry[]>;
  /** The default microphone and speakers. See `AudioDevices`. */
  audioDevices?(): Promise<AudioDevices>;

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
   * Get ready to speak, without speaking.
   *
   * Some engines are a process launch away from ready and some are a hundred
   * megabytes of weights away. This lets a surface pay that cost at a moment
   * of its choosing — one where nothing is waiting — instead of having it land
   * in front of the first sentence.
   *
   * Optional in every sense: absent on platforms with nothing to warm, and
   * resolving `false` on ones where the engine that would benefit is not
   * installed. Nothing depends on it having been called.
   */
  warmSpeech?(): Promise<boolean>;

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
   * The machine's networking, gated by `network`.
   *
   * Read-only by construction: there is no method here that changes an
   * adapter, joins a network or forgets a profile. That is not an oversight —
   * Phase 11 puts reads and system-changing operations in different risk
   * tiers, and keeping them in different methods means a caller cannot reach
   * for the wrong one by mistake.
   */
  networkAdapters?(): Promise<NetworkAdapter[]>;
  wifiStatus?(): Promise<WifiStatus>;
  /** Saved Wi-Fi profiles. Empty on a machine with no wireless. */
  wifiNetworks?(): Promise<string[]>;
  /**
   * Is there actually a working connection?
   *
   * A real request rather than a ping: what people mean by "am I online" is
   * whether things work, and a machine answers ICMP perfectly well while DNS
   * is broken or a captive portal is intercepting everything.
   */
  networkReachable?(): Promise<boolean>;

  /**
   * Windows services, gated by `services`.
   *
   * The first group in this port where reading and changing sit side by side,
   * so the split is deliberate: `listServices` and `serviceDetail` observe and
   * `serviceControl` acts, and there is no method that does both. A caller
   * reaching for the wrong one is then a visible mistake rather than a
   * surprise.
   *
   * The implementation is expected to refuse outright, not merely report a
   * failure, when asked to stop a service the machine cannot survive losing —
   * `ServiceEntry.protected` marks those, and the refusal belongs next to the
   * process, not only in the UI drawing the card.
   */
  listServices?(): Promise<ServiceEntry[]>;
  serviceDetail?(name: string): Promise<ServiceDetail>;
  serviceControl?(name: string, action: ServiceAction): Promise<ServiceOutcome>;

  /**
   * Environment variables, gated by `environment`.
   *
   * `listEnvironmentVariables` reads both persisted scopes — the user's own
   * and the machine's — and tags each entry with which one it came from,
   * because the same name can exist in both with different values. Setting or
   * deleting a `system`-scoped variable needs administrator rights; see
   * `environment.rs`'s module doc for the elevation story and why a value set
   * here is never visible to a process that was already running.
   */
  listEnvironmentVariables?(): Promise<EnvVar[]>;
  setEnvironmentVariable?(name: string, value: string, scope: EnvironmentScope): Promise<boolean>;
  deleteEnvironmentVariable?(name: string, scope: EnvironmentScope): Promise<boolean>;

  /**
   * What's using the space inside one folder, gated by `storage`.
   *
   * The counterpart to `systemInfo`'s per-drive `disks` array: that answers
   * "how full is the drive", this answers "what's using the space inside this
   * *folder*". Both cap how much they'll walk and report `truncated` rather
   * than silently returning a wrong-but-plausible number for a folder too big
   * to fully measure — see `disk_usage.rs`'s module doc.
   */
  folderSize?(path: string): Promise<FolderSize>;
  /** The largest files under a folder, most-bytes first. */
  largestFiles?(path: string, limit?: number): Promise<LargestFiles>;
  /** Which immediate subfolders are biggest — one walk, bounded in time. */
  largestSubfolders?(path: string, limit?: number): Promise<LargestSubfolders>;

  /**
   * A software project's own tooling, gated by `devtools`.
   *
   * The same rule as everywhere else on this port applies here at its
   * sharpest: `runDevTool` never takes a command string, only a closed
   * `DevTool` naming a fixed executable and subcommand, plus one validated
   * argument slot (a target, a script name, a test filter). A reader can
   * enumerate the complete set of programs this method will ever run by
   * reading `DevTool`'s definition — the same test `net.rs`'s module doc
   * applies to `ipconfig`/`netsh`.
   *
   * Every path here is scoped by the same allowed-folders list as the rest of
   * the `fs` group; `detectProject`/`dirTree`/`codeSearch`/`git*` all refuse a
   * `cwd` outside it, the same "a path is a claim, not a fact" rule.
   */
  detectProject?(cwd: string): Promise<ProjectInfo>;
  /** A bounded recursive listing — `listDir` is one folder deep; this isn't. */
  dirTree?(cwd: string, maxDepth?: number, maxEntries?: number): Promise<TreeEntry[]>;
  /**
   * Search file *contents*, not just names — the dedicated, capability-gated
   * exception to "the index reads names, never contents" (see
   * `docs/ARCHITECTURE.md` §7 and the five binding decisions in Phase 12's
   * roadmap notes): a door this port always left open, never a quiet widening
   * of `searchFiles`.
   */
  codeSearch?(cwd: string, query: string, glob?: string, limit?: number): Promise<SearchMatch[]>;
  gitStatus?(cwd: string): Promise<GitStatus>;
  /** Unstaged changes, or one path's, as unified diff text. */
  gitDiff?(cwd: string, path?: string): Promise<string>;
  gitLog?(cwd: string, limit?: number): Promise<GitLogEntry[]>;
  gitAdd?(cwd: string, path: string): Promise<boolean>;
  /** Returns the new commit's short hash. */
  gitCommit?(cwd: string, message: string): Promise<string>;
  gitBranches?(cwd: string): Promise<GitBranches>;
  /** Switch branch, or create-then-switch. The name is validated natively; no flags pass through. */
  gitCheckout?(cwd: string, branch: string, create: boolean): Promise<string>;
  /** Fast-forward only. */
  gitPull?(cwd: string): Promise<string>;
  /** The current branch to its own upstream — never forced. */
  gitPush?(cwd: string): Promise<string>;
  gitStash?(cwd: string, action: string): Promise<string>;
  /** merge / tag / tags / unstage / discard / init — a closed set, see `git_more`. */
  gitMore?(cwd: string, action: string, arg?: string): Promise<string>;
  /** A new terminal window with this folder as its working directory. */
  openProjectTerminal?(cwd: string): Promise<boolean>;
  /** VS Code on this folder, launched directly (no shell). */
  openProjectEditor?(cwd: string): Promise<boolean>;
  runDevTool?(cwd: string, tool: DevTool, arg?: string): Promise<ToolResult>;
  /**
   * Run one PowerShell script, window-less, under the emergency stop, for at most a minute.
   * The last resort: the engine's `powershell.run` shows the person the whole script and gets a yes
   * first, and the native side refuses a fixed list of dangerous things and any drive path outside
   * Allowed Folders on its own account. `cwd`, if given, must be an allowed folder.
   */
  runPowerShell?(script: string, cwd?: string): Promise<ToolResult>;
  /**
   * Add one dependency to a project, gated by `devtools` alongside the rest
   * of this group. The same rule as `runDevTool`, applied to `install`/`add`
   * instead of `build`/`test`: `manager` is a closed set naming a fixed
   * executable, `package` is the one validated slot (never a manager flag —
   * see `install_dependency`'s doc comment for why a leading `-` is refused
   * outright), and `dev` is a plain boolean, never a raw argument list.
   */
  installDependency?(
    cwd: string,
    manager: DepManager,
    pkg: string,
    dev?: boolean,
  ): Promise<ToolResult>;
  /**
   * Overwrite a file that already exists — the inverse of `createFile`, which
   * refuses when one does. Kept as a separate method rather than a flag on
   * `createFile` because they answer different questions ("make this" vs.
   * "this already exists, change it") and a caller should never be able to
   * blur the two by mistake.
   */
  writeTextFile?(path: string, content: string): Promise<boolean>;
  /**
   * Replace an exact substring in a file — refuses when `find` isn't present,
   * and refuses when it isn't unique unless `replaceAll` is set. The same
   * discipline as a precise text editor: a whole-file overwrite from a model
   * regenerating everything it just read is a much larger failure surface
   * than one verified, exact replacement. Returns a short message naming how
   * many replacements were made.
   */
  patchTextFile?(
    path: string,
    find: string,
    replace: string,
    replaceAll?: boolean,
  ): Promise<string>;

  /**
   * The allowed-folders list — not gated by a `CapabilityName`, because it
   * governs several of them at once (`fs`, `files`, `storage`) rather than
   * being a capability itself. Every path-taking command on this port is
   * refused outside these folders; `%USERPROFILE%` alone is the default,
   * preserving today's reach until a person explicitly widens it. See
   * `allowed_folders.rs`'s module doc for the whole design.
   */
  allowedFolders?(): Promise<string[]>;
  /** Add a folder. Rejects a path that doesn't exist or isn't a folder. */
  addAllowedFolder?(path: string): Promise<string[]>;
  /** Remove a folder. Refuses to empty the list entirely. */
  removeAllowedFolder?(path: string): Promise<string[]>;

  /**
   * Windows other than Atlas's own, gated by `window-control`.
   *
   * `listWindows` returns the same set Alt+Tab roughly shows — visible,
   * titled, top-level windows — because that is the set a person means by
   * "my windows". `activeWindow` deliberately answers even for a window that
   * filter would exclude: "what's focused right now" should never come back
   * empty just because the focused thing is a utility window.
   *
   * Every method taking an `id` re-resolves it against the live desktop
   * rather than trusting a handle the renderer is holding onto — a window can
   * close between being listed and being acted on, the same trust boundary
   * every path-taking method on this port already has.
   */
  listWindows?(): Promise<WindowEntry[]>;
  activeWindow?(): Promise<WindowEntry | null>;
  focusWindow?(id: string): Promise<boolean>;
  minimizeWindow?(id: string): Promise<boolean>;
  /** Keep a window above all others, or release it. Only the z-order changes. */
  setWindowTopmost?(id: string, on: boolean): Promise<boolean>;
  maximizeWindow?(id: string): Promise<boolean>;
  restoreWindow?(id: string): Promise<boolean>;
  /** Any field left out keeps the window's current value for it. */
  setWindowBounds?(
    id: string,
    bounds: { x?: number; y?: number; width?: number; height?: number },
  ): Promise<boolean>;
  /** A request to close, the same one `WM_CLOSE` sends — not a forced kill. */
  closeWindow?(id: string): Promise<boolean>;
  /**
   * End a running process outright, gated by `window-control` alongside the
   * rest of this group since both read from the same process list. Refused
   * rather than merely confirmed for anything the session doesn't survive
   * losing — see `end_process`'s guard in `window.rs`.
   */
  endProcess?(pid: number): Promise<boolean>;

  /**
   * Synthetic mouse and keyboard, gated by `input` — the last resort, tried
   * only once a Windows API or UI Automation can't reach a control.
   *
   * `moveMouse`, `cursorPosition` and `mouseScroll` are `safe` at the skill
   * layer: moving the cursor or scrolling is cosmetic and instantly
   * reversible. A click, a drag, a key press or typed text can do anything
   * the target application lets a human do, which is why every one of those
   * is `confirm` — see `window-skills.ts`'s doc comment for the same
   * reasoning applied to closing a window.
   */
  moveMouse?(x: number, y: number): Promise<boolean>;
  cursorPosition?(): Promise<CursorPosition>;
  mouseClick?(x: number, y: number, button: MouseButton, double?: boolean): Promise<boolean>;
  /** Notches, not pixels — positive scrolls up, negative scrolls down. */
  mouseScroll?(amount: number): Promise<boolean>;
  mouseDrag?(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button?: MouseButton,
  ): Promise<boolean>;
  /** A named key from a closed table — never an arbitrary code. */
  pressKey?(key: string): Promise<boolean>;
  /** Up to three modifiers plus one key, e.g. `(['ctrl'], 'c')`. */
  hotkey?(modifiers: string[], key: string): Promise<boolean>;
  /** Arbitrary Unicode text, sent character by character. */
  typeText?(text: string): Promise<boolean>;

  /**
   * UI Automation, gated by `ui-automation` — the preferred way to operate
   * another application, ahead of raw input, because it acts on the control
   * itself rather than guessing at where it happens to be drawn.
   *
   * `path` addresses an element as the sequence of child indices from the
   * window's root — see `UiaNode`'s doc comment for why. `uiaTree` is `safe`
   * at the skill layer; every action method acts on another application on
   * your behalf and is `confirm`.
   */
  uiaTree?(windowId: string, maxDepth?: number): Promise<UiaNode>;
  /** Whatever currently has keyboard focus, system-wide. */
  uiaFocusedElement?(): Promise<UiaNode | null>;
  /** Click, toggle or select — whichever pattern the element actually supports. */
  uiaInvoke?(windowId: string, path: number[]): Promise<boolean>;
  uiaSetExpanded?(windowId: string, path: number[], expand: boolean): Promise<boolean>;
  /** Direct text entry via ValuePattern — fails when the control doesn't support it. */
  uiaSetValue?(windowId: string, path: number[], value: string): Promise<boolean>;
  /** Bring keyboard focus to an element, e.g. before falling back to `typeText`. */
  uiaFocus?(windowId: string, path: number[]): Promise<boolean>;

  /**
   * Would input to this target be allowed? Answered without sending anything —
   * so a Windows permission screen, or a window running above Atlas, is refused
   * outright instead of being put to the person as a question. The native side
   * makes the same check again on every input, so this is an early answer, not
   * the guarantee.
   */
  inputProbe?(target?: InputTarget): Promise<InputProbe>;

  /**
   * Administrator rights, one approved action at a time. `elevationPrepare`
   * checks an operation against a closed set and returns a one-time token bound
   * to it; nothing runs. `elevationRun` redeems the token — once, within a
   * minute, only if nothing material changed — and Windows shows its own
   * prompt. `elevationCancel` drops an approval that was denied. Atlas never
   * sees or answers that prompt.
   */
  elevationStatus?(): Promise<{ elevated: boolean }>;
  elevationPrepare?(op: ElevationOperation): Promise<ElevationRequest>;
  elevationRun?(token: string, commandLine: string): Promise<ElevationOutcome>;
  elevationCancel?(token: string): Promise<boolean>;

  /**
   * Screen capture and displays, gated by `screen` — reached for only once a
   * Windows API or UI Automation can't answer the question (see
   * `screen-skills.ts`). Both captures resolve to a PNG.
   */
  captureWindow?(windowId: string): Promise<ArrayBuffer>;
  captureScreen?(): Promise<ArrayBuffer>;
  /**
   * One monitor, by its index in `listDisplays`.
   *
   * Separate from `captureScreen`, which takes the whole virtual desktop in
   * one go. That is right for "take a screenshot" and wrong for sharing: on a
   * multi-monitor machine it hands over every monitor at once, including the
   * one nobody chose. Sharing a screen has to mean *that* screen or the
   * choice isn't one.
   */
  captureDisplay?(index: number): Promise<ArrayBuffer>;
  listDisplays?(): Promise<DisplayInfo[]>;

  /**
   * Let the person choose files, through the OS picker.
   *
   * Only ever called from an explicit click — there is no way for Atlas to
   * raise this dialog on its own, and no save half to it. Resolves to the
   * chosen paths, or an empty array if the dialog was dismissed.
   *
   * Paths, not contents: an attachment is a *reference* (see
   * `models/attachment.ts`), and everything Atlas can already do to a file it
   * does by path. A browser `<input type="file">` was the alternative and is
   * useless here — it hands back a `File` with no path, which no skill can
   * act on.
   *
   * ⚠️ Picking a file does **not** widen the allowed-folders boundary.
   * `readTextFile` still refuses a path outside it, and the composer says so
   * plainly rather than failing silently. Treating the pick as a per-file
   * grant would be defensible — an OS picker *is* consent, and that is how
   * every other application treats it — but it is a real loosening of the one
   * boundary every file command shares, so it is a decision to take
   * deliberately rather than as a side effect of adding an attach button.
   */
  pickFiles?(options?: {
    /** Extension groups to offer, e.g. `[{ name: 'Images', extensions: ['png','jpg'] }]`. */
    filters?: { name: string; extensions: string[] }[];
    multiple?: boolean;
    title?: string;
  }): Promise<string[]>;

  /**
   * The system's folder chooser. One folder, or `null` if cancelled. Like
   * `pickFiles` it hands back a path and grants nothing: choosing a folder
   * here does not add it to Allowed Folders.
   */
  pickFolder?(options?: { title?: string }): Promise<string | null>;

  /**
   * Files dragged in from outside Atlas, as the desktop shell reports them:
   * paths (on `enter` and `drop`) and a window-relative position in CSS pixels.
   * Returns the function that stops listening. Absent in the browser build,
   * where a dropped file has no path a skill could use.
   */
  onFileDrag?(handler: (event: FileDragEvent) => void): Promise<() => void>;

  /**
   * Whether the summon key (Ctrl+Space) could be reserved: `null` when it could,
   * otherwise a sentence saying why not — another program owns it. Atlas starts
   * either way.
   */
  summonKeyStatus?(): Promise<string | null>;

  /**
   * Which Windows this is — informational, shown in About. Not gated by a
   * `CapabilityName`: nothing in this port actually varies by version, so
   * there is no skill to hide and no planner decision this affects.
   */
  windowsCompatibility?(): Promise<WindowsCompatibility>;

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
  /**
   * Move to an exact destination path, name included — `movePath` keeps the
   * file's own name, so it cannot say "put it there as `setup (2).exe`". Never
   * overwrites: something already at `to` is a refusal, not a replacement.
   * Both ends are validated against the allowed folders, like every other
   * file operation.
   */
  movePathTo?(from: string, to: string): Promise<boolean>;
  copyPath?(path: string, destDir: string): Promise<boolean>;
  /** Sends to the OS recycle bin, never a permanent delete. */
  deletePath?(path: string): Promise<boolean>;
  /** Plain text only, size-capped. Rejects binary content and huge files. */
  readTextFile?(path: string): Promise<string>;

  /** What a path is, without opening it. */
  pathInfo?(path: string): Promise<PathInfo>;
  /**
   * Is there a folder (or file) at this absolute path? Answers only that — name and whether it is a
   * folder — and works OUTSIDE Allowed Folders, which `pathInfo` deliberately does not. It exists
   * for the "Add It? / Not Now" offer, which must know a folder is real before it is allowed.
   */
  probePath?(path: string): Promise<PathInfo>;
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
  /** What this PC can do — hibernation in particular may be switched off. */
  powerStates?(): Promise<{ sleep: boolean; hibernate: boolean }>;
  /** Put the PC to sleep or hibernate it. Refused when hibernation is off. */
  sleepPc?(kind: 'sleep' | 'hibernate'): Promise<boolean>;
  /** Windows' own countdown (10 s – 24 h), cancellable by anyone with `shutdown /a`. */
  scheduleShutdown?(action: 'shutdown' | 'restart', seconds: number): Promise<boolean>;
  /** false = nothing was pending. */
  cancelShutdown?(): Promise<boolean>;
  /** Exact speaker volume/mute, unlike `setVolume`'s notches. Pass null to leave one alone. */
  volumeState?(): Promise<AudioLevel>;
  volumeSet?(level: number | null, muted: boolean | null): Promise<AudioLevel>;
  micState?(): Promise<AudioLevel>;
  micSet?(level: number | null, muted: boolean | null): Promise<AudioLevel>;
  themeGet?(): Promise<'light' | 'dark'>;
  themeSet?(mode: 'light' | 'dark'): Promise<boolean>;
  emptyRecycleBin?(): Promise<boolean>;

  /** winget, with fixed arguments and a validated id. Rejects with a plain message when winget is not installed. */
  wingetSearch?(query: string): Promise<WingetPackage[]>;
  wingetInstall?(id: string): Promise<string>;
  wingetUninstall?(id: string): Promise<string>;
  wingetUpgrade?(id: string): Promise<string>;
  wingetUpgrades?(): Promise<WingetPackage[]>;
  /** CPU, memory, OS and graphics cards. */
  hardwareSpecs?(): Promise<Specs>;
  /** Clear the DNS resolver cache. */
  flushDns?(): Promise<string>;
  /** A new Vite app in a new folder `name` inside `parent`. Refuses an existing folder. */
  scaffoldProject?(parent: string, name: string, template: string): Promise<ToolResult>;
  /** Deploy the project with Vercel's or Cloudflare's own CLI. */
  deployProject?(cwd: string, target: 'vercel' | 'cloudflare'): Promise<ToolResult>;
  /** ffmpeg-backed: a smaller copy of a video / a converted file / a resized picture. All new files. */
  compressVideo?(path: string, level: string): Promise<MediaResult>;
  convertMedia?(path: string, format: string): Promise<MediaResult>;
  resizeImage?(path: string, width: number | null, percent: number | null): Promise<MediaResult>;
  /** Length, size, frame rate and codecs of a media file (ffmpeg). Read-only. */
  mediaInfo?(path: string): Promise<MediaInfo>;
  /** trim / frame / rotate / flip / square / thumbnail — a fixed recipe each, to a new file. */
  editMedia?(path: string, op: string, a?: number, b?: number): Promise<MediaResult>;
  /** Monitor brightness over DDC/CI — rejects when no display lets Windows change it. */
  brightnessGet?(): Promise<BrightnessInfo>;
  brightnessSet?(level: number): Promise<BrightnessInfo>;
  /** Per-app volume (apps with an audio session on the default speakers). */
  appVolumes?(): Promise<AppVolume[]>;
  setAppVolume?(app: string, level: number | null, muted: boolean | null): Promise<AppVolume[]>;
  powerPlan?(): Promise<PowerPlan>;
  setPowerPlan?(plan: 'balanced' | 'high-performance' | 'power-saver'): Promise<PowerPlan>;
  projectDisplay?(mode: ProjectionMode): Promise<boolean>;
  recycleBinList?(limit?: number): Promise<BinItem[]>;
  /** Restore the newest item with this name; never overwrites. */
  recycleBinRestore?(name: string): Promise<BinItem>;
  startupApps?(): Promise<StartupApp[]>;
  setStartupApp?(name: string, enabled: boolean): Promise<StartupApp>;
  /** Open a page of Windows Settings from a fixed table. */
  openSettingsPage?(page: string): Promise<boolean>;
  printers?(): Promise<PrinterList>;
  setDefaultPrinter?(name: string): Promise<PrinterList>;
  /** The shell's own "print" verb, for documents and pictures in the allowed folders. */
  printFile?(path: string): Promise<boolean>;
  speedTest?(): Promise<SpeedResult>;
  /** Play one of Atlas's own alert tones (chime, bell, beep, soft, alarm, system) at a volume 0–100. */
  playSound?(kind: string, volume?: number): Promise<boolean>;
  /** Hold one key for 0.1–10 s, always released. */
  holdKey?(key: string, seconds: number): Promise<boolean>;

  /** Set the wallpaper to a .jpg/.png/.bmp inside the allowed folders. */
  setWallpaper?(path: string): Promise<boolean>;
  /** 1 (slowest) – 20 (fastest); 10 is Windows' default. */
  mouseSpeed?(): Promise<number>;
  setMouseSpeed?(speed: number): Promise<number>;
  explorerOptions?(): Promise<ExplorerOptions>;
  setExplorerOption?(which: 'file-extensions' | 'hidden-files', show: boolean): Promise<ExplorerOptions>;
  /** Closes open File Explorer windows; Windows restores the taskbar by itself. */
  restartExplorer?(): Promise<number>;
  doNotDisturb?(): Promise<boolean>;
  setDoNotDisturb?(on: boolean): Promise<boolean>;
  radios?(): Promise<RadioInfo[]>;
  setRadio?(kind: 'wifi' | 'bluetooth', on: boolean): Promise<RadioInfo[]>;
  /** The system media session — null when nothing is playing. */
  nowPlaying?(): Promise<NowPlaying | null>;
  setShuffle?(on: boolean): Promise<boolean>;

  /** Zip a file or folder into a new .zip (never overwrites); resolves to the archive's path. */
  zipPath?(path: string, destDir?: string): Promise<string>;
  /** Extract a .zip into a new folder beside it (zip-slip and size guarded); resolves to the folder. */
  unzipPath?(path: string, destDir?: string): Promise<string>;
  /** Four ICMP echoes to a host name or IPv4 address. */
  pingHost?(host: string): Promise<PingResult>;
  /** The addresses a host name resolves to. */
  dnsLookup?(host: string): Promise<string[]>;
  /** The hops to a host, one line each. */
  traceRoute?(host: string): Promise<string[]>;
  /** Where a running process's program is, how much memory it holds, how long it has been up. Never its command line. */
  processDetails?(pid: number): Promise<ProcessDetails>;
  /** BIOS, motherboard, computer and user name. */
  firmwareInfo?(): Promise<FirmwareInfo>;
  /** Firewall, Defender and whether Atlas is elevated. Reads only. */
  securityStatus?(): Promise<SecurityStatus>;
  /** Byte-for-byte comparison of two files. Read-only. */
  compareFiles?(a: string, b: string): Promise<FileComparison>;
  /** Identical files in a folder, largest first. Read-only. */
  findDuplicates?(path: string): Promise<Duplicates>;
  /** A copy of a file or folder beside it ("X - Copy"); resolves to the new path. Never overwrites. */
  duplicatePath?(path: string): Promise<string>;
  /** A .lnk to an existing file or folder, in `dir`; resolves to its path. */
  createShortcut?(target: string, dir: string, name?: string): Promise<string>;
  /** A .url shortcut to an http(s) address, in `dir`; resolves to its path. */
  createUrlShortcut?(url: string, name: string, dir: string): Promise<string>;
  /** How much of one kind of leftover there is (temp / crashdumps / installers). Counts only. */
  cleanupScan?(kind: string): Promise<CleanupScan>;
  /** Remove what was reviewed — refuses if there is noticeably more now. */
  cleanupClean?(kind: string, expectedFiles: number, expectedBytes: number): Promise<CleanupDone>;
  /** Whether git and ffmpeg are installed, and their versions. */
  toolVersions?(): Promise<{ git: string | null; ffmpeg: string | null }>;
  /** SHA-256 of one file. Read-only. */
  fileHash?(path: string): Promise<{ sha256: string; sizeBytes: number }>;
  /** What is inside a .zip, without extracting. Read-only. */
  listArchive?(path: string, limit?: number): Promise<ArchiveListing>;
  /** Files by extension / size / age, or the empty ones. Read-only. */
  findFiles?(query: FindFilesQuery): Promise<FoundFiles>;
  /** How two folders differ. Read-only. */
  compareFolders?(a: string, b: string): Promise<FolderComparison>;
  /** Files changed in the last N hours, newest first. */
  recentChanges?(path: string, hours: number, limit?: number): Promise<ChangedFile[]>;
  fileAttributes?(path: string): Promise<FileAttributes>;
  /** null leaves that attribute alone. System files are refused. */
  setFileAttributes?(path: string, readOnly: boolean | null, hidden: boolean | null): Promise<FileAttributes>;

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
  /**
   * Search through one named backend. `searchWeb` above stays as the
   * key-free default (DuckDuckGo); this is how the engine's search manager
   * reaches the others. A backend that needs a credential reads it on the
   * native side — the key never crosses into the renderer. A refusal comes
   * back as a rejected promise whose message starts with a
   * `SearchFailureKind` tag, e.g. `quota: …`.
   */
  searchWebWith?(
    provider: SearchProviderId,
    query: string,
    options?: WebSearchOptions,
  ): Promise<WebSearchResult[]>;
  /** Is this backend usable right now (for a keyed one: is a key saved)? Never returns the key. */
  searchProviderReady?(provider: SearchProviderId): Promise<boolean>;

  /**
   * The emergency stop, when this build has a native one — see
   * `models/halt.ts` for why it lives below the engine rather than in it.
   * Absent in the browser build, where the on-screen button still stops the
   * engine but there is no global key and nothing native to latch.
   */
  halt?: {
    /** Same path as the key: latch, cut requests, stop processes, emit. */
    now(): Promise<number>;
    status(): Promise<HaltStatus>;
    /** Clear the latch for the halt with this epoch. False if a newer one happened. */
    reset(epoch: number): Promise<boolean>;
    /** Rebind the key. Rejects with the reason if Windows or the rules refuse it. */
    setShortcut(shortcut: string): Promise<HaltStatus>;
    /** Every halt, whichever way it was triggered. Resolves to an unsubscribe. */
    onHalt(listener: (event: HaltEvent) => void): Promise<() => void>;
    /**
     * Tell the shell whether there is a run in flight.
     *
     * The stop key is registered system-wide, so it is swallowed everywhere
     * Atlas is running — and a press with nothing to stop must therefore do
     * nothing at all, rather than latch and pull Atlas's window in front of
     * whatever you were actually doing. Only the surface knows the answer: a
     * plan mid-flight, an open confirm card and a model being waited on are
     * all invisible to the shell. Reported on every change, and `false` on
     * mount, so a reload leaves nothing stale behind.
     */
    setWorking(working: boolean): Promise<void>;
  };
}
