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
  CloudProviderConfig,
  ClarifyAnswer,
  ClarifyChoice,
  ExecutionMode,
  HaltEvent,
  HaltSource,
  PlanOutcome,
  Platform,
  ResultRow,
  Skill,
  SkillArgs,
  SpeechOptions,
  SpeechPreferences,
  Storage,
  VoiceProfile,
} from '@atlas/core';
import { DEFAULT_EXECUTION_MODE, DEFAULT_SPEECH } from '@atlas/core';
import { MemoryStore } from '@atlas/data';
import {
  buildIntelligence,
  DEFAULT_LOCAL_AI_RUNTIME,
  type LocalAiRuntime,
} from './buildIntelligence';
import { readClarifyReply } from './clarify-reply';
import {
  Engine,
  Grammar,
  SkillRegistry,
  WorkingMemory,
  createCoreGrammar,
  createExtraGrammar,
  createCoreSkills,
  createCalcSkills,
  createNotesSkills,
  createOsSkills,
  createNetworkSkills,
  createServiceSkills,
  createEnvironmentSkills,
  createStorageSkills,
  createDevToolsSkills,
  createDevAgentSkill,
  createUiAgentSkill,
  createWindowSkills,
  createInputSkills,
  createUiaSkills,
  createScreenSkills,
  createTextSkills,
  createUtilitySkills,
  createWebSearchSkills,
  createSearchManager,
  createPhrasing,
  readAffirmation,
  recordEpisodes,
  type EngineIO,
} from '@atlas/engine';
import type { CapabilityName } from '@atlas/core';

export type EntryKind = 'you' | 'atlas' | 'results' | 'confirm' | 'clarify' | 'halted' | 'steps';

export type StepState = 'done' | 'failed' | 'declined' | 'halted' | 'skipped';

export interface Entry {
  id: number;
  kind: EntryKind;
  text?: string;
  rows?: ResultRow[];
  meta?: { title?: string; subtitle?: string };
  /** Confirmation entries carry their own resolution state. */
  question?: string;
  detail?: string;
  /** `halted`: the emergency stop ended the plan while this card was open. */
  answered?: 'yes' | 'no' | 'halted';
  /** `halted` entries: what stopped Atlas. */
  source?: HaltSource;
  /** `steps` entries: what a multi-step run actually did, one row per step. */
  steps?: { label: string; state: StepState; detail?: string }[];
  /** When the entry was added, for animating only what is new (restored entries have none). */
  at?: number;
  /** `atlas` entries: this reply arrived word by word, so it is drawn as it came and not re-animated. */
  streamed?: boolean;
  /** Still arriving. Never true for a restored entry. */
  streaming?: boolean;
  /** `clarify` entries: the options offered. */
  choices?: ClarifyChoice[];
  /** `clarify` entries: what was chosen or typed, once answered. */
  reply?: string;
}

/**
 * Atlas is halted: nothing runs until the person does something new.
 *
 * `epoch` is the native halt this corresponds to, and null for the moment
 * between pressing the on-screen button and the shell confirming it (or
 * forever, in the browser build, which has no native stop).
 */
/**
 * One row per step of a finished plan, for the transcript's collapsed
 * "Ran X actions" disclosure.
 *
 * Every field comes from the `PlanOutcome` the executor returned and nothing
 * else — there is no progress to animate here and no activity to stand in for
 * one. A row exists because a step existed; its state is what that step did.
 * The executor pads the steps a plan never reached (see its own doc comment),
 * so the count is out of what was *planned* rather than out of how far it got.
 *
 * Exported for `action-summary.test.ts`, which drives it from a real
 * `Executor` run rather than a hand-written outcome.
 */
export function stepRowsFrom(
  outcome: PlanOutcome,
  labelFor: (skillId: string) => string,
): { label: string; state: StepState; detail?: string }[] {
  return outcome.outcomes.map((o) => {
    const state: StepState = o.ok
      ? 'done'
      : o.error === 'Halted.'
        ? 'halted'
        : o.error === 'Cancelled.'
          ? 'declined'
          : o.skipped
            ? 'skipped'
            : 'failed';
    return { label: labelFor(o.skill), state, detail: o.ok ? undefined : o.error };
  });
}

