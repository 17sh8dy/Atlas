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
 *
 * ── Starting it ─────────────────────────────────────────────────────────────
 * It is a Python program in a folder of its own, and the Atlas download does
 * not include it. Turning it on is meant to be enough, so Atlas finds that
 * folder (or is shown it once) and starts the server itself — see
 * `atlas/novaLauncher.ts`. This section only reports on that and lets the
 * person start it by hand, point Atlas at the folder, or stop Atlas starting it
 * on its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icons, Surface, Switch } from '@atlas/ui';
import type { Platform, Storage } from '@atlas/core';
import {
  writeActiveProvider,
  writeNovaIntelligenceAutoStart,
  writeNovaIntelligenceBaseUrl,
  writeNovaIntelligenceEnabled,
  writeNovaIntelligenceFolder,
} from '@atlas/data';
import {
  NOVA_INTELLIGENCE_DEFAULT_BASE_URL,
  NOVA_INTELLIGENCE_PROVIDER_ID,
  isNovaIntelligenceReachable,
  locateNovaIntelligence,
  novaIntelligenceLaunchState,
  stopNovaIntelligence,
} from '@atlas/platform';
import type { NovaIntelligenceFolder } from '@atlas/platform';
import type { LocalAiRuntime } from '../../../atlas/buildIntelligence';
import { ensureNovaIntelligence, explainEnsure } from '../../../atlas/novaLauncher';
import { EndpointField, SectionHeader, Tag } from './parts';

interface Props {
  platform: Platform;
  storage: Storage;
  localAi: LocalAiRuntime;
  activeId: string | null;
  onChange(): void;
}

/** How long a start is watched before it is called stuck. Loading a model is slow, not instant. */
const START_PATIENCE_MS = 120_000;
const POLL_MS = 2_000;

type Start = { phase: 'idle' } | { phase: 'starting' } | { phase: 'problem'; message: string };

