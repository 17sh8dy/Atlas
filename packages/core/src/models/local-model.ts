/**
 * Local models — the catalog of what Atlas knows how to talk to on this
 * machine, and the rule for which one is in use.
 *
 * ── Intelligence, not control ───────────────────────────────────────────────
 * A model here is the conversation and reasoning layer and nothing else.
 * Actions on the computer — PowerShell, window control, files, permissions,
 * confirmations — stay with Atlas's own deterministic skills and executor. A
 * model can read a request and *ask* for a skill; it cannot run anything
 * itself, and choosing a different model changes how Atlas talks and
 * reasons, never what it is allowed to do.
 *
 * ── Model names are Ollama tags ─────────────────────────────────────────────
 * Local models are served by Ollama on this machine, so `ollamaTag` is the
 * exact tag `ollama pull` takes. Nothing here assumes a PC can run all of
 * them: the two large models are mixture-of-experts downloads (~19 and ~24 GB)
 * and are optional. The default is the small one.
 */

export type LocalModelRole = 'everyday' | 'reasoning' | 'flagship' | 'compact';

export interface LocalModelProfile {
  /** The `IntelligenceProvider` id. Stable — it is what "in use" is stored as. */
  id: string;
  label: string;
  /** What `ollama pull` takes. */
  ollamaTag: string;
  role: LocalModelRole;
  /** One line, in the user's words, for the Settings row. */
  blurb: string;
  /** Rough download size, so nobody is surprised by 19 GB. */
  approxDownloadGb: number;
  /**
   * How to set the model's "thinking" mode, or `undefined` to leave it alone.
   * Everyday chat runs with thinking off: on a home PC it is the difference
   * between a reply in seconds and a reply in minutes. A reasoning model keeps
   * its default, and what it thought is never shown — only what it answered.
   */
  think?: boolean;
}

export const LOCAL_MODEL_PROFILES: readonly LocalModelProfile[] = [
  {
    id: 'local:qwen3-8b',
    label: 'Qwen3-8B',
    ollamaTag: 'qwen3:8b',
    role: 'everyday',
    blurb: 'Everyday conversation and general tasks',
    approxDownloadGb: 5,
    think: false,
  },
  {
    id: 'local:qwen3-30b-a3b',
    label: 'Qwen3-30B-A3B',
    ollamaTag: 'qwen3:30b',
    role: 'reasoning',
    blurb: 'Deep reasoning and complex tasks',
    approxDownloadGb: 19,
  },
  {
    id: 'local:qwen3.5-35b',
    label: 'Qwen3.5-35B',
    ollamaTag: 'qwen3.5:35b',
    role: 'flagship',
    blurb: 'Newest generation: strongest reasoning, coding and vision',
    approxDownloadGb: 24,
  },
  {
    id: 'local:gpt-oss-20b',
    label: 'GPT-OSS 20B',
    ollamaTag: 'gpt-oss:20b',
    role: 'compact',
    blurb: "OpenAI's open-weight reasoning model; small enough for a 16 GB graphics card",
    approxDownloadGb: 14,
  },
];

export const ROLE_ICON: Record<LocalModelRole, string> = {
  everyday: '💬',
  reasoning: '🧠',
  flagship: '⭐',
  compact: '⚡',
};

/** The main local model: what is used when local models are on and none was picked. */
export const DEFAULT_LOCAL_MODEL_ID = 'local:qwen3-8b';

/** The id an arbitrary installed Ollama model is registered under. */
export function localModelIdForTag(tag: string): string {
  const known = LOCAL_MODEL_PROFILES.find((p) => p.ollamaTag === tag);
  return known ? known.id : `local:${tag}`;
}

/** Ollama lists `qwen3:8b` and `qwen3:8b-q4_K_M` alike; a bare name means `:latest`. */
export function sameOllamaTag(a: string, b: string): boolean {
  const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

export interface ResolveActiveInput {
  /** What the user last picked, or null. May name a provider that no longer exists. */
  chosen: string | null;
  /** Every provider id currently registered. */
  known: readonly string[];
  /** Whether the user has turned local models on. */
  localEnabled: boolean;
}

/**
 * Which provider is in use.
 *
 * A pick that still exists wins. A pick that does not (a cloud provider that
 * was removed, an id from an older version) is treated as no pick at all —
 * never as a reason to fail. With no valid pick, turning local models on means
 * the default local model; otherwise Atlas runs with nothing connected, which
 * is a normal state and not a fault.
 */
export function resolveActiveProviderId(input: ResolveActiveInput): string | null {
  if (input.chosen && input.known.includes(input.chosen)) return input.chosen;
  if (input.localEnabled && input.known.includes(DEFAULT_LOCAL_MODEL_ID)) {
    return DEFAULT_LOCAL_MODEL_ID;
  }
  return null;
}
