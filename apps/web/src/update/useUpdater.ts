/**
 * The React binding for `UpdateService`.
 *
 * Holds no update logic: it builds the service, forwards its state, and runs
 * the automatic check on a timer. Everything that decides is in
 * `@atlas/updater`; everything that touches the machine is in `updater.rs`.
 *
 * Only the desktop build updates. The browser build has no installer to
 * replace, so there the hook is inert and `supported` is false.
 *
 * ── Automatic checks ────────────────────────────────────────────────────────
 * On by default, and switchable in Settings → About. A check is one small
 * request to GitHub for a JSON file; it sends nothing about the person and
 * nothing is downloaded until they press Update.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Platform, Storage } from '@atlas/core';
import { createTauriUpdateBackend } from '@atlas/platform';
import {
  UpdateService,
  type CheckResult,
  type UpdateMemory,
  type UpdateState,
} from '@atlas/updater';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  KEY_AUTO_CHECK,
  KEY_DISMISSED,
  UPDATE_MANIFEST_URL,
  UPDATE_PRODUCT,
  UPDATE_PRODUCT_NAME,
  UPDATE_REQUIRE_SIGNATURE,
} from './config';

export interface Updater {
  state: UpdateState;
  /** False in the browser build. */
  supported: boolean;
  currentVersion: string | null;
  autoCheck: boolean;
  setAutoCheck(on: boolean): void;
  /** The "Check for updates" button. */
  checkNow(): Promise<CheckResult | 'unsupported'>;
  update(): void;
  later(): void;
  cancel(): void;
  retry(): void;
  acknowledge(): void;
}

function memoryOver(storage: Storage): UpdateMemory {
  return {
    dismissedVersion: async () => {
      const v = await storage.get<string>(KEY_DISMISSED);
      return typeof v === 'string' ? v : null;
    },
    dismiss: (version) => storage.set(KEY_DISMISSED, version),
  };
}

export function useUpdater(platform: Platform, storage: Storage): Updater {
  const supported = platform.id === 'tauri';
  const [state, setState] = useState<UpdateState>({ status: 'hidden' });
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [autoCheck, setAutoCheckState] = useState(true);
  const [service, setService] = useState<UpdateService | null>(null);
  const serviceRef = useRef<UpdateService | null>(null);

  // Build the service once the running version is known.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    let unsubscribe = () => {};
    void (async () => {
      const [{ getVersion }, stored] = await Promise.all([
        import('@tauri-apps/api/app'),
        storage.get<boolean>(KEY_AUTO_CHECK).catch(() => undefined),
      ]);
      const version = await getVersion();
      if (!alive) return;
      const svc = new UpdateService({
        backend: createTauriUpdateBackend(),
        manifestUrl: UPDATE_MANIFEST_URL,
        product: UPDATE_PRODUCT,
        currentVersion: version,
        policy: {
          requireSignature: UPDATE_REQUIRE_SIGNATURE,
          expectedProduct: UPDATE_PRODUCT_NAME,
        },
        memory: memoryOver(storage),
      });
      unsubscribe = svc.subscribe(setState);
      serviceRef.current = svc;
      setCurrentVersion(version);
      setAutoCheckState(stored !== false);
      setService(svc);
      // How did the last update end? Also tells the native side this launch is healthy.
      void svc.announceStartup();
    })();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [supported, storage]);

  // Automatic checks.
  useEffect(() => {
    if (!service || !autoCheck) return;
    const first = setTimeout(() => void service.checkForUpdate(), FIRST_CHECK_DELAY_MS);
    const every = setInterval(() => void service.checkForUpdate(), CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [service, autoCheck]);

  // A finished update announces itself once and then gets out of the way.
  useEffect(() => {
    if (state.status !== 'complete') return;
    const t = setTimeout(() => service?.acknowledge(), 9000);
    return () => clearTimeout(t);
  }, [state.status, service]);

  const setAutoCheck = useCallback(
    (on: boolean) => {
      setAutoCheckState(on);
      void storage.set(KEY_AUTO_CHECK, on).catch(() => {});
    },
    [storage],
  );

  return useMemo<Updater>(
    () => ({
      state,
      supported,
      currentVersion,
      autoCheck,
      setAutoCheck,
      checkNow: async () => (service ? service.checkForUpdate({ manual: true }) : 'unsupported'),
      update: () => void service?.update(),
      later: () => void service?.dismiss(),
      cancel: () => void service?.cancel(),
      retry: () => void service?.retry(),
      acknowledge: () => service?.acknowledge(),
    }),
    [state, supported, currentVersion, autoCheck, setAutoCheck, service],
  );
}
