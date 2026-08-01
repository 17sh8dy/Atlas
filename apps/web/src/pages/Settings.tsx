/**
 * Settings — which is mostly Intelligence Providers.
 *
 * The hierarchy on this screen is the product's central claim, so it is stated
 * literally: the engine is at the top, marked always-on and with no controls,
 * because there is nothing to configure and nothing that could be switched off.
 * External models are listed underneath as optional accessories.
 *
 * The alternative framing — a "Connect your AI" screen you must complete before
 * the app works — would describe a different program than the one this is.
 */

import { Icons, cn } from '@atlas/ui';
import type { SkillRegistry } from '@atlas/engine';
import type { CapabilityName, Platform } from '@atlas/core';

interface Props {
  platform: Platform;
  capabilities: readonly CapabilityName[];
  skills: SkillRegistry;
}

interface ProviderRow {
  id: string;
  name: string;
  icon: typeof Icons.Brain;
  always?: boolean;
  planned?: boolean;
  desc: string;
}

const PROVIDERS: ProviderRow[] = [
  {
    id: 'engine',
    name: 'Navigator Engine',
    icon: Icons.Brain,
    always: true,
    desc: 'Understands what you ask, drives this machine, searches, and remembers. Runs locally. No account, no key, no network.',
  },
  {
    id: 'local',
    name: 'Local Models',
    icon: Icons.MonitorSmartphone,
    planned: true,
    desc: 'Ollama on this machine, for open-ended questions. Private and free — nothing leaves your computer.',
  },
  {
    id: 'claude',
    name: 'Claude',
    icon: Icons.Cloud,
    planned: true,
    desc: 'Free-form reasoning about the wider world, through a proxy you host. Your API key stays on your own server.',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: Icons.Cloud,
    planned: true,
    desc: 'Not built yet. Would connect the same way as the other cloud models.',
  },
];

export function Settings({ platform, capabilities, skills }: Props) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-lg">
        <h1 className="text-base font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Everything optional lives here. Atlas is complete without any of it.
        </p>

        <section className="mt-7">
          <div className="mb-1 flex items-center gap-2">
            <Icons.Brain className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-medium text-foreground">Intelligence Providers</h2>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-foreground-subtle">
            The engine is the brain and is always running. External models only add open-ended
            reasoning about the wider world — the one thing the engine deliberately doesn&apos;t do.
          </p>

          <div className="overflow-hidden rounded-xl border border-border">
            {PROVIDERS.map((p, i) => (
              <div
                key={p.id}
                className={cn(
                  'flex items-start gap-3 px-4 py-3.5',
                  i > 0 && 'border-t border-border',
                  p.always && 'bg-primary/5',
                )}
              >
                <p.icon
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    p.always ? 'text-primary' : 'text-foreground-subtle',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{p.name}</span>
                    <Tag tone={p.always ? 'on' : 'muted'}>
                      {p.always ? 'Always enabled' : 'Planned'}
                    </Tag>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-foreground-subtle">{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-7">
          <h2 className="mb-3 text-sm font-medium text-foreground">This machine</h2>
          <dl className="overflow-hidden rounded-xl border border-border text-sm">
            <Row label="Platform" value={platform.id === 'tauri' ? 'Desktop (Tauri)' : 'Browser'} />
            <Row label="Actions available" value={String(skills.available().length)} />
            <Row
              label="Capabilities"
              value={capabilities.length ? capabilities.join(', ') : 'none — browser sandbox'}
            />
          </dl>
          <p className="mt-2 text-xs leading-relaxed text-foreground-subtle">
            Skills that need a capability this build doesn&apos;t have are hidden rather than
            shown broken — which is why the browser lists fewer actions than the desktop app.
          </p>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border px-4 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-xs text-foreground-subtle">{label}</dt>
      <dd className="truncate text-right text-xs text-foreground">{value}</dd>
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'on' | 'muted' }) {
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