export interface HaltState {
  epoch: number | null;
  source: HaltSource;
}

let nextId = 1;

/** Where the transcript persists — Phase 3's first piece, the same `Storage` port `MemoryStore` already proved this shape against. */
const TRANSCRIPT_KEY = 'atlas.transcript';
/** Entries, not turns — matches `MemoryStore`'s `EPISODIC_LIMIT` precedent for "capped rather than unbounded". */
const TRANSCRIPT_LIMIT = 200;
/** How long to wait after the last change before writing — a whole turn (the "you" entry, the "atlas" reply, maybe a results card) lands as one write instead of three. */
const TRANSCRIPT_SAVE_DELAY_MS = 500;

/**
 * A rows-only result, read aloud. Deliberately not the whole list — the same
 * reasoning `CapabilityBrowser`'s `teaser()` uses for the same shape of
 * problem, just spoken rather than printed: a hundred-odd rows read as "a lot
 * of things", not as a hundred-odd sentences.
 */
function summarizeForSpeech(rows: readonly ResultRow[], meta?: { title?: string }): string {
  if (!rows.length) return meta?.title ?? '';
  const names = rows.slice(0, 5).map((r) => r.title);
  const rest = rows.length - names.length;
  const listed = names.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
  return [meta?.title, listed].filter(Boolean).join(' — ');
}

/**
 * Which of a file skill's own args hold a path worth checking against
 * Allowed Folders, for `isPreapproved` below.
 *
 * `files.rename`'s `newName` is a bare name, not a path (see the skill's own
 * params), so renaming never needs a second path checked — the file stays in
 * the folder it was already in. Every other skill here that isn't listed
 * (read, search, info, everything outside `files.*`) never reaches
 * `isPreapproved` at all, because it isn't `risk: 'confirm'` in the first
 * place — see `effectiveRisk` in `@atlas/engine`'s executor.
 *
 * `project.create` (`@atlas/engine`'s devtools skills) is listed alongside
 * its `files.*` siblings for the same reason: it is `platform.createFolder`
 * under a project-domain name, the identical call `files.createFolder` already
 * makes, so it earns the identical softening. `dependency.install` is
 * deliberately **not** here — it runs a project's own package-manager tooling
 * (network access, postinstall scripts), a materially bigger consequence than
 * writing an empty file, so it keeps asking every time regardless of how
 * trusted the folder is.
 */
export const PREAPPROVABLE_PATH_ARGS: Readonly<Record<string, readonly string[]>> = {
  'files.create': ['path'],
  'files.createFolder': ['path'],
  'files.rename': ['path'],
  'files.move': ['path', 'destDir'],
  'files.copy': ['path', 'destDir'],
  'files.delete': ['path'],
  'files.append': ['path'],
  'project.create': ['path'],
};

/**
 * A best-effort match against the same list Settings → General's Allowed
 * Folders shows — good enough to decide whether to *ask*, never the security
 * boundary itself. That boundary is `allowed_folders::is_permitted` on the
 * Rust side, which canonicalizes (resolving `..` and symlinks) before every
 * real file operation regardless of what this function decides; the worst
 * this being wrong can do is an unnecessary confirm card (folder judged
 * outside when Rust would allow it) or one confirm card skipped for a path
 * Rust then refuses anyway with its own error — never a file touched this
 * didn't mean to allow.
 */
export function isInsideAnyAllowedFolder(path: string, allowedFolders: readonly string[]): boolean {
  const normalize = (p: string) => p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const target = normalize(path);
  return allowedFolders.some((root) => {
    const normalizedRoot = normalize(root);
    return (
      Boolean(normalizedRoot) &&
      (target === normalizedRoot || target.startsWith(`${normalizedRoot}\\`))
    );
  });
}

