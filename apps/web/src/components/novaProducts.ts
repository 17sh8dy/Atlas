/**
 * Opening a Nova product from the switcher.
 *
 * A Nova product is one of two different things, and opening one is a different act:
 *
 *   • a WEBSITE is opened in the person's default browser (`platform.openUrl`);
 *   • a DESKTOP APP is launched with a background command (`platform.launchApp`), the same
 *     command Atlas uses for "open Calculator": it resolves the app by id against what this PC
 *     has installed and never runs a path handed in from the UI. If the app is not installed the
 *     person is sent to its download page, or to the Nova home page when it has none yet.
 *
 * Nothing here launches Atlas itself; the switcher shows the current product as "You're here".
 */

import type { Platform } from '@atlas/core';

export type NovaProductKind = 'app' | 'site' | 'soon';

export interface NovaLaunchable {
  id: string;
  label: string;
  kind: NovaProductKind;
  /** 'site': the address to open in the default browser. */
  url?: string;
  /**
   * 'app': ids this program can have in the installed-apps list. An id is the program's
   * Start-menu name with everything but letters and digits removed and lowercased, so
   * "Replay.gg" is `replaygg`.
   */
  appIds?: string[];
  /**
   * 'app': where to send someone who has not installed it (its download page). Omit it and they
   * go to the Nova home page instead, so a missing app is never a dead end.
   */
  getUrl?: string;
}

/** Where anyone goes for an app that has no download page of its own yet. */
export const NOVA_HOME_URL = 'https://nova-780.pages.dev/';

export type OpenResult = { ok: true } | { ok: false; message: string };

export async function openNovaProduct(platform: Platform, p: NovaLaunchable): Promise<OpenResult> {
  if (p.kind === 'soon') return { ok: false, message: `${p.label} isn't available yet.` };

  if (p.kind === 'site') {
    if (p.url && platform.openUrl && (await platform.openUrl(p.url))) return { ok: true };
    return { ok: false, message: `Couldn't open ${p.label} in your browser.` };
  }

  // A desktop app: find it among what is installed, and start it in the background.
  if (platform.listApps && platform.launchApp && p.appIds?.length) {
    try {
      const apps = await platform.listApps();
      const found = apps.find((a) => p.appIds!.includes(a.id));
      if (found && (await platform.launchApp(found.id))) return { ok: true };
    } catch {
      // Fall through to the page / "not installed" answers below.
    }
  }

  // Not installed: its own download page if it has one, otherwise the Nova home page.
  const page = p.getUrl ?? NOVA_HOME_URL;
  if (platform.openUrl && (await platform.openUrl(page))) return { ok: true };
  return { ok: false, message: `${p.label} isn't installed on this PC, and its page couldn't be opened.` };
}
