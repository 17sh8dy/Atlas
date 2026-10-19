/**
 * Universal Agent — an experimental, opt-in way for Atlas to work a multi-step goal out one step at a time.
 *
 * OFF by default, for new installs and for everyone upgrading: nothing is offered and "figure out how to…" is
 * declined until this is switched on. Turning it on changes what Atlas may ASK A MODEL to do for you; it never
 * widens what Atlas is allowed to do. Every action still goes through the same permissions, Allowed Folders,
 * previews and confirmations, and an agent Atlas offered itself asks before every single action whatever the
 * execution mode.
 */

import { useEffect, useState } from 'react';
import { Icons, Surface, Switch } from '@atlas/ui';
import type { Storage } from '@atlas/core';
import { readUniversalAgent, writeUniversalAgent } from '@atlas/data';
import { ROUTING_CHANGED } from '../../../atlas/routingEvents';

export function UniversalAgent({ storage }: { storage: Storage }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void readUniversalAgent(storage).then((v) => alive && setOn(v)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [storage]);
  async function change(next: boolean) {
    setOn(next);
    await writeUniversalAgent(storage, next);
    window.dispatchEvent(new Event(ROUTING_CHANGED));
  }
  return (
    <section aria-labelledby="universal-agent-title">
      <div className="mb-2 flex items-center gap-2">
        <h3 id="universal-agent-title" className="text-foreground text-sm font-semibold">
          Universal Agent
        </h3>
        <span className="border-warning/40 bg-warning/10 text-warning rounded-full border px-2 py-0.5 text-[10px] font-medium">
          Experimental
        </span>
      </div>
      <Surface className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">Let Atlas work out multi-step jobs with a model</p>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            When a request has several parts and Atlas has no ready-made way to do it, it can offer to try one step
            at a time, choosing from what it can do. You always see a card first, and when Atlas starts it, every
            action asks you before it runs. Saying &ldquo;figure out how to&hellip;&rdquo; also needs this on. A
            small local model can plan poorly, so the final report lists what actually ran. Off by default; it
            never changes what Atlas is allowed to do.
          </p>
        </div>
        <Switch checked={on} onCheckedChange={(next) => void change(next)} aria-label="Universal Agent (experimental)" />
      </Surface>
      <p className="text-foreground-subtle mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed">
        <Icons.Lock className="mt-0.5 h-3 w-3 shrink-0" />
        With this off, Atlas understands and acts exactly as before, and nothing is sent to a model for this purpose.
      </p>
    </section>
  );
}
