/**
 * Tidying a folder, and taking it back.
 *
 * "Clean up my Downloads: installers in Software, images in Images, and ask me
 * before deleting anything." Every primitive for that already existed
 * (`files.list`, `createFolder`, `move`) — what was missing is the three
 * things that make it something a person can hand a real folder to:
 *
 *  1. **A plan they can see.** `files.organize` implements `Skill.preview`, so
 *     the confirmation card lists what will move where, instead of asking
 *     whether it is OK to "downloads". One approval covers that list, and `run`
 *     re-derives the plan and refuses to act if the folder has changed since
 *     (`ctx.approvedPreview`) — an approval is for what was shown.
 *  2. **A record.** Every batch is written to a journal as it happens — before
 *     the last file moves, not after — so an interrupted run still leaves
 *     something to undo from and something to report.
 *  3. **A way back.** `files.undo` reads the journal and puts files back,
 *     skipping (and saying so) any that have since been moved or replaced.
 *
 * ── What this never does ────────────────────────────────────────────────────
 * It never deletes. "Ask me before deleting anything" is satisfied the strong
 * way: this skill has no delete in it at all, so there is no version of a
 * tidy-up that removes something. Deleting stays `files.delete` /
 * `storage.emptyFolder`, each behind its own card.
 */

import type { FileEntry, KnownFolder, Platform, Skill, SkillContext } from '@atlas/core';
import {
  basenameOf,
  categorize,
  destinationFor,
  dirnameOf,
  fingerprintOf,
  joinPath,
  parseOrganizeRules,
  planOrganize,
  type OrganizePlan,
} from './organize-plan';

// ---- the journal ---------------------------------------------------------

export interface JournalMove {
  from: string;
  to: string;
}

/**
 * What kind of change a batch was. Only `organize`, `move` and `rename` are
 * pure reversals; the rest are recorded so the history is complete, and say why
 * they can't be undone.
 */
export type JournalKind = 'organize' | 'move' | 'rename' | 'create' | 'copy' | 'delete' | 'append';

/** One change Atlas made to files — a whole tidy-up, or a single move — as it actually happened. */
export interface JournalBatch {
  id: string;
  at: number;
  /** What it was called when it ran — "Tidied Downloads". */
  label: string;
  /** Absent on a batch written before this existed: those are all tidy-ups. */
  kind?: JournalKind;
  /** Where an undo puts things back: the folder they came from. */
  folder: string;
  createdFolders: string[];
  moves: JournalMove[];
  /**
   * Why an undo would not be a pure reversal — set on the kinds that can't be
   * undone, in words, so "undo that" can say so instead of doing something else.
   */
  cannotUndo?: string;
  /** Set once undone, never removed: history says what happened, including that. */
  undoneAt?: number;
  /** Originals already put back by an undo that did not finish — so a second one resumes. */
  restored?: string[];
}

/** Where the record lives. The desktop app backs this with its Storage port. */
export interface FileJournal {
  read(): Promise<JournalBatch[]>;
  write(batches: JournalBatch[]): Promise<void>;
}

/** How many batches are kept. A record nobody can page through is not a feature. */
export const JOURNAL_LIMIT = 20;

export function createMemoryJournal(): FileJournal {
  let batches: JournalBatch[] = [];
  return {
    read: async () => batches.map((b) => ({ ...b })),
    write: async (next) => {
      batches = next.map((b) => ({ ...b }));
    },
  };
}

// ---- helpers -------------------------------------------------------------

const KNOWN: readonly KnownFolder[] = [
  'home', 'downloads', 'documents', 'desktop', 'pictures', 'music', 'videos',
];

async function resolveFolder(platform: Platform, raw: string): Promise<string | null> {
  const trimmed = raw.trim().replace(/^["“]|["”]$/g, '');
  const known = trimmed.toLowerCase().replace(/\s+folder$/, '') as KnownFolder;
  if (KNOWN.includes(known)) {
    try {
      return await platform.knownFolder!(known);
    } catch {
      return null;
    }
  }
  return trimmed || null;
}

