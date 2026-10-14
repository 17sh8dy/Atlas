/**
 * What a connected model can do — as far as anyone has actually said.
 *
 * Atlas talks to very different models: a small local one, a large cloud one, an experimental
 * from-scratch one. Treating them as interchangeable breaks in both directions: a model that
 * cannot hold a conversation is handed greetings, or one that could do far more is never
 * given the chance. This descriptor is the one place that difference is written down.
 *
 * ── Three rules ─────────────────────────────────────────────────────────────
 * 1. **Unknown is not "yes".** Every field is `yes`, `no` or `unknown`, and a feature is only
 *    used when it is `yes` (`supports`). A model nobody has described gets the plain
 *    text-in, text-out path, which every model can do.
 * 2. **It describes; it never authorizes.** Nothing here widens what Atlas may do. Whether a
 *    step may run is decided by the registry, the executor, the execution mode and the
 *    person — never by what a model claims or is reported to support. A model that supports
 *    tool calling still proposes steps that are validated like any other plan.
 * 3. **Say where it came from.** `reported` (the model's own server said so), `declared`
 *    (written down here for a kind of provider) or `unknown`. A declared "yes" is a claim
 *    about a catalogue, not a measurement of this model on this PC.
 */

export type Support = 'yes' | 'no' | 'unknown';
export type CapabilitySource = 'reported' | 'declared' | 'unknown';

export interface ModelCapabilities {
  /** Can answer an ordinary message as a conversation partner. Only `no` excludes a model. */
  conversation: Support;
  /** Can be held to a schema for its output. */
  structuredOutput: Support;
  /** Can propose calls to tools it is given. (Proposal only: see rule 2.) */
  toolCalling: Support;
  /** Holds a long context: at least `LONG_CONTEXT_TOKENS`. */
  longContext: Support;
  vision: Support;
  /** Tuned for code. */
  coding: Support;
  source: CapabilitySource;
}

export type ModelFeature = Exclude<keyof ModelCapabilities, 'source'>;

/** The context size at which a model counts as "long context". */
export const LONG_CONTEXT_TOKENS = 32_768;

export const UNKNOWN_CAPABILITIES: ModelCapabilities = Object.freeze({
  conversation: 'unknown',
  structuredOutput: 'unknown',
  toolCalling: 'unknown',
  longContext: 'unknown',
  vision: 'unknown',
  coding: 'unknown',
  source: 'unknown',
});

/** True only when the feature is positively known to be there. */
export function supports(caps: ModelCapabilities | null | undefined, feature: ModelFeature): boolean {
  return caps?.[feature] === 'yes';
}

/**
 * May this model be handed an ordinary conversational message?
 *
 * Only an explicit `no` says it may not. This is the one place unknown is allowed to pass,
 * and the reason is that nothing is unlocked by it: whoever the person selected as their
 * conversation model writes a reply, and a failed or empty reply falls back to Atlas's own
 * answer. Contrast `supports`, which gates features that change what is sent or asked.
 */
export function canConverse(caps: ModelCapabilities | null | undefined): boolean {
  return (caps ?? UNKNOWN_CAPABILITIES).conversation !== 'no';
}

/** Nova Intelligence: documented as unable to hold a conversation or follow instructions. */
export const NOVA_INTELLIGENCE_CAPABILITIES: ModelCapabilities = Object.freeze({
  conversation: 'no',
  structuredOutput: 'no',
  toolCalling: 'no',
  longContext: 'no',
  vision: 'no',
  coding: 'no',
  source: 'declared',
});

/**
 * A cloud provider, before anything is known about the specific model: a chat endpoint can
 * converse, and nothing else is assumed. Tool calling, structured output and vision depend on
 * the model the person typed in, which Atlas has not been told about.
 */
export const CLOUD_DECLARED_CAPABILITIES: ModelCapabilities = Object.freeze({
  ...UNKNOWN_CAPABILITIES,
  conversation: 'yes',
  source: 'declared',
});

/** What an Ollama server reports for a model (`/api/show`), reduced to what is read here. */
export interface OllamaReport {
  /** Ollama's own capability strings: "completion", "tools", "vision", "thinking", "embedding"… */
  capabilities?: readonly string[] | null;
  /** The model's own context limit, tokens. */
  contextTokens?: number | null;
  /**
   * The server's own version (`/api/version`), e.g. "0.5.7". From 0.5.0 on Ollama enforces a JSON
   * Schema passed as `format` on any model, so a reply can be held to a schema regardless of how
   * well the model follows instructions.
   */
  serverVersion?: string | null;
}

/** The first Ollama release that enforces a JSON Schema in `format`. */
export const OLLAMA_STRUCTURED_OUTPUT_SINCE = [0, 5, 0] as const;

/** `true` when a version string like "0.5.7" or "v0.12.3-rc1" is at least `min`. Unparseable is false. */
export function versionAtLeast(version: string | null | undefined, min: readonly [number, number, number]): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((version ?? '').trim());
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! !== min[i]!) return have[i]! > min[i]!;
  }
  return true;
}

/**
 * Capabilities for a local model from what its server says.
 *
 * `declared` is what a catalogue entry says about this model before the server has answered
 * (a model in Atlas's own list is a chat model, for instance). The server's report overrides
 * it field by field; a field the server does not speak to stays as declared, or unknown.
 */
export function capabilitiesFromOllama(
  report: OllamaReport | null | undefined,
  declared: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  const base: ModelCapabilities = { ...UNKNOWN_CAPABILITIES, ...declared, source: declared.source ?? 'declared' };
  if (!report) return base;

  const out: ModelCapabilities = { ...base };
  let reported = false;
  const list = Array.isArray(report.capabilities) ? report.capabilities.map((c) => c.toLowerCase()) : null;
  if (list && list.length) {
    reported = true;
    out.toolCalling = list.includes('tools') ? 'yes' : 'no';
    out.vision = list.includes('vision') ? 'yes' : 'no';
    // An embedding-only model cannot converse; anything that completes text can.
    out.conversation = list.includes('completion') ? 'yes' : 'no';
  }
  if (typeof report.contextTokens === 'number' && report.contextTokens > 0) {
    reported = true;
    out.longContext = report.contextTokens >= LONG_CONTEXT_TOKENS ? 'yes' : 'no';
  }
  // A server new enough to enforce a schema says so by its version. A server that did not say
  // stays unknown, and unknown is not used.
  if (report.serverVersion) {
    reported = true;
    out.structuredOutput = versionAtLeast(report.serverVersion, OLLAMA_STRUCTURED_OUTPUT_SINCE) ? 'yes' : 'no';
  }
  if (reported) out.source = 'reported';
  return out;
}
