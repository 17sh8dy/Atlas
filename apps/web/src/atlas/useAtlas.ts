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
  createTextSkills,
  createUtilitySkills,
  createWebSearchSkills,
  createPhrasing,
  recordEpisodes,
  type EngineIO,
  type EngineStatus,
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

/**
 * How long a status line stays up before it may be replaced.
 *
 * Without this, "Switching to Claude…" can appear and vanish inside a single
 * frame on a fast hand-off, which reads as a glitch rather than as
 * information — the eye registers that something flickered but not what it
 * said. 420ms is long enough to read three words and short enough that it
 * never feels like the app is padding its own progress.
 *
 * It lives here, in the surface, and not in the engine: the engine reports
 * what is happening, and how long a human needs to see that is a
 * presentation decision. A test driving the same engine waits for nothing.
 */
const MIN_STATUS_MS = 420;

export function useAtlas(
  platform: Platform,
  capabilities: readonly CapabilityName[],
  storage: Storage,
  voiceProfile: VoiceProfile = {},
  providerKeys: Partial<Record<ProviderKeyId, string>> = {},
  activeProviderId: string | null = null,
  /** How Atlas should speak. `VoiceProfile` above is a different thing entirely. */
  speech: SpeechPreferences = DEFAULT_SPEECH,
) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const pendingConfirm = useRef<((approved: boolean) => void) | null>(null);

  // ── Status line ──────────────────────────────────────────────────────────
  const [status, setStatus] = useState<EngineStatus | null>(null);
  /** Mirrors `status` for the callback below, which must not re-create. */
  const statusRef = useRef<EngineStatus | null>(null);
  const shownAt = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Show a stage, honouring the minimum display time.
   *
   * If the current line has not been up long enough, the next one is queued
   * rather than dropped, so a fast sequence still reads as a sequence instead
   * of collapsing to whatever happened to be last.
   */
  const showStatus = useCallback((update: EngineStatus | null) => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }

    const apply = () => {
      shownAt.current = Date.now();
      statusRef.current = update;
      setStatus(update);
    };

    const remaining = MIN_STATUS_MS - (Date.now() - shownAt.current);
    // Only hold when something is actually on screen to protect. Going from
    // nothing to something is always immediate — that is the responsiveness
    // the whole feature is for.
    if (statusRef.current && remaining > 0) {
      holdTimer.current = setTimeout(apply, remaining);
    } else {
      apply();
    }
  }, []);

  /**
   * Clear the line immediately, ignoring the minimum display time.
   *
   * Used at the start of a request. The hold exists to stop a line flickering
   * mid-answer, but it must never make the NEXT request feel slow: without
   * this, asking a second question within 420ms of the first finishing would
   * queue the new "Switching…" behind the old line's leftover hold, which is
   * the exact opposite of what the hold is for.
   */
  const resetStatus = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    shownAt.current = 0;
    statusRef.current = null;
    setStatus(null);
  }, []);

  // A pending hold must not outlive the component, or it fires setState on an
  // unmounted tree the next time Settings is opened mid-answer.
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

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
      if (!prefs.enabled || !platform.speak) return;
      const spoken = text.trim();
      if (!spoken) return;
      // Fire and forget: the transcript is already on screen, and a failed
      // synthesis must not turn into an error in the conversation.
      void platform.speak(spoken, { voiceId: prefs.voiceId, pace: prefs.pace }).catch(() => {});
    },
    [platform],
  );

  const io = useMemo<EngineIO>(
    () => ({
      say: (text) => {
        push({ kind: 'atlas', text });
        speakIfEnabled(text);
      },
      showResults: (rows, meta) => push({ kind: 'results', rows, meta }),
      confirm: (question, detail) => {
        // A question on screen is not "work in progress" — it is Atlas
        // waiting on the user. Leaving a spinner up next to it would suggest
        // the app is busy when the only thing missing is an answer.
        showStatus(null);
        return new Promise<boolean>((resolve) => {
          pendingConfirm.current = resolve;
          push({ kind: 'confirm', question, detail });
        });
      },
      status: (update) => showStatus(update),

    }),
    [push, speakIfEnabled, showStatus],
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
      resetStatus();
      try {
        await engine.ask(trimmed, io);
      } finally {
        setBusy(false);
        // The engine clears its own status on every normal path; this is the
        // backstop for the abnormal one. If `ask` threw, the last stage would
        // otherwise stay on screen forever, claiming Atlas is still thinking
        // about a request it has already given up on.
        resetStatus();
      }
    },
    [busy, engine, io, push, resetStatus],
  );

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
    /**
     * What Atlas is doing, when it is worth saying. Null on the fast local
     * path, where the work finishes before a label would be readable.
     */
    status,
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
