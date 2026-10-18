/**
 * Reviewing and undoing the edits Atlas makes to files.
 *
 * `code.edit` and `code.write` already existed and already asked first. What was missing was the
 * ability to SEE what they would change before saying yes, and to take it back afterwards. This
 * module adds exactly that and nothing else, on top of what is there:
 *
 *   · the ordinary confirmation card is untouched — it still appears when it appeared before and
 *     not otherwise. `reviewDetail` only fills it in with the diff;
 *   · an edit that has been WRITTEN reports a diff marked `applied` and a one-step undo, through the
 *     same `Skill.undo` path every reversible action already uses ("undo that");
 *   · the undo only ever puts a file back if it still holds exactly what Atlas wrote. A file that
 *     has been edited since is left alone, and Atlas says so.
 *
 * What it does NOT do, on purpose: grant any new permission (every read and write still goes through
 * the same Allowed-Folders gate), run anything, or keep copies anywhere but Atlas's own folder.
 */

import type { Platform, ReviewPayload, Skill, SkillArgs, SkillResult } from '@atlas/core';
import { applyEdit, fileNameOf, payloadOf, reviewOf } from '../review/diff';

/** The text of a file, or null if it cannot be read whole (too large, not text, not allowed). */
export async function readBefore(platform: Platform, path: string): Promise<string | null> {
  if (!platform.readTextFile) return null;
  try {
    return await platform.readTextFile(path);
  } catch {
    return null;
  }
}

/** A fast non-cryptographic hash (cyrb53) — to compare, never to protect. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What a confirmation card showed, so the write can refuse if the file moved on before the answer.
 * "I showed you THIS change" has to stay true: if someone saved the file in between, the card was
 * about a file that no longer exists.
 */
const proposals = new Map<string, { beforeHash: string; at: number }>();
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

function proposalKey(skill: string, args: SkillArgs): string {
  return `${skill}\u0000${hashText(JSON.stringify([args.path, args.find, args.replace, args.replaceAll === true, args.content]))}`;
}

export function rememberProposal(skill: string, args: SkillArgs, before: string, now = Date.now()): void {
  for (const [k, v] of proposals) if (now - v.at > PROPOSAL_TTL_MS) proposals.delete(k);
  proposals.set(proposalKey(skill, args), { beforeHash: hashText(before), at: now });
}

/**
 * If a card was shown for exactly this call, and the file is no longer what that card was about,
 * say so (and write nothing). Consumed on use. Null when nothing was shown or nothing has changed.
 */
export function staleProposal(skill: string, args: SkillArgs, before: string | null, now = Date.now()): string | null {
  const key = proposalKey(skill, args);
  const entry = proposals.get(key);
  if (!entry) return null;
  proposals.delete(key);
  if (before === null || now - entry.at > PROPOSAL_TTL_MS) return null;
  if (hashText(before) === entry.beforeHash) return null;
  return `${fileNameOf(String(args.path))} changed after I showed you this change, so I wrote nothing. Ask again and I'll show you the new version.`;
}

/** What a skill adds to its result after it has WRITTEN a file. */
export interface Applied {
  review?: ReviewPayload;
  undo?: SkillResult['undo'];
  /** Said after the message when something about the undo needs saying. */
  warning?: string;
}

/**
 * The file has just been written. Read it back, keep a checkpoint, and describe what changed.
 * Never throws: a checkpoint problem must not turn a successful edit into a reported failure — it
 * becomes a plain warning that this edit cannot be undone from here.
 */
export async function recordApplied(
  platform: Platform,
  path: string,
  before: string | null,
  source: string,
): Promise<Applied> {
  const name = fileNameOf(path);
  const after = await readBefore(platform, path);
  if (before === null || after === null) {
    return {
      warning: `I couldn't keep a copy of ${name} to undo from (it is too large to read here), so this edit can't be undone from here.`,
    };
  }
  if (after === before) return {}; // written, but nothing differs
  const draft = reviewOf(path, before, after, 'applied');
  if (!platform.recordChange) {
    return { review: payloadOf({ ...draft, note: 'No checkpoint was kept in this build, so this edit can’t be undone from here.' }) };
  }
  try {
    const changeId = await platform.recordChange({
      path,
      before,
      after,
      source,
      added: draft.added,
      removed: draft.removed,
    });
    return {
      review: payloadOf({ ...draft, changeId }),
      undo: { skill: 'code.undo', args: { path, changeId }, label: `Undo the edit to ${name}` },
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      review: payloadOf({ ...draft, note: `No checkpoint was kept (${why}), so this edit can't be undone from here.` }),
      warning: `I couldn't keep a checkpoint of ${name} (${why}), so this edit can't be undone from here.`,
    };
  }
}

