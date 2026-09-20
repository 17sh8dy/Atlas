/**
 * Intelligence — the models Atlas can talk through, and which one is in use.
 *
 * ── What this layer is, and is not ──────────────────────────────────────────
 * A model here is the *conversation and reasoning* layer: it reads what you
 * say, answers, and can ask Atlas for one of its own capabilities. It never
 * controls the computer. PowerShell, window control, files, permissions and
 * confirmations belong to Atlas's own deterministic skills, which do not
 * consult which model is selected. So this page changes how Atlas talks and
 * thinks — never what it is allowed to do.
 *
 * ── Three kinds, kept apart ─────────────────────────────────────────────────
 *  - Local Models: run on this PC through Ollama. Nothing leaves the machine.
 *  - Cloud Models: use a provider account and key the person added themselves.
 *  - Nova Intelligence: Nova's own from-scratch model, experimental.
 *
 * ── Off is a real state, not a broken one ───────────────────────────────────
 * The copy leads with what still works. Atlas answers, acts and searches with
 * everything here off — that is the premise of the engine — so a page that
 * opened with "not connected" would be describing a fault that isn't one.
 * "Ollama isn't running" is information, not an error, and it is phrased that
 * way.
 */

import { LOCAL_MODEL_PROFILES, localModelIdForTag, resolveActiveProviderId } from '@atlas/core';
import type { CloudProviderConfig, Platform, Storage } from '@atlas/core';
import { NOVA_INTELLIGENCE_PROVIDER_ID } from '@atlas/platform';
import { extraInstalledTags, type LocalAiRuntime } from '../../atlas/buildIntelligence';
import { CloudProviders } from './intelligence/CloudProviders';
import { LocalModels } from './intelligence/LocalModels';
import { NovaIntelligence } from './intelligence/NovaIntelligence';

interface Props {
  platform: Platform;
  storage: Storage;
  localAi: LocalAiRuntime;
  activeProviderId: string | null;
  cloudProviders: CloudProviderConfig[];
  onProviderChange(): void;
}

export function Intelligence({
  platform,
  storage,
  localAi,
  activeProviderId,
  cloudProviders,
  onProviderChange,
}: Props) {
  // The same rule the engine applies, so the page never claims a model is in
  // use that the engine would not actually ask.
  const known = [
    ...LOCAL_MODEL_PROFILES.map((p) => p.id),
    ...extraInstalledTags(localAi.installed).map(localModelIdForTag),
    NOVA_INTELLIGENCE_PROVIDER_ID,
    ...cloudProviders.map((c) => c.id),
  ];
  const chosen = resolveActiveProviderId({
    chosen: activeProviderId,
    known,
    localEnabled: localAi.local.enabled,
  });
  const switchedOn = (id: string): boolean =>
    id === NOVA_INTELLIGENCE_PROVIDER_ID
      ? localAi.nova.enabled
      : id.startsWith('local:')
        ? localAi.local.enabled
        : Boolean(cloudProviders.find((c) => c.id === id)?.enabled);
  const activeId = chosen && switchedOn(chosen) ? chosen : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-foreground-muted text-xs leading-relaxed">
        Models handle conversation and reasoning. They never control your computer — Atlas&apos;s
        own tools, permissions and confirmations do that, whichever model is selected. Nothing here
        is required: Atlas answers, acts and searches the same way with every model off.
      </p>

      <LocalModels
        platform={platform}
        storage={storage}
        localAi={localAi}
        activeId={activeId}
        onChange={onProviderChange}
      />

      <CloudProviders
        storage={storage}
        providers={cloudProviders}
        activeProviderId={activeId}
        onChange={onProviderChange}
      />

      <NovaIntelligence
        storage={storage}
        localAi={localAi}
        activeId={activeId}
        onChange={onProviderChange}
      />
    </div>
  );
}