/**
 * What `list_dir` will return — its own hard ceiling (platform.rs), so asking
 * for one more to detect "there are more" cannot work. A listing that comes
 * back exactly this long is therefore treated as *possibly* cut off, and the
 * card says so rather than implying it saw everything.
 */
const LIST_CAP = 500;
/** Names shown per folder on the card, and problems quoted in a report. */
const SAMPLE = 3;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

function shortName(name: string, max = 34): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The card, as text: a summary a person can scan and actually check. */
export function describePlan(plan: OrganizePlan): string {
  const byFolder = new Map<string, string[]>();
  for (const move of plan.moves) {
    const list = byFolder.get(move.destFolder) ?? [];
    list.push(move.name);
    byFolder.set(move.destFolder, list);
  }

  const lines: string[] = [
    `${basenameOf(plan.folder)}: ${plural(plan.moves.length, 'file')} into ${plural(byFolder.size, 'folder')}`,
    '',
  ];
  for (const [dest, names] of byFolder) {
    const fresh = plan.newFolders.includes(dest) ? ' (new)' : '';
    const shown = names.slice(0, SAMPLE).map((n) => shortName(n)).join(', ');
    const more = names.length > SAMPLE ? `, +${names.length - SAMPLE} more` : '';
    lines.push(`• ${basenameOf(dest)}${fresh} — ${plural(names.length, 'file')}`);
    lines.push(`    ${shown}${more}`);
  }

  const kept: string[] = [];
  const { left } = plan;
  if (left.folders) kept.push(plural(left.folders, 'folder'));
  if (left.unfinished) kept.push(`${plural(left.unfinished, 'unfinished download')}`);
  if (left.recent) kept.push(`${plural(left.recent, 'file')} still changing`);
  if (left.unrecognised) kept.push(`${plural(left.unrecognised, 'file')} I don't recognise`);
  if (left.hidden) kept.push(`${plural(left.hidden, 'hidden file')}`);
  lines.push('');
  if (kept.length) lines.push(`Left where they are: ${kept.join(', ')}.`);
  if (plan.truncated) {
    lines.push(`This folder has ${LIST_CAP} items or more, so this is a first batch — ask again afterwards for the rest.`);
  }
  lines.push('Nothing is deleted or overwritten — and I can undo this afterwards.');
  return lines.join('\n');
}

