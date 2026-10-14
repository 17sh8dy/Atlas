/**
 * SearXNG — a search engine you run (or reach) yourself, as Atlas's preferred web search.
 *
 * ── Nothing is chosen for you ───────────────────────────────────────────────
 * There is no default server and Atlas never picks a public one: until an address is entered
 * here this does nothing, and no search is sent to it. Atlas installs nothing and starts
 * nothing; running SearXNG is the person's own business.
 *
 * ── The address is checked natively ─────────────────────────────────────────
 * What is typed here is validated again in Rust, on saving and on every search. A server on
 * this PC is fine as it is; one on the local network needs the confirmation below; one on the
 * internet has to use https. A search carries no address of its own.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Platform, SearxngSetup } from '@atlas/core';
import { Button, Input } from '@atlas/ui';
import { describeReach, describeSetupError, describeTest, type Tone } from './searxng-setup';

const toneClass = (tone: Tone) =>
  tone === 'bad' ? 'text-danger text-xs' : tone === 'good' ? 'text-primary text-xs' : 'text-foreground-muted text-xs';

export function SearxngSetting({ platform, onChanged }: { platform: Platform; onChanged(): void }) {
  const [setup, setSetup] = useState<SearxngSetup | null>(null);
  const [url, setUrl] = useState('');
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: Tone; message: string } | null>(null);

  const apply = useCallback((next: SearxngSetup) => {
    setSetup(next);
    setUrl(next.url);
    setAllowPrivate(next.allowPrivate);
  }, []);

  useEffect(() => {
    let alive = true;
    void platform.searxngConfig?.().then((s) => {
      if (alive) apply(s);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [platform, apply]);

  if (!platform.searxngConfigure) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      apply(await platform.searxngConfigure!(url, allowPrivate));
      setNeedsConfirm(false);
      onChanged();
    } catch (e) {
      const problem = describeSetupError(e);
      setError(problem.message);
      setNeedsConfirm(problem.needsPrivateConfirmation);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      const report = await platform.searxngTest!();
      setResult(describeTest(report));
      onChanged();
    } catch {
      setResult({ tone: 'neutral', message: 'The test could not run.' });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      apply(await platform.searxngConfigure!('', false));
      setNeedsConfirm(false);
      onChanged();
    } catch (e) {
      setError(describeSetupError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const configured = setup?.configured === true;
  const showConfirm = needsConfirm || (configured && setup?.reach === 'private-network');

  return (
    <div className="border-border mt-4 flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center gap-2">
        <span className="text-foreground-subtle text-xs font-medium uppercase tracking-wide">SearXNG</span>
        {configured ? (
          <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2 py-0.5 text-[10px] font-medium">
            Set up {describeReach(setup?.reach ?? null)}
          </span>
        ) : (
          <span className="text-foreground-subtle text-xs">not set up</span>
        )}
      </div>

      <p className="text-foreground-muted text-sm">
        If you run your own <span className="text-foreground">SearXNG</span> search server, Atlas will
        use it first and fall back to the engines above if it can't answer. Nothing is chosen for you:
        until you enter an address, Atlas sends nothing to SearXNG.
      </p>

      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          placeholder="http://127.0.0.1:8888"
          spellCheck={false}
          autoComplete="off"
          aria-label="SearXNG server address"
        />
        <Button variant="primary" size="md" disabled={busy || !url.trim()} onClick={() => void save()}>
          Save
        </Button>
        {configured && (
          <>
            <Button variant="ghost" size="md" disabled={busy} onClick={() => void test()}>
              Test
            </Button>
            <Button variant="ghost" size="md" disabled={busy} onClick={() => void clear()}>
              Remove
            </Button>
          </>
        )}
      </div>

      {showConfirm && (
        <label className="text-foreground-muted flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={allowPrivate}
            onChange={(e) => setAllowPrivate(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            This server is on my own network. Atlas will send my searches to it. (Only for a server you
            control — Atlas never assumes a device on your network is safe.)
          </span>
        </label>
      )}

      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className={toneClass(result.tone)}>
          {result.message}
        </p>
      )}

      <p className="text-foreground-subtle text-xs">
        SearXNG must have JSON output switched on (<code>search → formats → json</code> in its
        settings.yml); most public instances don't. Your searches go to the server you enter, which asks
        other search engines for you, so run one you trust. Atlas doesn't install or start SearXNG, and
        doesn't follow redirects: enter the address it finally answers at.
      </p>
    </div>
  );
}
