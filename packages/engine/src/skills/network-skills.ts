/**
 * The network — what it is, whether it works, what it has connected to.
 *
 * The first pack built under Phase 11, and written to be the template for the
 * nine groups after it. Three properties every one of those should copy:
 *
 * 1. **Read-only skills are `safe`.** Asking what your IP address is changes
 *    nothing, and a confirmation card in front of a question trains people to
 *    click through the cards that matter.
 * 2. **The answer is a sentence, not a table dump.** `ipconfig` prints sixty
 *    lines because it does not know which one you wanted. Atlas does — you
 *    just told it — so the message leads with that and the rows carry the
 *    rest for anyone who wants it.
 * 3. **Absence is an answer.** A machine with no wireless hardware is told it
 *    has none, rather than being shown an empty list or an error about the
 *    service not running. This one came from the desktop it was built on,
 *    which has exactly that shape.
 */

import type { Platform, ResultRow, Skill } from '@atlas/core';

export function createNetworkSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'net.adapters',
    label: 'Network adapters',
    icon: '🌐',
    domain: 'system',
    description: 'List the machine’s network adapters, with their addresses.',
    needs: ['network'],
    risk: 'safe',
    examples: ['what network adapters do I have', 'show my network adapters'],
    async run(_args, ctx) {
      const adapters = (await platform.networkAdapters?.()) ?? [];
      if (!adapters.length) {
        return { ok: false, error: 'I couldn’t read any network adapters.' };
      }

      const rows: ResultRow[] = adapters.map((a) => ({
        title: a.name,
        subtitle: [
          a.kind,
          a.connected ? a.ipv4 ?? 'no address' : 'disconnected',
          a.gateway ? `via ${a.gateway}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        icon: '🌐',
        payload: a,
      }));

      const live = adapters.filter((a) => a.connected && a.ipv4);
      ctx.showResults?.(rows, {
        title: `${adapters.length} network adapter${adapters.length === 1 ? '' : 's'}`,
        subtitle: live.length ? `${live.length} with an address` : 'none currently connected',
      });
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'net.ip',
    label: 'My IP address',
    icon: '🏷️',
    domain: 'system',
    description: 'The local IP address of whichever adapter is actually carrying traffic.',
    needs: ['network'],
    risk: 'safe',
    examples: ['what is my ip', 'what is my ip address'],
    async run() {
      const adapters = (await platform.networkAdapters?.()) ?? [];
      // The one that matters is the connected adapter with a gateway: a
      // machine has several addresses and only one of them is the answer to
      // "what's my IP".
      const primary =
        adapters.find((a) => a.connected && a.ipv4 && a.gateway) ??
        adapters.find((a) => a.connected && a.ipv4);

      if (!primary?.ipv4) {
        return { ok: false, error: 'Nothing here has an address — you look offline.' };
      }
      return {
        ok: true,
        message: `${primary.ipv4}, on ${primary.name}${
          primary.gateway ? ` (gateway ${primary.gateway})` : ''
        }.`,
      };
    },
  });

  skills.push({
    id: 'net.wifi',
    label: 'Wi-Fi status',
    icon: '📶',
    domain: 'system',
    description: 'Which Wi-Fi network this machine is on, and how good the signal is.',
    needs: ['network'],
    risk: 'safe',
    examples: ['what wifi am I on', 'wifi signal'],
    async run() {
      const status = await platform.wifiStatus?.();
      if (!status) return { ok: false, error: 'I couldn’t read the Wi-Fi status.' };

      // Three genuinely different answers, and conflating any two of them
      // produces something that is simply untrue on some machine.
      if (!status.available) {
        return { ok: true, message: 'This machine doesn’t have Wi-Fi — it’s wired.' };
      }
      if (!status.connected) {
        return { ok: true, message: 'Wi-Fi is on but not connected to anything.' };
      }

      const detail = [
        status.signal !== undefined ? `${status.signal}% signal` : '',
        status.band ? status.band : '',
        status.speed ? `${status.speed} Mbps` : '',
      ].filter(Boolean);

      return {
        ok: true,
        message: `On ${status.ssid ?? 'an unnamed network'}${
          detail.length ? ` — ${detail.join(', ')}` : ''
        }.`,
      };
    },
  });

  skills.push({
    id: 'net.savedNetworks',
    label: 'Saved Wi-Fi networks',
    icon: '📶',
    domain: 'system',
    description: 'The Wi-Fi networks this machine remembers.',
    needs: ['network'],
    risk: 'safe',
    examples: ['what wifi networks do I have saved'],
    async run(_args, ctx) {
      const names = (await platform.wifiNetworks?.()) ?? [];
      if (!names.length) {
        // Deliberately not an error. On a wired desktop this is the correct
        // answer, not a failure to produce one.
        return { ok: true, message: 'No saved Wi-Fi networks on this machine.' };
      }

      ctx.showResults?.(
        names.map((name) => ({ title: name, icon: '📶', payload: { name } })),
        { title: `${names.length} saved Wi-Fi network${names.length === 1 ? '' : 's'}` },
      );
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'net.online',
    label: 'Am I online?',
    icon: '📡',
    domain: 'system',
    description: 'Check whether the machine actually has a working internet connection.',
    needs: ['network'],
    risk: 'safe',
    examples: ['am I online', 'is the internet working'],
    async run() {
      const reachable = await platform.networkReachable?.();
      if (reachable === undefined) {
        return { ok: false, error: 'I couldn’t check the connection.' };
      }
      return reachable
        ? { ok: true, message: 'Yes — the connection is working.' }
        : {
            ok: true,
            // Not an error: "no" is a successful answer to "am I online".
            message: 'No — nothing is getting through.',
          };
    },
  });

  return skills;
}
