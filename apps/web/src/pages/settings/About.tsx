/**
 * About — what this build is, and what it does with your data.
 *
 * The second half arrived from the deleted Privacy tab. As a tab it was a
 * page with nothing on it, headed "Nothing to configure yet", which read as
 * an unfinished feature. It is not a feature — it is the single most
 * important fact about Atlas, and stated here, next to the version, it reads
 * as the plain claim it is.
 *
 * Version is read from Tauri's own app metadata (already available via
 * `@tauri-apps/api`, no new plugin); the web build has no version to show,
 * since web isn't the shipping target.
 */

import { useEffect, useState } from 'react';
import type { Platform } from '@atlas/core';
import { AtlasMark, Icons } from '@atlas/ui';

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
    <div className="flex flex-col gap-3">
      <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <AtlasMark className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Atlas</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            {platform.id === 'tauri'
              ? `Version ${version ?? '…'} — desktop build`
              : 'Browser build — a test bed and fallback, not the shipping target.'}
          </p>
        </div>
      </section>

      <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <Icons.Lock className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Everything stays here</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            No account needed, no API key, nothing uploaded. Atlas speaks and listens on this
            machine, and what it remembers sits in a file on this disk. It reaches the network only
            when you ask it to — a web search, opening a link, or signing in to the optional Nova
            Account — and never on its own. Signing in uploads nothing; see Account.
          </p>
        </div>
      </section>

      {/* CC BY 4.0 requires attribution wherever the work is distributed — this is that notice,
          not decoration. Piper and whisper.cpp are MIT and need no credit here. */}
      <section className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <Icons.Mic className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Voice</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            Speaking uses the <span className="text-foreground">en_GB-vctk-medium</span> voice
            (Piper), trained on the University of Edinburgh Centre for Speech Technology
            Research's VCTK Corpus, licensed{' '}
            <span className="text-foreground">CC BY 4.0</span>. Listening uses{' '}
            <span className="text-foreground">whisper.cpp</span> and OpenAI's Whisper{' '}
            <span className="text-foreground">base.en</span> model. Both run on this machine.
          </p>
        </div>
      </section>
    </div>
  );
}