/** A proposed overwrite or edit, for the confirmation card. Read-only. */
export async function proposeEdit(
  platform: Platform,
  skill: 'code.edit' | 'code.write',
  args: SkillArgs,
): Promise<ReviewPayload | undefined> {
  const path = String(args.path ?? '');
  if (!path) return undefined;
  const before = await readBefore(platform, path);
  if (before === null) return undefined;
  let after: string;
  if (skill === 'code.edit') {
    const r = applyEdit(before, String(args.find ?? ''), String(args.replace ?? ''), args.replaceAll === true);
    if (!r.ok) return undefined; // run() will say why it cannot happen
    after = r.after;
  } else {
    after = String(args.content ?? '');
  }
  if (after === before) return undefined;
  rememberProposal(skill, args, before);
  return payloadOf(reviewOf(path, before, after, 'proposed'));
}

/** `code.undo` and `code.changes`: the way back, and the history. */
export function createCodeReviewSkills(platform: Platform): Skill[] {
  return [
    {
      id: 'code.undo',
      label: 'Undo an edit Atlas made',
      icon: '↩️',
      domain: 'code',
      description:
        'Put a file back to how it was before an edit Atlas made — only if the file still holds exactly what Atlas wrote. A file edited since is left untouched.',
      needs: ['devtools'],
      risk: 'confirm',
      params: {
        path: { type: 'string', required: true, description: 'full path of the file the edit was made to' },
        changeId: { type: 'string', required: true, description: 'the id of the recorded change, from the edit result or code.changes' },
      },
      async reviewDetail(args) {
        const rec = await platform.getChange?.(String(args.changeId ?? ''))?.catch(() => null);
        if (!rec || rec.status === 'reverted') return undefined;
        // The picture of what undoing will do: the edit, run backwards.
        return payloadOf(reviewOf(rec.path, rec.after, rec.before, 'proposed', { changeId: rec.id }));
      },
      async run(args) {
        const id = String(args.changeId ?? '');
        if (!platform.revertChange) return { ok: false, error: "This build doesn't keep checkpoints, so I can't undo that." };
        let out;
        try {
          out = await platform.revertChange(id);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : `I couldn't undo that edit.` };
        }
        if (!out.ok) return { ok: false, error: out.message };
        const rec = await platform.getChange?.(id)?.catch(() => null);
        return {
          ok: true,
          message: out.message,
          ...(rec && out.outcome === 'reverted'
            ? { review: payloadOf(reviewOf(rec.path, rec.after, rec.before, 'reverted', { changeId: id })) }
            : {}),
        };
      },
    },
    {
      id: 'code.changes',
      label: 'Show what Atlas changed',
      icon: '📝',
      domain: 'code',
      description:
        'List the edits Atlas has recently made to your files, newest first, each with what it added and removed and whether it is still in place, kept or put back.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['show me what you changed', 'review the recent code changes', 'what did you edit'],
      params: {
        limit: { type: 'number', required: false, default: 20, description: 'how many to show' },
      },
      async run(args) {
        if (!platform.listChanges) return { ok: false, error: "This build doesn't keep a history of edits." };
        const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 20)) || 20));
        let metas;
        try {
          metas = await platform.listChanges(limit);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "I couldn't read the history of edits." };
        }
        if (!metas.length) return { ok: true, message: "Atlas hasn't edited any of your files yet, so there is nothing to review." };
        const files = metas.map((m) => ({
          path: m.path,
          name: m.name,
          status: m.status,
          added: m.added,
          removed: m.removed,
          hunks: null,
          changeId: m.id,
          ...(m.edited ? { note: 'You edited this after Atlas wrote it.' } : {}),
        }));
        return {
          ok: true,
          message: `Here ${metas.length === 1 ? 'is the last edit' : `are the last ${metas.length} edits`} Atlas made to your files. Open one to see exactly what changed.`,
          aloud: false,
          review: { files },
        };
      },
    },
  ];
}
