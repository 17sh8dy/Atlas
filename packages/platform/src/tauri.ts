/**
 * The Tauri implementation of the `Platform` port.
 *
 * Deliberately dumb: every method is a one-line `invoke` of a command defined
 * in `src-tauri/src/platform.rs`. No validation, no path fixing, no cleverness
 * happens here — because this file runs in the webview, which is the least
 * trusted part of the application. Anything enforced here could be bypassed by
 * whatever else ends up running in that context, so all of it is enforced in
 * Rust and this is just the phone line.
 */

import type {
  AppEntry,
  CapabilityName,
  FileEntry,
  Platform,
  ProcessEntry,
  SystemSnapshot,
  NetworkAdapter,
  ServiceDetail,
  ServiceEntry,
  ServiceOutcome,
  EnvironmentScope,
  EnvVar,
  FolderSize,
  LargestFiles,
  SpeechVoice,
  Transcript,
  WebPage,
  WifiStatus,
  PathInfo,
  WebSearchResult,
  WindowEntry,
  CursorPosition,
  MouseButton,
  UiaNode,
  DisplayInfo,
  WindowsCompatibility,
  DevTool,
  GitLogEntry,
  GitStatus,
  ProjectInfo,
  SearchMatch,
  ToolResult,
  TreeEntry,
  HaltEvent,
  HaltStatus,
} from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

