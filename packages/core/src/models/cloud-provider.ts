/**
 * A cloud model provider — optional, user-configured, never required.
 *
 * Atlas's engine and its local models both work with nothing connected; this
 * is the opt-in escalation someone can add if they want stronger
 * conversation quality than a local model gives and are willing to send
 * their own questions to their own account. See `docs/ARCHITECTURE.md` §6.3
 * for the full reasoning and the disclosure this requires in the UI.
 *
 * Non-secret configuration only. The API key never lives in this shape or
 * anywhere `Storage` can see — see `secrets.rs`'s module doc.
 */

/**
 * The wire format, not the brand. `OpenAI`, `Kimi`, and a self-hosted
 * "Custom Provider" are all `openai-compatible` — one real request/response
 * shape, distinguished only by `baseUrl`. See `cloud_intelligence.rs`'s
 * module doc for why that is a deliberate choice, not a shortcut.
 */
export type CloudProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';

export interface CloudProviderConfig {
  /** Stable, generated once. Doubles as the Credential Manager target and the `IntelligenceProvider` id. */
  id: string;
  kind: CloudProviderKind;
  /** What the user called it — "OpenAI", "Kimi", "My local proxy". */
  label: string;
  model: string;
  /**
   * Required for `openai-compatible` (no shared default across OpenAI/Kimi/a
   * proxy). Empty means "use the real default" for `anthropic`/`gemini` —
   * resolved in `cloud_intelligence.rs`, not here.
   */
  baseUrl: string;
  /** Whether this provider may be selected as active. Adding one does not enable it. */
  enabled: boolean;
}

/** What the Settings page shows after a "Test connection" click. */
export interface CloudProviderTestResult {
  ok: boolean;
  message: string;
}