export function NovaIntelligence({ platform, storage, localAi, activeId, onChange }: Props) {
  const nova = localAi.nova;
  const [saving, setSaving] = useState(false);
  /** null while unknown — the probe has not answered yet. */
  const [reachable, setReachable] = useState<boolean | null>(null);
  /** undefined while looking; null when there is no such folder on this PC. */
  const [located, setLocated] = useState<NovaIntelligenceFolder | null | undefined>(undefined);
  const [start, setStart] = useState<Start>({ phase: 'idle' });
  const watching = useRef(0);

  // Where it is. Looked up again when the chosen folder changes.
  useEffect(() => {
    if (!nova.enabled) {
      setLocated(undefined);
      return;
    }
    let alive = true;
    void locateNovaIntelligence(nova.folder).then((found) => {
      if (alive) setLocated(found);
    });
    return () => {
      alive = false;
    };
  }, [nova.enabled, nova.folder]);

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

  /** Follow a start until it answers, dies, or runs out of patience. */
  const watch = useCallback(() => {
    const ticket = ++watching.current;
    setStart({ phase: 'starting' });
    const began = Date.now();
    const tick = async () => {
      if (watching.current !== ticket) return;
      if (await isNovaIntelligenceReachable(nova.baseUrl)) {
        if (watching.current !== ticket) return;
        setReachable(true);
        setStart({ phase: 'idle' });
        return;
      }
      const launch = await novaIntelligenceLaunchState();
      if (watching.current !== ticket) return;
      if (launch.state === 'exited') {
        setStart({
          phase: 'problem',
          message: `The server stopped before it was ready.${launch.detail ? ` It said: ${launch.detail}` : ''}`,
        });
        return;
      }
      if (Date.now() - began > START_PATIENCE_MS) {
        setStart({
          phase: 'problem',
          message:
            'It is running but still hasn’t answered after two minutes. Try again in a moment.',
        });
        return;
      }
      window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
  }, [nova.baseUrl]);

  // Auto-start (in the app shell) may have kicked it off before this page was
  // opened; pick that up rather than showing "not running" over a loading model.
  useEffect(() => {
    if (!nova.enabled || reachable !== false) return;
    let alive = true;
    void novaIntelligenceLaunchState().then((s) => {
      if (alive && s.state === 'running') watch();
    });
    return () => {
      alive = false;
    };
  }, [nova.enabled, reachable, watch]);

  useEffect(
    () => () => {
      watching.current += 1; // stop any watch when the page goes away
    },
    [],
  );

  const startNow = useCallback(async () => {
    setStart({ phase: 'starting' });
    const result = await ensureNovaIntelligence(nova);
    if (result.kind === 'up') {
      setReachable(true);
      setStart({ phase: 'idle' });
      return;
    }
    if (result.kind === 'started') {
      watch();
      return;
    }
    setStart({ phase: 'problem', message: explainEnsure(result) ?? 'It would not start.' });
  }, [nova, watch]);

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

  const chooseFolder = useCallback(async () => {
    const picked = await platform.pickFolder?.({ title: 'Choose the NovaIntelligence folder' });
    if (!picked) return;
    const found = await locateNovaIntelligence(picked);
    if (!found || found.path.toLowerCase() !== picked.trim().toLowerCase()) {
      setStart({
        phase: 'problem',
        message:
          'That doesn’t look like the NovaIntelligence folder. It should contain .venv and phase4_nova\\server.py.',
      });
      return;
    }
    await run(() => writeNovaIntelligenceFolder(storage, found.path));
    setLocated(found);
    if (!found.hasModel) {
      setStart({
        phase: 'problem',
        message: `Found it at ${found.path}, but its trained model is missing, so there is nothing to start.`,
      });
      return;
    }
    setStart({ phase: 'idle' });
    void startNow();
  }, [platform, run, startNow, storage]);

  const inUse = activeId === NOVA_INTELLIGENCE_PROVIDER_ID;
  const notInstalled = nova.enabled && located === null;
  const running = reachable === true;

  const status = !nova.enabled
    ? null
    : start.phase === 'starting'
      ? 'Starting…'
      : reachable === null
        ? 'Checking…'
        : running
          ? 'Running'
          : 'Not running';

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
              {status && (
                <Tag tone={running ? 'on' : start.phase === 'starting' ? 'muted' : 'warn'}>
                  {status}
                </Tag>
              )}
              {inUse && nova.enabled && <Tag tone="on">In use</Tag>}
            </div>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              {start.phase === 'starting'
                ? 'Starting it now. Loading the model can take a minute.'
                : start.phase === 'problem'
                  ? start.message
                  : notInstalled
                    ? (explainEnsure({ kind: 'not-found' }) ?? '')
                    : nova.enabled && reachable === false
                      ? 'Switched on, but not running yet.'
                      : 'Runs on this PC. Nothing is sent anywhere.'}
            </p>
          </div>
          <Switch
            checked={nova.enabled}
            disabled={saving}
            onCheckedChange={(next) => {
              // Turning it off also stops the copy Atlas started; turning it on
              // is picked up by the app shell, which starts it.
              if (!next) {
                watching.current += 1;
                setStart({ phase: 'idle' });
                void stopNovaIntelligence();
              }
              void run(() => writeNovaIntelligenceEnabled(storage, next));
            }}
            aria-label="Use Nova Intelligence"
          />
        </div>

        {nova.enabled && (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {!running && located && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving || start.phase === 'starting'}
                  onClick={() => void startNow()}
                >
                  {start.phase === 'starting' ? 'Starting…' : 'Start Nova Intelligence'}
                </Button>
              )}
              {(notInstalled || start.phase === 'problem') && platform.pickFolder && (
                <Button
                  variant={located ? 'ghost' : 'primary'}
                  size="sm"
                  disabled={saving}
                  onClick={() => void chooseFolder()}
                >
                  Choose the NovaIntelligence folder…
                </Button>
              )}
              <Button
                variant={inUse ? 'secondary' : running ? 'primary' : 'ghost'}
                size="sm"
                disabled={saving || inUse}
                onClick={() =>
                  void run(() => writeActiveProvider(storage, NOVA_INTELLIGENCE_PROVIDER_ID))
                }
              >
                {inUse ? 'In use' : 'Use for conversation'}
              </Button>
            </div>

            {located && (
              <p className="text-foreground-subtle mt-3 break-all text-xs leading-relaxed">
                Folder: {located.path}
              </p>
            )}

            <div className="border-border mt-3 flex items-center justify-between gap-4 border-t pt-3">
              <div className="min-w-0">
                <span className="text-foreground text-xs font-medium">Start automatically</span>
                <p className="text-foreground-subtle text-xs leading-relaxed">
                  Start it when Atlas opens, so it is ready when you are. It stops when Atlas quits.
                </p>
              </div>
              <Switch
                checked={nova.autoStart}
                disabled={saving}
                onCheckedChange={(next) =>
                  void run(() => writeNovaIntelligenceAutoStart(storage, next))
                }
                aria-label="Start Nova Intelligence automatically"
              />
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
