/**
 * Default apps — placeholder. Atlas currently opens files and links with
 * whatever Windows already has registered as the default handler (via the
 * `open` crate in `platform.rs`); per-action overrides are planned but not
 * built.
 */

import { Icons, Surface } from '@atlas/ui';

export function DefaultApps() {
  return (
    <Surface className="flex items-start gap-3 p-4">
      <Icons.AppWindow className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <h2 className="text-foreground text-sm font-medium">Using your Windows defaults</h2>
        <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
          Atlas opens files and links with whatever your system already has set as default.
          Per-action overrides (e.g. always open PDFs in a specific app) are planned.
        </p>
      </div>
    </Surface>
  );
}
