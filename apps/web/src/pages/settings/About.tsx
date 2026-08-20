/**
 * About — version and build info. On desktop, read from Tauri's own app
 * metadata (already available via `@tauri-apps/api`, no new plugin); on the
 * web build there's no version to show, since web isn't the shipping target.
 */

import { useEffect, useState } from 'react';
import type { Platform } from '@atlas/core';
import { Icons } from '@atlas/ui';

export function About({ platform }: { platform: Platform }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (platform.id !== 'tauri') return;
    let alive = true;
    void (async () => {
      const { getVersion } = await import('@tauri-apps/api/app');
      const v = await getVersion();
      if (alive) setVersion(v);
    })();
    return () => {
      alive = false;
    };
  }, [platform.id]);

  return (
    <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
      <Icons.Compass className="text-primary mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <h2 className="text-foreground text-sm font-medium">Atlas</h2>
        <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
          {platform.id === 'tauri'
            ? `Version ${version ?? '…'} — desktop build`
            : 'Browser build — a test bed and fallback, not the shipping target.'}
        </p>
      </div>
    </section>
  );
}
