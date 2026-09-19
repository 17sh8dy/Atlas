/**
 * Web search — which engine Atlas asks, and an optional key for a better one.
 *
 * ── Nothing here is required ────────────────────────────────────────────────
 * Atlas searches with DuckDuckGo out of the box: no account, no key. A Tavily
 * key is an upgrade — cleaner, page-aware results built for this — and the
 * copy leads with what still works without it, because "no key" is a normal
 * state and not a fault. If a saved key runs out of free searches Atlas goes
 * back to DuckDuckGo by itself, without an error, so nothing on this page is
 * ever the reason a question goes unanswered.
 *
 * ── The key never comes back here ───────────────────────────────────────────
 * Same boundary as the model-provider keys (`secrets.rs`): typed in once,
 * written to Windows Credential Manager, and never read back into the page.
 * The only thing this component can ask is "is one saved", which is what the
 * badge shows. There is no "reveal".
 */

import { useCallback, useEffect, useState } from 'react';
import type { Platform } from '@atlas/core';
import { Button, Input, Surface } from '@atlas/ui';
import { deleteProviderSecret, hasProviderSecret, saveProviderSecret } from '@atlas/platform';

/** Where `secrets.rs` files this key: `Atlas:cloudProvider:search-tavily`. */
const TAVILY_SECRET_ID = 'search-tavily';

/**
 * The engine keeps a short memory of which search backends recently refused
 * (a spent allowance, a rejected key). Changing the key is exactly when that
 * memory is wrong, so this tells it to forget. A window event because
 * Settings and the engine share a page but not a component tree.
 */
export const SEARCH_KEY_CHANGED = 'atlas:search-key-changed';

export function WebSearch({ platform }: { platform: Platform }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSaved(await hasProviderSecret(TAVILY_SECRET_ID).catch(() => false));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The desktop shell is the only thing that can hold a key.
  if (platform.id !== 'tauri') return null;

  const changed = () => window.dispatchEvent(new Event(SEARCH_KEY_CHANGED));

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await saveProviderSecret(TAVILY_SECRET_ID, trimmed);
      setKey('');
      await refresh();
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteProviderSecret(TAVILY_SECRET_ID);
      await refresh();
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="text-foreground mb-3 text-sm font-medium">Web search</h2>
      <Surface className="flex flex-col gap-3 p-4">
        <p className="text-foreground-muted text-sm">
          Atlas searches the web with DuckDuckGo — no account or key needed. Adding a{' '}
          <span className="text-foreground">Tavily</span> key gives cleaner, more reliable results.
          If the key runs out of free searches, Atlas quietly goes back to DuckDuckGo.
        </p>

        <div className="flex items-center gap-2">
          <span className="text-foreground-subtle text-xs font-medium uppercase tracking-wide">
            Tavily
          </span>
          {saved === null ? null : saved ? (
            <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2 py-0.5 text-[10px] font-medium">
              Key saved
            </span>
          ) : (
            <span className="text-foreground-subtle text-xs">not set — using DuckDuckGo</span>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
            type="password"
            placeholder={saved ? 'Paste a new key to replace it' : 'Paste a Tavily key'}
            spellCheck={false}
            autoComplete="off"
            aria-label="Tavily API key"
          />
          <Button
            variant="primary"
            size="md"
            disabled={busy || !key.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
          {saved && (
            <Button variant="ghost" size="md" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          )}
        </div>

        {error && (
          <p role="alert" className="text-danger text-xs">
            {error}
          </p>
        )}

        <p className="text-foreground-subtle text-xs">
          Get a key at tavily.com. Nova does not provide or pay for Tavily access — you need your
          own account, and Tavily sets its own limits and pricing. The key is stored in Windows
          Credential Manager, never in Atlas's settings file, and is never shown again once saved.
          Searches you make are sent to whichever engine is in use.
        </p>
      </Surface>
    </section>
  );
}
