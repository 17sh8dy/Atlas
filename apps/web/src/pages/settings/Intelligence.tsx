/**
 * Intelligence — the one thing Atlas can escalate to, and its switch.
 *
 * ── What this page used to be ───────────────────────────────────────────────
 * "Developer → Intelligence Providers": a list of five. Claude and ChatGPT
 * with key fields, then Local Models, Gemini and Custom Provider sitting
 * underneath marked *Planned*. Three of the five did nothing, and the two
 * that worked both sent your questions to a company. A page advertising a
 * marketplace Atlas did not have, for a capability it mostly did not need.
 *
 * Now it lists one, it runs on this machine, and there is no key field
 * because there is nothing to authenticate to.
 *
 * ── Off is a real state, not a broken one ───────────────────────────────────
 * The copy leads with what still works. Atlas answers, acts and searches with
 * this switch off — that is the entire premise of the engine — so a page that
 * opened with "not connected" would be describing a fault that isn't one.
 * "Cortex isn't running" is information, not an error, and it is phrased that
 * way.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icons, Button, Input, Surface, Switch, cn } from '@atlas/ui';
import type { Storage } from '@atlas/core';
import type { CortexSettings } from '@atlas/data';
import { writeCortexBaseUrl, writeCortexEnabled, writeActiveProvider } from '@atlas/data';
import { CORTEX_DEFAULT_BASE_URL, isCortexReachable } from '@atlas/platform';

interface Props {
  storage: Storage;
  cortex: CortexSettings;
  activeProviderId: string | null;
  onProviderChange(): void;
}

export function Intelligence({ storage, cortex, activeProviderId, onProviderChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [endpoint, setEndpoint] = useState(cortex.baseUrl);
  /** null while unknown — the probe hasn't answered yet. */
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => setEndpoint(cortex.baseUrl), [cortex.baseUrl]);

  // Only probed while it's switched on. Polling a port the user never asked
  // Atlas to talk to would be a connection attempt they didn't consent to,
  // however harmless the destination.
  useEffect(() => {
    if (!cortex.enabled) {
      setReachable(null);
      return;
    }
    let alive = true;
    void isCortexReachable(cortex.baseUrl).then((up) => {
      if (alive) setReachable(up);
    });
    return () => {
      alive = false;
    };
  }, [cortex.enabled, cortex.baseUrl]);

  const toggle = useCallback(
    async (next: boolean) => {
      setSaving(true);
      try {
        await writeCortexEnabled(storage, next);
        // Enabling it also selects it — there is nothing else to select, and
        // making someone flip a switch and then press "use this" is a second
        // step that only ever had one possible answer.
        await writeActiveProvider(storage, next ? 'cortex' : null);
        onProviderChange();
      } finally {
        setSaving(false);
      }
    },
    [storage, onProviderChange],
  );

  const saveEndpoint = useCallback(async () => {
    setSaving(true);
    try {
      await writeCortexBaseUrl(storage, endpoint);
      onProviderChange();
    } finally {
      setSaving(false);
    }
  }, [storage, endpoint, onProviderChange]);

  const active = activeProviderId === 'cortex' && cortex.enabled;

  return (
    <div className="flex flex-col gap-4">
      <section>
        <div className="mb-1 flex items-center gap-2">
          <Icons.Brain className="text-primary h-4 w-4" />
          <h2 className="text-foreground text-sm font-medium">Cortex</h2>
        </div>
        <p className="text-foreground-muted mb-3 text-xs leading-relaxed">
          Atlas answers and acts on its own. Cortex is the one thing it escalates to — open-ended
          reasoning about the wider world — and it runs on this machine. Nothing is sent anywhere,
          and it needs no account or key.
        </p>

        <Surface className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground text-sm font-medium">Use Cortex</span>
              {active && (
                <Tag tone={reachable === false ? 'muted' : 'on'}>
                  {reachable === null ? 'Checking…' : reachable ? 'Running' : 'Not running'}
                </Tag>
              )}
            </div>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              {active && reachable === false
                ? 'Switched on, but nothing is answering on that port. Atlas carries on without it.'
                : 'For questions Atlas has no action for.'}
            </p>
          </div>
          <Switch
            checked={cortex.enabled}
            disabled={saving}
            onCheckedChange={(next) => void toggle(next)}
            aria-label="Use Cortex"
          />
        </Surface>
      </section>

      {cortex.enabled && (
        <section>
          <h3 className="text-foreground-subtle mb-2 text-xs font-medium uppercase tracking-wide">
            Where Cortex is listening
          </h3>
          <div className="flex gap-2">
            <Input
              value={endpoint}
              placeholder={CORTEX_DEFAULT_BASE_URL}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <Button
              variant="secondary"
              size="md"
              disabled={saving || endpoint === cortex.baseUrl}
              onClick={() => void saveEndpoint()}
            >
              Save
            </Button>
          </div>
          <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
            Leave blank for {CORTEX_DEFAULT_BASE_URL}. This machine only — an address that isn't
            localhost is refused, so it can never become a route off the device.
          </p>
        </section>
      )}

      <p className="text-foreground-subtle text-xs leading-relaxed">
        Atlas connects to no other model. There is no cloud provider, no fallback, and nothing to
        opt out of.
      </p>
    </div>
  );
}

function Tag({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'on' | 'muted' }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium',
        tone === 'on'
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border text-foreground-subtle',
      )}
    >
      {children}
    </span>
  );
}
