/**
 * Engine tests — run against a scripted Platform, so they exercise the real
 * registry, grammar, executor and kernel without touching the machine.
 */

import { test, assert } from 'vitest';

import type { CapabilityName, Platform, ResultRow } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createCoreGrammar } from '../src/planner/core-grammar';

// ---- a machine we can script ------------------------------------------------

interface Journal {
  opened: string[];
  revealed: string[];
  launched: string[];
  urls: string[];
  hidden: number;
}

function makePlatform(capabilities: CapabilityName[], journal: Journal): Platform {
  return {
    id: 'test',
    capabilities: async () => capabilities,
    searchFiles: async (query) =>
      query.includes('tax')
        ? [{ path: 'D:\\Docs\\tax-2025.pdf', name: 'tax-2025.pdf', ext: 'pdf', isDirectory: false }]
        : [],
    openPath: async (p) => {
      journal.opened.push(p);
      return true;
    },
    revealPath: async (p) => {
      journal.revealed.push(p);
      return true;
    },
    openUrl: async (u) => {
      journal.urls.push(u);
      return true;
    },
    listApps: async () => [
      { id: 'steam', name: 'Steam', target: 'steam.exe' },
      { id: 'code', name: 'Visual Studio Code', target: 'code.exe' },
      { id: 'code-insiders', name: 'Visual Studio Code Insiders', target: 'code-insiders.exe' },
    ],
    launchApp: async (id) => {
      journal.launched.push(id);
      return true;
    },
    systemInfo: async () => ({
      cpuPercent: 12,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 32 * 1024 ** 3,
      disks: [{ mount: 'C:', usedBytes: 400 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3 }],
      uptimeSeconds: 3600,
    }),
    writeClipboard: async () => true,
    hideWindow: async () => {
      journal.hidden += 1;
    },
  };
}

interface Harness {
  engine: Engine;
  said: string[];
  rows: ResultRow[];
  journal: Journal;
  confirmAnswer: boolean;
  confirmsAsked: string[];
}

function harness(capabilities: CapabilityName[] = ['files', 'fs', 'apps', 'system', 'clipboard', 'windows']): Harness {
  const journal: Journal = { opened: [], revealed: [], launched: [], urls: [], hidden: 0 };
  const platform = makePlatform(capabilities, journal);

  const skills = new SkillRegistry({ capabilities: () => capabilities });
  skills.registerMany(createCoreSkills(platform));

  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar());

  const h: Harness = {
    engine: new Engine({ skills, grammar }),
    said: [],
    rows: [],
    journal,
    confirmAnswer: true,
    confirmsAsked: [],
  };
  return h;
}

function io(h: Harness) {
  return {
    say: (t: string) => h.said.push(t),
    confirm: async (q: string) => {
      h.confirmsAsked.push(q);
      return h.confirmAnswer;
    },
    showResults: (items: ResultRow[]) => h.rows.push(...items),
  };
}

// ---- grammar ----------------------------------------------------------------

test('grammar: recognises an app launch', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open steam');
  assert.equal(p?.steps[0].skill, 'app.open');
  assert.equal(p?.steps[0].args.name, 'steam');
});

test('grammar: a file path is not an app launch', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open C:\\Users\\me\\tax-notes.txt');
  assert.equal(p?.steps[0].skill, 'files.open');
  assert.equal(p?.steps[0].args.path, 'C:\\Users\\me\\tax-notes.txt');
});

test('grammar: file searches beat app launches', () => {
  const h = harness();
  const p = h.engine.grammar.parse('find my tax pdf');
  assert.equal(p?.steps[0].skill, 'files.find');
  assert.equal(p?.steps[0].args.kind, 'document');
  assert.equal(p?.steps[0].args.query, 'tax');
});

test('grammar: referential targets are declined', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('open it'), null);
  assert.equal(h.engine.grammar.parse('open that'), null);
});

test('grammar: questions do not become commands', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('what is the capital of Peru?'), null);
  assert.equal(h.engine.grammar.parse('who invented the telescope'), null);
});

test('grammar: a question-safe rule may still answer', () => {
  const h = harness();
  const p = h.engine.grammar.parse('how much memory am I using?');
  assert.equal(p?.steps[0].skill, 'system.info');
});

test('grammar: bare urls are normalised to https', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open github.com');
  assert.equal(p?.steps[0].args.url, 'https://github.com');
});

test('triage: questions are not actionable', () => {
  const h = harness();
  assert.equal(h.engine.grammar.looksActionable('what is a black hole?'), false);
  assert.equal(h.engine.grammar.looksActionable('open the report'), true);
});

// ---- registry ---------------------------------------------------------------

