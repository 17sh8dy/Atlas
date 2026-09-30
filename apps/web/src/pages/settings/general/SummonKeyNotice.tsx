/**
 * "Ctrl+Space isn't working" — said, instead of left to be discovered.
 *
 * Atlas reserves Ctrl+Space to summon it. Another program can already own that
 * key, and when it does Atlas still starts (it used to crash on it) and is
 * reached from the tray icon. Nothing is shown at all when the key was
 * reserved normally.
 */

import { useEffect, useState } from 'react';
import type { Platform } from '@atlas/core';
import { Icons } from '@atlas/ui';

export function SummonKeyNotice({ platform }: { platform: Platform }) {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void platform
      .summonKeyStatus?.()
      .then((note) => alive && setProblem(note))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [platform]);

  if (!problem) return null;
  return (
    <section className="mb-8" role="status">
      <div className="border-border bg-surface/40 flex items-start gap-2.5 rounded-xl border p-3.5">
        <Icons.Shield className="text-foreground-muted mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-foreground-muted text-xs leading-relaxed">{problem}</p>
      </div>
    </section>
  );
}
