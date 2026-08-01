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
    runningProcesses: (limit) => invoke<ProcessEntry[]>('running_processes', { limit: limit ?? null }),

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
