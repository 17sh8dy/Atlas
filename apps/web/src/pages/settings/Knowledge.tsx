/**
 * Knowledge — what Atlas knows about Nova and itself, and how it keeps that current.
 *
 * Two switches, both on by default, each saying what it contacts. Everything is read from the
 * native side, which verifies the pack against a compiled-in key; this page only displays and
 * toggles. A failed check is shown in "Last problem", it does not throw.
 *
 * Advanced: the Token accuracy table (what Atlas has learned about how a model counts compared with
 * its own estimate). It holds ratios and counts only, never text.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Switch } from '@atlas/ui';
import {
  calibrationReset,
  calibrationStatus,
  isTauri,
  knowledgeCheckNow,
  knowledgeSetAutoRefresh,
  knowledgeSetLiveLookups,
  knowledgeStatus,
} from '@atlas/platform';
import type { CalibrationRow, KnowledgeStatus } from '@atlas/platform';
import {
  AUTO_REFRESH_EXPLAINER,
  LIVE_LOOKUPS_EXPLAINER,
  packDate,
  packNote,
  ratioLabel,
  sortCalibration,
  sourceLabel,
  whenMs,
} from './knowledgeView';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-xs">
      <span className="text-foreground-subtle">{label}</span>
      <span className="text-foreground text-right tabular-nums">{value}</span>
    </div>
  );
}

function Toggle({
  title,
  body,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  body: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3.5">
      <div>
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{body}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} />
    </div>
  );
}

export function Knowledge() {
  const native = isTauri();
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [rows, setRows] = useState<CalibrationRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!native) return;
    try {
      setStatus(await knowledgeStatus());
      setRows(sortCalibration(await calibrationStatus()));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, [native]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!native) {
    return (
      <p className="text-foreground-subtle text-sm">
        The knowledge pack belongs to the desktop app, so there is nothing to show in a browser.
      </p>
    );
  }

  const act = async (fn: () => Promise<KnowledgeStatus>) => {
    setBusy(true);
    setProblem(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <Toggle
        title="Refresh Nova knowledge automatically"
        body={AUTO_REFRESH_EXPLAINER}
        checked={status?.autoRefresh ?? true}
        disabled={!status || busy}
        onChange={(v) => void act(() => knowledgeSetAutoRefresh(v))}
      />
      <Toggle
        title="Look up current information from Nova's public pages"
        body={LIVE_LOOKUPS_EXPLAINER}
        checked={status?.liveLookups ?? true}
        disabled={!status || busy}
        onChange={(v) => void act(() => knowledgeSetLiveLookups(v))}
      />

      <div className="border-border rounded-xl border px-4 py-3.5">
        <h2 className="text-foreground mb-1 text-sm font-medium">Knowledge pack</h2>
        {status ? (
          <>
            <p className="text-foreground-subtle mb-2 text-xs leading-relaxed">{packNote(status)}</p>
            <Row label="Version" value={status.seq === null ? '—' : String(status.seq)} />
            <Row label="Built" value={packDate(status.builtAt)} />
            <Row label="Source" value={sourceLabel(status)} />
            <Row label="Last checked" value={whenMs(status.lastCheckedMs)} />
            <Row label="Last updated" value={whenMs(status.lastUpdatedMs)} />
            <Row label="Last problem" value={status.lastError ?? 'None'} />
          </>
        ) : (
          <p className="text-foreground-subtle text-xs">Loading…</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !status?.provisioned}
            onClick={() => void act(knowledgeCheckNow)}
          >
            {busy ? 'Checking…' : 'Check now'}
          </Button>
          {problem && <p className="text-foreground-subtle text-xs">{problem}</p>}
        </div>
      </div>

      <details className="border-border rounded-xl border px-4 py-3.5">
        <summary className="text-foreground cursor-pointer text-sm font-medium">Token accuracy (advanced)</summary>
        <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
          When a model reports how many tokens it used, Atlas compares that with its own estimate and learns a
          correction per model. Only ratios and counts are kept, never text. A correction is used after 20 samples.
        </p>
        {rows.length === 0 ? (
          <p className="text-foreground-subtle mt-2 text-xs">Nothing learned yet.</p>
        ) : (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-foreground-subtle text-left">
                <th className="py-1 font-normal">Model</th>
                <th className="py-1 font-normal">Kind</th>
                <th className="py-1 text-right font-normal">Samples</th>
                <th className="py-1 text-right font-normal">Ratio</th>
                <th className="py-1 text-right font-normal">In use</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.provider}/${r.model}/${r.kind}`} className="text-foreground">
                  <td className="py-1">{r.model}</td>
                  <td className="py-1">{r.kind}</td>
                  <td className="py-1 text-right tabular-nums">{r.samples}</td>
                  <td className="py-1 text-right tabular-nums">{ratioLabel(r.ratioPermille)}</td>
                  <td className="py-1 text-right">{r.inUse ? 'Yes' : 'Not yet'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={rows.length === 0}
            onClick={async () => {
              await calibrationReset();
              await load();
            }}
          >
            Reset token accuracy
          </Button>
        </div>
      </details>
    </section>
  );
}
