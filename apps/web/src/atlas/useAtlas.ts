/**
 * The React binding for the engine.
 *
 * The engine renders nothing and knows nothing about React — it is handed an
 * `io` object and calls it. This hook is that io: it turns `say`, `confirm` and
 * `showResults` into transcript entries and component state, and hands `ask`
 * back to the UI.
 *
 * The interesting piece is `confirm`. The engine awaits a promise before
 * running anything risky, so the approval has to become UI and then resolve
 * back — which is done by parking the resolver in a ref while a card renders
 * in the transcript. That keeps the safety gate exactly where it belongs (in
 * the executor) rather than reimplemented per button.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Platform, ResultRow } from '@atlas/core';
import {
  Engine,
  Grammar,
  SkillRegistry,
  createCoreGrammar,
  createCoreSkills,
  type EngineIO,
} from '@atlas/engine';
import type { CapabilityName } from '@atlas/core';

export type EntryKind = 'you' | 'atlas' | 'results' | 'confirm';

export interface Entry {
  id: number;
  kind: EntryKind;
  text?: string;
  rows?: ResultRow[];
  meta?: { title?: string; subtitle?: string };
  /** Confirmation entries carry their own resolution state. */
  question?: string;
  detail?: string;
  answered?: 'yes' | 'no';
}

let nextId = 1;

export function useAtlas(platform: Platform, capabilities: readonly CapabilityName[]) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const pendingConfirm = useRef<((approved: boolean) => void) | null>(null);

  const push = useCallback((entry: Omit<Entry, 'id'>) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId++ }]);
  }, []);

  const engine = useMemo(() => {
    const skills = new SkillRegistry({ capabilities: () => capabilities });
    skills.registerMany(createCoreSkills(platform));

    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar());

    return new Engine({ skills, grammar });
  }, [platform, capabilities]);

  const io = useMemo<EngineIO>(
    () => ({
      say: (text) => push({ kind: 'atlas', text }),
      showResults: (rows, meta) => push({ kind: 'results', rows, meta }),
      confirm: (question, detail) =>
        new Promise<boolean>((resolve) => {
          pendingConfirm.current = resolve;
          push({ kind: 'confirm', question, detail });
        }),
    }),
    [push],
  );

  /** Answer the outstanding confirmation, and mark its card as decided. */
  const answerConfirm = useCallback((approved: boolean) => {
    const resolve = pendingConfirm.current;
    pendingConfirm.current = null;
    // Mark the most recent unanswered card, searching backwards: the engine
    // only ever has one confirmation outstanding, and it is always the latest.
    setEntries((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const entry = next[i];
        if (entry && entry.kind === 'confirm' && !entry.answered) {
          next[i] = { ...entry, answered: approved ? 'yes' : 'no' };
          break;
        }
      }
      return next;
    });
    resolve?.(approved);
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      push({ kind: 'you', text: trimmed });
      setBusy(true);
      try {
        await engine.ask(trimmed, io);
      } finally {
        setBusy(false);
      }
    },
    [busy, engine, io, push],
  );

  /** Run a row's action — the same executor path a typed command takes. */
  const runAction = useCallback(
    async (skill: string, args: Record<string, string | number | boolean>) => {
      setBusy(true);
      try {
        await engine.run({ source: 'direct', intent: 'action', confidence: 1, steps: [{ skill, args }] }, io);
      } finally {
        setBusy(false);
      }
    },
    [engine, io],
  );

  const clear = useCallback(() => setEntries([]), []);

  return {
    entries,
    busy,
    ask,
    runAction,
    answerConfirm,
    clear,
    skillCount: engine.skills.available().length,
    skills: engine.skills,
  };
}
