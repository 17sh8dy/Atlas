/**
 * General — what this build of Atlas can do, and the machine it's running on.
 *
 * The engine itself is the one thing worth stating literally here: always
 * running, nothing to configure, nothing that could be switched off. External
 * providers used to be listed on this screen too, as optional accessories
 * underneath it — they've moved to Settings → Developer, since choosing and
 * wiring up one is a decision for someone who already knows which provider
 * they want, not a setting on the way to changing your name or theme.
 */

import type { SkillRegistry } from '@atlas/engine';
import type { CapabilityName, Platform } from '@atlas/core';

interface Props {
  platform: Platform;
  capabilities: readonly CapabilityName[];
  skills: SkillRegistry;
}

export function General({ platform, capabilities, skills }: Props) {
  return (
    <div>
      <section>
        <h2 className="text-foreground mb-3 text-sm font-medium">This machine</h2>
        <dl className="border-border overflow-hidden rounded-xl border text-sm">
          <Row label="Platform" value={platform.id === 'tauri' ? 'Desktop (Tauri)' : 'Browser'} />
          <Row label="Actions available" value={String(skills.available().length)} />
          <Row
            label="Capabilities"
            value={capabilities.length ? capabilities.join(', ') : 'none — browser sandbox'}
          />
        </dl>
        <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
          Skills that need a capability this build doesn&apos;t have are hidden rather than shown
          broken — which is why the browser lists fewer actions than the desktop app.
        </p>
      </section>
    </div>
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
