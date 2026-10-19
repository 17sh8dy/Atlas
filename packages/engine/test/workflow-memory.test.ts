/**
 * Workflow memory: what may be saved, what is refused, and that replay is ordinary execution.
 */
import { describe, expect, test } from 'vitest';
import type { Plan, PlanStep, Skill, SkillContext, Storage } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { parseRemember } from '../src/planner/workflow-memory-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { createWorkflowMemorySkills } from '../src/skills/workflow-memory-skills';
import { MAX_STEPS, WorkflowMemory, secretIn, validateSteps, workflowKey } from '../src/workflow/memory';
import { WorkingMemory } from '../src/working-memory';
import { understand } from './helpers/chain';

function memoryStorage(): Storage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    set: async (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))),
    remove: async (k: string) => void data.delete(k),
  };
}

const step = (skill: string, args: Record<string, unknown> = {}): PlanStep => ({ skill, args }) as PlanStep;

describe('what is never stored', () => {
  test('credentials by field name or by shape', () => {
    expect(secretIn([step('x', { password: 'hunter2' })])).toMatch(/credential field/);
    expect(secretIn([step('x', { apiKey: 'abc' })])).toMatch(/credential field/);
    expect(secretIn([step('x', { nested: { token: 'abc' } })])).toMatch(/credential field/);
    expect(secretIn([step('x', { script: 'curl -H "Authorization: Bearer abcdefghijklmnop"' })])).toBeNull; // header text alone is not a shape we claim
    expect(secretIn([step('x', { text: 'sk-abcdefghijklmnopqrstuvwx' })])).toMatch(/looks like/);
    expect(secretIn([step('x', { text: 'ghp_abcdefghijklmnopqrstuvwxyz0123' })])).toMatch(/looks like/);
    expect(secretIn([step('x', { script: '$env:X = 1; password=hunter2' })])).toMatch(/looks like/);
    expect(secretIn([step('x', { text: '4111 1111 1111 1111' })])).toMatch(/looks like/);
  });

  test('ordinary steps pass', () => {
    expect(secretIn([step('app.open', { name: 'steam' }), step('terminal.open', { script: 'npm run dev', cwd: 'D:/Dev/App' })])).toBeNull();
    // An empty credential field is not a credential.
    expect(secretIn([step('x', { token: '' })])).toBeNull();
  });

  test('the message never repeats the secret', () => {
    const r = validateSteps([step('x', { password: 'hunter2hunter2' })], () => true);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('validateSteps', () => {
  const known = (id: string) => ['app.open', 'terminal.open', 'workflow.replay'].includes(id);
  test('refuses empty, too long, unknown and self-referencing', () => {
    expect(validateSteps([], known).ok).toBe(false);
    expect(validateSteps(Array.from({ length: MAX_STEPS + 1 }, () => step('app.open')), known).ok).toBe(false);
    expect(validateSteps([step('nope.nothing')], known).ok).toBe(false);
    expect(validateSteps([step('workflow.replay', { name: 'x' })], known).ok).toBe(false);
    expect(validateSteps([step('app.open', { name: 'steam' })], known).ok).toBe(true);
  });
});

describe('the store', () => {
  test('saves, finds by the name a person uses, survives a reload, forgets', async () => {
    const storage = memoryStorage();
    const m = new WorkflowMemory(storage, () => 1000);
    expect((await m.save('My Morning Routine!', [step('app.open', { name: 'spotify' })])).ok).toBe(true);
    expect(m.get('morning routine')?.name).toBe('morning');
    expect(workflowKey('The Deploy Workflow')).toBe('deploy');
    const again = new WorkflowMemory(storage);
    await again.load();
    expect(again.names()).toEqual(['morning']);
    expect((await again.remove('my morning routine'))?.name).toBe('morning');
    expect(again.all()).toEqual([]);
  });

  test('overwriting keeps one entry and a nameless save is refused', async () => {
    const m = new WorkflowMemory(memoryStorage());
    await m.save('alpha', [step('app.open')]);
    await m.save('alpha', [step('app.open'), step('app.close')]);
    expect(m.all()).toHaveLength(1);
    expect(m.all()[0]!.steps).toHaveLength(2);
    expect((await m.save('!!!', [step('app.open')])).ok).toBe(false);
  });
});

describe('the skills', () => {
  function rig(confirmAnswer = true) {
    const ran: string[] = [];
    const registry = new SkillRegistry({ capabilities: () => [] });
    const open: Skill = {
      id: 'app.open', label: 'Open an app', icon: '•', domain: 'apps', description: 'Launch an app.', risk: 'safe',
      params: { name: { type: 'string', required: true, description: 'app' } },
      async run(args) { ran.push(`open:${String(args.name)}`); return { ok: true, message: 'ok' }; },
    };
    const risky: Skill = {
      id: 'thing.risky', label: 'Risky thing', icon: '•', domain: 'x', description: 'Needs a yes.', risk: 'confirm',
      params: {},
      summarize: () => 'do the risky thing',
      async run() { ran.push('risky'); return { ok: true, message: 'ok' }; },
    };
    registry.registerMany([open, risky]);
    const memory = new WorkflowMemory(memoryStorage());
    let last: Plan | null = null;
    const confirmed: string[] = [];
    const skills = createWorkflowMemorySkills({
      memory, skills: registry, getExecutionMode: () => 'confirmActions',
      planFor: async (t) => (t.includes('nothing') ? null : { source: 'grammar', intent: 'x', steps: [step('app.open', { name: 'steam' }), step('thing.risky')], confidence: 1 }),
      lastPlan: () => last,
    });
    const by = (id: string) => skills.find((s) => s.id === id)!;
    const ctx = (answer = confirmAnswer) => ({ confirm: async (q: string) => { confirmed.push(q); return answer; }, say: () => {}, approvedPreview: undefined }) as unknown as SkillContext;
    return { by, ctx, ran, memory, confirmed, setLast: (p: Plan) => void (last = p) };
  }

  test('remember shows the steps, and saving runs nothing', async () => {
    const r = rig();
    const out = await r.by('workflow.remember').run({ name: 'morning', then: 'open steam and do the risky thing' }, r.ctx());
    expect(out.ok).toBe(true);
    expect(r.ran).toEqual([]);
    expect(r.confirmed[0]).toMatch(/Save "morning"/);
    expect(r.memory.names()).toEqual(['morning']);
  });

  test('declining saves nothing', async () => {
    const r = rig(false);
    expect((await r.by('workflow.remember').run({ name: 'morning', then: 'open steam' }, r.ctx(false))).ok).toBe(false);
    expect(r.memory.all()).toEqual([]);
  });

  test('"remember that" uses the last plan, and says so when there is none', async () => {
    const r = rig();
    expect((await r.by('workflow.remember').run({ name: 'x' }, r.ctx())).error).toMatch(/haven't done anything/);
    r.setLast({ source: 'grammar', intent: 'x', steps: [step('app.open', { name: 'obs' })], confidence: 1 });
    expect((await r.by('workflow.remember').run({ name: 'x' }, r.ctx())).ok).toBe(true);
    expect(r.memory.get('x')!.steps[0]!.args).toEqual({ name: 'obs' });
  });

  test('a credential in the steps is refused and nothing is stored', async () => {
    const r = rig();
    r.setLast({ source: 'grammar', intent: 'x', steps: [step('app.open', { name: 'obs', password: 'hunter2' })], confidence: 1 });
    const out = await r.by('workflow.remember').run({ name: 'leaky' }, r.ctx());
    expect(out.ok).toBe(false);
    expect(r.memory.all()).toEqual([]);
    expect(r.confirmed).toEqual([]);
  });

  test('replay goes through the executor: a risky step asks again, and a no stops the rest', async () => {
    const r = rig();
    await r.by('workflow.remember').run({ name: 'morning', then: 'open steam and do the risky thing' }, r.ctx());
    r.confirmed.length = 0;
    const out = await r.by('workflow.replay').run({ name: 'my morning workflow' }, r.ctx(false));
    expect(r.ran).toEqual(['open:steam']);
    expect(r.confirmed.length).toBeGreaterThan(0);
    expect(out.ok).toBe(false);
    const yes = await r.by('workflow.replay').run({ name: 'morning' }, r.ctx(true));
    expect(r.ran).toContain('risky');
    expect(yes.ok).toBe(true);
    expect(r.memory.get('morning')!.runs).toBe(2);
  });

  test('replay re-checks the registry: a removed skill is reported, not guessed', async () => {
    const r = rig();
    await r.memory.save('old', [step('gone.skill')]);
    const out = await r.by('workflow.replay').run({ name: 'old' }, r.ctx());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/can't run now/);
  });

  test('an unknown name lists what exists', async () => {
    const r = rig();
    await r.memory.save('alpha', [step('app.open', { name: 'x' })]);
    expect((await r.by('workflow.replay').run({ name: 'zeta' }, r.ctx())).error).toMatch(/alpha/);
  });
});

describe('phrasing', () => {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  const first = (t: string) => understand(g, t).plan?.steps[0];

  test('remember / replay / list / forget', () => {
    expect(first('remember that as my morning routine')).toMatchObject({ skill: 'workflow.remember', args: { name: 'morning routine' } });
    expect(first('save a workflow called deploy: run npm test then open the site')).toMatchObject({ skill: 'workflow.remember', args: { name: 'deploy', then: 'run npm test then open the site' } });
    expect(first('run my morning workflow')).toMatchObject({ skill: 'workflow.replay', args: { name: 'morning' } });
    expect(first('what workflows have I saved')?.skill).toBe('workflow.saved');
    expect(first('forget my morning workflow')).toMatchObject({ skill: 'workflow.forget' });
  });

  test('ordinary requests are not taken for workflows', () => {
    for (const t of ['run the tests', 'save the file', 'open steam', 'remember to buy milk', 'what did you just do']) {
      expect(first(t)?.skill ?? '', t).not.toMatch(/^workflow\.(remember|replay|saved|forget)$/);
    }
    expect(parseRemember('remember to buy milk')).toBeNull();
  });
});

describe('saved workflow labels', () => {
  test('show what a step does, without raw flags or repeated values', async () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    registry.register({ id: 'terminal.open', label: 'Open a terminal and run something', icon: '•', domain: 'terminal', description: 'x', risk: 'safe', params: {}, async run() { return { ok: true }; } } as Skill);
    const memory = new WorkflowMemory(memoryStorage());
    await memory.save('echo test', [step('terminal.open', { script: 'echo hi', watch: true, title: 'echo hi' })]);
    const skills = createWorkflowMemorySkills({ memory, skills: registry, getExecutionMode: () => 'doIt', planFor: async () => null, lastPlan: () => null });
    const out = await skills.find((s) => s.id === 'workflow.saved')!.run({}, { say() {}, confirm: async () => true } as never);
    expect(out.message).toContain('Open a terminal and run something — echo hi');
    expect(out.message).not.toContain('true');
    expect(out.message).not.toContain('echo hi · echo hi');
  });
});
