/**
 * Atlas's optional Nova Account.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THIS CHANGES ATLAS'S PHILOSOPHY BY EXACTLY ONE WORD, AND NO MORE.
 *
 * The README's three claims were "no account, no key, no network." The first one is now
 * "no account required", and the difference matters:
 *
 *   • Atlas is complete signed out. Every skill, the planner, memory, voice, the file index,
 *     the system probe — all of it runs with nothing connected, exactly as before, forever.
 *   • Nothing in `packages/engine` or `packages/core` knows this file exists, and nothing in
 *     them may import it. The engine is the product; identity is a thing the shell offers.
 *   • Signing in moves no data. Not up, not down. Atlas's memory stays in a file on this disk.
 *
 * The other two claims are untouched: still no API key, and still no network call to do its
 * job. This one is a network call somebody explicitly asks for by pressing a button, which
 * `openUrl` and a web search already were.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT AN ACCOUNT IS FOR HERE, TODAY: support, and being the same person across Nova.
 *
 * Not sync. Atlas's memory is the most personal thing in the ecosystem and syncing it is a
 * decision to take deliberately, with a design in front of it — not something to switch on
 * because the plumbing happens to exist. The scope is requested (Atlas is registered for it,
 * so a later feature needs no server change) and nothing reads or writes a sync document.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE CSP NAMES ONE HOST.
 *
 * `tauri.conf.json` adds exactly one Nova.Help origin to `connect-src`, and nothing else. That
 * is the "every capability is declared" rule applied to the network: the set of hosts this
 * app may reach is a short, readable list in one file rather than a policy of "anywhere".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE ORIGIN IS A WORKERS.DEV URL, NOT nova.help.
 *
 * `nova.help` was added to Cloudflare as a zone on 2026-09-03 but was never actually bought at
 * a registrar — its zone has sat "pending" (`activation_failure_reason: "unresolvable"`) ever
 * since, and the domain does not resolve. Brandon isn't buying a domain for this right now, so
 * Nova.Help is deployed on Cloudflare's free workers.dev subdomain instead — a real, working
 * address rather than a placeholder for one. Update this the day a domain is bought and pointed
 * at Cloudflare (update the CSP in both tauri.conf.json and tauri.dev.conf.json to match).
 */

import { useCallback, useEffect, useState } from 'react';
import { createNovaAccountClient, type NovaAccount, type NovaAccountClient } from '@nova/account-client';
import { asyncStorage } from '@nova/account-client/storage';
import type { Platform, Storage } from '@atlas/core';

/**
 * The one place the production address appears. Must match the host allowed
 * in tauri.conf.json's CSP.
 *
 * `import.meta.env.DEV` is Vite's own dev/build flag — statically `false` and
 * dead-code-eliminated in a production build (`vite build`), so a `vite dev`
 * session run with the right env var can point at a local Nova.Help instead,
 * with zero risk of a shipped build ever reading anything but the literal
 * string below. The env var itself is opt-in and unset by default, so an
 * ordinary `pnpm dev` behaves exactly like production unless a developer
 * deliberately sets it (see apps/desktop/tauri.dev.conf.json for the matching
 * CSP override, which only ever reaches `tauri dev`, never `tauri build`).
 */
export const NOVA_ORIGIN: string =
  (import.meta.env.DEV && import.meta.env.VITE_NOVA_DEV_ORIGIN) ||
  'https://nova-help.17sh8dy.workers.dev';

/**
 * Where a Nova Account is managed. Atlas shows who you are and can sign you out;
 * everything else about the account (name, email, password, picture, security,
 * deleting it) lives on Nova's own site, so it is one place for every product.
 */
export const NOVA_ACCOUNT_URL = 'https://nova-780.pages.dev/';

/** Atlas's section of the support portal. A real page today. */
export const NOVA_HELP_URL = `${NOVA_ORIGIN}/help/atlas`;

/** Where the token lives, through Atlas's own Storage port. */
const STORAGE_KEY = 'atlas.nova.account';