test('registry: unknown skills are refused', () => {
  const h = harness();
  const r = h.engine.skills.validate('does.notExist', {});
  assert.equal(r.ok, false);
});

test('registry: missing required args are refused', () => {
  const h = harness();
  const r = h.engine.skills.validate('app.open', {});
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /needs/);
});

test('registry: args are coerced against the declared type', () => {
  const h = harness();
  const r = h.engine.skills.validate('files.find', { query: 'tax', limit: '5' });
  assert.equal(r.ok, true);
  assert.equal((r as { args: Record<string, unknown> }).args.limit, 5);
});

test('registry: undeclared args are dropped, not passed through', () => {
  const h = harness();
  const r = h.engine.skills.validate('app.open', { name: 'steam', sneaky: 'rm -rf' });
  assert.equal(r.ok, true);
  assert.equal((r as { args: Record<string, unknown> }).args.sneaky, undefined);
});

test('registry: skills needing an absent capability are hidden', () => {
  const withApps = harness(['apps']);
  const without = harness(['files']);
  assert.ok(withApps.engine.skills.available().some((s) => s.id === 'app.open'));
  assert.ok(!without.engine.skills.available().some((s) => s.id === 'app.open'));
});

test('registry: the AI catalog only lists available skills', () => {
  const h = harness(['files']);
  const catalog = h.engine.skills.catalog();
  assert.ok(catalog.includes('files.find'));
  assert.ok(!catalog.includes('app.open'));
});

// ---- executor ----------------------------------------------------------------

test('executor: a safe skill runs without asking', async () => {
  const h = harness();
  await h.engine.ask('how much memory am I using?', io(h));
  assert.equal(h.confirmsAsked.length, 0);
  assert.match(h.said.join(' '), /CPU 12%/);
});

test('executor: a risky skill asks first', async () => {
  const h = harness();
  await h.engine.ask('open steam', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.launched, ['steam']);
});

test('executor: declining means nothing happens', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('open steam', io(h));
  assert.deepEqual(h.journal.launched, []);
  assert.match(h.said.join(' '), /left alone/i);
});

test('executor: a declined step aborts the rest of the plan', async () => {
  const h = harness();
  h.confirmAnswer = false;
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'app.open', args: { name: 'steam' } },
        { skill: 'files.open', args: { path: 'D:\\a.txt' } },
      ],
    },
    io(h),
  );
  assert.equal(outcome.aborted, true);
  assert.equal(h.journal.opened.length, 0);
});

test('executor: a failing step stops the ones after it', async () => {
  const h = harness();
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'web.open', args: { url: 'ftp://nope' } },
        { skill: 'app.open', args: { name: 'steam' } },
      ],
    },
    io(h),
  );
  assert.equal(outcome.aborted, true);
  assert.deepEqual(h.journal.launched, []);
});

test('executor: a multi-step plan announces itself first', async () => {
  const h = harness();
  await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'system.info', args: {} },
        { skill: 'app.list', args: {} },
      ],
    },
    io(h),
  );
  assert.match(h.said[0], /^Right — .*, then /);
});

// ---- skills ------------------------------------------------------------------

test('app.open prefers an exact name over a longer substring match', async () => {
  const h = harness();
  await h.engine.ask('open visual studio code', io(h));
  assert.deepEqual(h.journal.launched, ['code']);
});

test('web.open refuses a non-http scheme', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('web.open', { url: 'file:///etc/passwd' }, {
    say: () => {},
    confirm: async () => true,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(h.journal.urls, []);
});

test('files.find renders actionable rows', async () => {
  const h = harness();
  await h.engine.ask('find my tax pdf', io(h));
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].title, 'tax-2025.pdf');
  assert.equal(h.rows[0].actions?.[0].skill, 'files.open');
});

test('files.find says so plainly when there is nothing', async () => {
  const h = harness();
  await h.engine.ask('find my holiday photos', io(h));
  assert.match(h.said.join(' '), /Nothing named like/);
});

// ---- conversation ---------------------------------------------------------------

test('with no provider, a question leads with what still works', async () => {
  const h = harness();
  await h.engine.ask('what is the capital of Peru?', io(h));
  const said = h.said.join(' ');
  assert.match(said, /optional and off by default/);
  assert.match(said, /Everything else works/);
  assert.match(said, /\d+ actions/);
});

test('a crashing skill is contained, not fatal', async () => {
  const h = harness();
  h.engine.skills.register({
    id: 'test.explode',
    label: 'Explode',
    domain: 'test',
    description: 'Throws.',
    params: {},
    run() {
      throw new Error('boom');
    },
  });
  const r = await h.engine.skills.invoke('test.explode', {}, { say: () => {}, confirm: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.error!, /boom/);
});
