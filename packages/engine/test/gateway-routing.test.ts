import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

function rig(opts: { local: boolean; cloudPlanning?: boolean }) {
  const asked: string[] = [];
  const provider = {
    id: 'p',
    label: 'P',
    isConfigured: () => true,
    isLocal: () => opts.local,
    ask: (prompt: string, h: { onDone(t: string): void }) => {
      asked.push(prompt);
      h.onDone('{"intent":"chat","confidence":1,"steps":[]}');
    },
  } as unknown as IntelligenceProvider;
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  const events: Array<{ route: string | null; attempts: number; result: string; steps: number }> = [];
  const engine = new Engine({
    skills: new SkillRegistry({ capabilities: () => [] }),
    grammar,
    working,
    intelligence: { register: () => {}, get: () => provider, list: () => [provider], active: () => provider, setActive: () => {} },
    ...(opts.cloudPlanning === undefined ? {} : { routing: { cloudPlanning: () => opts.cloudPlanning! } }),
  });
  engine.bus.on('gateway:plan', (p) => events.push(p as never));
  return { engine, asked, events };
}

const REQUEST = 'please tidy up the zebra situation';

describe('routing: whether a cloud model may plan', () => {
  test('on by default: a cloud model is asked, as it always was', async () => {
    const r = rig({ local: false });
    await r.engine.planFor(REQUEST);
    expect(r.asked.length).toBe(1);
  });

  test('off: a cloud model is never asked to plan, and Atlas plans on its own', async () => {
    const r = rig({ local: false, cloudPlanning: false });
    const plan = await r.engine.planFor(REQUEST);
    expect(plan).toBeNull();
    expect(r.asked).toEqual([]);
  });

  test('off does not affect a local model, whose requests stay on this PC', async () => {
    const r = rig({ local: true, cloudPlanning: false });
    await r.engine.planFor(REQUEST);
    expect(r.asked.length).toBe(1);
  });

  test('every model-planned request reports its route and how it ended, as counts only', async () => {
    const r = rig({ local: true });
    await r.engine.planFor(REQUEST);
    expect(r.events).toEqual([{ route: 'text', attempts: 1, result: 'no-steps', steps: 0 }]);
  });
});
