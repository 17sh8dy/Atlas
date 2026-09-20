/**
 * The Tauri implementation of `UpdateBackend` — one line of `invoke` per method,
 * like the rest of this package. The work is in `updater.rs`.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DownloadedPackage, StartupStatus, UpdateBackend, VerifyReport } from '@atlas/updater';

interface Progress {
  received: number;
  total: number | null;
}

export function createTauriUpdateBackend(): UpdateBackend {
  return {
    fetchManifest: (url) => invoke<string>('updater_fetch_manifest', { url }),

    async download(url, onProgress) {
      // Subscribed before the download starts so the first chunk is not missed,
      // and released whichever way it ends.
      const stop = await listen<Progress>('atlas://update-progress', (e) =>
        onProgress(e.payload.received, e.payload.total),
      );
      try {
        return await invoke<DownloadedPackage>('updater_download', { url });
      } finally {
        stop();
      }
    },

    cancelDownload: () => invoke<void>('updater_cancel'),

    verify: (pkg) => invoke<VerifyReport>('updater_verify', { path: pkg.path }),

    install: (pkg, expect) =>
      invoke<void>('updater_install', {
        path: pkg.path,
        sha256: expect.sha256,
        product: expect.product,
        version: expect.version,
        fromVersion: expect.fromVersion,
      }),

    restart: () => invoke<void>('updater_restart'),

    startupStatus: () => invoke<StartupStatus>('updater_startup_status'),

    confirmLaunch: () => invoke<void>('updater_confirm_launch'),
  };
}
