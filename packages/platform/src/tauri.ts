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
  SpeechVoice,
  Transcript,
  WebPage,
  WifiStatus,
  PathInfo,
  WebSearchResult,
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

    // The one voice path that reaches the network. Kept adjacent to the local
    // pair so a reader sees both and can tell them apart, not in a file where
    // it could be mistaken for one of them.
    synthesizeSpeechOnline: async (apiKey, text, pace) =>
      toArrayBuffer(await invoke<unknown>('synthesize_speech_online', { apiKey, text, pace })),
    transcribeSpeechOnline: (apiKey, audio) =>
      invoke<Transcript>('transcribe_speech_online', new Uint8Array(audio), {
        headers: { 'Atlas-Api-Key': apiKey },
      }),

    networkAdapters: () => invoke<NetworkAdapter[]>('network_adapters'),
    wifiStatus: () => invoke<WifiStatus>('wifi_status'),
    wifiNetworks: () => invoke<string[]>('wifi_networks'),
    networkReachable: () => invoke<boolean>('network_reachable'),

    logDiagnostic: (scope, message) => invoke<void>('log_diagnostic', { scope, message }),
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
