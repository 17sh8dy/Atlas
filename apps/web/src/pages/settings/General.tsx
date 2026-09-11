/**
 * General — what this build of Atlas can do, and the machine it's running on.
 *
 * The engine itself is the one thing worth stating literally here: always
 * running, nothing to configure, nothing that could be switched off. External
 * providers used to be listed on this screen too, as optional accessories
 * underneath it — they've moved to Settings → Developer, since choosing and
 * wiring up one is a decision for someone who already knows which provider
 * they want, not a setting on the way to changing your name or theme.
 *
 * ── The capability ids are not for reading ──────────────────────────────────
 * This screen used to print them raw: "files, fs, apps, system, processes,
 * clipboard, notifications, os, wind…" — a comma-joined dump of internal
 * identifiers, right-aligned in a cell that truncated it. Three separate
 * problems in one line. It named `fs` and `os` and `windows`, which mean
 * nothing to anyone who has not read `platform.ts`; it listed `files` and
 * `fs` as though they were different things to a person, when both are "can
 * Atlas work with your files"; and it cut off whatever did not fit, so the
 * list was incomplete on top of being unreadable.
 *
 * The ids are still the truth underneath — the engine hides skills whose
 * capability is missing, and that is what makes the count honest — but the
 * page now says what each one *lets Atlas do*, in the words someone using the
 * app would choose.
 */

import { useEffect, useState } from 'react';
import type { SkillRegistry } from '@atlas/engine';
import type { CapabilityName, ExecutionMode, Platform } from '@atlas/core';
import { EXECUTION_MODES, EXECUTION_MODE_META } from '@atlas/core';
import { Button, Icons, Input, SegmentedControl } from '@atlas/ui';

interface Props {
  platform: Platform;
  capabilities: readonly CapabilityName[];
  skills: SkillRegistry;
  executionMode: ExecutionMode;
  onExecutionModeChange(mode: ExecutionMode): void;
}

/**
 * What each capability means to the person using Atlas, rather than to the
 * code that checks for it.
 *
 * Two ids deliberately share a label. `files` is the search index and `fs` is
 * opening and revealing paths — a real distinction to the engine, and none at
 * all to someone asking whether Atlas can get at their files. Collapsing them
 * is the point rather than a shortcut: a list that says "Files" once is more
 * accurate about what is on offer than one that says "files" and "fs".
 */
const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  files: 'Files',
  fs: 'Files',
  apps: 'Apps',
  system: 'System info',
  processes: 'Processes',
  os: 'Device controls',
  windows: 'Window',
  'window-control': 'Other windows',
  input: 'Mouse & keyboard',
  'ui-automation': 'App controls',
  screen: 'Screen capture',
  clipboard: 'Clipboard',
  notifications: 'Notifications',
  network: 'Web',
  services: 'Services',
  environment: 'Environment variables',
  storage: 'Folder sizes',
  devtools: 'Developer tools',
  speech: 'Speech',
  listening: 'Listening',
  ai: 'AI',
};

/**
 * The order they read in, which is not the order the backend reports them.
 *
 * Grouped by what they are about — your files and apps, then the machine,
 * then the things Atlas passes through, then the two local models — so the
 * list scans as categories rather than as whatever order the capability
 * probe happened to finish in.
 */
const CAPABILITY_ORDER: readonly CapabilityName[] = [
  'files',
  'fs',
  'apps',
  'system',
  'processes',
  'os',
  'windows',
  'window-control',
  'input',
  'ui-automation',
  'screen',
  'clipboard',
  'notifications',
  'network',
  'services',
  'devtools',
  'speech',
  'listening',
  'ai',
];