export function createTauriPlatform(): Platform {
  return {
    id: 'tauri',

    capabilities: () => invoke<CapabilityName[]>('capabilities'),

    searchFiles: (query, opts) =>
      invoke<FileEntry[]>('search_files', {
        query,
        kind: opts?.kind ?? null,
        limit: opts?.limit ?? null,
      }),

    openPath: (path) => invoke<boolean>('open_path', { path }),
    revealPath: (path) => invoke<boolean>('reveal_path', { path }),
    openUrl: (url) => invoke<boolean>('open_url', { url }),

    listApps: () => invoke<AppEntry[]>('list_apps'),
    launchApp: (id) => invoke<boolean>('launch_app', { id }),

    systemInfo: () => invoke<SystemSnapshot>('system_info'),
    runningProcesses: (limit) =>
      invoke<ProcessEntry[]>('running_processes', { limit: limit ?? null }),

    readClipboard: async () => {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return (await readText()) ?? '';
    },
    writeClipboard: async (text) => {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return true;
    },

    showWindow: () => invoke<void>('show_window'),
    hideWindow: () => invoke<void>('hide_window'),
    toggleWindow: () => invoke<void>('toggle_window'),

    createFile: (path, content) =>
      invoke<boolean>('create_file', { path, content: content ?? null }),
    createFolder: (path) => invoke<boolean>('create_folder', { path }),
    renamePath: (path, newName) => invoke<boolean>('rename_path', { path, newName }),
    movePath: (path, destDir) => invoke<boolean>('move_path', { path, destDir }),
    copyPath: (path, destDir) => invoke<boolean>('copy_path', { path, destDir }),
    deletePath: (path) => invoke<boolean>('delete_path', { path }),
    readTextFile: (path) => invoke<string>('read_text_file', { path }),

    pathInfo: (path) => invoke<PathInfo>('path_info', { path }),
    appendFile: (path, content) => invoke<boolean>('append_file', { path, content }),
    listDir: (path, limit) => invoke<FileEntry[]>('list_dir', { path, limit: limit ?? null }),
    knownFolder: (id) => invoke<string>('known_folder', { id }),

    lockWorkstation: () => invoke<boolean>('lock_workstation'),
    powerAction: (action) => invoke<boolean>('power_action', { action }),
    mediaKey: (key) => invoke<boolean>('media_key', { key }),
    setVolume: (direction, steps) =>
      invoke<boolean>('set_volume', { direction, steps: steps ?? null }),
    toggleMute: () => invoke<boolean>('toggle_mute'),
    displayOff: () => invoke<boolean>('display_off'),
    emptyRecycleBin: () => invoke<boolean>('empty_recycle_bin'),

    openSystemTool: (id) => invoke<boolean>('open_system_tool', { id }),

    searchWeb: (query) => invoke<WebSearchResult[]>('web_search', { query }),
    fetchPage: (url) => invoke<WebPage>('fetch_page', { url }),

    notify: async (title, body) => {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import('@tauri-apps/plugin-notification');
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (!granted) return false;
      sendNotification({ title, body });
      return true;
    },

    // Speech. The renderer names a voice by id and supplies text; it cannot
    // point this at an executable or pass engine flags — the same narrow shape
    // every other command here has.
    speechVoices: () => invoke<SpeechVoice[]>('speech_voices'),
    // The command returns a `tauri::ipc::Response`, so a WAV crosses as bytes
    // rather than as an array of a hundred thousand numbers. What those bytes
    // *arrive* as depends on which IPC transport Tauri picked, which is why
    // the result goes through `toArrayBuffer` — see the note on it.
    synthesizeSpeech: async (text, options) => {
      const audio = await invoke<unknown>('synthesize_speech', {
        text,
        voiceId: options?.voiceId,
        pace: options?.pace,
      });
      return toArrayBuffer(audio);
    },

    // Load the refined model without saying anything.
    //
    // Reading 163 MB of weights and building the graph takes a second or two,
    // and it happens on the first sentence unless something asks for it
    // sooner. That first sentence is the one a person judges the whole voice
    // by, so this is called when the voice screen opens — the gesture that
    // most reliably precedes speech by a few seconds.
    //
    // Resolves false, not an error, when the refined voice is not installed:
    // "there was nothing to warm" is an ordinary outcome, not a failure.
    warmSpeech: () => invoke<boolean>('kokoro_warm'),

    // The WAV goes over as the request *body* rather than as an argument: a
    // few seconds of audio is ~100 KB, and JSON would turn that into an array
    // of a hundred thousand numbers to cross one process boundary. The
    // vocabulary hint rides in a header because the body is already spoken
    // for, percent-encoded because header values are bytes and app names are
    // not necessarily ASCII.
    transcribeSpeech: (audio, hints) =>
      invoke<Transcript>('transcribe_speech', new Uint8Array(audio), {
        headers: hints ? { 'Atlas-Hints': encodeURIComponent(hints) } : {},
      }),

    networkAdapters: () => invoke<NetworkAdapter[]>('network_adapters'),
    wifiStatus: () => invoke<WifiStatus>('wifi_status'),
    wifiNetworks: () => invoke<string[]>('wifi_networks'),
    networkReachable: () => invoke<boolean>('network_reachable'),

    listServices: () => invoke<ServiceEntry[]>('list_services'),
    serviceDetail: (name) => invoke<ServiceDetail>('service_detail', { name }),
    serviceControl: (name, action) => invoke<ServiceOutcome>('service_control', { name, action }),

    listEnvironmentVariables: () => invoke<EnvVar[]>('list_environment_variables'),
    setEnvironmentVariable: (name, value, scope) =>
      invoke<boolean>('set_environment_variable', { name, value, scope }),
    deleteEnvironmentVariable: (name, scope: EnvironmentScope) =>
      invoke<boolean>('delete_environment_variable', { name, scope }),

    folderSize: (path) => invoke<FolderSize>('folder_size', { path }),
    largestFiles: (path, limit) =>
      invoke<LargestFiles>('largest_files', { path, limit: limit ?? null }),

    detectProject: (cwd) => invoke<ProjectInfo>('detect_project', { cwd }),
    dirTree: (cwd, maxDepth, maxEntries) =>
      invoke<TreeEntry[]>('dir_tree', {
        cwd,
        maxDepth: maxDepth ?? null,
        maxEntries: maxEntries ?? null,
      }),
    codeSearch: (cwd, query, glob, limit) =>
      invoke<SearchMatch[]>('code_search', {
        cwd,
        query,
        glob: glob ?? null,
        limit: limit ?? null,
      }),
    gitStatus: (cwd) => invoke<GitStatus>('git_status', { cwd }),
    gitDiff: (cwd, path) => invoke<string>('git_diff', { cwd, path: path ?? null }),
    gitLog: (cwd, limit) => invoke<GitLogEntry[]>('git_log', { cwd, limit: limit ?? null }),
    gitAdd: (cwd, path) => invoke<boolean>('git_add', { cwd, path }),
    gitCommit: (cwd, message) => invoke<string>('git_commit', { cwd, message }),
    runDevTool: (cwd, tool: DevTool, arg) =>
      invoke<ToolResult>('run_devtool', { cwd, tool, arg: arg ?? null }),
    writeTextFile: (path, content) => invoke<boolean>('write_text_file', { path, content }),
    patchTextFile: (path, find, replace, replaceAll) =>
      invoke<string>('patch_text_file', { path, find, replace, replaceAll: replaceAll ?? null }),

    allowedFolders: () => invoke<string[]>('allowed_folders'),
    addAllowedFolder: (path) => invoke<string[]>('add_allowed_folder', { path }),
    removeAllowedFolder: (path) => invoke<string[]>('remove_allowed_folder', { path }),

    listWindows: () => invoke<WindowEntry[]>('list_windows'),
    activeWindow: () => invoke<WindowEntry | null>('active_window'),
    focusWindow: (id) => invoke<boolean>('focus_window', { id }),
    minimizeWindow: (id) => invoke<boolean>('minimize_window', { id }),
    maximizeWindow: (id) => invoke<boolean>('maximize_window', { id }),
    restoreWindow: (id) => invoke<boolean>('restore_window', { id }),
    setWindowBounds: (id, bounds) =>
      invoke<boolean>('set_window_bounds', {
        id,
        x: bounds.x ?? null,
        y: bounds.y ?? null,
        width: bounds.width ?? null,
        height: bounds.height ?? null,
      }),
    closeWindow: (id) => invoke<boolean>('close_window', { id }),
    endProcess: (pid) => invoke<boolean>('end_process', { pid }),

    moveMouse: (x, y) => invoke<boolean>('move_mouse', { x, y }),
    cursorPosition: () => invoke<CursorPosition>('cursor_position'),
    mouseClick: (x, y, button, double) =>
      invoke<boolean>('mouse_click', { x, y, button, double: double ?? null }),
    mouseScroll: (amount) => invoke<boolean>('mouse_scroll', { amount }),
    mouseDrag: (fromX, fromY, toX, toY, button) =>
      invoke<boolean>('mouse_drag', {
        fromX,
        fromY,
        toX,
        toY,
        button: (button as MouseButton | undefined) ?? null,
      }),
    pressKey: (key) => invoke<boolean>('press_key', { key }),
    hotkey: (modifiers, key) => invoke<boolean>('hotkey', { modifiers, key }),
    typeText: (text) => invoke<boolean>('type_text', { text }),

    uiaTree: (windowId, maxDepth) =>
      invoke<UiaNode>('uia_tree', { windowId, maxDepth: maxDepth ?? null }),
    uiaFocusedElement: () => invoke<UiaNode | null>('uia_focused_element'),
    uiaInvoke: (windowId, path) => invoke<boolean>('uia_invoke', { windowId, path }),
    uiaSetExpanded: (windowId, path, expand) =>
      invoke<boolean>('uia_set_expanded', { windowId, path, expand }),
    uiaSetValue: (windowId, path, value) =>
      invoke<boolean>('uia_set_value', { windowId, path, value }),
    uiaFocus: (windowId, path) => invoke<boolean>('uia_focus', { windowId, path }),

    // Same shape as `synthesizeSpeech`: the command returns a
    // `tauri::ipc::Response`, so the bytes need the same transport-agnostic
    // conversion — see `toArrayBuffer`'s doc comment.
    captureWindow: async (windowId) =>
      toArrayBuffer(await invoke<unknown>('capture_window', { windowId })),
    captureScreen: async () => toArrayBuffer(await invoke<unknown>('capture_screen')),
    listDisplays: () => invoke<DisplayInfo[]>('list_displays'),
    windowsCompatibility: () => invoke<WindowsCompatibility>('windows_compatibility'),

    logDiagnostic: (scope, message) => invoke<void>('log_diagnostic', { scope, message }),

    // The emergency stop. `onHalt` listens for the native event rather than
    // for the button's own promise, so a halt from the key and a halt from the
    // button reach the app through exactly the same path.
    halt: {
      now: () => invoke<number>('halt_now'),
      status: () => invoke<HaltStatus>('halt_status'),
      reset: (epoch) => invoke<boolean>('halt_reset', { epoch }),
      setShortcut: (shortcut) => invoke<HaltStatus>('set_halt_shortcut', { shortcut }),
      onHalt: async (listener) => {
        const { listen } = await import('@tauri-apps/api/event');
        return listen<HaltEvent>('atlas://halt', (event) => listener(event.payload));
      },
    },
  };
}

