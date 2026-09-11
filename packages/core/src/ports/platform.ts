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
import type { NetworkAdapter, WifiStatus } from '../models/network';
import type { ServiceAction, ServiceDetail, ServiceEntry, ServiceOutcome } from '../models/service';
import type { EnvironmentScope, EnvVar } from '../models/environment';
import type { FolderSize, LargestFiles } from '../models/disk-usage';
import type { WindowEntry } from '../models/window';
import type { CursorPosition, MouseButton } from '../models/input';
import type { UiaNode } from '../models/uia';
import type { DisplayInfo } from '../models/screen';
import type { WindowsCompatibility } from '../models/compat';

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
  | 'window-control' // OTHER windows on the desktop: list, focus, move, close
  | 'input' // synthetic mouse and keyboard, for when nothing else can reach it
  | 'ui-automation' // inspect and operate other apps' actual controls
  | 'screen' // capture what's on screen, and read display information
  | 'network' // search the web, fetch a page
  | 'services' // Windows services: list, inspect, start/stop
  | 'environment' // environment variables: list, set, delete
  | 'storage' // what's using space inside a folder: size, largest files
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
   * Screen capture and displays, gated by `screen` — reached for only once a
   * Windows API or UI Automation can't answer the question (see
   * `screen-skills.ts`). Both captures resolve to a PNG.
   */
  captureWindow?(windowId: string): Promise<ArrayBuffer>;
  captureScreen?(): Promise<ArrayBuffer>;
  listDisplays?(): Promise<DisplayInfo[]>;

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
