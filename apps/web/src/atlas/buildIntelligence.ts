/**
 * Builds the intelligence registry: which models Atlas can talk to, and which
 * one is in use.
 *
 * Pulled out of `useAtlas` so it can be tested without React or Tauri — the
 * claim worth proving is "the provider that is active is the provider that
 * gets asked", and that is a fact about this function, not about a hook.
 *
 * ── Intelligence, not control ───────────────────────────────────────────────
 * Everything registered here is the conversation and reasoning layer. None of
 * it is handed a skill to run or a permission to grant; the executor, the
 * skills and the confirmation flow are built elsewhere and never consult which
 * provider is active.
 *
 * ── Three kinds of provider, one rule ───────────────────────────────────────
 *  - Local models: the three catalogued Qwen3 models are always registered,
 *    so selecting one is possible before it is installed (and says exactly
 *    what to run if it is not). Any *other* model Ollama reports is added too,
 *    so what is installed on this PC is usable without a code change.
 *  - Nova Intelligence: Nova's own from-scratch model.
 *  - Cloud providers: only ever from the user's own list, never hard-coded.
 * Every one is inert until the user has switched it on: `isConfigured()`
 * reports the switch, and `SimpleIntelligenceRegistry.active()` treats a
 * selected-but-off provider as nothing selected.
 */

import type { CloudProviderConfig, IntelligenceProvider, Storage } from '@atlas/core';
import {
  LOCAL_MODEL_PROFILES,
  localModelIdForTag,
  resolveActiveProviderId,
  sameOllamaTag,
} from '@atlas/core';
import { DEFAULT_LOCAL_AI_SETTINGS, readLocalAiSettings, type LocalAiSettings } from '@atlas/data';
import {
  createCloudProvider,
  createLocalModelProvider,
  createNovaIntelligenceProvider,
  listInstalledLocalModels,
} from '@atlas/platform';
import { SimpleIntelligenceRegistry } from '@atlas/engine';

/** The saved settings, plus what Ollama reported when it was last asked. */
export interface LocalAiRuntime extends LocalAiSettings {
  /** Tags Ollama has installed. Empty when it is off or unreachable. */
  installed: readonly string[];
}

export const DEFAULT_LOCAL_AI_RUNTIME: LocalAiRuntime = {
  ...DEFAULT_LOCAL_AI_SETTINGS,
  installed: [],
};

/**
 * Reads the saved settings and, only if local models are switched on, asks
 * Ollama what it has. Nothing is probed while the switch is off — a
 * connection to a port nobody asked Atlas to use would be one the user never
 * consented to. Never throws: an unreachable server is an empty list.
 *
 * `known` is a list from an earlier probe, to reuse instead of asking again.
 * The probe is the slowest thing a settings change can trigger — with Ollama
 * not running, Windows takes two to four seconds to refuse the connection — so
 * a change that cannot possibly alter what Ollama has (a voice, a pace, a
 * switch) passes the last answer rather than making the person wait for it.
 */
export async function loadLocalAiRuntime(
  storage: Storage,
  known?: readonly string[],
): Promise<LocalAiRuntime> {
  const settings = await readLocalAiSettings(storage).catch(() => DEFAULT_LOCAL_AI_SETTINGS);
  if (known) return { ...settings, installed: known };
  const models = settings.local.enabled
    ? await listInstalledLocalModels(settings.local.baseUrl)
    : null;
  return { ...settings, installed: (models ?? []).map((m) => m.name) };
}

export interface IntelligenceSetup {
  localAi: LocalAiRuntime;
  /** What the user last picked. May name a provider that no longer exists. */
  activeProviderId: string | null;
  cloudProviders: readonly CloudProviderConfig[];
}

export interface BuiltIntelligence {
  registry: SimpleIntelligenceRegistry;
  /** The id in use, after the pick is checked against what exists. */
  activeId: string | null;
}

/** Installed tags that are not one of the catalogued three. */
export function extraInstalledTags(installed: readonly string[]): string[] {
  return installed.filter(
    (tag) => !LOCAL_MODEL_PROFILES.some((p) => sameOllamaTag(p.ollamaTag, tag)),
  );
}

export function buildIntelligence(setup: IntelligenceSetup): BuiltIntelligence {
  const { localAi } = setup;
  const registry = new SimpleIntelligenceRegistry();

  for (const profile of LOCAL_MODEL_PROFILES) {
    registry.register(createLocalModelProvider(profile, localAi.local));
  }
  for (const tag of extraInstalledTags(localAi.installed)) {
    registry.register(
      createLocalModelProvider(
        // Thinking off: a model Atlas has no profile for is treated as an
        // everyday chat model, and on a home PC the hidden reasoning is the
        // difference between a reply in half a second and one in four.
        { id: localModelIdForTag(tag), label: tag, ollamaTag: tag, think: false },
        localAi.local,
      ),
    );
  }

  // Ollama is only asked what it has when Atlas loads. If it was not running
  // yet then (started after Atlas, or slow to come up), a model the person had
  // already picked is missing from `installed` and would be silently swapped for
  // the default. Register it from its own id so the pick survives and any real
  // problem is reported by name at call time. An installed tag always carries a
  // `:`, which also keeps ids from older versions (no colon) out of this path.
  const chosen = setup.activeProviderId;
  if (chosen && chosen.startsWith('local:') && !registry.get(chosen)) {
    const tag = chosen.slice('local:'.length);
    if (tag.includes(':')) {
      registry.register(
        createLocalModelProvider(
          { id: chosen, label: tag, ollamaTag: tag, think: false },
          localAi.local,
        ),
      );
    }
  }

  registry.register(createNovaIntelligenceProvider(localAi.nova));

  // Zero or more, entirely by the user's own hand — nothing here enables one,
  // `config.enabled` still gates `isConfigured()` per provider.
  for (const config of setup.cloudProviders) {
    registry.register(createCloudProvider(config));
  }

  const activeId = resolveActiveProviderId({
    chosen: setup.activeProviderId,
    known: registry.list().map((p: IntelligenceProvider) => p.id),
    localEnabled: localAi.local.enabled,
  });
  registry.setActive(activeId);
  return { registry, activeId };
}