export function useAtlas(
  platform: Platform,
  capabilities: readonly CapabilityName[],
  storage: Storage,
  voiceProfile: VoiceProfile = {},
  localAi: LocalAiRuntime = DEFAULT_LOCAL_AI_RUNTIME,
  activeProviderId: string | null = null,
  /** Zero or more opt-in cloud providers — see `docs/ARCHITECTURE.md` §6.3. Never required. */
  cloudProviders: readonly CloudProviderConfig[] = [],
  /** How Atlas should speak. `VoiceProfile` above is a different thing entirely. */
  speech: SpeechPreferences = DEFAULT_SPEECH,
  /**
   * Supplied from the app's single `useSpeech` player, rather than created
   * here: the voice screen's visualiser has to read the same analyser that is
   * playing, and two players would mean two Atlases able to talk at once.
   */
  speak: (text: string, options?: SpeechOptions) => void = () => {},
  /** Speaks a reply while it is still streaming in; without it, speech waits for the end. */
  speakStream?: (options?: SpeechOptions) => { append(chunk: string): void; finish(): void },
  executionMode: ExecutionMode = DEFAULT_EXECUTION_MODE,
  /** Called on every halt, for what lives outside the engine — a voice mid-sentence. */
  onHalt: () => void = () => {},
) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const pendingConfirm = useRef<((approved: boolean) => void) | null>(null);
  /** A question Atlas asked about a vague request, and the options it offered. */
  const pendingClarify = useRef<{
    resolve: (answer: ClarifyAnswer) => void;
    choices: ClarifyChoice[];
  } | null>(null);

  const push = useCallback((entry: Omit<Entry, 'id'>) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId++, at: Date.now() }]);
  }, []);

  /**
   * The transcript across restarts — Phase 3's first piece.
   *
   * `Entry` is already a plain, JSON-safe shape (`rows[].payload` is always
   * data a `Platform` method already returned across the same IPC boundary;
   * a captured screenshot rides in a `SkillResult`'s own `data` field as a
   * data: URL string, never as binary in an `Entry`), so this writes the
   * array through as-is rather than needing a serialiser of its own.
   *
   * `loaded` gates the write effect below so a slow first read can never lose
   * a race with it: without this, mounting with `entries` still `[]` would
   * schedule a write of `[]` that could land *after* the real transcript comes
   * back, silently erasing it.
   */
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    storage
      .get<Entry[]>(TRANSCRIPT_KEY)
      .then((saved) => {
        if (cancelled) return;
        if (saved?.length) {
          // New entries must never collide with a restored id — this hook can
          // run more than once across the app's lifetime (mode switches),
          // and `nextId` is process-wide by design (see its own declaration).
          const maxId = saved.reduce((m, e) => Math.max(m, e.id), 0);
          if (maxId >= nextId) nextId = maxId + 1;
          // A reply that was mid-stream when the app closed is not still arriving.
          setEntries(
            saved.map((e) => {
              if (e.streaming) return { ...e, streaming: false };
              // A question that was open when the app closed is not still
              // waiting on anyone.
              if (e.kind === 'clarify' && !e.answered) return { ...e, answered: 'halted' as const };
              return e;
            }),
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) loaded.current = true;
      });
    return () => {
      cancelled = true;
    };
    // Runs once: `storage` is a stable instance for the app's lifetime, and
    // re-running this on every render would re-fight the write effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => {
      storage.set(TRANSCRIPT_KEY, entries.slice(-TRANSCRIPT_LIMIT)).catch(() => {});
    }, TRANSCRIPT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [entries, storage]);

  /**
   * Read from a ref for the same reason `speechRef` is: cycling modes
   * (Shift+Tab) has to take effect on the very next thing Atlas does, and
   * rebuilding the engine mid-conversation to pick up a new dependency value
   * would cost far more (working memory, the skill registry) than a setting
   * that changed is worth.
   */
  const executionModeRef = useRef<ExecutionMode>(executionMode);
  executionModeRef.current = executionMode;

  const phrasing = useMemo(() => createPhrasing(voiceProfile), [voiceProfile]);
  const memory = useMemo(() => new MemoryStore(storage), [storage]);

  /**
   * Do It's one "already permitted" exception — see the executor's own doc
   * comment in `@atlas/engine` for the policy and why it exists at all. This
   * is where the policy actually lives: the executor only knows *whether*
   * something answered yes, never *what* "already permitted" means.
   *
   * Reads the allowed-folders list fresh on every call rather than caching
   * it — this only ever runs immediately before what would otherwise be a
   * confirm card, so the extra round-trip is free next to a dialog the user
   * would have had to read and click anyway, and it means a folder added in
   * Settings a moment ago is honoured on the very next command.
   */
  const isPreapproved = useCallback(
    async (skill: Skill, args: SkillArgs): Promise<boolean> => {
      const pathArgs = PREAPPROVABLE_PATH_ARGS[skill.id];
      if (!pathArgs || !platform.allowedFolders) return false;
      const folders = await platform.allowedFolders().catch(() => []);
      if (!folders.length) return false;
      return pathArgs.every((key) => {
        const value = args[key];
        return typeof value === 'string' && isInsideAnyAllowedFolder(value, folders);
      });
    },
    [platform],
  );

  // One instance shared between the grammar (which reads it synchronously to
  // resolve "it"/"the second one") and the engine (which writes to it
  // whenever a skill renders a result list) — see WorkingMemory's doc comment.
  const working = useMemo(() => new WorkingMemory(), []);

  // Which search backends recently refused lives here, not inside the engine
  // memo below: the engine is rebuilt whenever a provider setting changes, and
  // a spent Tavily allowance should not be forgotten every time it is.
  const searchManager = useMemo(() => createSearchManager(platform), [platform]);

  // Saving or removing a search key is exactly when that memory is wrong.
  // The event's name is owned by Settings' WebSearch section (string, not an
  // import, so the hook does not depend on a settings page).
  useEffect(() => {
    const forget = () => searchManager.reset();
    window.addEventListener('atlas:search-key-changed', forget);
    return () => window.removeEventListener('atlas:search-key-changed', forget);
  }, [searchManager]);

  // Built once per change to the settings that shape it, outside the engine
  // memo, so the UI can also ask "is a model active?" without a second build.
  const builtIntelligence = useMemo(
    () => buildIntelligence({ localAi, activeProviderId, cloudProviders }),
    [localAi, activeProviderId, cloudProviders],
  );
  const hasModel = builtIntelligence.registry.active() !== null;

  // "Think longer": extended thinking and a fuller answer, for the messages
  // sent while it is on. Stays on until turned off — it is a mode, and a mode
  // that quietly reset after one message would be a surprise in the other
  // direction.
  const [thinkLonger, setThinkLonger] = useState(false);

  const engine = useMemo(() => {
    const skills = new SkillRegistry({ capabilities: () => capabilities });
    skills.registerMany(createCoreSkills(platform, memory, skills, phrasing));
    skills.registerMany(createWebSearchSkills(platform, searchManager));
    skills.registerMany(createUtilitySkills());
    skills.registerMany(createTextSkills());
    skills.registerMany(createCalcSkills());
    skills.registerMany(createNotesSkills(memory));
    skills.registerMany(createOsSkills(platform));
    skills.registerMany(createNetworkSkills(platform));
    skills.registerMany(createServiceSkills(platform));
    skills.registerMany(createEnvironmentSkills(platform));
    skills.registerMany(createStorageSkills(platform));
    skills.registerMany(createDevToolsSkills(platform));
    skills.registerMany(createWindowSkills(platform));
    skills.registerMany(createInputSkills(platform));
    skills.registerMany(createUiaSkills(platform));
    skills.registerMany(createScreenSkills(platform));

    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(working));
    grammar.addMany(createExtraGrammar());

    // The models Atlas can talk to, and which one is in use — see
    // `buildIntelligence`. This is the conversation and reasoning layer only:
    // skills, the executor and permissions are built around it and never
    // consult which provider is active. Everything is inert until the user
    // switches it on, and Atlas works completely with all of it off.
    const intelligence = builtIntelligence.registry;

    // The developer agent needs `intelligence` (to ask the selected model itself) and
    // `skills` (to validate/run each step it proposes) both already built,
    // which is why this registration sits after them rather than beside the
    // other `createXSkills(platform)` calls above.
    skills.register(
      createDevAgentSkill({
        skills,
        intelligence,
        phrasing,
        getExecutionMode: () => executionModeRef.current,
      }),
    );
    // Same reasoning, same shape, for the UI-driving agent — see
    // `packages/engine/src/uiagent/loop.ts`'s module doc.
    skills.register(
      createUiAgentSkill({
        skills,
        intelligence,
        phrasing,
        getExecutionMode: () => executionModeRef.current,
      }),
    );

    return new Engine({
      skills,
      grammar,
      voice: voiceProfile,
      working,
      intelligence,
      getExecutionMode: () => executionModeRef.current,
      isPreapproved,
    });
  }, [
    platform,
    searchManager,
    builtIntelligence,
    capabilities,
    memory,
    phrasing,
    voiceProfile,
    working,
    isPreapproved,
  ]);

  // Episodic memory doesn't touch the ask/io path at all — it just listens.
  useEffect(() => recordEpisodes(engine.bus, memory, engine.skills), [engine, memory]);

  /**
   * A record of what a multi-step run did, as one collapsed row.
   *
   * Only for plans of two or more steps: a single action already says what
   * happened in its own reply, and a disclosure for one line is noise. After
   * a halt it is the answer to "what had Atlas already done?", so it lands
   * above the halt marker rather than below it.
   */
  useEffect(
    () =>
      engine.bus.on<{ mode: string; outcome?: PlanOutcome }>('engine:done', (payload) => {
        const outcome = payload.outcome;
        if (payload.mode !== 'command' || !outcome || outcome.outcomes.length < 2) return;
        const steps = stepRowsFrom(outcome, (id) => engine.skills.get(id)?.label ?? id);
        setEntries((prev) => {
          const entry: Entry = { id: nextId++, kind: 'steps', steps, at: Date.now() };
          const last = prev[prev.length - 1];
          if (outcome.halted && last?.kind === 'halted') return [...prev.slice(0, -1), entry, last];
          return [...prev, entry];
        });
      }),
    [engine],
  );

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
      say: (text, options) => {
        push({ kind: 'atlas', text });
        // `aloud: false` is a skill saying its answer is for the eyes — a
        // password, a hash, a page of statistics. Still shown, still
        // copyable, just not read out.
        if (options?.aloud !== false) speakIfEnabled(text);
      },
      showResults: (rows, meta) => {
        push({ kind: 'results', rows, meta });
        // A rows-only answer carries no spoken message (see the executor's
        // "quiet when the skill rendered its own output" rule) because a card
        // on screen already answers the question — for whoever is looking at
        // the screen right now. The voice screen has no card to look at at
        // all, and even in chat a silent reply reads as broken rather than
        // answered, so this is the one place both surfaces get a sentence for
        // what would otherwise be nothing back.
        speakIfEnabled(summarizeForSpeech(rows, meta));
      },
      // Words as they are generated, not the whole answer at the end. The
      // engine asks for this only when a model is answering; everything else
      // still arrives through `say`. Speech waits for the finished text — a
      // voice reading half a sentence is worse than one that starts a moment
      // later.
      stream: () => {
        const id = nextId++;
        setEntries((prev) => [
          ...prev,
          { id, kind: 'atlas', text: '', at: Date.now(), streamed: true, streaming: true },
        ]);
        // Sentences are spoken as they finish, so the voice starts after the
        // first one rather than after the whole answer.
        const prefs = speechRef.current;
        const voice =
          prefs.enabled && speakStream
            ? speakStream({ voiceId: prefs.voiceId, pace: prefs.pace })
            : null;
        let streamedAny = false;
        return {
          append: (chunk: string) => {
            if (chunk.trim()) streamedAny = true;
            voice?.append(chunk);
            setEntries((prev) =>
              prev.map((e) => (e.id === id ? { ...e, text: (e.text ?? '') + chunk } : e)),
            );
          },
          finish: (full: string) => {
            setEntries((prev) =>
              prev.map((e) => (e.id === id ? { ...e, text: full, streaming: false } : e)),
            );
            // What was streamed has been spoken; `full` may carry a Sources
            // footer that is for the eyes. Nothing streamed (a reply that came
            // back whole) is spoken the ordinary way.
            if (voice && streamedAny) voice.finish();
            else {
              voice?.finish();
              if (full.trim()) speakIfEnabled(full);
            }
          },
        };
      },
      // Asking instead of guessing: a card in the transcript, options on it,
      // and the composer stays open for a typed answer. The engine is parked
      // on this promise exactly as it is on a confirmation.
      clarify: (question) =>
        new Promise<ClarifyAnswer>((resolve) => {
          pendingClarify.current = { resolve, choices: [...question.choices] };
          push({ kind: 'clarify', question: question.question, choices: [...question.choices] });
          speakIfEnabled(question.question);
        }),
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
    [push, speakIfEnabled, speakStream],
  );

  /** Answer the outstanding question, and mark its card as answered. */
  const answerClarify = useCallback((answer: ClarifyAnswer, label: string) => {
    const pending = pendingClarify.current;
    pendingClarify.current = null;
    setEntries((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const entry = next[i];
        if (entry && entry.kind === 'clarify' && !entry.answered) {
          next[i] = {
            ...entry,
            answered: answer.kind === 'cancelled' ? 'no' : 'yes',
            reply: answer.kind === 'cancelled' ? undefined : label,
          };
          break;
        }
      }
      return next;
    });
    pending?.resolve(answer);
  }, []);

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

  // ── Emergency stop ──────────────────────────────────────────────────────
  //
  // The stop has already happened by the time anything here runs: the shell
  // latched every hand, killed running tools and dropped model requests
  // before it emitted the event (see halt.rs). This is the renderer catching
  // up — telling the engine to stop thinking about it, clearing what was
  // queued, and showing the state.
  const [halt, setHalt] = useState<HaltState | null>(null);
  const haltRef = useRef<HaltState | null>(null);
  haltRef.current = halt;
  /** The button's native call, so resuming can wait for an epoch it hasn't heard yet. */
  const nativeHalt = useRef<Promise<number> | null>(null);
  const onHaltRef = useRef(onHalt);
  onHaltRef.current = onHalt;

  const applyHalt = useCallback(
    (event: { epoch: number | null; source: HaltSource }) => {
      engine.halt();
      queued.current = null;
      onHaltRef.current();

      const already = haltRef.current;
      const next: HaltState = {
        epoch: event.epoch ?? already?.epoch ?? null,
        source: already?.source ?? event.source,
      };
      haltRef.current = next;
      setHalt(next);
      // One marker per halt the person caused, not one per native echo of it:
      // the button applies locally at once and then hears its own event.
      if (already) return;

      const resolve = pendingConfirm.current;
      pendingConfirm.current = null;
      resolve?.(false);
      const question = pendingClarify.current;
      pendingClarify.current = null;
      question?.resolve({ kind: 'cancelled' });
      setEntries((prev) => [
        ...prev.map((e) =>
          (e.kind === 'confirm' || e.kind === 'clarify') && !e.answered
            ? { ...e, answered: 'halted' as const }
            : e,
        ),
        { id: nextId++, kind: 'halted', source: event.source, at: Date.now() },
      ]);
    },
    [engine],
  );

  useEffect(() => {
    const native = platform.halt;
    if (!native) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void native
      .onHalt((event: HaltEvent) => applyHalt(event))
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    // A reload while halted (or a halt from before this hook mounted) is
    // still a halt — pick the state up rather than show Atlas as ready.
    void native
      .status()
      .then((status) => {
        if (alive && status.halted && !haltRef.current) {
          const next: HaltState = { epoch: status.epoch, source: 'shortcut' };
          haltRef.current = next;
          setHalt(next);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [platform, applyHalt]);

  /** The on-screen stop button. */
  const requestHalt = useCallback(() => {
    applyHalt({ epoch: null, source: 'button' });
    if (platform.halt) {
      nativeHalt.current = platform.halt.now();
      nativeHalt.current.catch(() => {});
    }
  }, [applyHalt, platform]);

  /**
   * Leave the halted state. Only ever from something the person did — a new
   * message, a button — and only for the halt they saw: if a newer one
   * happened in the meantime, it stays in force.
   */
  const resume = useCallback(async (): Promise<boolean> => {
    const current = haltRef.current;
    if (!current) return true;
    const native = platform.halt;
    if (native) {
      let epoch = current.epoch;
      if (epoch === null) epoch = (await nativeHalt.current?.catch(() => null)) ?? null;
      if (epoch !== null && !(await native.reset(epoch).catch(() => false))) {
        const status = await native.status().catch(() => null);
        if (status?.halted) {
          const next: HaltState = { epoch: status.epoch, source: current.source };
          haltRef.current = next;
          setHalt(next);
          return false;
        }
      }
    }
    nativeHalt.current = null;
    haltRef.current = null;
    setHalt(null);
    return true;
  }, [platform]);

  const ask = useCallback(
    /**
     * `echo` is how a replayed instruction avoids appearing twice.
     *
     * Saying something that is neither yes nor no over a confirmation both
     * declines the card *and* is the next instruction, so the words are shown
     * where they were said and the replay below stays silent. Without it the
     * transcript claims you typed the same sentence twice.
     */
    async (text: string, options: { echo?: boolean } = {}) => {
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
      if (pendingClarify.current) {
        push({ kind: 'you', text: trimmed });
        const reading = readClarifyReply(trimmed, pendingClarify.current.choices);
        if (reading.kind === 'needs-text') {
          // Picked an option that wants typing, or a number that is not one:
          // say what is needed and keep waiting.
          push({ kind: 'atlas', text: reading.prompt });
        } else {
          answerClarify(reading.answer, reading.label);
        }
        return;
      }

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
      // Sending something new is the explicit act that ends a halt.
      if (haltRef.current && !(await resume())) return;
      if (options.echo !== false) push({ kind: 'you', text: trimmed });
      setBusy(true);
      try {
        await engine.ask(trimmed, io, { thinkLonger: thinkLonger && hasModel });
      } finally {
        setBusy(false);
      }
    },
    [busy, engine, io, push, answerConfirm, answerClarify, resume, thinkLonger, hasModel],
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
    // Already shown, at the point where it declined the card.
    void askRef.current(next, { echo: false });
  }, [busy]);

  /** Run a row's action — the same executor path a typed command takes. */
  const runAction = useCallback(
    async (skill: string, args: Record<string, string | number | boolean>) => {
      if (haltRef.current && !(await resume())) return;
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
    [engine, io, resume],
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
     * Is a confirmation waiting on the user right now?
     *
     * Exported because `busy` is true throughout — the executor is parked on
     * the card — and every surface that gates input on `busy` would otherwise
     * refuse the very answer the engine is waiting for. `ask` already handles
     * a typed answer correctly; this is what lets one reach it.
     *
     * Derived from the transcript rather than from `pendingConfirm`, because
     * that is a ref: changing it would not re-render anything, and a gate that
     * only lifts on the next unrelated render is not a gate.
     */
    awaitingAnswer: entries.some(
      (e) => (e.kind === 'confirm' || e.kind === 'clarify') && !e.answered,
    ),
    /** Is a model connected and switched on? Nothing about thinking longer means anything without one. */
    hasModel,
    thinkLonger,
    toggleThinkLonger: () => setThinkLonger((on) => !on),
    ask,
    runAction,
    /** Null unless Atlas is halted. */
    halt,
    requestHalt,
    resume,
    answerConfirm,
    answerClarify,
    clear,
    copy,
    /**
     * The engine's own bus, for a surface that wants to watch rather than
     * ask — the activity panel subscribes to `activity:step` on it. Handed
     * out rather than wrapped for the same reason `memory` is: anything
     * useful here already depends on the engine's event shapes.
     */
    engineBus: engine.bus,
    skillCount: engine.skills.available().length,
    skills: engine.skills,
    greeting: phrasing.greeting(),
    atlasName: voiceProfile.atlasName?.trim() || 'Atlas',
    /**
     * Handed straight out rather than wrapped in narrower callbacks. Home
     * reads `episodes()` for Recent Activity and Settings' Activity tab reads
     * and deletes from the same store — both already depend on the `Memory`
     * port shape, so there is nothing a wrapper here would hide.
     */
    memory,
  };
}