export function createOrganizeSkills(platform: Platform, journal: FileJournal): Skill[] {
  const skills: Skill[] = [];

  /** Read the folder and work out the plan. Read-only — safe to call from `preview`. */
  async function buildPlan(
    args: Record<string, string | number | boolean>,
  ): Promise<{ plan: OrganizePlan } | { error: string }> {
    const raw = String(args.path ?? '');
    const folder = await resolveFolder(platform, raw);
    if (!folder) return { error: `I couldn’t find “${raw}”.` };

    const { folders, unknown } = parseOrganizeRules(String(args.rules ?? ''));
    if (unknown.length) {
      return {
        error: `I didn't follow “${unknown[0]}” — say it like “installers in Software”. I haven't moved anything.`,
      };
    }

    let entries: FileEntry[];
    try {
      entries = (await platform.listDir!(folder, LIST_CAP)) ?? [];
    } catch (e) {
      return { error: e instanceof Error ? e.message : `I couldn’t read ${folder}.` };
    }
    const truncated = entries.length >= LIST_CAP;

    // What is already in each destination, so a clash is named around rather
    // than discovered halfway through. A folder that can't be listed doesn't
    // exist yet — which is also what makes it "(new)" on the card.
    const dests = new Set<string>();
    for (const e of entries) {
      if (e.isDirectory) continue;
      const category = categorize(e.ext);
      if (category) dests.add(destinationFor(folder, category, folders));
    }
    const existing = new Map<string, Set<string>>();
    for (const dir of dests) {
      try {
        const there = (await platform.listDir!(dir, LIST_CAP)) ?? [];
        existing.set(dir, new Set(there.map((f) => f.name.toLowerCase())));
      } catch {
        /* not there yet */
      }
    }

    return {
      plan: planOrganize({ folder, entries, folders, existing, now: Date.now(), truncated }),
    };
  }

  async function record(batches: JournalBatch[]): Promise<void> {
    try {
      await journal.write(batches.slice(-JOURNAL_LIMIT));
    } catch {
      /* the journal failing must not undo a move that already happened */
    }
  }

  skills.push({
    id: 'files.organize',
    label: 'Organize a folder',
    icon: '🧹',
    domain: 'files',
    description:
      'Sort the loose files in a folder into subfolders by type (installers, images, documents, videos, audio, archives…), optionally into folders the user names. Never deletes or overwrites anything, and can be undone.',
    needs: ['fs'],
    // It changes where hundreds of things are at once. Reversible through the
    // journal, but not something closing a window undoes — a confirm, always,
    // and never softened by Allowed Folders (see `Skill.preview`).
    risk: 'confirm',
    examples: [
      'clean up my downloads folder',
      'organize my downloads: put installers in Software, images in Images',
    ],
    params: {
      path: { type: 'string', required: true, description: 'a known folder name or a path' },
      rules: {
        type: 'string',
        required: false,
        description: 'where each kind goes, e.g. "installers in Software, images in Images"',
      },
    },

    async preview(args) {
      const built = await buildPlan(args);
      if ('error' in built) return { kind: 'refuse', error: built.error };
      const { plan } = built;
      if (!plan.moves.length) {
        const why = plan.left.unrecognised || plan.left.recent || plan.left.unfinished
          ? ` (${plural(plan.left.unrecognised + plan.left.recent + plan.left.unfinished, 'file')} I left alone)`
          : '';
        return { kind: 'nothing', message: `${basenameOf(plan.folder)} is already tidy — nothing to move${why}.` };
      }
      return {
        kind: 'ask',
        question: `🧹 Tidy up ${basenameOf(plan.folder)}?`,
        detail: describePlan(plan),
        fingerprint: plan.fingerprint,
      };
    },

    async run(args, ctx: SkillContext) {
      const built = await buildPlan(args);
      if ('error' in built) return { ok: false, error: built.error };
      const { plan } = built;

      if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== plan.fingerprint) {
        return {
          ok: false,
          error:
            "That folder changed after I showed you the plan, so I didn't move anything. Ask again and I'll show you what's there now.",
        };
      }
      if (!plan.moves.length) return { ok: true, message: `${basenameOf(plan.folder)} is already tidy.` };

      const batch: JournalBatch = {
        id: stamp(),
        at: Date.now(),
        label: `Tidied ${basenameOf(plan.folder)}`,
        kind: 'organize',
        folder: plan.folder,
        createdFolders: [],
        moves: [],
      };
      const history = await journal.read().catch(() => [] as JournalBatch[]);
      const save = () => record([...history, batch]);

      const step = ctx.activity?.step('Sorting files', `0 of ${plan.moves.length}`);

      // Folders first. Written to the journal as they are made so an undo knows
      // which folders were Atlas's and which were already there.
      for (const dir of plan.newFolders) {
        try {
          if (!(await platform.createFolder!(dir))) throw new Error('refused');
          batch.createdFolders.push(dir);
        } catch (e) {
          await save();
          step?.failed(`couldn't create ${basenameOf(dir)}`);
          return {
            ok: false,
            error: `I couldn't create ${dir}${e instanceof Error && e.message !== 'refused' ? ` — ${e.message}` : ''}. Nothing was moved.`,
          };
        }
      }

      const failures: string[] = [];
      let stopped = false;
      for (const move of plan.moves) {
        if (ctx.signal?.aborted) {
          stopped = true;
          break;
        }
        try {
          if (await platform.movePathTo!(move.from, move.to)) {
            batch.moves.push({ from: move.from, to: move.to });
          } else {
            failures.push(`${move.name} — refused`);
          }
        } catch (e) {
          failures.push(`${move.name} — ${e instanceof Error ? e.message : String(e)}`);
        }
        // Written as it goes, not only at the end: a run that dies at file 300
        // must still be undoable and reportable.
        if (batch.moves.length > 0 && batch.moves.length % 20 === 0) {
          step?.update(`${batch.moves.length} of ${plan.moves.length}`);
          await save();
        }
      }
      await save();

      const done = batch.moves.length;
      if (done === 0) {
        step?.failed('nothing moved');
        return {
          ok: false,
          error: `I couldn't move anything.${failures.length ? ` ${failures[0]}.` : ''}`,
        };
      }
      step?.done(`${done} moved`);

      const destOf = new Map(plan.moves.map((m) => [m.to, basenameOf(m.destFolder)]));
      const byFolder = new Map<string, number>();
      for (const m of batch.moves) {
        const name = destOf.get(m.to) ?? '?';
        byFolder.set(name, (byFolder.get(name) ?? 0) + 1);
      }
      const summary = [...byFolder].map(([name, n]) => `${name} ${n}`).join(' · ');
      const parts = [
        `🧹 Moved ${done} of ${plural(plan.moves.length, 'file')} in ${basenameOf(plan.folder)} — ${summary}.`,
      ];
      if (stopped) parts.push('I stopped early, so the rest are still where they were.');
      if (failures.length) {
        parts.push(
          `${plural(failures.length, 'file')} couldn't be moved: ${failures.slice(0, SAMPLE).join('; ')}${failures.length > SAMPLE ? '…' : ''}.`,
        );
      }
      parts.push('Nothing was deleted. Say “undo that” to put it all back.');
      return { ok: true, message: parts.join(' '), data: { moved: done, failed: failures.length } };
    },
  });

  // ---- undo ------------------------------------------------------------

