/**
 * Cloud model providers — optional, user-configured, never required.
 *
 * ── Why this exists, and what it must never become ──────────────────────────
 * Atlas's whole thesis is "works with nothing connected"; local models are the on-device
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

import { useCallback, useEffect, useState } from 'react';
import { Icons, Button, Input, Surface, Switch, cn } from '@atlas/ui';
import type { CloudProviderConfig, CloudProviderKind, Storage } from '@atlas/core';
import { readCloudPlanning, writeActiveProvider, writeCloudPlanning } from '@atlas/data';
import { ROUTING_CHANGED } from '../../../atlas/routingEvents';
import { formatPriceMilli, parsePriceMilli, priceTextProblem } from './prices';
import {
  addProviderWithKey,
  deleteProviderSecret,
  listProviderStanding,
  readProviderBinding,
  resumeProvider,
  setProviderCaps,
  setProviderPrices,
  testCloudProviderConnection,
  unbindProvider,
  updateProvider,
  type ProviderStanding,
} from '@atlas/platform';

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
  // Where each key is actually sent, as the native side holds it — not what the list says.
  const [hosts, setHosts] = useState<Record<string, string | null>>({});
  const [addError, setAddError] = useState<string | null>(null);
  // Whether a cloud model may be asked to plan an action (otherwise it only converses).
  const [cloudPlanning, setCloudPlanning] = useState(true);
  useEffect(() => {
    let alive = true;
    void readCloudPlanning(storage).then((v) => alive && setCloudPlanning(v)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [storage]);
  async function changeCloudPlanning(next: boolean) {
    setCloudPlanning(next);
    await writeCloudPlanning(storage, next);
    window.dispatchEvent(new Event(ROUTING_CHANGED));
  }

  // Cloud safety: whether a provider is paused, the caps Atlas enforces, and this month's use.
  const [standing, setStanding] = useState<Record<string, ProviderStanding>>({});
  const [capDraft, setCapDraft] = useState<Record<string, { r: string; t: string }>>({});
  // What the person says a million tokens cost, in dollars as typed, for the Stats estimate.
  const [priceDraft, setPriceDraft] = useState<Record<string, { i: string; o: string }>>({});
  const [safetyNote, setSafetyNote] = useState<Record<string, string>>({});

  const refreshStanding = useCallback(async () => {
    try {
      const rows = await listProviderStanding();
      setStanding(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch {
      /* the card simply shows no usage line */
    }
  }, []);

  useEffect(() => {
    void refreshStanding();
  }, [providers, refreshStanding]);

  async function resume(id: string) {
    setBusy(true);
    setSafetyNote((p) => ({ ...p, [id]: '' }));
    try {
      await resumeProvider(id);
      await refreshStanding();
      onChange();
    } catch (err) {
      setSafetyNote((p) => ({ ...p, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function saveCaps(id: string) {
    const d = capDraft[id] ?? { r: '', t: '' };
    const num = (s: string) => {
      const n = Number(s.replace(/[,\s]/g, ''));
      return s.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    };
    setBusy(true);
    setSafetyNote((p) => ({ ...p, [id]: '' }));
    try {
      await setProviderCaps(id, num(d.r), num(d.t));
      await refreshStanding();
      setCapDraft((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    } catch (err) {
      setSafetyNote((p) => ({ ...p, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function savePrices(id: string) {
    const st = standing[id];
    const d = priceDraft[id] ?? {
      i: formatPriceMilli(st?.priceInMilli ?? null),
      o: formatPriceMilli(st?.priceOutMilli ?? null),
    };
    const problem = priceTextProblem(d.i) ?? priceTextProblem(d.o);
    if (problem) {
      setSafetyNote((p) => ({ ...p, [id]: problem }));
      return;
    }
    const pi = parsePriceMilli(d.i);
    const po = parsePriceMilli(d.o);
    // An estimate needs both halves; one alone would quietly price the other at nothing.
    if ((pi === null) !== (po === null)) {
      setSafetyNote((p) => ({ ...p, [id]: 'Enter both prices, or leave both empty.' }));
      return;
    }
    setBusy(true);
    setSafetyNote((p) => ({ ...p, [id]: '' }));
    try {
      await setProviderPrices(id, pi, po);
      await refreshStanding();
      setPriceDraft((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    } catch (err) {
      setSafetyNote((p) => ({ ...p, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    void (async () => {
      const next: Record<string, string | null> = {};
      for (const p of providers) next[p.id] = (await readProviderBinding(p.id))?.host ?? null;
      if (live) setHosts(next);
    })();
    return () => {
      live = false;
    };
  }, [providers]);

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
    setAddError(null);
    try {
      const id = newProviderId();
      // One native question covers both the address the key is bound to and the key. If the
      // address is refused, or the person says no, nothing is written anywhere.
      // The list is native too: this one call records the provider, its address and its key.
      await addProviderWithKey(id, preset.kind, trimmedBaseUrl, trimmedKey, trimmedLabel, trimmedModel);
      onChange();
      resetForm();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(id: string, next: boolean) {
    setBusy(true);
    try {
      await updateProvider(id, { enabled: next });
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
      await unbindProvider(id);
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
        Optional. If a local model isn't enough for a particular conversation, you can connect your own
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

      <Surface className="mb-3 flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">Let a cloud model plan actions</p>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            When Atlas doesn't recognise an instruction, it can ask your model to turn it into steps. With
            a cloud model that sends your words, and the names of Atlas's tools, to that provider. Turn this
            off to use a cloud model for conversation only; Atlas then plans on its own. Every plan,
            whoever wrote it, is checked and confirmed the same way.
          </p>
        </div>
        <Switch
          checked={cloudPlanning}
          onCheckedChange={(next) => void changeCloudPlanning(next)}
          aria-label="Let a cloud model plan actions"
        />
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
                  <p className="text-foreground-subtle mt-0.5 break-words text-xs">
                    {config.kind} · {config.model}
                    {hosts[config.id] ? ` · sends to ${hosts[config.id]}` : ' · address not confirmed'}
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

              {(() => {
                const st = standing[config.id];
                if (!st) return null;
                const d = capDraft[config.id] ?? {
                  r: st.capRequests ? String(st.capRequests) : '',
                  t: st.capTokens ? String(st.capTokens) : '',
                };
                const tokens =
                  st.monthTokens >= 1000 ? `≈ ${(st.monthTokens / 1000).toFixed(1)}k` : `≈ ${st.monthTokens}`;
                return (
                  <div className="border-border mt-1 flex flex-col gap-2 border-t pt-2">
                    {st.paused && (
                      <div className="border-warning/40 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
                        <p className="text-foreground text-xs leading-relaxed">
                          ⚠️ <strong className="font-medium">Cloud AI limit reached.</strong> This provider said
                          its account has reached its limit, so Atlas has paused requests to it. Nothing was
                          switched to another provider.
                        </p>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void resume(config.id)}>
                          Resume
                        </Button>
                      </div>
                    )}
                    <p className="text-foreground-subtle text-xs">
                      This month: {st.monthRequests.toLocaleString('en-US')} request
                      {st.monthRequests === 1 ? '' : 's'} · {tokens} tokens (estimated unless the provider
                      reported them).
                      {st.monthTokensUncertain > 0 &&
                        ` Includes about ${st.monthTokensUncertain.toLocaleString('en-US')} from requests that may have reached the provider before failing; those count toward your limit.`}{' '}
                      Your provider’s dashboard has the real figures.
                    </p>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-foreground-subtle text-xs">
                        Requests a month
                        <Input
                          value={d.r}
                          inputMode="numeric"
                          placeholder="no limit"
                          onChange={(e) => setCapDraft((p) => ({ ...p, [config.id]: { ...d, r: e.target.value } }))}
                        />
                      </label>
                      <label className="text-foreground-subtle text-xs">
                        Tokens a month
                        <Input
                          value={d.t}
                          inputMode="numeric"
                          placeholder="no limit"
                          onChange={(e) => setCapDraft((p) => ({ ...p, [config.id]: { ...d, t: e.target.value } }))}
                        />
                      </label>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void saveCaps(config.id)}>
                        Save limits
                      </Button>
                    </div>
                    <p className="text-foreground-subtle text-xs leading-relaxed">
                      Atlas stops sending requests to this provider when a limit is reached, on top of
                      whatever your provider enforces. Raising or removing a limit asks you first.
                    </p>
                    {(() => {
                      const pd = priceDraft[config.id] ?? {
                        i: formatPriceMilli(st.priceInMilli),
                        o: formatPriceMilli(st.priceOutMilli),
                      };
                      return (
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="text-foreground-subtle text-xs">
                            Price per 1M input tokens (USD)
                            <Input
                              value={pd.i}
                              inputMode="decimal"
                              placeholder="not set"
                              onChange={(e) =>
                                setPriceDraft((p) => ({ ...p, [config.id]: { ...pd, i: e.target.value } }))
                              }
                            />
                          </label>
                          <label className="text-foreground-subtle text-xs">
                            Price per 1M output tokens (USD)
                            <Input
                              value={pd.o}
                              inputMode="decimal"
                              placeholder="not set"
                              onChange={(e) =>
                                setPriceDraft((p) => ({ ...p, [config.id]: { ...pd, o: e.target.value } }))
                              }
                            />
                          </label>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void savePrices(config.id)}>
                            Save prices
                          </Button>
                        </div>
                      );
                    })()}
                    <p className="text-foreground-subtle text-xs leading-relaxed">
                      Optional. Atlas has no price list, so these are your own numbers from your
                      provider’s pricing page. They are used for one thing: the estimated spending on the
                      Stats page. They never limit or change what is sent.
                    </p>
                    {safetyNote[config.id] && <p className="text-danger text-xs">{safetyNote[config.id]}</p>}
                  </div>
                );
              })()}

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

          {addError && <p className="text-danger text-xs leading-relaxed">{addError}</p>}

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
