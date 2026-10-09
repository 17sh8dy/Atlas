/**
 * The builder loop: change → check → verify → undo.
 *
 * The developer agent is a stand-in that edits a real file; what is under test is everything around it:
 * the snapshot taken first, the check after, the honest report, the history, the undo, the no-model
 * answer, and which sentences the grammar claims.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { createBuilderSkills } from '../src/skills/builder-skills';
import { createAppGrammar, parseBuilderChange, parseBuilderRevert, parseBuilderRebuild, parseBuilderPreview } from '../src/planner/app-grammar';
import { diskPlatform, makeTempProject } from './helpers/disk-platform';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const ctx = { say: () => undefined } as unknown as SkillContext;

function rig(opts: { model: boolean; agentEdits?: boolean; agentOk?: boolean }) {
  const proj = makeTempProject({
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><button id="b">Click</button><script src="app.js"></script></body></html>',
    'style.css': 'button { font-size: 12px; }',
    'app.js': 'console.log(1);',
  });
  cleanups.push(proj.cleanup);
  const platform = diskPlatform();
  const facts = new Map<string, string>();
  const memory = {
    fact: async (_k: string, s: string) => (facts.has(s) ? { value: facts.get(s)! } : undefined),
    remember: async (_k: string, s: string, v: string) => void facts.set(s, v),
  } as never;
  let cur: string | null = proj.root;
  const current = { get: async () => cur, set: async (p: string) => void (cur = p) };
  const skills = new SkillRegistry({ capabilities: () => ['devtools', 'fs', 'files'] as never });
  const goals: string[] = [];
  const agent: Skill = {
    id: 'devagent.run',
    label: 'agent',
    icon: 'x',
    domain: 'devagent',
    description: 'stand-in',
    risk: 'confirm',
    params: { goal: { type: 'string', required: true, description: 'g' }, path: { type: 'string', required: true, description: 'p' } },
    async run(args) {
      goals.push(String(args.goal));
      if (opts.agentEdits !== false) writeFileSync(join(String(args.path), 'style.css'), 'button { font-size: 24px; }');
      const ok = opts.agentOk !== false;
      return { ok, message: 'x', spoken: true, data: { verified: ok, changed: ['files.edit style.css'] } };
    },
  };
  skills.registerMany(createBuilderSkills(platform, current, memory, { skills, hasModel: () => opts.model }));
  skills.register(agent);
  const run = (id: string, args: Record<string, unknown>) => Promise.resolve(skills.get(id)!.run(args, ctx));
  return { proj, run, goals, current };
}

describe('builder.change', () => {
  test('snapshots first, changes only what was asked, checks again and says it is verified', async () => {
    const r = rig({ model: true });
    const out = await r.run('builder.change', { request: 'make the button bigger' });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(r.proj.root, 'style.css'), 'utf8')).toContain('24px');
    expect(out.message).toMatch(/Done: “make the button bigger”/);
    expect(out.message).toMatch(/Changed: files\.edit style\.css/);
    expect(out.message).toMatch(/still hangs together/);
    expect(out.message).toMatch(/build\/test passed/);
    expect(out.message).toMatch(/undo the last change/);
    expect(r.goals[0]).toMatch(/make the button bigger/);
    expect(r.goals[0]).toMatch(/ONLY this change/);
    const backups = readdirSync(join(r.proj.root, '.atlas-backup'));
    expect(backups.some((b) => b.startsWith('change-'))).toBe(true);
  });

  test('undo puts the files back byte for byte, and the history shows it', async () => {
    const r = rig({ model: true });
    await r.run('builder.change', { request: 'make the button bigger' });
    const back = await r.run('builder.revert', {});
    expect(back.ok).toBe(true);
    expect(readFileSync(join(r.proj.root, 'style.css'), 'utf8')).toBe('button { font-size: 12px; }');
    expect(back.message).toMatch(/Put back 3 files/);
    const status = await r.run('builder.status', {});
    expect(status.message).toMatch(/undone: “make the button bigger”/);
    const again = await r.run('builder.revert', {});
    expect(again.message).toMatch(/no change to undo/);
  });

  test('an agent that stops short is reported as not finished, and is not called verified', async () => {
    const r = rig({ model: true, agentOk: false });
    const out = await r.run('builder.change', { request: 'add a shop' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/didn’t finish “add a shop”/);
    expect(out.message).not.toMatch(/build\/test passed/);
    expect(out.message).toMatch(/Not verified/);
  });

  test('a project the check finds broken is not called verified, whatever the agent says', async () => {
    const r = rig({ model: true, agentEdits: false });
    writeFileSync(join(r.proj.root, 'index.html'), '<!doctype html><html><script src="gone.js"></script></html>');
    const out = await r.run('builder.change', { request: 'tidy up' });
    expect(out.message).toMatch(/project check found a problem/);
    expect(out.message).not.toMatch(/build\/test passed/);
  });

  test('no model: says so plainly, touches nothing, makes no snapshot', async () => {
    const r = rig({ model: false });
    const out = await r.run('builder.change', { request: 'make the button bigger' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/needs an AI model/);
    expect(out.error).toMatch(/recolour/);
    expect(existsSync(join(r.proj.root, '.atlas-backup'))).toBe(false);
    expect(readFileSync(join(r.proj.root, 'style.css'), 'utf8')).toContain('12px');
  });

  test('nothing built yet: asks for a project instead of guessing', async () => {
    const r = rig({ model: true });
    await r.current.set('');
    const out = await r.run('builder.change', { request: 'make it red' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Build one first/);
  });
});

describe('what the grammar claims', () => {
  test('changes to the build, by its parts or by reference', () => {
    for (const t of ['make the buttons bigger', 'add a shop to the game', 'change the title to Space Clicker', 'Now make the background darker', 'can you add a sound to my app please', 'make it faster and add a score counter'])
      expect(parseBuilderChange(t), t).not.toBeNull();
  });
  test('and leaves everything else to the other rules', () => {
    for (const t of ['make it louder', 'turn it off', 'add milk to my list', 'what is the button', 'how do I make the button bigger?', 'add a shop to D:\\Dev\\Game', 'open the app', 'put it on my desktop'])
      expect(parseBuilderChange(t), t).toBeNull();
  });
  test('undo, rebuild and preview', () => {
    expect(parseBuilderRevert('undo the last change to my game')).toBe(true);
    expect(parseBuilderRevert('undo the last change')).toBe(false);
    expect(parseBuilderRevert('undo that')).toBe(false);
    expect(parseBuilderRebuild('rebuild it')).toBe(true);
    expect(parseBuilderRebuild('build the app again')).toBe(true);
    expect(parseBuilderRebuild('build the app')).toBe(false);
    expect(parseBuilderPreview('preview it')).toBe(true);
    expect(parseBuilderPreview('show me a preview')).toBe(true);
  });
  test('the rule plans change then preview, so a failed change never opens anything', () => {
    const rule = createAppGrammar().find((r) => r.name === 'builderLoop')!;
    const p = rule.test('make the buttons bigger', 'make the buttons bigger', {} as never) as { steps: Array<{ skill: string }> };
    expect(p.steps.map((s) => s.skill)).toEqual(['builder.change', 'project.play']);
  });
});
