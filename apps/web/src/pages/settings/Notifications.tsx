/**
 * Notifications — a real toggle, backed by `platform.notify`.
 *
 * The toggle is app-level config (do you want Atlas to notify you at all),
 * which is a different shape of thing than a preference Atlas "knows about
 * you" — so it's a raw boolean under its own storage key, not routed through
 * the `Fact`/preferences module Personalization uses.
 */

import { useEffect, useState } from 'react';
import type { CapabilityName, Platform, Storage } from '@atlas/core';
import { Button, Switch } from '@atlas/ui';

/**
 * Lowercase on purpose. `storage.rs` only accepts `[a-z0-9._-]` keys, so the
 * camelCase name this used to have was refused on the desktop build — the
 * toggle looked like it saved and reverted on every launch. `LEGACY_KEY` is
 * only for the browser build, where `localStorage` accepted the old spelling
 * and someone may genuinely have a saved value under it.
 */
const KEY = 'atlas.settings.notifications-enabled';
const LEGACY_KEY = 'atlas.settings.notificationsEnabled'; // storage-key-legacy

interface Props {
  platform: Platform;
  capabilities: readonly CapabilityName[];
  storage: Storage;
}

export function Notifications({ platform, capabilities, storage }: Props) {
  const supported = capabilities.includes('notifications');
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let v = await storage.get<boolean>(KEY).catch(() => undefined);
      if (v === undefined) {
        v = await storage.get<boolean>(LEGACY_KEY).catch(() => undefined);
        // Carry it forward once, so the next read is a plain hit on `KEY`.
        if (v !== undefined) await storage.set(KEY, v).catch(() => {});
      }
      if (alive) setEnabled(v ?? true);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    await storage.set(KEY, next);
  };

  return (
    <section>
      <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3.5">
        <div>
          <h2 className="text-foreground text-sm font-medium">Allow notifications</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            {supported
              ? 'Atlas can let you know about things like a finished download.'
              : "This build can't send OS notifications."}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={!supported}
          onCheckedChange={toggle}
          aria-label="Allow notifications"
        />
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!supported || !enabled}
          onClick={async () => {
            const ok = await platform.notify?.('Atlas', 'Notifications are working.');
            setStatus(ok ? 'Sent.' : "Couldn't send — check your OS notification settings.");
          }}
        >
          Send a test notification
        </Button>
        {status && <p className="text-foreground-subtle text-xs">{status}</p>}
      </div>
    </section>
  );
}
