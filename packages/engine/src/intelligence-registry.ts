/**
 * The concrete `IntelligenceRegistry` — a map plus one active id.
 *
 * `active()` returning `null` (nothing registered, or nothing selected) is
 * the normal, supported state, not a degraded one — the engine works
 * completely without it. That's already how `core/ports/intelligence.ts`
 * describes the port; this is just the plain object holding it.
 */

import type { IntelligenceProvider, IntelligenceRegistry, ProviderId } from '@atlas/core';

export class SimpleIntelligenceRegistry implements IntelligenceRegistry {
  private readonly providers = new Map<ProviderId, IntelligenceProvider>();
  private activeId: ProviderId | null = null;

  register(provider: IntelligenceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): IntelligenceProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): IntelligenceProvider[] {
    return [...this.providers.values()];
  }

  active(): IntelligenceProvider | null {
    if (!this.activeId) return null;
    const provider = this.providers.get(this.activeId);
    // A selected-but-unconfigured provider (key removed after being chosen)
    // is the same as nothing selected — the engine's offline path already
    // handles "no active provider" correctly, so route there instead of
    // handing back something that will just fail every call.
    return provider && provider.isConfigured() ? provider : null;
  }

  setActive(id: ProviderId | null): void {
    this.activeId = id;
  }
}
