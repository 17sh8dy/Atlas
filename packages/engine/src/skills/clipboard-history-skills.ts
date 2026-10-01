/**
 * Clipboard history skills: list what was copied recently, put one back, clear it.
 *
 * The history itself is `clipboard/history.ts` — memory only, opt-in, secrets never kept.
 * These skills never turn it on: that is a setting the person changes, in the same way
 * Atlas never loosens its own permissions.
 */

import type { Platform, Skill } from '@atlas/core';
import type { ClipboardHistory } from '../clipboard/history';

export interface ClipboardHistoryDeps {
  platform: Platform;
  history: ClipboardHistory;
  /** Whether the person has switched history on (Settings → General). */
  isEnabled: () => boolean;
}

const OFF = 'Clipboard history is off. It keeps the last 20 things you copy, in memory only, and skips anything that looks like a password or key. Turn it on in Settings → General if you want it.';

const preview = (text: string, max = 90) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function createClipboardHistorySkills({ platform, history, isEnabled }: ClipboardHistoryDeps): Skill[] {
  return [
    {
      id: 'clipboard.history',
      label: 'Clipboard history',
      icon: '📋',
      domain: 'clipboard',
      description: 'The last things you copied (newest first). Only kept while clipboard history is switched on, only in memory, and never anything that looks like a password or key.',
      needs: ['clipboard'],
      risk: 'safe',
      aloud: false,
      examples: ['show my clipboard history', 'what did i copy earlier'],
      params: {},
      run(_args, ctx) {
        if (!isEnabled()) return { ok: true, message: OFF };
        const items = history.list();
        if (!items.length) return { ok: true, message: '📋 Nothing yet — I’ll keep what you copy from now on.' };
        ctx.showResults?.(
          items.map((e, i) => ({
            title: preview(e.text),
            subtitle: `#${i + 1} · ${ago(e.at)}`,
            icon: '📋',
            actions: [{ label: 'Copy again', skill: 'clipboard.restore', args: { n: i + 1 } }],
          })),
          // private: shown, but never saved with the conversation or read aloud.
          { title: 'Clipboard history', subtitle: `${items.length} item${items.length === 1 ? '' : 's'} · memory only`, private: true },
        );
        return { ok: true, spoken: true, message: '' };
      },
    },
    {
      id: 'clipboard.restore',
      label: 'Copy an earlier item again',
      icon: '↩️',
      domain: 'clipboard',
      description: 'Put one of the recent items from clipboard history back on the clipboard, by its number in the list (1 is the newest).',
      needs: ['clipboard'],
      risk: 'safe',
      examples: ['copy clipboard item 2 again'],
      params: { n: { type: 'number', required: true, description: 'which item, 1 = newest' } },
      async run(args) {
        if (!isEnabled()) return { ok: true, message: OFF };
        const n = Math.floor(Number(args.n));
        const entry = history.get(n);
        if (!entry) return { ok: false, error: history.size ? `There’s no item ${n} — I have ${history.size}.` : 'The history is empty.' };
        const ok = await platform.writeClipboard?.(entry.text);
        return ok ? { ok: true, message: `↩️ Copied item ${n} back: “${preview(entry.text, 60)}”.` } : { ok: false, error: "I couldn't write to the clipboard." };
      },
    },
    {
      id: 'clipboard.clearHistory',
      label: 'Clear clipboard history',
      icon: '🧽',
      domain: 'clipboard',
      description: 'Forget everything clipboard history has kept. The clipboard itself is not touched.',
      needs: ['clipboard'],
      risk: 'safe',
      examples: ['clear my clipboard history'],
      params: {},
      run() {
        const n = history.size;
        history.clear();
        return { ok: true, message: n ? `🧽 Forgot ${n} item${n === 1 ? '' : 's'}.` : '🧽 There was nothing to forget.' };
      },
    },
  ];
}
