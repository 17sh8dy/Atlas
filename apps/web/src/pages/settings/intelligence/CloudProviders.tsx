/**
 * Cloud model providers — optional, user-configured, never required.
 *
 * ── Why this exists, and what it must never become ──────────────────────────
 * Atlas's whole thesis is "works with nothing connected"; Cortex is the local
 * escalation for open-ended reasoning. This is the *second*, opt-in
 * escalation for someone who wants stronger conversation quality than a
 * local model gives and is willing to send their own questions to their own
 * account at a provider they chose. Nothing here may become required for
 * Atlas's coding tools, desktop skills or permissions — those never consult
 * `activeProviderId` at all, only `Engine.converse()` does, and that is
 * conversation only.
 *
 * ── The key never comes back here ───────────────────────────────────────────
 * `saveProviderSecret` writes a typed-in key once and this component never
 * reads one back — there is no "show key" anywhere, because there is no
 * function that would return one. See `secrets.rs` and `providers.ts`'s
 * module docs for the full boundary.
 *
 * ── The kind vs. the preset ──────────────────────────────────────────────
 * `CloudProviderKind` is a wire format (`cloud_intelligence.rs`'s module
 * doc); `PRESETS` below is presentation over it — OpenAI, Kimi and Custom
 * Provider all pick `openai-compatible`, differing only in the base URL a
 * person starts from. That split is deliberate: the brand is a label, the
 * kind is the only thing Rust needs to know.
 */

import { useState } from 'react';
import { Icons, Button, Input, Surface, Switch, cn } from '@atlas/ui';
import type { CloudProviderConfig, CloudProviderKind, Storage } from '@atlas/core';
import { writeActiveProvider, writeCloudProviders } from '@atlas/data';
import { deleteProviderSecret, saveProviderSecret, testCloudProviderConnection } from '@atlas/platform';

interface Props {
  storage: Storage;
  providers: CloudProviderConfig[];
  activeProviderId: string | null;
  onChange(): void;
}

interface Preset {
  id: string;
  label: string;
  kind: CloudProviderKind;
  defaultBaseUrl: string;
  modelHint: string;
}

const PRESETS: readonly Preset[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', defaultBaseUrl: 'https://api.openai.com', modelHint: 'e.g. gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic / Claude', kind: 'anthropic', defaultBaseUrl: '', modelHint: 'e.g. claude-opus-5' },
  { id: 'gemini', label: 'Google Gemini', kind: 'gemini', defaultBaseUrl: '', modelHint: 'e.g. gemini-2.5-flash' },
  { id: 'kimi', label: 'Kimi (Moonshot AI)', kind: 'openai-compatible', defaultBaseUrl: 'https://api.moonshot.ai', modelHint: 'e.g. kimi-k2' },
  {
    id: 'custom',
    label: 'Custom Provider',
    kind: 'openai-compatible',
    defaultBaseUrl: '',
    modelHint: 'whatever your endpoint calls it',
  },
];

function newProviderId(): string {
  return `cloud-${crypto.randomUUID()}`;
}

/** `PRESETS` is a fixed, non-empty literal — this is the one place that fact is asserted. */
const DEFAULT_PRESET: Preset = PRESETS[0]!;

function presetFor(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET;
}

