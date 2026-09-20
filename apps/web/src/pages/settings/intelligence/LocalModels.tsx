/**
 * Local Models — models that run on this PC, through Ollama.
 *
 * ── What "in use" means ─────────────────────────────────────────────────────
 * The model marked *In use* is the one Atlas's conversation and reasoning go
 * through. Picking a different one changes how Atlas talks and thinks; it
 * changes nothing about what Atlas may do — actions on the computer stay with
 * Atlas's own skills, permissions and confirmations.
 *
 * ── Not every PC can run every model ────────────────────────────────────────
 * The larger models are ~14–24 GB downloads and are optional. The page says how
 * big each one is and how to get it, and never assumes it is installed: a row
 * for a model that is not there says so and shows the one command to run, and
 * "Use" stays off until it is. When Ollama is not running at all, the page
 * says that instead of listing every model as missing.
 *
 * ── Off is a real state ─────────────────────────────────────────────────────
 * Nothing is probed until the switch is on. A connection to a port nobody
 * asked Atlas to use would be one the user never consented to.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Icons, Surface, Switch } from '@atlas/ui';
import type { LocalModelProfile, Platform, Storage } from '@atlas/core';
import {
  DEFAULT_LOCAL_MODEL_ID,
  LOCAL_MODEL_PROFILES,
  ROLE_ICON,
  localModelIdForTag,
  sameOllamaTag,
} from '@atlas/core';
import { writeActiveProvider, writeLocalModelsBaseUrl, writeLocalModelsEnabled } from '@atlas/data';
import {
  OLLAMA_DEFAULT_BASE_URL,
  listInstalledLocalModels,
  type InstalledLocalModel,
} from '@atlas/platform';
import { extraInstalledTags, type LocalAiRuntime } from '../../../atlas/buildIntelligence';
import { EndpointField, SectionHeader, Tag } from './parts';

interface Props {
  platform: Platform;
  storage: Storage;
  localAi: LocalAiRuntime;
  /** The provider actually in use, after the saved pick is checked against what exists. */
  activeId: string | null;
  onChange(): void;
}

/** undefined: still checking. null: Ollama is not running. Otherwise, what it has. */
type Probe = InstalledLocalModel[] | null | undefined;

