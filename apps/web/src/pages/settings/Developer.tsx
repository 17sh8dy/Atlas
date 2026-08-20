/**
 * Developer — Intelligence Providers.
 *
 * Moved out of General: connecting an external model is a decision for
 * someone who already knows which provider they want and how to use its
 * API, not a setting every user needs to see on the way to changing their
 * name or theme. The engine itself has no row here — it's always on and
 * unconfigurable, so there's nothing to show.
 *
 * Claude and ChatGPT are real: the key you save here goes through the same
 * `Storage` port as everything else Atlas remembers (see
 * `packages/data/src/provider-keys.ts`), and "Connected" reflects
 * `isConfigured()` on the actual registered `IntelligenceProvider` — not a
 * static label. Local Models and Gemini stay "Planned"; Custom Provider
 * documents the contract for one that doesn't exist yet.
 */

import { useEffect, useState } from 'react';
import { Icons, Button, Input, cn } from '@atlas/ui';
import type { Storage } from '@atlas/core';
import type { ProviderKeyId } from '@atlas/data';
import { writeProviderKey, writeActiveProvider } from '@atlas/data';

interface Props {
  storage: Storage;
  providerKeys: Partial<Record<ProviderKeyId, string>>;
  activeProviderId: string | null;
  onProviderChange(): void;
}

interface PlannedRow {
  id: string;
  name: string;
  icon: typeof Icons.Brain;
  desc: string;
}

const PLANNED: PlannedRow[] = [
  {
    id: 'local',
    name: 'Local Models',
    icon: Icons.MonitorSmartphone,
    desc: 'Ollama on this machine, for open-ended questions. Private and free — nothing leaves your computer.',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    icon: Icons.Cloud,
    desc: 'Not built yet. Would connect the same way as the other cloud models.',
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    icon: Icons.Settings,
    desc: 'Not built yet. Any endpoint implementing the provider contract (id, label, isConfigured, ask) can register itself.',
  },
];

export function Developer({ storage, providerKeys, activeProviderId, onProviderChange }: Props) {
  return (
    <div>
      <section>
        <div className="mb-1 flex items-center gap-2">
          <Icons.Brain className="text-primary h-4 w-4" />
          <h2 className="text-foreground text-sm font-medium">Intelligence Providers</h2>
        </div>
        <p className="text-foreground mb-3 text-xs font-medium leading-relaxed">
          Recommended for people who know which AI provider they prefer and understand how to use
          their APIs.
        </p>

        <div className="border-border bg-surface mb-4 rounded-xl border px-4 py-3">
          <p className="text-foreground-subtle text-xs leading-relaxed">
            <span className="text-foreground font-medium">Disclaimer:</span> Atlas does not pay for,
            provide, or include any AI plans or API credits. You must use API keys and services that
            you already own or have access to.
          </p>
        </div>

        <div className="border-border overflow-hidden rounded-xl border">
          <ConnectableProvider
            id="claude"
            name="Claude"
            icon={Icons.Cloud}
            desc="Free-form reasoning about the wider world. Your API key stays on this machine and is sent only to Anthropic."
            apiKey={providerKeys.claude}
            active={activeProviderId === 'claude'}
            storage={storage}
            onChange={onProviderChange}
          />
          <ConnectableProvider
            id="openai"
            name="ChatGPT"
            icon={Icons.Cloud}
            desc="Free-form reasoning about the wider world. Your API key stays on this machine and is sent only to OpenAI."
            apiKey={providerKeys.openai}
            active={activeProviderId === 'openai'}
            storage={storage}
            onChange={onProviderChange}
            first={false}
          />
          {PLANNED.map((p) => (
            <div key={p.id} className="border-border flex items-start gap-3 border-t px-4 py-3.5">
              <p.icon className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm font-medium">{p.name}</span>
                  <Tag>Planned</Tag>
                </div>
                <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ConnectableProvider({
  id,
  name,
  icon: Icon,
  desc,
  apiKey,
  active,
  storage,
  onChange,
  first = true,
}: {
  id: ProviderKeyId;
  name: string;
  icon: typeof Icons.Brain;
  desc: string;
  apiKey: string | undefined;
  active: boolean;
  storage: Storage;
  onChange(): void;
  first?: boolean;
}) {
  const configured = Boolean(apiKey);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  // The saved key never round-trips back into the field — there's nothing
  // to edit toward, only "replace" or "clear" — so unlike Personalization's
  // fields this one doesn't seed `value` from a prop.
  useEffect(() => setValue(''), [apiKey]);

  const save = async () => {
    setSaving(true);
    try {
      await writeProviderKey(storage, id, value);
      setValue('');
      onChange();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-2.5 px-4 py-3.5', !first && 'border-border border-t')}>
      <div className="flex items-start gap-3">
        <Icon className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground text-sm font-medium">{name}</span>
            <Tag tone={configured ? 'on' : 'muted'}>
              {configured ? 'Connected' : 'Not connected'}
            </Tag>
            {active && <Tag tone="on">Active</Tag>}
          </div>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{desc}</p>
        </div>
      </div>

      <div className="flex gap-2 pl-7">
        <Input
          type="password"
          value={value}
          placeholder={configured ? 'Replace saved key…' : 'API key'}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
        />
        <Button variant="secondary" size="md" disabled={!value.trim() || saving} onClick={save}>
          Save
        </Button>
        {configured && !active && (
          <Button
            variant="ghost"
            size="md"
            onClick={async () => {
              await writeActiveProvider(storage, id);
              onChange();
            }}
          >
            Use this
          </Button>
        )}
      </div>
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
