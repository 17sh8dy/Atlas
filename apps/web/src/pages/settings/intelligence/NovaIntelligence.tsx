/**
 * Nova Intelligence — Nova's own model, built from scratch.
 *
 * ── What this is, said plainly ──────────────────────────────────────────────
 * A small language model trained by Nova on public-domain text, running as its
 * own local process. It is real, it is Nova's, and it is early: it continues
 * text convincingly but cannot yet hold a conversation or follow an
 * instruction. The copy says so up front, because a settings row that implied
 * otherwise would set up a bad first experience. It is a section of its own,
 * not a rung on the ladder of models above it.
 *
 * Like every model here it is the conversation layer only — it never runs
 * anything; Atlas's skills, permissions and confirmations are unchanged.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Icons, Surface, Switch } from '@atlas/ui';
import type { Storage } from '@atlas/core';
import {
  writeActiveProvider,
  writeNovaIntelligenceBaseUrl,
  writeNovaIntelligenceEnabled,
} from '@atlas/data';
import {
  NOVA_INTELLIGENCE_DEFAULT_BASE_URL,
  NOVA_INTELLIGENCE_PROVIDER_ID,
  isNovaIntelligenceReachable,
} from '@atlas/platform';
import type { LocalAiRuntime } from '../../../atlas/buildIntelligence';
import { EndpointField, SectionHeader, Tag } from './parts';

interface Props {
  storage: Storage;
  localAi: LocalAiRuntime;
  activeId: string | null;
  onChange(): void;
}

export function NovaIntelligence({ storage, localAi, activeId, onChange }: Props) {
  const nova = localAi.nova;
  const [saving, setSaving] = useState(false);
  /** null while unknown — the probe has not answered yet. */
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!nova.enabled) {
      setReachable(null);
      return;
    }
    let alive = true;
    void isNovaIntelligenceReachable(nova.baseUrl).then((up) => {
      if (alive) setReachable(up);
    });
    return () => {
      alive = false;
    };
  }, [nova.enabled, nova.baseUrl]);

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

  const inUse = activeId === NOVA_INTELLIGENCE_PROVIDER_ID;

  return (
    <section>
      <SectionHeader
        icon={<Icons.Sparkles className="text-primary h-4 w-4" />}
        title="Nova Intelligence"
      >
        Nova&apos;s own model, built from scratch and trained on public-domain text. It is
        experimental: it can continue writing, but it can&apos;t hold a conversation or follow
        instructions yet, so it is not a substitute for the models above.
      </SectionHeader>

      <Surface className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground text-sm font-medium">Use Nova Intelligence</span>
              {nova.enabled && (
                <Tag tone={reachable === false ? 'warn' : 'on'}>
                  {reachable === null ? 'Checking…' : reachable ? 'Running' : 'Not running'}
                </Tag>
              )}
              {inUse && nova.enabled && <Tag tone="on">In use</Tag>}
            </div>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              {nova.enabled && reachable === false
                ? 'Switched on, but nothing is answering. Start its server from the NovaIntelligence folder: .venv\\Scripts\\python phase4_nova\\server.py'
                : 'Runs on this PC. Nothing is sent anywhere.'}
            </p>
          </div>
          <Switch
            checked={nova.enabled}
            disabled={saving}
            onCheckedChange={(next) => void run(() => writeNovaIntelligenceEnabled(storage, next))}
            aria-label="Use Nova Intelligence"
          />
        </div>

        {nova.enabled && (
          <>
            <div className="mt-3 flex">
              <Button
                variant={inUse ? 'secondary' : 'primary'}
                size="sm"
                disabled={saving || inUse}
                onClick={() =>
                  void run(() => writeActiveProvider(storage, NOVA_INTELLIGENCE_PROVIDER_ID))
                }
              >
                {inUse ? 'In use' : 'Use for conversation'}
              </Button>
            </div>
            <EndpointField
              value={nova.baseUrl}
              placeholder={NOVA_INTELLIGENCE_DEFAULT_BASE_URL}
              saving={saving}
              onSave={(next) => void run(() => writeNovaIntelligenceBaseUrl(storage, next))}
            />
          </>
        )}
      </Surface>
    </section>
  );
}
