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
  WebPage,
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
  };
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