/** The guide "Install" opens: how to download Ollama models quickly. */
export const INSTALL_GUIDE_URL =
  'https://www.devtutorial.io/local-ai-with-ollama-downloading-and-testing-models-with-ollama-p3812.html';

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function LocalModels({ platform, storage, localAi, activeId, onChange }: Props) {
  const local = localAi.local;
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Probe>(undefined);

  const check = useCallback(() => {
    if (!local.enabled) {
      setProbe(undefined);
      return () => {};
    }
    let alive = true;
    setProbe(undefined);
    void listInstalledLocalModels(local.baseUrl).then((found) => {
      if (alive) setProbe(found);
    });
    return () => {
      alive = false;
    };
  }, [local.enabled, local.baseUrl]);

  useEffect(() => check(), [check]);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setSaving(true);
      try {
        await work();
        onChange();
      } finally {
        setSaving(false);
      }
    },
    [onChange],
  );

  const running = Array.isArray(probe);
  const installedNames = Array.isArray(probe) ? probe.map((m) => m.name) : [];
  const isInstalled = (p: LocalModelProfile) =>
    installedNames.some((n) => sameOllamaTag(n, p.ollamaTag));
  const extras = extraInstalledTags(installedNames);

  const status =
    probe === undefined ? (
      <Tag>Checking…</Tag>
    ) : probe === null ? (
      <Tag tone="warn">Ollama not running</Tag>
    ) : (
      <Tag tone="on">Ollama running</Tag>
    );

  const select = (id: string) => void run(() => writeActiveProvider(storage, id));

  return (
    <section>
      <SectionHeader icon={<Icons.Cpu className="text-primary h-4 w-4" />} title="Local Models">
        Models that run on this PC through Ollama. Nothing is sent anywhere, and there is no account
        or key.
      </SectionHeader>

      <Surface className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-sm font-medium">Use local models</span>
            {local.enabled && status}
          </div>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            {!local.enabled
              ? 'Off. Atlas still answers and acts on its own. Turn on to talk through a model on this PC — Qwen3-8B is the default.'
              : probe === null
                ? "Switched on, but Ollama isn't answering. Open the Ollama app; Atlas carries on without a model until then."
                : running && installedNames.length === 0
                  ? 'Ollama is running, but no models are installed yet. Pick one below to see how.'
                  : 'The model marked “In use” handles conversation and reasoning.'}
          </p>
        </div>
        <Switch
          checked={local.enabled}
          disabled={saving}
          onCheckedChange={(next) => void run(() => writeLocalModelsEnabled(storage, next))}
          aria-label="Use local models"
        />
      </Surface>

      {local.enabled && (
        <div className="mt-2 flex flex-col gap-2">
          {LOCAL_MODEL_PROFILES.map((p) => {
            const inUse = activeId === p.id;
            const installed = isInstalled(p);
            const missing = running && !installed;
            return (
              <Surface key={p.id} className="flex items-center gap-3 p-3">
                <span className="text-base" aria-hidden>
                  {ROLE_ICON[p.role]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground text-sm font-medium">{p.label}</span>
                    {p.id === DEFAULT_LOCAL_MODEL_ID && <Tag tone="on">Default</Tag>}
                    {running &&
                      (installed ? <Tag>Installed</Tag> : <Tag tone="warn">Not installed</Tag>)}
                  </div>
                  <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{p.blurb}</p>
                  {missing && (
                    <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
                      Get it with{' '}
                      <code className="text-foreground-muted">ollama pull {p.ollamaTag}</code> ·
                      about {p.approxDownloadGb} GB
                      {p.approxDownloadGb >= 10
                        ? ' — needs a powerful PC, so only if yours can run it'
                        : ''}
                    </p>
                  )}
                </div>
                {missing && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void platform.openUrl?.(INSTALL_GUIDE_URL)}
                    title="Opens a guide to downloading Ollama models"
                  >
                    Install
                  </Button>
                )}
                <Button
                  variant={inUse ? 'secondary' : 'primary'}
                  size="sm"
                  disabled={saving || inUse || !installed}
                  title={
                    installed || inUse
                      ? undefined
                      : probe === null
                        ? 'Start Ollama first, then Refresh'
                        : 'Install this model first'
                  }
                  onClick={() => select(p.id)}
                >
                  {inUse ? 'In use' : 'Use'}
                </Button>
              </Surface>
            );
          })}

          {extras.length > 0 && (
            <>
              <h3 className="text-foreground-subtle mt-2 text-xs font-medium uppercase tracking-wide">
                Also installed on this PC
              </h3>
              {extras.map((tag) => {
                const id = localModelIdForTag(tag);
                const inUse = activeId === id;
                const size = probe?.find((m) => m.name === tag)?.sizeBytes;
                return (
                  <Surface key={tag} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-foreground text-sm font-medium">{tag}</span>
                      {size ? (
                        <span className="text-foreground-subtle ml-2 text-xs">{gb(size)}</span>
                      ) : null}
                    </div>
                    <Button
                      variant={inUse ? 'secondary' : 'primary'}
                      size="sm"
                      disabled={saving || inUse}
                      onClick={() => select(id)}
                    >
                      {inUse ? 'In use' : 'Use'}
                    </Button>
                  </Surface>
                );
              })}
            </>
          )}

          <div className="flex items-center justify-between">
            <EndpointField
              value={local.baseUrl}
              placeholder={OLLAMA_DEFAULT_BASE_URL}
              saving={saving}
              onSave={(next) => void run(() => writeLocalModelsBaseUrl(storage, next))}
            />
            <Button variant="ghost" size="sm" onClick={() => check()} disabled={saving}>
              Refresh
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
