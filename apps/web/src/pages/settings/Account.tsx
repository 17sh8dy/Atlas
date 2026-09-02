/**
 * Account — the optional Nova Account.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE FIRST THING THIS PANEL SAYS IS THAT ATLAS DOES NOT NEED IT.
 *
 * That is the entire reason this section is allowed to exist at all. Atlas's claim has always
 * been that it works with nothing connected, and adding a sign-in button is the exact moment
 * that claim usually starts eroding. So the panel opens by restating it, and everything below
 * is careful to describe what an account ADDS rather than what it unlocks — because it unlocks
 * nothing. Every skill, the planner, memory, voice, the file index and the system probe all
 * run signed out, forever.
 *
 * THERE IS NO PASSWORD FIELD. Atlas shows an eight-character code and you approve it at
 * Nova.Help in your own browser. A local-first assistant asking for your ecosystem password
 * would be teaching precisely the habit that gets people phished.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PANEL DOES NOT OFFER, ON PURPOSE.
 *
 * No sync toggle. Atlas's memory is the most personal thing in the Nova ecosystem, and the
 * fact that the storage now exists is not a reason to offer to upload it. When that is
 * designed it gets its own screen and its own conversation; a switch here would be a decision
 * taken by accident. `settingsRegistry`-style honesty: say what is real, and say what is not.
 */

import type { Platform, Storage } from '@atlas/core';
import { Button, Icons } from '@atlas/ui';
import { NOVA_HELP_URL, useNovaAccount } from '../../account/novaAccount';

interface Props {
  platform: Platform;
  storage: Storage;
}

export function Account({ platform, storage }: Props) {
  const { ready, account, signedIn, signIn, busy, begin, cancel, signOut } = useNovaAccount(
    storage,
    platform,
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
        <Icons.Lock className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Atlas does not need an account</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            Every skill, your memory, voice, the file index — all of it runs signed out, and
            always will. Signing in adds an identity across Nova. It unlocks nothing, and it
            moves none of your data anywhere.
          </p>
        </div>
      </div>

      {signIn.phase === 'waiting' ? (
        <div className="border-border rounded-xl border px-4 py-3.5">
          <h2 className="text-foreground text-sm font-medium">Enter this code</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            In your browser, sign in to Nova and enter this code at {signIn.verificationUri}. It
            expires in ten minutes.
          </p>
          <p className="text-foreground mt-3 select-all font-mono text-2xl tracking-[0.18em]">
            {signIn.userCode}
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={() => void platform.openUrl?.(signIn.verificationUriComplete)}
            >
              Open the page again
            </Button>
          </div>
        </div>
      ) : signedIn ? (
        <div className="border-border rounded-xl border px-4 py-3.5">
          <h2 className="text-foreground text-sm font-medium">
            {account?.displayName ?? 'Signed in'}
          </h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            The same Nova Account as Nova.Help, Open Cut, Online Earth and Replay.GG. Atlas can
            see who you are and file support tickets as you. It cannot see your password, and
            nothing on this machine has been uploaded.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={() => void signOut()} disabled={busy}>
              Sign out
            </Button>
            <Button variant="ghost" onClick={() => void platform.openUrl?.(NOVA_HELP_URL)}>
              Help with Atlas
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-border rounded-xl border px-4 py-3.5">
          {signIn.phase === 'failed' && (
            <p className="text-destructive mb-2 text-xs leading-relaxed" role="alert">
              {signIn.message}
            </p>
          )}
          <h2 className="text-foreground text-sm font-medium">Sign in to Nova</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            One Nova Account across the whole ecosystem — never a second one per app. Today it
            means support tickets you file can be tied to you, so you can follow them without a
            ticket ID.
          </p>
          <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
            You will not be asked for a password here. Atlas shows a code and you approve it in
            your browser.
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void begin()} disabled={!ready || signIn.phase === 'starting'}>
              {signIn.phase === 'starting' ? 'Starting…' : 'Sign in to Nova'}
            </Button>
            <Button variant="ghost" onClick={() => void platform.openUrl?.(NOVA_HELP_URL)}>
              Help with Atlas
            </Button>
          </div>
        </div>
      )}

      <div className="border-border rounded-xl border px-4 py-3.5">
        <h2 className="text-foreground text-sm font-medium">Your memory stays here</h2>
        <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
          Atlas does not sync what it remembers about you, signed in or not. That is a
          deliberate gap rather than a missing feature: an assistant's memory is the most
          personal thing in the Nova ecosystem, and uploading it is a decision worth taking
          on purpose, not one to inherit because an account exists.
        </p>
      </div>
    </section>
  );
}
