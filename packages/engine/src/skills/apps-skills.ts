/**
 * Install, remove and update apps with winget.
 *
 * Spoken names are resolved to a package id *before* anything is installed: an
 * exact name match, or a single result. Anything less certain is reported with
 * the candidates and nothing is touched — installing the wrong program is the
 * kind of mistake that is not undone by saying "no, the other one".
 *
 * All three that change something are `confirm`, and the card names the app. Windows'
 * own permission prompt, when an installer raises one, is left to the person.
 */

import type { Platform, Skill } from '@atlas/core';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const ID_LIKE = /^[A-Za-z0-9][A-Za-z0-9+_-]*\.[A-Za-z0-9][A-Za-z0-9._+-]*$/;

type Resolved = { ok: true; id: string; name: string } | { ok: false; error: string };

export async function resolvePackage(platform: Platform, spoken: string): Promise<Resolved> {
  const q = spoken.trim().replace(/^["']|["']$/g, '');
  if (!q) return { ok: false, error: 'Which app?' };
  // "Spotify.Spotify" is already an id.
  if (ID_LIKE.test(q)) return { ok: true, id: q, name: q };
  let found;
  try {
    found = await platform.wingetSearch!(q);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!found.length) return { ok: false, error: `winget has nothing called “${q}”.` };
  const q_ = q.toLowerCase();
  // Store entries carry opaque ids (XPDM1ZW6815MQM); a named publisher id (VideoLAN.VLC) is the
  // one people mean, so those are preferred — but only when that leaves exactly one.
  const dotted = found.filter((p) => p.id.includes('.'));
  const exact = found.filter((p) => p.name.toLowerCase() === q_ || p.id.toLowerCase().split('.').pop() === q_);
  const startsWith = dotted.filter((p) => p.name.toLowerCase().startsWith(q_));
  const pick =
    (exact.filter((p) => p.id.includes('.')).length === 1 ? exact.find((p) => p.id.includes('.')) : null) ??
    (startsWith.length === 1 ? startsWith[0] : null) ??
    // Two real publishers' apps both fit: that is ambiguity, not a reason to take the store entry.
    (startsWith.length > 1 ? null : exact.length === 1 ? exact[0] : null) ??
    (found.length === 1 ? found[0] : null);
  if (pick) return { ok: true, id: pick.id, name: pick.name };
  const list = found.slice(0, 5).map((p) => `${p.name} (${p.id})`).join('; ');
  return { ok: false, error: `“${q}” could be more than one app: ${list}. Say which — the id, like ${found[0]!.id}, is exact.` };
}

export function createAppsSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'apps.install',
    label: 'Install an app',
    icon: '📥',
    domain: 'apps',
    description:
      'Install an app with winget by name or id. It will not guess between two apps. Windows may show its own permission prompt, which is yours to answer.',
    needs: ['os'],
    risk: 'confirm',
    confirmAs: (a) => `install ${String(a.name)} using winget`,
    examples: ['install spotify', 'install vlc'],
    params: { name: { type: 'string', required: true, description: 'the app, or its winget id like Spotify.Spotify' } },
    async run(args) {
      const r = await resolvePackage(platform, String(args.name ?? ''));
      if (!r.ok) return { ok: false, error: r.error };
      try {
        const out = await platform.wingetInstall!(r.id);
        return { ok: true, message: `📥 Installed ${r.name}.\n${out}`.trim(), data: r };
      } catch (e) {
        return fail(e, `I couldn't install ${r.name}.`);
      }
    },
  });

  skills.push({
    id: 'apps.uninstall',
    label: 'Uninstall an app',
    icon: '🗑️',
    domain: 'apps',
    description: 'Uninstall an app with winget. Asks first, and will not guess between two apps.',
    needs: ['os'],
    risk: 'confirm',
    confirmAs: (a) => `uninstall ${String(a.name)}`,
    examples: ['uninstall vlc'],
    params: { name: { type: 'string', required: true, description: 'the app, or its winget id' } },
    async run(args) {
      const r = await resolvePackage(platform, String(args.name ?? ''));
      if (!r.ok) return { ok: false, error: r.error };
      try {
        const out = await platform.wingetUninstall!(r.id);
        return { ok: true, message: `🗑️ Removed ${r.name}.\n${out}`.trim(), data: r };
      } catch (e) {
        return fail(e, `I couldn't remove ${r.name}.`);
      }
    },
  });

  skills.push({
    id: 'apps.update',
    label: 'Update an app',
    icon: '⬆️',
    domain: 'apps',
    description: 'Update one app to its newest version with winget.',
    needs: ['os'],
    risk: 'confirm',
    confirmAs: (a) => `update ${String(a.name)} to its newest version`,
    examples: ['update vlc'],
    params: { name: { type: 'string', required: true, description: 'the app, or its winget id' } },
    async run(args) {
      const r = await resolvePackage(platform, String(args.name ?? ''));
      if (!r.ok) return { ok: false, error: r.error };
      try {
        const out = await platform.wingetUpgrade!(r.id);
        return { ok: true, message: `⬆️ Updated ${r.name}.\n${out}`.trim(), data: r };
      } catch (e) {
        return fail(e, `I couldn't update ${r.name}.`);
      }
    },
  });

  skills.push({
    id: 'apps.updates',
    label: 'Which apps have updates',
    icon: '🔔',
    domain: 'apps',
    description: 'List the installed apps that winget knows a newer version of. Read-only.',
    needs: ['os'],
    risk: 'safe',
    examples: ['which apps need updates'],
    params: {},
    async run(_args, ctx) {
      try {
        const list = await platform.wingetUpgrades!();
        if (!list.length) return { ok: true, message: '🔔 Everything winget manages is up to date.' };
        ctx.showResults?.(
          list.map((p) => ({
            title: p.name,
            subtitle: `${p.id} · ${p.version}`,
            icon: '⬆️',
            payload: p,
            actions: [{ label: 'Update', skill: 'apps.update', args: { name: p.id } }],
          })),
          { title: 'Updates available', subtitle: `${list.length} app${list.length === 1 ? '' : 's'}` },
        );
        return { ok: true, spoken: true, message: `🔔 ${list.length} app${list.length === 1 ? ' has' : 's have'} an update.`, data: list };
      } catch (e) {
        return fail(e, "I couldn't check for updates.");
      }
    },
  });

  return skills;
}
