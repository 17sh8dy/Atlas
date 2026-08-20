/**
 * Privacy — placeholder, and the future home for anything that needs a
 * network exception (weather, most notably — see docs/ROADMAP.md). Nothing
 * in Atlas calls out to the network today; this tab exists so that if
 * something ever does, it's opt-in and disclosed here rather than silent.
 */

import { Icons, Surface } from '@atlas/ui';

export function Privacy() {
  return (
    <Surface className="flex items-start gap-3 p-4">
      <Icons.Lock className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <h2 className="text-foreground text-sm font-medium">Nothing to configure yet</h2>
        <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
          Atlas makes no network calls today. Anything that would need one in the future — like
          weather, which needs an external API — will be opt-in and shown here, with your own key if
          one is required.
        </p>
      </div>
    </Surface>
  );
}
