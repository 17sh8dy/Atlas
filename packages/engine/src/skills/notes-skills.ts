/**
 * Notes and to-dos — the first skills that *keep* something.
 *
 * They store through the `Memory` port, not a file of their own. Memory
 * already persists, already survives a restart, and already has one place
 * where writes happen; a second store for "short things with a timestamp"
 * would have doubled that surface to save a filter.
 *
 * Notes and to-dos are list-shaped rather than key-shaped: the subject is the
 * moment it was written, so many can share a kind. That is why they get their
 * own `FactKind`s instead of being crammed into `fact` with a naming
 * convention — a convention would make "list my notes" a string-prefix search
 * and eventually a bug.
 */

import type { Fact, Memory, ResultRow, Skill } from '@atlas/core';

/** Newest last, the order a notebook reads in. */
function chronological(facts: Fact[]): Fact[] {
  return [...facts].sort((a, b) => a.at - b.at);
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A subject that sorts by time and never collides within a session. */
function stamp(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const DONE_PREFIX = '✓ ';

export function createNotesSkills(memory: Memory): Skill[] {
  const skills: Skill[] = [];

  // ---- notes --------------------------------------------------------------

  skills.push({
    id: 'notes.add',
    label: 'Take a note',
    icon: '📝',
    domain: 'notes',
    description: 'Write something down to read back later.',
    risk: 'safe',
    examples: ['note that the router password is on the fridge', 'take a note: call the dentist'],
    params: { text: { type: 'string', required: true, description: 'what to write down' } },
    async run(args) {
      const text = String(args.text).trim();
      if (!text) return { ok: false, error: 'Give me something to write down.' };
      await memory.remember('note', stamp(), text);
      return { ok: true, message: `📝 Noted — ${text}` };
    },
  });

  skills.push({
    id: 'notes.list',
    label: 'Read my notes',
    icon: '📒',
    domain: 'notes',
    description: 'Show everything written down, newest last.',
    risk: 'safe',
    examples: ['read my notes', 'what are my notes'],
    params: {},
    async run(_args, ctx) {
      const notes = chronological(await memory.facts('note'));
      if (!notes.length) return { ok: true, message: "You haven't taken any notes yet." };

      ctx.showResults?.(
        notes.map<ResultRow>((note) => ({
          title: note.value,
          subtitle: when(note.at),
          icon: '📝',
          payload: note,
        })),
        { title: 'Your notes', subtitle: `${notes.length} note${notes.length === 1 ? '' : 's'}` },
      );
      return { ok: true, spoken: true, message: '', data: notes };
    },
  });

  skills.push({
    id: 'notes.clear',
    label: 'Clear my notes',
    icon: '🗑️',
    domain: 'notes',
    description: 'Delete every note.',
    // Nothing else in Atlas can bring these back, so this asks first — the same
    // bar as deleting a file.
    risk: 'confirm',
    examples: ['clear my notes'],
    params: {},
    async run() {
      const notes = await memory.facts('note');
      if (!notes.length) return { ok: true, message: 'There were no notes to clear.' };
      for (const note of notes) await memory.forget('note', note.subject);
      return { ok: true, message: `Cleared ${notes.length} note${notes.length === 1 ? '' : 's'}.` };
    },
  });

  // ---- to-dos -------------------------------------------------------------

  skills.push({
    id: 'todo.add',
    label: 'Add a to-do',
    icon: '☑️',
    domain: 'notes',
    description: 'Add an item to your to-do list.',
    risk: 'safe',
    examples: ['add buy milk to my todo list', 'remind me to renew the domain'],
    params: { text: { type: 'string', required: true, description: 'the task' } },
    async run(args) {
      const text = String(args.text).trim();
      if (!text) return { ok: false, error: 'Give me something to add.' };
      await memory.remember('todo', stamp(), text);
      return { ok: true, message: `☑️ Added — ${text}` };
    },
  });

  skills.push({
    id: 'todo.list',
    label: 'Show my to-do list',
    icon: '📋',
    domain: 'notes',
    description: 'Show the to-do list, open items first.',
    risk: 'safe',
    examples: ['what is on my todo list', 'show my todos'],
    params: {},
    async run(_args, ctx) {
      const items = chronological(await memory.facts('todo'));
      if (!items.length) return { ok: true, message: 'Your to-do list is empty.' };

      const open = items.filter((i) => !i.value.startsWith(DONE_PREFIX));
      const done = items.filter((i) => i.value.startsWith(DONE_PREFIX));

      ctx.showResults?.(
        [...open, ...done].map<ResultRow>((item) => {
          const finished = item.value.startsWith(DONE_PREFIX);
          return {
            title: item.value,
            subtitle: when(item.at),
            icon: finished ? '✅' : '⬜',
            payload: item,
            actions: finished
              ? undefined
              : [{ label: 'Done', skill: 'todo.done', args: { text: item.value } }],
          };
        }),
        { title: 'To-do', subtitle: `${open.length} open · ${done.length} done` },
      );
      return {
        ok: true,
        spoken: true,
        message: '',
        data: { open: open.length, done: done.length },
      };
    },
  });

  skills.push({
    id: 'todo.done',
    label: 'Tick something off',
    icon: '✅',
    domain: 'notes',
    description: 'Mark a to-do item as done.',
    risk: 'safe',
    examples: ['tick off buy milk', 'mark buy milk as done'],
    params: { text: { type: 'string', required: true, description: 'words from the item' } },
    async run(args) {
      const needle = String(args.text).trim().toLowerCase();
      if (!needle) return { ok: false, error: 'Which one?' };

      const items = chronological(await memory.facts('todo'));
      const open = items.filter((i) => !i.value.startsWith(DONE_PREFIX));
      // Exact first, then contains — "milk" should tick off "buy milk", but an
      // item that *is* what you typed always wins over one that merely mentions it.
      const hit =
        open.find((i) => i.value.toLowerCase() === needle) ??
        open.find((i) => i.value.toLowerCase().includes(needle));

      if (!hit) return { ok: false, error: `Nothing open matching "${String(args.text)}".` };

      await memory.remember('todo', hit.subject, `${DONE_PREFIX}${hit.value}`);
      return { ok: true, message: `✅ Done — ${hit.value}` };
    },
  });

  return skills;
}