export function CloudProviders({ storage, providers, activeProviderId, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const preset = presetFor(presetId);
  const [label, setLabel] = useState(preset.label);
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState(preset.defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');

  function choosePreset(id: string) {
    const next = presetFor(id);
    setPresetId(id);
    setLabel(next.label);
    setBaseUrl(next.defaultBaseUrl);
  }

  function resetForm() {
    choosePreset(DEFAULT_PRESET.id);
    setModel('');
    setApiKey('');
    setAdding(false);
  }

  async function addProvider() {
    const trimmedLabel = label.trim();
    const trimmedModel = model.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedLabel || !trimmedModel || !trimmedKey) return;
    if (preset.kind === 'openai-compatible' && !trimmedBaseUrl) return;

    setBusy(true);
    try {
      const id = newProviderId();
      await saveProviderSecret(id, trimmedKey);
      const config: CloudProviderConfig = {
        id,
        kind: preset.kind,
        label: trimmedLabel,
        model: trimmedModel,
        baseUrl: trimmedBaseUrl,
        enabled: true,
      };
      await writeCloudProviders(storage, [...providers, config]);
      onChange();
      resetForm();
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(id: string, next: boolean) {
    setBusy(true);
    try {
      await writeCloudProviders(
        storage,
        providers.map((p) => (p.id === id ? { ...p, enabled: next } : p)),
      );
      // Disabling the one currently in use falls back to nothing selected,
      // rather than leaving `activeProviderId` pointing at a provider that
      // will now refuse every call — the same "selected but unconfigured is
      // the same as nothing selected" rule `SimpleIntelligenceRegistry`
      // already enforces on the engine side; this just keeps Settings
      // showing the truth instead of a state the engine has already moved on
      // from.
      if (!next && activeProviderId === id) await writeActiveProvider(storage, null);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function selectForConversation(id: string) {
    setBusy(true);
    try {
      await writeActiveProvider(storage, id);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteProviderSecret(id);
      await writeCloudProviders(
        storage,
        providers.filter((p) => p.id !== id),
      );
      if (activeProviderId === id) await writeActiveProvider(storage, null);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function test(config: CloudProviderConfig) {
    setTesting(config.id);
    try {
      const result = await testCloudProviderConnection(config);
      setTestResults((prev) => ({ ...prev, [config.id]: result }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <Icons.Cloud className="text-primary h-4 w-4" />
        <h2 className="text-foreground text-sm font-medium">Cloud Models</h2>
      </div>
      <p className="text-foreground-muted mb-3 text-xs leading-relaxed">
        Optional. If Cortex isn't enough for a particular conversation, you can connect your own
        account at a cloud provider for stronger quality — Atlas's own tools, coding, permissions
        and desktop actions never depend on this and keep working exactly the same either way.
      </p>

      <Surface className="mb-3 flex items-start gap-2 border-border-strong p-3">
        <Icons.Lock className="text-foreground-subtle mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="text-foreground-subtle text-xs leading-relaxed">
          Nova does not provide, pay for, include, or maintain subscriptions or API access for
          these cloud AI providers. You need your own valid access and API keys, and the provider
          may charge you separately according to their own terms and pricing. A key you save here
          is stored in Windows Credential Manager, never in Atlas's own settings file, and is
          never shown again once saved.
        </p>
      </Surface>

      <div className="flex flex-col gap-2">
        {providers.map((config) => {
          const isActive = activeProviderId === config.id;
          const result = testResults[config.id];
          return (
            <Surface key={config.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground text-sm font-medium">{config.label}</span>
                    {isActive && (
                      <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2 py-0.5 text-[10px] font-medium">
                        In use
                      </span>
                    )}
                  </div>
                  <p className="text-foreground-subtle mt-0.5 truncate text-xs">
                    {config.kind} · {config.model}
                    {config.baseUrl ? ` · ${config.baseUrl}` : ''}
                  </p>
                </div>
                <Switch
                  checked={config.enabled}
                  disabled={busy}
                  onCheckedChange={(next) => void toggleEnabled(config.id, next)}
                  aria-label={`Enable ${config.label}`}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || testing === config.id}
                  onClick={() => void test(config)}
                >
                  {testing === config.id ? 'Testing…' : 'Test connection'}
                </Button>
                {config.enabled && !isActive && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void selectForConversation(config.id)}>
                    Use for conversation
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="text-danger ml-auto"
                  onClick={() => void remove(config.id)}
                >
                  <Icons.Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>

              {result && (
                <p
                  className={cn(
                    'text-xs leading-relaxed',
                    result.ok ? 'text-success' : 'text-danger',
                  )}
                >
                  {result.ok ? '✓ ' : '✗ '}
                  {result.message}
                </p>
              )}
            </Surface>
          );
        })}
      </div>

      {adding ? (
        <Surface className="mt-2 flex flex-col gap-3 p-4">
          <div>
            <label className="text-foreground-subtle mb-1 block text-xs font-medium uppercase tracking-wide">
              Provider
            </label>
            <select
              value={presetId}
              onChange={(e) => choosePreset(e.target.value)}
              className="border-border bg-surface text-foreground h-10 w-full rounded-lg border px-3 text-sm"
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-foreground-subtle mb-1 block text-xs font-medium uppercase tracking-wide">
              Label
            </label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What to call it" />
          </div>

          <div>
            <label className="text-foreground-subtle mb-1 block text-xs font-medium uppercase tracking-wide">
              Model
            </label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={preset.modelHint}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="text-foreground-subtle mb-1 block text-xs font-medium uppercase tracking-wide">
              Base URL{preset.kind !== 'openai-compatible' ? ' (optional — leave blank for the default)' : ''}
            </label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.kind === 'openai-compatible' ? 'https://…' : 'the provider default'}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="text-foreground-subtle mb-1 block text-xs font-medium uppercase tracking-wide">
              API key
            </label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="Pasted in, never shown again"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" disabled={busy} onClick={resetForm}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={
                busy ||
                !label.trim() ||
                !model.trim() ||
                !apiKey.trim() ||
                (preset.kind === 'openai-compatible' && !baseUrl.trim())
              }
              onClick={() => void addProvider()}
            >
              Save provider
            </Button>
          </div>
        </Surface>
      ) : (
        <Button variant="secondary" size="md" className="mt-2" onClick={() => setAdding(true)}>
          <Icons.Plus className="h-4 w-4" />
          Add a provider
        </Button>
      )}
    </section>
  );
}
