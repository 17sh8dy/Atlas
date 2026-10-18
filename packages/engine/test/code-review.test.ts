/**
 * Code review, end to end: the REAL executor, the REAL skills, a real folder on disk, and a
 * checkpoint store that obeys the same rules as the native one.
 *
 * What these tests hold in place is the part a person trusts:
 *   · a proposal is shown BEFORE anything is written, and declining leaves the file exactly as it was;
 *   · an edit that was written is reported as applied, never as something that "would" happen;
 *   · undo puts the file back — unless it was changed since, in which case it is left alone;
 *   · the questions Atlas asks are the same ones it asked before, in every execution mode.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfirmOptions, ExecutionMode, Plan, Platform, ReviewPayload, SkillContext } from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { createDevToolsSkills } from '../src/skills/devtools-skills';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { diskPlatform, makeTempProject } from './helpers/disk-platform';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const SOURCE = ['export function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i;', '  return sum;', '}', ''].join('\n');

function project(files: Record<string, string> = { 'a.ts': SOURCE }) {
  const p = makeTempProject(files);
  cleanups.push(p.cleanup);
  return p;
}

interface Seen {
  cards: Array<{ question: string; detail?: string; review?: ReviewPayload; fileAtAsk: string }>;
  said: Array<{ text: string; review?: ReviewPayload }>;
}

function setup(opts: { platform?: Platform; mode?: ExecutionMode; answer?: boolean | ((n: number) => boolean); onAsk?: () => void; file?: string } = {}) {
  const platform = opts.platform ?? diskPlatform();
  const registry = new SkillRegistry({ capabilities: () => ['devtools'] });
  registry.registerMany(createDevToolsSkills(platform));
  const seen: Seen = { cards: [], said: [] };
  const ctx: SkillContext = {
    say: (text, options) => {
      seen.said.push({ text, ...(options?.review ? { review: options.review } : {}) });
    },
    showResults: () => {},
    confirm: async (question: string, detail?: string, options?: ConfirmOptions) => {
      seen.cards.push({
        question,
        ...(detail ? { detail } : {}),
        ...(options?.review ? { review: options.review } : {}),
        fileAtAsk: opts.file ? readFileSync(opts.file, 'utf8') : '',
      });
      opts.onAsk?.();
      const a = opts.answer ?? true;
      return typeof a === 'function' ? a(seen.cards.length) : a;
    },
  };
  const run = (steps: Plan['steps']) =>
    new Executor(registry).run({ source: 'grammar', intent: 'test', confidence: 1, steps }, ctx, { mode: opts.mode ?? 'doIt' });
  return { platform, registry, seen, run };
}

const edit = (path: string, find: string, replace: string, extra: Record<string, unknown> = {}) => ({
  skill: 'code.edit',
  args: { path, find, replace, ...extra },
});

describe('a proposed edit', () => {
  test('is shown as a diff BEFORE anything is written, and marked proposed', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { seen, run } = setup({ file });
    await run([edit(file, '  let sum = 0;', '  let sum = 0; // running total')]);

    expect(seen.cards).toHaveLength(1);
    const card = seen.cards[0]!;
    // The file was untouched at the moment the question was put.
    expect(card.fileAtAsk).toBe(SOURCE);
    const f = card.review!.files[0]!;
    expect(f.status).toBe('proposed');
    expect(f).toMatchObject({ name: 'a.ts', added: 1, removed: 1 });
    expect(f.hunks![0]!.lines.find((l) => l.kind === 'add')!.text).toBe('  let sum = 0; // running total');
    expect(f.changeId, 'a proposal has no checkpoint yet — nothing was written').toBeUndefined();
  });

  test('declining writes nothing and keeps no checkpoint', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { platform, seen, run } = setup({ answer: false });
    const out = await run([edit(file, 'sum += i', 'sum += i * 2')]);
    expect(out.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
    expect(await platform.listChanges!()).toHaveLength(0);
    expect(seen.said.filter((s) => s.review)).toHaveLength(0);
  });

  test('an edit that cannot happen gets the ordinary card and the native refusal', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { seen, run } = setup();
    const out = await run([edit(file, 'text that is not there', 'x')]);
    expect(seen.cards[0]!.review, 'nothing to show for an edit that will be refused').toBeUndefined();
    expect(out.outcomes[0]!.error).toBe("That text isn't in the file — nothing to replace.");
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
  });
});

describe('an applied edit', () => {
  test('is reported as applied, with a checkpoint and a one-step undo', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { platform, seen, run } = setup();
    const out = await run([edit(file, 'sum += i', 'sum += i * 2')]);

    expect(out.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('sum += i * 2');
    const applied = seen.said.find((s) => s.review)!;
    const f = applied.review!.files[0]!;
    expect(f.status).toBe('applied');
    expect(f.changeId).toBeTruthy();
    expect(f).toMatchObject({ added: 1, removed: 1 });
    // Nothing in the words says "would" or "proposed" about something that has happened.
    expect(applied.text).not.toMatch(/\bwould\b|proposed/i);
    const step = out.outcomes[0]!;
    expect(step.undo).toMatchObject({ skill: 'code.undo', args: { changeId: f.changeId } });
    expect((await platform.getChange!(f.changeId!))!.before).toBe(SOURCE);
  });

  test('is the same payload the card showed, now with a checkpoint', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { seen, run } = setup();
    await run([edit(file, 'return sum;', 'return sum | 0;')]);
    const proposed = seen.cards[0]!.review!.files[0]!;
    const applied = seen.said.find((s) => s.review)!.review!.files[0]!;
    expect(applied.hunks).toEqual(proposed.hunks);
    expect([proposed.status, applied.status]).toEqual(['proposed', 'applied']);
  });

  test('a write over a whole file is reviewed the same way', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const next = SOURCE.replace('let sum = 0;', 'let sum = 1;');
    const { seen, run } = setup({ file });
    const out = await run([{ skill: 'code.write', args: { path: file, content: next } }]);
    expect(out.ok).toBe(true);
    expect(seen.cards[0]!.review!.files[0]!.status).toBe('proposed');
    expect(seen.cards[0]!.fileAtAsk).toBe(SOURCE);
    expect(readFileSync(file, 'utf8')).toBe(next);
    expect(seen.said.find((s) => s.review)!.review!.files[0]!.status).toBe('applied');
  });

  test('a write that changes nothing reports no edit and keeps no checkpoint', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { platform, seen, run } = setup();
    await run([{ skill: 'code.write', args: { path: file, content: SOURCE } }]);
    expect(seen.said.filter((s) => s.review)).toHaveLength(0);
    expect(await platform.listChanges!()).toHaveLength(0);
  });
});

describe('undo', () => {
  async function editThenUndoStep(files?: Record<string, string>) {
    const { root } = project(files);
    const file = join(root, 'a.ts');
    const s = setup({ file });
    const first = await s.run([edit(file, 'sum += i', 'sum += i * 2')]);
    const undo = first.outcomes[0]!.undo!;
    s.seen.cards.length = 0;
    s.seen.said.length = 0;
    return { ...s, file, undo };
  }

  test('puts the file back, showing the edit run backwards on the card first', async () => {
    const { run, seen, file, undo, platform } = await editThenUndoStep();
    const out = await run([{ skill: undo.skill, args: undo.args }]);
    expect(out.ok).toBe(true);
    // The card showed what undoing would do, before doing it.
    const card = seen.cards[0]!;
    expect(card.review!.files[0]!.status).toBe('proposed');
    expect(card.review!.files[0]!.hunks![0]!.lines.find((l) => l.kind === 'add')!.text).toBe('  for (const i of items) sum += i;');
    expect(card.fileAtAsk).toContain('sum += i * 2');
    // Then it did it.
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
    expect(seen.said.find((s) => s.review)!.review!.files[0]!.status).toBe('reverted');
    expect((await platform.listChanges!())[0]!.status).toBe('reverted');
  });

  test('declining the undo leaves the edit in place', async () => {
    const { platform, file, undo, registry, seen } = await editThenUndoStep();
    const ctx: SkillContext = { say: () => {}, showResults: () => {}, confirm: async () => false };
    await new Executor(registry).run({ source: 'grammar', intent: 't', confidence: 1, steps: [{ skill: undo.skill, args: undo.args }] }, ctx, { mode: 'doIt' });
    expect(readFileSync(file, 'utf8')).toContain('sum += i * 2');
    expect((await platform.listChanges!())[0]!.status).toBe('applied');
    expect(seen.said).toHaveLength(0);
  });

  test('will not overwrite work Atlas did not do', async () => {
    const { run, file, undo } = await editThenUndoStep();
    // The person kept working after Atlas's edit.
    const theirs = readFileSync(file, 'utf8') + '// my own note\n';
    writeFileSync(file, theirs);
    const out = await run([{ skill: undo.skill, args: undo.args }]);
    expect(out.ok).toBe(false);
    expect(out.outcomes[0]!.error).toMatch(/changed since Atlas edited it/);
    expect(readFileSync(file, 'utf8'), 'their work is exactly as they left it').toBe(theirs);
  });

  test('a second undo is harmless', async () => {
    const { run, file, undo } = await editThenUndoStep();
    await run([{ skill: undo.skill, args: undo.args }]);
    const again = await run([{ skill: undo.skill, args: undo.args }]);
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
    expect(again.outcomes[0]!.ok).toBe(true);
  });
});

describe('the questions Atlas asks have not changed', () => {
  test('Do It + still runs an edit without asking — and still reports it, with an undo', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { seen, run } = setup({ mode: 'doItPlus' });
    const out = await run([edit(file, 'sum += i', 'sum += i * 3')]);
    expect(seen.cards, 'no new question appeared in this mode').toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(seen.said.find((s) => s.review)!.review!.files[0]!.status).toBe('applied');
    expect(out.outcomes[0]!.undo).toBeTruthy();
  });

  test('Confirm Actions still asks, once per edit', async () => {
    const { root } = project({ 'a.ts': SOURCE, 'b.ts': 'one\ntwo\n' });
    const a = join(root, 'a.ts');
    const b = join(root, 'b.ts');
    const { seen, run } = setup({ mode: 'confirmActions' });
    await run([edit(a, 'sum += i', 'sum += 2'), edit(b, 'two', 'TWO')]);
    expect(seen.cards).toHaveLength(2);
    expect(seen.cards.map((c) => c.review!.files[0]!.name)).toEqual(['a.ts', 'b.ts']);
  });

  test('per-file approval: say yes to one file and no to the next', async () => {
    const { root } = project({ 'a.ts': SOURCE, 'b.ts': 'one\ntwo\n' });
    const a = join(root, 'a.ts');
    const b = join(root, 'b.ts');
    const { run } = setup({ mode: 'confirmActions', answer: (n) => n === 1 });
    // A declined step stops the rest of a plan, as it always has: the first file is changed, the second never touched.
    await run([edit(a, 'sum += i', 'sum += 2'), edit(b, 'two', 'TWO')]);
    expect(readFileSync(a, 'utf8')).toContain('sum += 2');
    expect(readFileSync(b, 'utf8')).toBe('one\ntwo\n');
  });
});

describe('never silently overwriting', () => {
  test('a whole-file write refuses if the file changed while the card was open', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const theirs = SOURCE + '// saved while the card was open\n';
    const { run, seen } = setup({ onAsk: () => writeFileSync(file, theirs) });
    const out = await run([{ skill: 'code.write', args: { path: file, content: SOURCE.replace('0', '99') } }]);
    expect(out.ok).toBe(false);
    expect(out.outcomes[0]!.error).toMatch(/changed after I showed you this change, so I wrote nothing/);
    expect(readFileSync(file, 'utf8'), 'their save survives').toBe(theirs);
    expect(seen.said.filter((s) => s.review)).toHaveLength(0);
  });

  test('an edit that was never shown on a card is not held to a proposal', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const { run } = setup({ mode: 'doItPlus' });
    writeFileSync(file, SOURCE + '// extra\n');
    const out = await run([edit(file, 'sum += i', 'sum += 5')]);
    expect(out.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('// extra');
  });
});

describe('when a checkpoint cannot be kept', () => {
  test('a file too large to keep a copy of is still written, and Atlas says it cannot be undone', async () => {
    // Over the 256 KB Atlas can read: it can be overwritten (up to 2 MB) but never copied whole.
    const big = Array.from({ length: 30_000 }, (_, i) => `line number ${i}`).join('\n') + '\n';
    const { root } = project({ 'big.txt': big });
    const file = join(root, 'big.txt');
    const { seen, run } = setup({ mode: 'doItPlus' });
    const next = big.replace('line number 5\n', 'line number FIVE\n');
    const out = await run([{ skill: 'code.write', args: { path: file, content: next } }]);
    expect(out.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('line number FIVE');
    expect(out.outcomes[0]!.undo).toBeUndefined();
    expect(out.outcomes[0]!.message).toMatch(/can't be undone from here/);
    expect(seen.said.filter((s) => s.review)).toHaveLength(0);
  });

  test('a build with no checkpoint support says so on the diff instead of promising an undo', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const base = diskPlatform();
    const { recordChange: _drop, ...noCheckpoints } = base as Platform & { recordChange?: unknown };
    const { seen, run } = setup({ platform: noCheckpoints as Platform, mode: 'doItPlus' });
    const out = await run([edit(file, 'sum += i', 'sum += 7')]);
    expect(out.ok).toBe(true);
    const f = seen.said.find((s) => s.review)!.review!.files[0]!;
    expect(f.status).toBe('applied');
    expect(f.note).toMatch(/can.t be undone/);
    expect(out.outcomes[0]!.undo).toBeUndefined();
  });

  test('a platform that cannot even read files still edits exactly as before', async () => {
    const calls: string[] = [];
    const platform = {
      id: 'stub',
      capabilities: async () => ['devtools'],
      patchTextFile: async () => {
        calls.push('patch');
        return 'Replaced 1 occurrence.';
      },
    } as unknown as Platform;
    const { run } = setup({ platform, mode: 'doItPlus' });
    const out = await run([edit('C:\\proj\\a.ts', 'x', 'y')]);
    expect(out.ok).toBe(true);
    expect(calls).toEqual(['patch']);
    expect(out.outcomes[0]!.message).toMatch(/^Replaced 1 occurrence\. \(a\.ts\)/);
  });
});

describe('code.changes', () => {
  test('lists the recent edits, newest first, with what each did', async () => {
    const { root } = project({ 'a.ts': SOURCE, 'b.ts': 'one\ntwo\n' });
    const a = join(root, 'a.ts');
    const b = join(root, 'b.ts');
    const { run, seen } = setup({ mode: 'doItPlus' });
    await run([edit(a, 'sum += i', 'sum += 2'), edit(b, 'two', 'TWO')]);
    seen.said.length = 0;
    const out = await run([{ skill: 'code.changes', args: {} }]);
    expect(out.ok).toBe(true);
    const files = seen.said.find((s) => s.review)!.review!.files;
    expect(files.map((f) => f.name)).toEqual(['b.ts', 'a.ts']);
    expect(files.every((f) => f.status === 'applied' && f.changeId && f.hunks === null)).toBe(true);
  });

  test('says so plainly when Atlas has edited nothing', async () => {
    project();
    const { run, seen } = setup();
    const out = await run([{ skill: 'code.changes', args: {} }]);
    expect(out.ok).toBe(true);
    expect(seen.said[0]!.text).toMatch(/hasn't edited any of your files yet/);
    expect(seen.said[0]!.review).toBeUndefined();
  });
});

describe('the skills themselves', () => {
  test('code.undo asks first; code.changes only reads', () => {
    const skills = createDevToolsSkills(diskPlatform());
    expect(skills.find((s) => s.id === 'code.undo')!.risk).toBe('confirm');
    expect(skills.find((s) => s.id === 'code.changes')!.risk).toBe('safe');
    for (const id of ['code.undo', 'code.changes']) expect(skills.find((s) => s.id === id)!.needs).toContain('devtools');
  });

  test('reviewDetail is read-only: asking for a proposal writes nothing anywhere', async () => {
    const { root } = project();
    const file = join(root, 'a.ts');
    const platform = diskPlatform();
    const skill = createDevToolsSkills(platform).find((s) => s.id === 'code.edit')!;
    const ctx: SkillContext = { say: () => {}, showResults: () => {}, confirm: async () => true };
    const payload = await skill.reviewDetail!({ path: file, find: 'sum += i', replace: 'sum -= i' }, ctx);
    expect(payload!.files[0]!.status).toBe('proposed');
    expect(readFileSync(file, 'utf8')).toBe(SOURCE);
    expect(await platform.listChanges!()).toHaveLength(0);
  });
});

describe('how to ask for the review', () => {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  const skillFor = (text: string) => g.parse(text)?.steps.map((st) => st.skill).join(',') ?? 'nothing';

  test('plain ways of asking reach code.changes', () => {
    for (const t of [
      'show me what you changed',
      'review the recent code changes',
      'what did you edit',
      'what have you changed',
      'show me the changes you made',
      'review your changes',
      'show code changes',
    ]) {
      expect(skillFor(t), t).toBe('code.changes');
    }
  });

  test('phrasings that already meant something else still mean it', () => {
    expect(skillFor('what did you change')).toBe('files.history');
    expect(skillFor('show my file changes')).toBe('files.history');
    expect(skillFor('what did i change')).toBe('git.status');
    expect(skillFor('git diff')).toBe('git.diff');
    expect(skillFor('show my changes')).not.toBe('code.changes');
  });
});