/** Present capabilities as labels: ordered, de-duplicated, human. */
function capabilityLabels(capabilities: readonly CapabilityName[]): string[] {
  const present = new Set(capabilities);
  const labels: string[] = [];
  for (const name of CAPABILITY_ORDER) {
    if (!present.has(name)) continue;
    const label = CAPABILITY_LABELS[name];
    // `files` and `fs` both land on "Files"; whichever comes first wins and
    // the other is not repeated.
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function General({
  platform,
  capabilities,
  skills,
  executionMode,
  onExecutionModeChange,
}: Props) {
  const labels = capabilityLabels(capabilities);

  return (
    <div>
      <section className="mb-8">
        <h2 className="text-foreground mb-3 text-sm font-medium">Execution mode</h2>
        <p className="text-foreground-muted mb-3 text-xs leading-relaxed">
          How much Atlas asks before it acts. This never changes which actions are safe and which
          aren&apos;t — only when the question about a consequential one gets put to you. The same
          three modes are also reachable from the composer (Shift+Tab cycles them).
        </p>
        <SegmentedControl
          options={EXECUTION_MODES.map((mode) => ({
            value: mode,
            label: EXECUTION_MODE_META[mode].label,
          }))}
          value={executionMode}
          onChange={onExecutionModeChange}
        />
        <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
          {EXECUTION_MODE_META[executionMode].description}
        </p>
      </section>

      <section>
        <h2 className="text-foreground mb-3 text-sm font-medium">Device</h2>
        <dl className="border-border overflow-hidden rounded-xl border text-sm">
          <Row label="Platform" value={platform.id === 'tauri' ? 'Desktop (Tauri)' : 'Browser'} />
          <Row label="Actions available" value={String(skills.available().length)} />
        </dl>

        {/*
          Out of the definition list on purpose. As a row it was a single
          right-aligned cell that truncated; as its own block it wraps, so the
          list is complete however many capabilities a build has.
        */}
        <div className="mt-4">
          <p className="text-foreground-subtle text-[10px] font-medium uppercase tracking-wide">
            Capabilities
          </p>
          <p className="text-foreground mt-1.5 text-xs leading-relaxed">
            {labels.length ? labels.join(' · ') : 'None — running in the browser sandbox.'}
          </p>
        </div>

        <p className="text-foreground-subtle mt-3 text-xs leading-relaxed">
          Skills that need a capability this build doesn&apos;t have are hidden rather than shown
          broken — which is why the browser lists fewer actions than the desktop app.
        </p>
      </section>

      <AllowedFolders platform={platform} />
    </div>
  );
}

/**
 * The one setting that decides what every file command may touch.
 *
 * `%USERPROFILE%` is here by default, preserving exactly what Atlas could
 * already reach — this is a way to widen that reach deliberately (a projects
 * drive living outside the home folder, say), not a permission anyone has to
 * grant for Atlas to work at all. Absent entirely in the browser build, which
 * has no filesystem access to gate in the first place.
 */
function AllowedFolders({ platform }: { platform: Platform }) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    platform
      .allowedFolders?.()
      .then((list) => {
        if (alive) setFolders(list);
      })
      .catch(() => {
        if (alive) setFolders([]);
      });
    return () => {
      alive = false;
    };
  }, [platform]);

  if (!platform.allowedFolders) return null;

  const add = async () => {
    const path = input.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      setFolders(await platform.addAllowedFolder!(path));
      setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that folder.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      setFolders(await platform.removeAllowedFolder!(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove that folder.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="text-foreground mb-3 text-sm font-medium">Allowed folders</h2>
      <p className="text-foreground-muted mb-3 text-xs leading-relaxed">
        Atlas can only open, read, or change something inside one of these folders — everywhere else
        is refused, the same way running an arbitrary command is. Your home folder is here by
        default; add another one (a projects drive, say) to let Atlas reach it too.
      </p>

      {folders === null ? (
        <p className="text-foreground-subtle text-xs">Loading…</p>
      ) : (
        <ul className="border-border overflow-hidden rounded-xl border text-sm">
          {folders.map((path) => (
            <li
              key={path}
              className="border-border flex items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0"
            >
              <span className="text-foreground truncate text-xs" title={path}>
                {path}
              </span>
              <button
                type="button"
                onClick={() => remove(path)}
                disabled={busy || folders.length <= 1}
                className="text-foreground-subtle hover:text-foreground shrink-0 disabled:opacity-30"
                aria-label={`Remove ${path}`}
                title={
                  folders.length <= 1 ? 'At least one folder has to stay on the list.' : 'Remove'
                }
              >
                <Icons.Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="D:\Dev"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          className="flex-1"
        />
        <Button variant="secondary" size="sm" onClick={add} disabled={busy || !input.trim()}>
          <Icons.Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {error && <p className="text-warning mt-2 text-xs">{error}</p>}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border flex items-baseline justify-between gap-4 border-b px-4 py-2.5 last:border-b-0">
      <dt className="text-foreground-subtle shrink-0 text-xs">{label}</dt>
      <dd className="text-foreground truncate text-right text-xs">{value}</dd>
    </div>
  );
}
