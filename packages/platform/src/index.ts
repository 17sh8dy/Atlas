/**
 * @atlas/platform — the concrete implementations of the `Platform` port.
 *
 * One import for the app: `detectPlatform()` returns the right one for wherever
 * the UI happens to be running. Nothing above this package branches on
 * environment, which is the point of the port existing at all.
 */

import type { Platform } from '@atlas/core';
import { createTauriPlatform, isTauri } from './tauri';
import { createWebPlatform } from './web';

export { createTauriPlatform, isTauri } from './tauri';
export { createWebPlatform } from './web';
export {
  createLocalModelProvider,
  createNovaIntelligenceProvider,
  listInstalledLocalModels,
  isNovaIntelligenceReachable,
  explainLocalFailure,
  OLLAMA_DEFAULT_BASE_URL,
  NOVA_INTELLIGENCE_DEFAULT_BASE_URL,
  NOVA_INTELLIGENCE_PROVIDER_ID,
} from './providers';
export type { LocalModelOptions, InstalledLocalModel } from './providers';
export {
  createCloudProvider,
  saveProviderSecret,
  hasProviderSecret,
  deleteProviderSecret,
  testCloudProviderConnection,
} from './providers';

/** The platform for the current runtime. */
export function detectPlatform(): Platform {
  return isTauri() ? createTauriPlatform() : createWebPlatform();
}
