/**
 * Startup — placeholder. Autostart wiring (registering Atlas to launch at
 * login) is real OS-integration work saved for a later phase; this is UI
 * only, shown disabled so the setting exists in the right place once it does.
 */

import { Switch } from '@atlas/ui';

export function Startup() {
  return (
    <section>
      <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3.5">
        <div>
          <h2 className="text-foreground text-sm font-medium">Launch Atlas at login</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            Planned for a later phase.
          </p>
        </div>
        <Switch checked={false} disabled aria-label="Launch Atlas at login (not yet available)" />
      </div>
    </section>
  );
}