/**
   * The batch "undo that" means: the newest change not already undone — of any
   * kind. It is deliberately *not* "the newest one that happens to be
   * undoable": if the last thing Atlas did was delete a file, "undo that"
   * quietly reversing an older move instead would be an action nobody meant.
   */
  async function latestBatch(): Promise<JournalBatch | null> {
    const all = await journal.read().catch(() => [] as JournalBatch[]);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (!all[i]!.undoneAt) return all[i]!;
    }
    return null;
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await platform.pathInfo!(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Which of a batch's moves can still be reversed, and why the rest can't. */
  async function restorable(batch: JournalBatch) {
    const can: JournalMove[] = [];
    const cannot: Array<{ move: JournalMove; why: string }> = [];
    const already = new Set(batch.restored ?? []);
    for (const move of [...batch.moves].reverse()) {
      if (already.has(move.from)) continue;
      if (!(await exists(move.to))) cannot.push({ move, why: 'it has been moved or deleted since' });
      else if (await exists(move.from)) cannot.push({ move, why: 'something else is in its old place' });
      else can.push(move);
    }
    return { can, cannot };
  }

  skills.push({
    id: 'files.undo',
    label: 'Undo the last file change',
    icon: '↩️',
    domain: 'files',
    description:
      'Undo the most recent file change Atlas made — a folder tidy-up, a move or a rename — putting things back where they were.',
    needs: ['fs'],
    risk: 'confirm',
    examples: ['undo that', 'undo the last cleanup'],
    params: {},

    async preview() {
      const batch = await latestBatch();
      if (!batch) return { kind: 'nothing', message: "I haven't moved anything I could put back." };
      if (batch.cannotUndo) {
        return { kind: 'refuse', error: `The last thing I did was “${batch.label}”, and ${batch.cannotUndo}` };
      }
      const { can, cannot } = await restorable(batch);
      if (!can.length) {
        return {
          kind: 'refuse',
          error: `None of the ${plural(batch.moves.length, 'file')} from “${batch.label}” can go back — they've all been moved or changed since.`,
        };
      }
      const lines = [
        `${batch.label}, ${ago(batch.at)}: put ${plural(can.length, 'file')} back in ${basenameOf(batch.folder)}.`,
        '',
        ...can.slice(0, 5).map((m) => `• ${shortName(basenameOf(m.to))}  →  ${basenameOf(dirnameOf(m.from))}`),
      ];
      if (can.length > 5) lines.push(`• …and ${can.length - 5} more`);
      if (cannot.length) {
        lines.push('', `${plural(cannot.length, 'file')} can't go back (moved or replaced since) and will be left alone.`);
      }
      return {
        kind: 'ask',
        question: `↩️ Undo “${batch.label}”?`,
        detail: lines.join('\n'),
        fingerprint: fingerprintOf(can.map((m) => `${m.to}>${m.from}`)),
      };
    },

    async run(_args, ctx) {
      const all = await journal.read().catch(() => [] as JournalBatch[]);
      const batch = await latestBatch();
      if (!batch) return { ok: false, error: "I haven't moved anything I could put back." };
      if (batch.cannotUndo) {
        return { ok: false, error: `The last thing I did was “${batch.label}”, and ${batch.cannotUndo}` };
      }
      const { can, cannot } = await restorable(batch);
      if (
        ctx.approvedPreview !== undefined &&
        ctx.approvedPreview !== fingerprintOf(can.map((m) => `${m.to}>${m.from}`))
      ) {
        return {
          ok: false,
          error: "Things changed after I showed you what I'd put back, so I didn't move anything. Ask again.",
        };
      }

      let restored = 0;
      const back: string[] = [];
      const failures: string[] = [];
      let attempted = 0;
      for (const move of can) {
        if (ctx.signal?.aborted) break;
        attempted += 1;
        try {
          if (await platform.movePathTo!(move.to, move.from)) {
            restored += 1;
            back.push(move.from);
          } else failures.push(basenameOf(move.to));
        } catch (e) {
          failures.push(`${basenameOf(move.to)} — ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Closed only when everything reversible went back. A run that was
      // stopped or hit a failure stays open, remembering what it already did,
      // so a second "undo that" carries on rather than starting over.
      const target = all.find((b) => b.id === batch.id);
      if (target) {
        target.restored = [...(target.restored ?? []), ...back];
        if (attempted === can.length && failures.length === 0) target.undoneAt = Date.now();
        await record(all);
      }

      if (restored === 0) return { ok: false, error: `I couldn't put anything back.${failures[0] ? ` ${failures[0]}.` : ''}` };
      const parts = [`↩️ Put ${plural(restored, 'file')} back in ${basenameOf(batch.folder)}.`];
      if (cannot.length) parts.push(`${plural(cannot.length, 'file')} couldn't go back because they'd been moved since.`);
      if (failures.length) parts.push(`${plural(failures.length, 'file')} failed: ${failures.slice(0, SAMPLE).join('; ')}.`);
      if (batch.createdFolders.length) {
        parts.push(
          `The ${batch.createdFolders.map((d) => basenameOf(d)).join(', ')} folder${batch.createdFolders.length === 1 ? ' is' : 's are'} still there, now empty — I don't delete folders on my own.`,
        );
      }
      return { ok: true, message: parts.join(' ') };
    },
  });

  // ---- history ---------------------------------------------------------

  skills.push({
    id: 'files.history',
    label: 'What I changed',
    icon: '📜',
    domain: 'files',
    description:
      'List the file changes Atlas has made — tidy-ups, moves, renames, new files, deletes — newest first, and whether each was undone.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['what did you just change', 'show my file changes'],
    params: {},
    async run(_args, ctx) {
      const all = await journal.read().catch(() => [] as JournalBatch[]);
      if (!all.length) return { ok: true, message: "I haven't rearranged any files yet." };
      const newest = [...all].reverse();
      ctx.showResults?.(
        newest.map((b) => ({
          // A single action already says what it touched in its label; only a
          // batch has a count worth adding.
          title: b.moves.length > 1 ? `${b.label} — ${plural(b.moves.length, 'file')}` : b.label,
          subtitle: `${ago(b.at)}${b.undoneAt ? ' · undone' : b.cannotUndo ? ' · can’t be undone' : ''}`,
          icon: b.undoneAt ? '↩️' : (KIND_ICON[b.kind ?? 'organize'] ?? '📄'),
          payload: b,
        })),
        { title: 'Changes I made', subtitle: `${all.length} recorded` },
      );
      return { ok: true, spoken: true, message: '' };
    },
  });

  return skills;
}

const KIND_ICON: Record<JournalKind, string> = {
  organize: '🧹',
  move: '📦',
  rename: '✏️',
  create: '📄',
  copy: '📋',
  delete: '🗑️',
  append: '📝',
};

// ---- journaling every file action ---------------------------------------

/**
 * Wrap the single-file skills so each successful one is written to the same
 * journal the organizer uses — which is what turns "undo that" from a feature
 * of one skill into a property of file work: whatever Atlas last did to your
 * files, it can say what that was, and reverse it where a reversal is honest.
 *
 * ── Which ones can be undone, and why the rest say so ───────────────────────
 * A move and a rename are exact reversals: the same file, back to the same
 * place. Nothing else is. Creating something is undone by deleting it, and
 * deleting is a thing Atlas only does on request; a copy the same; and a
 * delete sent to the recycle bin can only be reversed *from* the recycle bin,
 * which Atlas has no way into. Those are recorded — so history is complete and
 * "what did you just change" is true — and refuse an undo in a sentence,
 * rather than being skipped in favour of some older action nobody meant.
 *
 * Done by wrapping rather than editing each skill: the skills stay ignorant of
 * the journal, only ever fire after the change has actually succeeded, and a
 * journal that fails to write never turns a completed move into an error.
 */
export function withFileJournal(skills: readonly Skill[], journal: FileJournal): Skill[] {
  const record = async (b: Omit<JournalBatch, 'id' | 'at' | 'createdFolders'>) => {
    try {
      const all = await journal.read().catch(() => [] as JournalBatch[]);
      all.push({ id: stamp(), at: Date.now(), createdFolders: [], ...b });
      await journal.write(all.slice(-JOURNAL_LIMIT));
    } catch {
      /* the change already happened; not being able to note it is not a failure of it */
    }
  };

  const describers: Record<string, (a: Record<string, string | number | boolean>) => Omit<JournalBatch, 'id' | 'at' | 'createdFolders'>> = {
    'files.move': (a) => {
      const from = String(a.path);
      const destDir = String(a.destDir);
      return {
        kind: 'move',
        label: `Moved ${basenameOf(from)}`,
        folder: dirnameOf(from),
        moves: [{ from, to: joinPath(destDir, basenameOf(from)) }],
      };
    },
    'files.rename': (a) => {
      const from = String(a.path);
      const newName = String(a.newName);
      return {
        kind: 'rename',
        label: `Renamed ${basenameOf(from)} to ${newName}`,
        folder: dirnameOf(from),
        moves: [{ from, to: joinPath(dirnameOf(from), newName) }],
      };
    },
    'files.create': (a) => ({
      kind: 'create',
      label: `Created ${basenameOf(String(a.path))}`,
      folder: dirnameOf(String(a.path)),
      moves: [],
      cannotUndo: "I don't delete files I've just made — you can remove it yourself, or ask me to delete it.",
    }),
    'files.createFolder': (a) => ({
      kind: 'create',
      label: `Created the folder ${basenameOf(String(a.path))}`,
      folder: dirnameOf(String(a.path)),
      moves: [],
      cannotUndo: "I don't delete folders on my own — you can remove it yourself, or ask me to delete it.",
    }),
    'files.copy': (a) => ({
      kind: 'copy',
      label: `Copied ${basenameOf(String(a.path))} to ${basenameOf(String(a.destDir))}`,
      folder: dirnameOf(String(a.path)),
      moves: [],
      cannotUndo: "undoing a copy means deleting the copy, which I only do when you ask.",
    }),
    'files.delete': (a) => ({
      kind: 'delete',
      label: `Sent ${basenameOf(String(a.path))} to the recycle bin`,
      folder: dirnameOf(String(a.path)),
      moves: [],
      cannotUndo: "it's in the recycle bin — restore it from there, which I can't reach.",
    }),
    'files.append': (a) => ({
      kind: 'append',
      label: `Added to ${basenameOf(String(a.path))}`,
      folder: dirnameOf(String(a.path)),
      moves: [],
      cannotUndo: "I can't take back a line I've added to a file.",
    }),
  };

  return skills.map((skill) => {
    const describe = describers[skill.id];
    if (!describe) return skill;
    return {
      ...skill,
      async run(args, ctx) {
        const result = await skill.run(args, ctx);
        if (result.ok) await record(describe(args));
        return result;
      },
    };
  });
}
