/**
 * Approval is for one exact operation. Anything that changes the step's details while it is being asked about
 * means the step does not run. Also: the universal agent's actions ask whatever the execution mode.
 */
import { describe, expect, test } from 'vitest';
import type { Plan, Skill, SkillContext } from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { operationSeal } from '../src/safety/operation-seal';

describe('operationSeal', () => {
  test('ignores key order and undefined, notices every real difference', () => {
    expect(operationSeal('a.b', { x: 1, y: 'p' })).toBe(operationSeal('a.b', { y: 'p', x: 1, z: undefined }));
    for (const other of [
      operationSeal('a.c', { x: 1, y: 'p' }),
      operationSeal('a.b', { x: 2, y: 'p' }),
      operationSeal('a.b', { x: 1, y: 'q' }),
      operationSeal('a.b', { x: 1, y: 'p', z: 1 }),
      operationSeal('a.b', { x: '1', y: 'p' }),
      operationSeal('a.b', { x: 1, y: { n: 'p' } }),
    ]) expect(other).not.toBe(operationSeal('a.b', { x: 1, y: 'p' }));
  });
  test('a path that differs by one character is a different operation', () => {
    expect(operationSeal('files.delete', { path: 'C:/x/a.txt' })).not.toBe(operationSeal('files.delete', { path: 'C:/x/a.txt ' }));
    expect(operationSeal('files.delete', { path: 'C:/x/a.txt' })).not.toBe(operationSeal('files.delete', { path: 'C:/x/b.txt' }));
  });
});

describe('the executor', () => {
  function rig(onConfirm: (args: Record<string, unknown>) => void) {
    const ran: Array<Record<string, unknown>> = [];
    const registry = new SkillRegistry({ capabilities: () => [] });
    const del: Skill = {
      id: 'files.delete', label: 'Delete', icon: '•', domain: 'files', description: 'Delete a file.', risk: 'confirm',
      params: { path: { type: 'string', required: true, description: 'p' } },
      async run(a) { ran.push({ ...a }); return { ok: true, message: 'deleted' }; },
    };
    registry.register(del);
    const args = { path: 'C:/x/old.txt' };
    const plan: Plan = { source: 'ai', intent: 'x', steps: [{ skill: 'files.delete', args }], confidence: 1 };
    const said: string[] = [];
    const ctx = { say: (t: string) => void said.push(t), confirm: async () => { onConfirm(args); return true; } } as unknown as SkillContext;
    return { run: () => new Executor(registry).run(plan, ctx, { mode: 'confirmActions' }), ran, said };
  }

  test('what was shown is what runs', async () => {
    const r = rig(() => {});
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.ran).toEqual([{ path: 'C:/x/old.txt' }]);
  });

  test('a change made while the card was open means the step does not run, and the person is told', async () => {
    const r = rig((args) => { args.path = 'C:/Users/me/Documents/IMPORTANT.docx'; });
    const out = await r.run();
    expect(out.ok).toBe(false);
    expect(r.ran).toEqual([]);
    expect(out.outcomes[0]!.failure).toBe('refused');
    expect(r.said.join(' ')).toMatch(/changed after you were asked/);
  });
});