type Backing = ReturnType<typeof asyncStorage>;

let client: NovaAccountClient | null = null;
let backing: Backing | null = null;

/**
 * Build the client over Atlas's Storage port.
 *
 * `asyncStorage` exists for exactly this shape: the port is async and the client's storage
 * contract is synchronous, so it caches in memory and writes through. `prime()` fills that
 * cache; until it has run Atlas is simply signed out, which is the correct thing for an app
 * that has not finished starting to believe about itself.
 */
export function initNovaAccount(storage: Storage): NovaAccountClient {
  if (client) return client;

  backing = asyncStorage({
    get: (key) => storage.get<string>(key),
    set: (key, value) => storage.set(key, value),
    remove: (key) => storage.remove(key),
  }, { key: STORAGE_KEY });

  client = createNovaAccountClient({
    product: 'atlas',
    /* `support` so a ticket can be filed as you. `sync` is REQUESTED but UNUSED — see the
       header: the plumbing existing is not a reason to sync somebody's assistant memory. */
    scopes: ['support', 'sync'],
    origin: NOVA_ORIGIN,
    storage: backing,
  });

  return client;
}

export type NovaSignInState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string; verificationUri: string; verificationUriComplete: string }
  | { phase: 'failed'; message: string };

/**
 * The hook the Account settings section uses.
 *
 * IT MAKES NO NETWORK CALL UNLESS A TOKEN IS ALREADY HELD. Opening Settings for somebody who
 * has never signed in costs one cache read and nothing else — which is what keeps "Atlas works
 * with nothing connected" a fact rather than a slogan.
 */
export function useNovaAccount(storage: Storage, platform: Platform) {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<NovaAccount | null>(null);
  const [signIn, setSignIn] = useState<NovaSignInState>({ phase: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const c = initNovaAccount(storage);
      // The cached token has to be loaded through the async port before anything can be true.
      await backing?.prime();
      if (!alive) return;
      setAccount(c.account());
      setReady(true);

      /* Only now, and only if there is something to check. A revoked token becomes "signed
         out"; an unreachable server does NOT — the client keeps it, and so must this. */
      if (!c.isSignedIn()) return;
      const checked = await c.refresh();
      if (alive && checked.state !== 'offline') setAccount(checked.state === 'signed-in' ? checked.account : null);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const begin = useCallback(async () => {
    const c = initNovaAccount(storage);
    setSignIn({ phase: 'starting' });

    const flow = await c.beginSignIn({ deviceName: `Atlas on ${platform.id === 'tauri' ? 'this PC' : 'a browser'}` });
    if (!flow.ok) {
      setSignIn({
        phase: 'failed',
        message:
          flow.reason === 'unavailable'
            ? 'Could not reach Nova Accounts. Check your connection and try again.'
            : 'Nova Accounts refused this app. Please report it.',
      });
      return;
    }

    setSignIn({
      phase: 'waiting',
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      verificationUriComplete: flow.verificationUriComplete,
    });
    /* A convenience, never the mechanism — the code is on screen and works if this is refused
       or if the platform has no `openUrl` at all. */
    void platform.openUrl?.(flow.verificationUriComplete);

    const result = await flow.wait();
    if (result.ok) {
      setAccount(result.account);
      setSignIn({ phase: 'idle' });
      return;
    }
    setSignIn({
      phase: 'failed',
      message:
        result.reason === 'denied'
          ? 'The request was refused in the browser.'
          : result.reason === 'cancelled'
            ? 'Sign-in cancelled.'
            : 'That code expired before it was approved. Try again.',
    });
  }, [storage, platform]);

  const cancel = useCallback(() => setSignIn({ phase: 'idle' }), []);

  const signOut = useCallback(async () => {
    setBusy(true);
    await initNovaAccount(storage).signOut();
    setAccount(null);
    setSignIn({ phase: 'idle' });
    setBusy(false);
  }, [storage]);

  return { ready, account, signedIn: account !== null, signIn, busy, begin, cancel, signOut };
}
