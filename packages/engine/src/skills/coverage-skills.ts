/**
 * Small skills that were missing for no good reason: what this PC is, whether an
 * app is running, reversing and spelling text, and "play X on Spotify".
 *
 * Each one answers a question people ask in a sentence and that used to end in
 * "I don't know how to do that".
 */

import type { Platform, Skill } from '@atlas/core';
import { matchRunningProcess } from '../text/processes';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

export function createCoverageSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'system.specs',
    label: 'What this PC is',
    icon: '🖥️',
    domain: 'system',
    description: 'The processor, memory, graphics card and Windows version of this PC.',
    needs: ['system'],
    risk: 'safe',
    aloud: false,
    examples: ['what are my specs', 'what graphics card do i have'],
    params: {},
    async run() {
      try {
        const s = await platform.hardwareSpecs!();
        const gpu = s.gpus.length ? s.gpus.join(', ') : 'no graphics card reported';
        return {
          ok: true,
          message: `🖥️ ${s.cpu} (${s.cores} cores, ${s.threads} threads) · ${Math.round(s.memoryGb)} GB memory · ${gpu} · ${s.os}`,
          data: s,
        };
      } catch (e) {
        return fail(e, "I couldn't read this PC's specs.");
      }
    },
  });

  skills.push({
    id: 'app.isRunning',
    label: 'Is an app running',
    icon: '🔍',
    domain: 'apps',
    description: 'Say whether an app is running right now (and whether it has a window open).',
    needs: ['processes'],
    risk: 'safe',
    examples: ['is spotify running'],
    params: { name: { type: 'string', required: true, description: 'the app' } },
    async run(args) {
      const name = String(args.name ?? '').trim();
      try {
        const [processes, windows] = await Promise.all([
          platform.runningProcesses!(2000),
          platform.listWindows ? platform.listWindows().catch(() => []) : Promise.resolve([]),
        ]);
        const m = matchRunningProcess(name, processes, windows);
        if (m.kind === 'none') return { ok: true, message: `🔍 No — ${name} isn't running.` };
        if (m.kind === 'many') return { ok: true, message: `🔍 More than one thing matches “${name}” — it looks like it is running.` };
        const open = windows.some((w) => w.title.toLowerCase().includes(name.toLowerCase()));
        return { ok: true, message: `🔍 Yes — ${name} is running${open ? ' and has a window open' : ''}.` };
      } catch (e) {
        return fail(e, "I couldn't check that.");
      }
    },
  });

  skills.push({
    id: 'text.reverse',
    label: 'Reverse text',
    icon: '🔁',
    domain: 'text',
    description: 'Reverse the letters of some text.',
    risk: 'safe',
    examples: ['reverse hello'],
    params: { text: { type: 'string', required: true, description: 'the text to reverse' } },
    run(args) {
      const out = [...String(args.text ?? '')].reverse().join('');
      return { ok: true, message: `🔁 ${out}`, data: out };
    },
  });

  skills.push({
    id: 'text.spell',
    label: 'Spell a word',
    icon: '🔤',
    domain: 'text',
    description: 'Spell a word out letter by letter.',
    risk: 'safe',
    examples: ['spell necessary'],
    params: { text: { type: 'string', required: true, description: 'the word' } },
    run(args) {
      const word = String(args.text ?? '').trim();
      if (!word) return { ok: false, error: 'Which word?' };
      const letters = [...word].map((c) => c.toUpperCase()).join(' - ');
      return { ok: true, message: `🔤 ${word}: ${letters}`, data: letters };
    },
  });

  skills.push({
    id: 'media.playOn',
    label: 'Play something on…',
    icon: '▶️',
    domain: 'web',
    description: 'Play or search for something in Spotify (opens Spotify on it) or on YouTube.',
    needs: ['network'],
    risk: 'safe',
    examples: ['play lofi on spotify'],
    params: {
      query: { type: 'string', required: true, description: 'what to play' },
      service: { type: 'string', required: false, enum: ['spotify', 'youtube'], description: 'where; default Spotify' },
    },
    async run(args) {
      const q = String(args.query ?? '').trim();
      if (!q) return { ok: false, error: 'Play what?' };
      const service = String(args.service ?? 'spotify');
      try {
        const url =
          service === 'youtube'
            ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
            : `spotify:search:${encodeURIComponent(q)}`;
        const ok = await platform.openUrl!(url);
        return ok
          ? { ok: true, message: `▶️ Opened ${service === 'youtube' ? 'YouTube' : 'Spotify'} on “${q}” — press play on the result you want.` }
          : { ok: false, error: service === 'youtube' ? "I couldn't open YouTube." : "I couldn't open Spotify — is it installed? I can search YouTube instead." };
      } catch (e) {
        return fail(e, "I couldn't start that.");
      }
    },
  });

  return skills;
}