/**
 * Whatever the IPC handed back, as an `ArrayBuffer`.
 *
 * Tauri has two transports for a command result and they do not agree on how
 * bytes look on arrival. The custom-protocol transport answers with
 * `application/octet-stream` and the page reads a real `ArrayBuffer`. The
 * `postMessage` fallback cannot carry bytes, so a payload over 1 KB is
 * serialised as a JSON array of numbers instead — which every consumer here
 * would then quietly reject, because `decodeAudioData` wants a buffer and an
 * `Array` has no `byteLength` to fail a length check on. Silence, no error.
 *
 * The fallback is not hypothetical: it is what runs whenever the app's CSP
 * omits `connect-src ipc: http://ipc.localhost`, since blocking that fetch is
 * exactly how Tauri decides the custom protocol is unavailable. The CSP now
 * allows it, so the fast path is the normal one — this is here so that a
 * transport change can never again turn into a feature that makes no sound.
 */
function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    // A view may cover part of a larger buffer; copy the window it describes
    // rather than handing out the whole thing.
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]).buffer;
  return new ArrayBuffer(0);
}

/**
 * Are we running inside Tauri?
 *
 * Checked on a global the runtime injects rather than by user-agent sniffing or
 * by trying an invoke and catching — both of which are guesses. This is a fact.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
