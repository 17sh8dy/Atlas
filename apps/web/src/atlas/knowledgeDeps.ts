/**
 * Connects the engine's knowledge tier to the native side (docs/PLAN-2.0.3.md §K, §B).
 *
 * The native side verifies the pack against a compiled-in key and fetches only from pinned addresses; this
 * only reads what it hands back, builds a search index once per pack, and maps a live reading into the shape
 * the engine expects. Everything it returns is data. A failure anywhere here makes the tier decline, never
 * the question fail.
 */

import {
  KnowledgeIndex,
  faqEntries,
  parsePack,
  type KnowledgeDeps,
  type LiveReading,
  type LiveSourceId,
  type LoadedKnowledge,
} from '@atlas/engine';
import { knowledgeLiveFetch, knowledgePack, knowledgeStatus, type KnowledgeStatus } from '@atlas/platform';

function niceMonth(iso: string | null): string {
  if (!iso) return 'an unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function createKnowledgeDeps(opts: { capabilityCount: () => number }): KnowledgeDeps {
  let loaded: { seq: number; value: LoadedKnowledge } | null = null;
  let status: KnowledgeStatus | null = null;
  let version = '0.0.0';

  // The running version comes from the app itself; until it is known, no verified answer is used.
  void import('@tauri-apps/api/app')
    .then(({ getVersion }) => getVersion())
    .then((v) => {
      version = v;
    })
    .catch(() => undefined);

  const refreshStatus = async (): Promise<KnowledgeStatus | null> => {
    try {
      status = await knowledgeStatus();
    } catch {
      /* keep the last known status */
    }
    return status;
  };

  return {
    async load() {
      const s = await refreshStatus();
      if (!s || s.source === 'none' || s.seq === null) return null;
      if (loaded && loaded.seq === s.seq) return loaded.value;
      const pack = await knowledgePack();
      if (!pack) return null;
      const parsed = parsePack(pack.text);
      if (!parsed) return null;
      const value: LoadedKnowledge = {
        info: { source: pack.source, seq: pack.seq, builtAt: pack.builtAt },
        index: new KnowledgeIndex(parsed),
        faq: faqEntries(parsed.chunks),
      };
      loaded = { seq: pack.seq, value };
      return value;
    },

    async live(id: LiveSourceId): Promise<LiveReading | null> {
      try {
        const r = await knowledgeLiveFetch(id);
        return {
          label: r.label,
          url: r.url,
          fetchedAtMs: r.fetchedAtMs,
          title: r.title,
          published: r.published,
          text: r.text,
          thin: r.thin,
          isRelease: id.endsWith('-release'),
        };
      } catch {
        return null; // off, offline, or unreadable: the tier falls back to the pack
      }
    },

    liveAllowed: () => status?.liveLookups ?? true,
    refreshing: () => status?.autoRefresh ?? true,
    get runningVersion() {
      return version;
    },
    facts: () => ({
      atlasVersion: version === '0.0.0' ? undefined : version,
      packDate: status?.builtAt ? niceMonth(status.builtAt) : undefined,
      autoRefresh: status?.autoRefresh,
      liveLookups: status?.liveLookups,
      capabilityCount: opts.capabilityCount(),
    }),
  };
}
