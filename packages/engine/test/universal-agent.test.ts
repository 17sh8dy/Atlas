/**
 * The universal agent: the shared loop pointed at the whole registry through the capability index.
 *
 * What has to hold: it is only OFFERED a bounded, relevant catalog; it can only RUN what it was offered
 * and what is not denied; every step still goes through the real executor (so a "no" stops it); and a
 * big registry does not make the prompt bigger.
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { CATALOG_SIZE, MAX_UNIVERSAL_ITERATIONS, runUniversalTask, vetDestructive } from '../src/universal/loop';
import { parseSolveRequest } from '../src/planner/universal-grammar';
import type { AgentDeps } from '../src/agent/loop';

function ctx(answer = true): SkillContext & { said: string[] } {
  const said: string[] = [];
  return { say: (t: string) => void said.push(t), confirm: async () => answer, said } as never;
}

function provider(next: (call: number, prompt: string) => string): IntelligenceProvider & { prompts: string[] } {
  const p = {
    id: 't', label: 'T', prompts: [] as string[], isConfigured: () => true, isLocal: () => true,
    ask(prompt: string, h: { onDone: (s: string) => void }) { p.prompts.push(prompt); h.onDone(next(p.prompts.length, prompt)); },
  };
  return p as never;
}
const registryOf = (p: IntelligenceProvider | null): IntelligenceRegistry =>
  ({ register: () => {}, get: () => p, list: () => (p ? [p] : []), active: () => p, setActive: () => {} }) as never;

const skill = (id: string, description: string, risk: 'safe' | 'confirm', ran: string[], extra: Partial<Skill> = {}): Skill => ({
  id, label: id, icon: '•', domain: id.split('.')[0]!, description, risk, params: {},
  summarize: () => id,
  async run() { ran.push(id); return { ok: true, message: `${id} finished` }; },
  ...extra,
});

function rig(replies: string[], answer = true, extra: Skill[] = []) {
  const ran: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([
    skill('app.open', 'Launch an installed application by name.', 'safe', ran),
    skill('files.find', 'Find files by name on this PC.', 'safe', ran),
    skill('storage.largest', 'List the largest files and folders on a drive.', 'safe', ran),
    skill('files.delete', 'Delete a file (moves it to the recycle bin).', 'confirm', ran),
    skill('devagent.run', 'Build or fix a project with the developer agent.', 'confirm', ran),
    skill('system.shutdownNow', 'Shut the PC down immediately.', 'confirm', ran),
    ...extra,
  ]);
  const p = provider((n) => replies[Math.min(n - 1, replies.length - 1)]!);
  const deps: AgentDeps = { skills: registry, intelligence: registryOf(p), executor: new Executor(registry), getExecutionMode: () => 'doIt' };
  return { deps, ran, p, run: (goal: string) => runUniversalTask(goal, deps, ctx(answer)) };
}

describe('what it is offered', () => {
  test('a bounded, relevant catalog, re-selected each step', async () => {
    const r = rig([
      '{"skill":"storage.largest","args":{}}',
      '{"done":true,"summary":"found them"}',
    ]);
    const report = await r.run('find the largest files on my D drive');
    expect(report.ok).toBe(true);
    expect(r.ran).toEqual(['storage.largest']);
    const first = r.p.prompts[0]!;
    expect(first).toContain('storage.largest');
    // The shutdown skill matches nothing about this goal, so it is not even shown.
    expect(first).not.toContain('system.shutdownNow');
    expect(r.p.prompts).toHaveLength(2);
  });

  test('the prompt does not grow with the registry', async () => {
    const small = rig(['{"done":true,"summary":"x"}']);
    await small.run('open steam and find my videos');
    const extra: Skill[] = [];
    const sink: string[] = [];
    for (let i = 0; i < 3000; i++) extra.push(skill(`synthetic${i % 30}.op${i}`, `Does made up thing number ${i} with a widget`, 'safe', sink));
    const big = rig(['{"done":true,"summary":"x"}'], true, extra);
    await big.run('open steam and find my videos');
    const a = small.p.prompts[0]!.length;
    const b = big.p.prompts[0]!.length;
    expect(b).toBeLessThan(a + 3000);
    const catalogLines = big.p.prompts[0]!.split('\n').filter((l) => /^[a-z0-9]+\.[A-Za-z0-9]+\(/.test(l));
    expect(catalogLines.length).toBeLessThanOrEqual(CATALOG_SIZE);
  });
});

describe('what it can run', () => {
  test('a tool that was never offered does not run, even if it exists', async () => {
    const r = rig(['{"skill":"system.shutdownNow","args":{}}', '{"done":true,"summary":"ok"}']);
    await r.run('find the largest files on my D drive');
    expect(r.ran).toEqual([]);
  });

  test('other agents are never available, however well they match', async () => {
    const r = rig(['{"skill":"devagent.run","args":{}}', '{"done":true,"summary":"ok"}']);
    await r.run('build and fix a project with the developer agent');
    expect(r.ran).toEqual([]);
    expect(r.p.prompts[0]).not.toContain('devagent.run(');
  });

  test('a step goes through the real executor: a risky step asks, and a "no" ends the task', async () => {
    const r = rig(['{"skill":"files.delete","args":{}}', '{"skill":"app.open","args":{}}'], false);
    const report = await r.run('delete the old file');
    expect(r.ran).toEqual([]);
    expect(report.stoppedBecause).toBe('declined');
  });

  test('a malformed argument is rejected by the registry, not run', async () => {
    const r = rig(['{"skill":"app.open","args":"nope"}', '{"done":true,"summary":"stopped"}']);
    await r.run('open steam');
    expect(r.ran).toEqual([]);
  });

  test('is bounded by a step budget', async () => {
    const r = rig(['{"skill":"files.find","args":{"q":"1"}}']);
    // The same call repeating is stopped as a repeated action long before the budget; vary it.
    let n = 0;
    r.p.ask = ((prompt: string, h: { onDone: (s: string) => void }) => {
      r.p.prompts.push(prompt);
      h.onDone(`{"skill":"files.find","args":{"q":"${++n}"}}`);
    }) as never;
    const report = await r.run('find files named report');
    expect(r.ran.length).toBeLessThanOrEqual(MAX_UNIVERSAL_ITERATIONS);
    expect(['budget', 'done', 'repeated-failure']).toContain(report.stoppedBecause);
  });

  test('needs a model, and says so', async () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    const report = await runUniversalTask('open steam', { skills: registry, intelligence: registryOf(null), executor: new Executor(registry), getExecutionMode: () => 'doIt' }, ctx());
    expect(report.ok).toBe(false);
    expect(report.stoppedBecause).toBe('no-provider');
  });
});

describe('the explicit phrasing', () => {
  test('only "figure out / work out" hands a goal over', () => {
    expect(parseSolveRequest('figure out how to free up space on my D drive')).toBe('free up space on my D drive');
    expect(parseSolveRequest('work out how to see what is slowing my PC')).toBe('see what is slowing my PC');
    expect(parseSolveRequest('handle this: clean up my downloads and tell me what you removed')).toMatch(/clean up my downloads/);
    for (const t of ['open steam', 'how do I free up space', 'figure', 'work out 1,250 * 3', 'figure out the tip', 'what is the capital of Peru']) expect(parseSolveRequest(t), t).toBeNull();
  });
});

describe('verification wording', () => {
  test('a general job that changed files is not told to run a build', async () => {
    const r = rig(['{"skill":"files.delete","args":{}}', '{"done":true,"summary":"removed it"}']);
    const report = await r.run('delete the old file');
    expect(report.message).not.toMatch(/Not verified|build or tests/);
    expect(report.verified).toBeUndefined();
  });
});

describe('reported, confirmed, and claimed are three different things', () => {
  const folderSkill = (ran: string[]): Skill => ({
    id: 'files.createFolder', label: 'Create a folder', icon: '•', domain: 'files', description: 'Create a new folder at a path.', risk: 'safe',
    params: { path: { type: 'string', required: true, description: 'where' } },
    async run(a) { ran.push(String(a.path)); return { ok: true, message: 'Created.' }; },
  });
  const probeAlways = (state: 'confirmed' | 'contradicted') => async (specs: readonly { kind: string }[]) =>
    specs.map((probe) => ({ probe, state, evidence: state === 'confirmed' ? 'the folder is there' : 'the folder is not there' })) as never;

  async function runWith(replies: string[], goal: string, verifyState: 'confirmed' | 'contradicted' | null) {
    const ran: string[] = [];
    const r = rig(replies, true, [folderSkill(ran)]);
    const deps = { ...r.deps, ...(verifyState ? { verify: probeAlways(verifyState) } : {}) };
    return { report: await runUniversalTask(goal, deps, ctx()), ran };
  }

  test('confirmed: a read-back saw the effect', async () => {
    const { report } = await runWith(['{"skill":"files.createFolder","args":{"path":"C:/x/reports"}}', '{"done":true,"summary":"ok"}'], 'create a folder called reports in C:/x', 'confirmed');
    expect(report.message).toMatch(/Done, and Atlas confirmed it/);
    expect(report.message).toMatch(/Confirmed by Atlas: files\.createFolder/);
    expect(report.steps[0]!.verified).toBe('confirmed');
  });

  test('reported only: the tool said ok and Atlas could not check', async () => {
    const { report } = await runWith(['{"skill":"files.createFolder","args":{"path":"C:/x/reports"}}', '{"done":true,"summary":"ok"}'], 'create a folder called reports in C:/x', null);
    expect(report.message).toMatch(/could not independently confirm/);
    expect(report.message).not.toMatch(/Atlas confirmed it/);
    expect(report.message).toMatch(/Reported done by the tool/);
  });

  test('a read-back that finds nothing is not described as done', async () => {
    const { report } = await runWith(['{"skill":"files.createFolder","args":{"path":"C:/x/reports"}}', '{"done":true,"summary":"ok"}'], 'create a folder called reports in C:/x', 'contradicted');
    expect(report.message).not.toMatch(/Atlas confirmed it/);
  });

  test('the model claim is labelled and never stands in for the record', async () => {
    const { report } = await runWith(['{"skill":"files.createFolder","args":{"path":"C:/x/reports"}}', '{"done":true,"summary":"I created it and moved big.log too."}'], 'create a folder called reports in C:/x and then move big.log into it', null);
    expect(report.message).toMatch(/Only part of this was done/);
    expect(report.message).toMatch(/Not done: .*move big\.log into it/);
    expect(report.message).toMatch(/The model's own summary \(Atlas did not check this\)/);
  });

  test('"done" with a part uncovered is sent back, and the model can finish the job', async () => {
    const ran: string[] = [];
    const move: Skill = { id: 'files.move', label: 'Move', icon: '•', domain: 'files', description: 'Move a file into a folder.', risk: 'safe', params: { path: { type: 'string', required: true, description: 'p' }, destDir: { type: 'string', required: true, description: 'd' } }, async run() { ran.push('move'); return { ok: true, message: 'moved' }; } };
    const r = rig(
      ['{"skill":"files.createFolder","args":{"path":"C:/x/reports"}}', '{"done":true,"summary":"all done"}', '{"skill":"files.move","args":{"path":"C:/x/big.log","destDir":"C:/x/reports"}}', '{"done":true,"summary":"now really done"}'],
      true,
      [folderSkill(ran), move],
    );
    const report = await runUniversalTask('create a folder called reports in C:/x and then move big.log into it', r.deps, ctx());
    expect(ran).toContain('move');
    expect(report.message).not.toMatch(/Not done/);
    // Atlas told the model what was missing:
    expect(r.p.prompts.join(' ')).toMatch(/Atlas checked your "done"/);
  });

  test('a model that keeps claiming done is challenged at most twice, then the report says what is missing', async () => {
    const r = rig(['{"skill":"files.createFolder","args":{"path":"C:/x/reports"}}', '{"done":true,"summary":"done"}'], true, [folderSkill([])]);
    const report = await runUniversalTask('create a folder called reports in C:/x and then move big.log into it', r.deps, ctx());
    expect(r.p.prompts.filter((q) => /Atlas checked your "done"/.test(q)).length).toBeLessThanOrEqual(2);
    expect(report.message).toMatch(/Not done: .*move big\.log into it/);
  });

  test('retry limit: repeated failures stop the task and the report says so', async () => {
    const failing: Skill = { id: 'files.createFolder', label: 'Create', icon: '•', domain: 'files', description: 'Create a new folder at a path.', risk: 'safe', params: { path: { type: 'string', required: true, description: 'p' } }, async run(a) { return { ok: false, error: `cannot make ${String(a.path)} number ${Math.random()}` }; } };
    let n = 0;
    const r = rig([], true, [failing]);
    r.p.ask = ((prompt: string, h: { onDone: (s: string) => void }) => { r.p.prompts.push(prompt); h.onDone(`{"skill":"files.createFolder","args":{"path":"C:/x/f${++n}"}}`); }) as never;
    const report = await runUniversalTask('create a folder called reports in C:/x', r.deps, ctx());
    expect(report.stoppedBecause).toBe('repeated-failure');
    expect(n).toBeLessThanOrEqual(4);
    expect(report.message).toMatch(/Nothing was done/);
  });
});

describe('destructive actions must be what was asked', () => {
  const cleanup: Skill = {
    id: 'cleanup.clean', label: 'Clean up temp files, crash dumps or old installers', icon: '•', domain: 'files',
    description: 'Remove old temp files or crash dumps for good, or old installers.', risk: 'safe',
    params: { kind: { type: 'string', required: true, enum: ['temp', 'crashdumps', 'installers'], description: 'which' } },
    async run() { return { ok: true, message: 'cleaned' }; },
  };

  test('"delete the old log files" is not answered with a temp-file cleanup', async () => {
    const ran: string[] = [];
    const r = rig(['{"skill":"cleanup.clean","args":{"kind":"temp"}}', '{"done":true,"summary":"nothing fits"}'], true, [{ ...cleanup, async run() { ran.push('cleanup'); return { ok: true }; } }]);
    const report = await r.run('delete the old log files in my downloads');
    expect(ran).toEqual([]);
    expect(report.refused.join(' ')).toMatch(/never mentions "temp"/);
  });

  test('"clean my temp files" may use it', async () => {
    const ran: string[] = [];
    const r = rig(['{"skill":"cleanup.clean","args":{"kind":"temp"}}', '{"done":true,"summary":"ok"}'], true, [{ ...cleanup, async run() { ran.push('cleanup'); return { ok: true }; } }]);
    await r.run('clean out my temp files');
    expect(ran).toEqual(['cleanup']);
  });
});

describe('a path is not part of what was asked', () => {
  test('a folder called Temp in the path does not ground a temp-file cleanup', () => {
    const skill = { id: 'cleanup.clean', risk: 'safe', params: { kind: { type: 'string', enum: ['temp', 'crashdumps', 'installers'] } } } as unknown as Skill;
    const goal = 'delete all the old log files in C:\\Users\\me\\AppData\\Local\\Temp\\work and then show me what is left';
    expect(vetDestructive(skill, { kind: 'temp' }, goal)).toMatch(/never mentions "temp"/);
    expect(vetDestructive(skill, { kind: 'temp' }, 'clean up my temp files in C:/x')).toBeNull();
  });
});

describe('local-model compatibility: structured replies', () => {
  test('a model that can be held to a schema is held to it; one that cannot is asked as before', async () => {
    for (const [support, expectSchema] of [['yes', true], ['unknown', false], ['no', false]] as const) {
      const seen: Array<Record<string, unknown> | undefined> = [];
      const r = rig(['{"done":true,"summary":"x"}']);
      const p = r.p as unknown as { capabilities: () => unknown; ask: (...a: unknown[]) => void };
      p.capabilities = () => ({ structuredOutput: support, conversation: 'yes', toolCalling: 'unknown', longContext: 'unknown', vision: 'unknown', coding: 'unknown', source: 'reported' });
      const original = p.ask.bind(p);
      p.ask = (prompt: unknown, h: unknown, opts: unknown) => { seen.push((opts as { responseSchema?: Record<string, unknown> } | undefined)?.responseSchema); original(prompt, h, opts); };
      await r.run('find the largest files in C:/x');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => (expectSchema ? Array.isArray(s?.anyOf) : s === undefined)), support).toBe(true);
    }
  });
});

describe('a model that cannot produce a usable action', () => {
  test('four unusable replies in a row end the task instead of burning every step', async () => {
    const r = rig([]);
    let n = 0;
    r.p.ask = ((prompt: string, h: { onDone: (s: string) => void }) => { r.p.prompts.push(prompt); n += 1; h.onDone('{"skill":"files.createFolder","summary":"no args at all"}'); }) as never;
    const report = await runUniversalTask('create a folder called reports in C:/x', r.deps, ctx());
    expect(n).toBeLessThanOrEqual(5);
    expect(report.stoppedBecause).toBe('malformed');
    expect(report.message).toMatch(/Nothing was done/);
  });

  test('the reply schema demands args for an action and a summary for done', async () => {
    const { AGENT_REPLY_SCHEMA } = await import('../src/agent/loop');
    const shapes = (AGENT_REPLY_SCHEMA as { anyOf: Array<{ required: string[] }> }).anyOf;
    expect(shapes.map((s) => s.required)).toEqual([['done', 'summary'], ['skill', 'args']]);
  });
});
