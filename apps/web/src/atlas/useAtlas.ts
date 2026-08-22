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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Platform,
  ResultRow,
  SpeechOptions,
  SpeechPreferences,
  Storage,
  VoiceProfile,
} from '@atlas/core';
import { DEFAULT_SPEECH } from '@atlas/core';
import { MemoryStore } from '@atlas/data';
import type { ProviderKeyId } from '@atlas/data';
import { createClaudeProvider, createOpenAIProvider } from '@atlas/platform';
import {
  Engine,
  Grammar,
  SimpleIntelligenceRegistry,
  SkillRegistry,
  WorkingMemory,
  createCoreGrammar,
  createExtraGrammar,
  createCoreSkills,
  createCalcSkills,
  createNotesSkills,
  createOsSkills,
  createNetworkSkills,
  createTextSkills,
  createUtilitySkills,
  createWebSearchSkills,
  createPhrasing,
  readAffirmation,
  recordEpisodes,
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

export function useAtlas(
  platform: Platform,
  capabilities: readonly CapabilityName[],
  storage: Storage,
  voiceProfile: VoiceProfile = {},
  providerKeys: Partial<Record<ProviderKeyId, string>> = {},
  activeProviderId: string | null = null,
  /** How Atlas should speak. `VoiceProfile` above is a different thing entirely. */
  speech: SpeechPreferences = DEFAULT_SPEECH,
  /**
   * Supplied from the app's single `useSpeech` player, rather than created
   * here: the voice screen's visualiser has to read the same analyser that is
   * playing, and two players would mean two Atlases able to talk at once.
   */
  speak: (text: string, options?: SpeechOptions) => void = () => {},
) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const pendingConfirm = useRef<((approved: boolean) => void) | null>(null);

  const push = useCallback((entry: Omit<Entry, 'id'>) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId++ }]);
  }, []);

  const phrasing = useMemo(() => createPhrasing(voiceProfile), [voiceProfile]);
  const memory = useMemo(() => new MemoryStore(storage), [storage]);
  // One instance shared between the grammar (which reads it synchronously to
  // resolve "it"/"the second one") and the engine (which writes to it
  // whenever a skill renders a result list) — see WorkingMemory's doc comment.
  const working = useMemo(() => new WorkingMemory(), []);

  const engine = useMemo(() => {
    const skills = new SkillRegistry({ capabilities: () => capabilities });
    skills.registerMany(createCoreSkills(platform, memory, skills, phrasing));
    skills.registerMany(createWebSearchSkills(platform));
    skills.registerMany(createUtilitySkills());
    skills.registerMany(createTextSkills());
    skills.registerMany(createCalcSkills());
    skills.registerMany(createNotesSkills(memory));
    skills.registerMany(createOsSkills(platform));
    skills.registerMany(createNetworkSkills(platform));

    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(working));
    grammar.addMany(createExtraGrammar());

    // Registered unconditionally — `isConfigured()` is false with no saved
    // key, and `active()` already treats "selected but unconfigured" as
    // nothing selected (see SimpleIntelligenceRegistry), so there's no
    // separate platform gate needed here the way skills need `needs: [...]`.
    const intelligence = new SimpleIntelligenceRegistry();
    intelligence.register(createClaudeProvider(providerKeys.claude));
    intelligence.register(createOpenAIProvider(providerKeys.openai));
    intelligence.setActive(activeProviderId);

    return new Engine({ skills, grammar, voice: voiceProfile, working, intelligence });
  }, [
    platform,
    capabilities,
    memory,
    phrasing,
    voiceProfile,
    working,
    providerKeys,
    activeProviderId,
  ]);

  // Episodic memory doesn't touch the ask/io path at all — it just listens.
  useEffect(() => recordEpisodes(engine.bus, memory, engine.skills), [engine, memory]);

  /**
   * Speak a reply, if speaking is on.
   *
   * Read from a ref rather than a dependency so that turning speech on or off
   * does not rebuild `io` — which would rebuild the engine's context in the
   * middle of a conversation. The setting is read at the moment of speaking,
   * which is also when it should be.
   */
  const speechRef = useRef<SpeechPreferences>(DEFAULT_SPEECH);
  speechRef.current = speech;

  const speakIfEnabled = useCallback(
    (text: string) => {
      const prefs = speechRef.current;
      if (!prefs.enabled) return;
      const spoken = text.trim();
      if (!spoken) return;
      // Fire and forget: the transcript is already on screen, and a failed
      // synthesis must never turn into an error in the conversation.
      void speak(spoken, { voiceId: prefs.voiceId, pace: prefs.pace });
    },
    [speak],
  );

  const io = useMemo<EngineIO>(
    () => ({
      say: (text) => {
        push({ kind: 'atlas', text });
        speakIfEnabled(text);
      },
      showResults: (rows, meta) => push({ kind: 'results', rows, meta }),
      confirm: (question, detail) =>
        new Promise<boolean>((resolve) => {
          pendingConfirm.current = resolve;
          push({ kind: 'confirm', question, detail });
          // Spoken as well as shown. A question that only exists on a card is
          // a question someone who is talking never hears, and they are left
          // waiting on an assistant that has quietly stopped.
          speakIfEnabled(detail ? `${question} ${detail}` : question);
        }),
    }),
    [push, speakIfEnabled],
  );

  /** Said while a confirmation was open, and not an answer to it. */
  const queued = useRef<string | null>(null);

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
      if (!trimmed) return;

      /**
       * An outstanding confirmation owns whatever you say next.
       *
       * Without this the answer is simply dropped: `busy` stays true for as
       * long as the executor is awaiting the card, so "yes" arrived, matched
       * the early return, and vanished — which from the outside looks like
       * Atlas getting stuck on his own question.
       */
      if (pendingConfirm.current) {
        push({ kind: 'you', text: trimmed });
        const answer = readAffirmation(trimmed);
        answerConfirm(answer === 'yes');
        // Something that is neither yes nor no is a new instruction, not an
        // answer. The pending action is declined rather than left hanging, and
        // what was actually said is queued for once the executor has unwound.
        if (answer === null) queued.current = trimmed;
        return;
      }

      if (busy) return;
      push({ kind: 'you', text: trimmed });
      setBusy(true);
      try {
        await engine.ask(trimmed, io);
      } finally {
        setBusy(false);
      }
    },
    [busy, engine, io, push, answerConfirm],
  );

  /**
   * Run whatever was said over a confirmation, once the engine is free.
   *
   * A ref rather than state: this is a handoff between two turns, not
   * something the screen renders, and putting it in state would re-render the
   * transcript to carry a string nobody can see.
   */
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (busy || !queued.current) return;
    const next = queued.current;
    queued.current = null;
    void askRef.current(next);
  }, [busy]);

  /** Run a row's action — the same executor path a typed command takes. */
  const runAction = useCallback(
    async (skill: string, args: Record<string, string | number | boolean>) => {
      setBusy(true);
      try {
        await engine.run(
          { source: 'direct', intent: 'action', confidence: 1, steps: [{ skill, args }] },
          io,
        );
      } finally {
        setBusy(false);
      }
    },
    [engine, io],
  );

  const clear = useCallback(() => setEntries([]), []);

  /**
   * Put text on the clipboard for the UI.
   *
   * Goes through the `Platform` port first, which is the same route the
   * `clipboard.copy` skill takes — one clipboard implementation, not a second
   * one living in a component. `navigator.clipboard` is the fallback for the
   * browser build, where the port has no clipboard to offer.
   */
  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const value = String(text ?? '');
      if (!value.trim()) return false;

      if (platform.writeClipboard) {
        try {
          if (await platform.writeClipboard(value)) return true;
        } catch {
          // fall through — a failing port is a reason to try the other route,
          // not a reason to tell the user copying is broken
        }
      }
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        return false;
      }
    },
    [platform],
  );

  return {
    entries,
    busy,
    ask,
    runAction,
    answerConfirm,
    clear,
    copy,
    skillCount: engine.skills.available().length,
    skills: engine.skills,
    greeting: phrasing.greeting(),
    personalized: Boolean(voiceProfile.userName || voiceProfile.atlasName || voiceProfile.greeting),
    atlasName: voiceProfile.atlasName?.trim() || 'Atlas',
  };
}
