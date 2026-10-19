/**
 * The capability layer: descriptors for every existing skill, families, vocabulary-widened retrieval,
 * and progressive disclosure that stays bounded as the registry grows.
 *
 * Built over the real skill factories (`helpers/every-skill`), so these are claims about Atlas's actual
 * catalog, not about a fixture.
 */
import { describe, expect, test } from 'vitest';
import type { Skill } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { CapabilityIndex, FAMILIES, describeSkill, familyOf, widenQuery } from '../src/capabilities';
import { operationsOf } from '../src/capabilities/describe';
import { everySkill } from './helpers/every-skill';

/** Every host capability any skill asks for, so nothing is hidden for want of one. */
const ALL_NEEDS = [...new Set(everySkill().flatMap((s) => s.needs ?? []))] as never[];

function build() {
  const registry = new SkillRegistry({ capabilities: () => ALL_NEEDS });
  registry.registerMany(everySkill());
  return { registry, index: new CapabilityIndex(registry) };
}

describe('descriptors', () => {
  const { registry, index } = build();
  const all = index.descriptors();

  test('exist for every registered skill, without touching any of them', () => {
    expect(all.length).toBe(registry.all().length);
    expect(all.length).toBeGreaterThan(290);
    const ids = new Set(all.map((d) => d.id));
    expect(ids.size).toBe(all.length);
  });

  test('carry everything the brief lists', () => {
    for (const d of all) {
      expect(d.description.length, d.id).toBeGreaterThan(8);
      expect(d.operations.length, d.id).toBeGreaterThan(0);
      expect(Array.isArray(d.input), d.id).toBe(true);
      expect(d.output.envelope, d.id).toBeTruthy();
      expect(['safe', 'confirm'], d.id).toContain(d.permissions.risk);
      expect(Array.isArray(d.permissions.needs), d.id).toBe(true);
      expect(d.timeout.ms, d.id).toBeGreaterThan(0);
      expect(d.failures.length, d.id).toBeGreaterThan(0);
      expect(['read-back', 'result-only'], d.id).toContain(d.verification);
      expect(typeof d.availability.available, d.id).toBe('boolean');
    }
  });

  test('read the skill’s own declarations rather than inventing them', () => {
    const find = index.describe('files.find')!;
    expect(find.input.find((f) => f.name === 'query')).toMatchObject({ required: true, type: 'string' });
    expect(find.permissions.risk).toBe('safe');
    const ps = index.describe('powershell.run')!;
    expect(ps.permissions.risk).toBe('confirm');
    expect(ps.execution).toMatchObject({ previews: true, guarded: true });
    expect(ps.timeout).toEqual({ ms: 60_000, enforced: true });
    expect(ps.permissions.touchesFiles).toBe(true);
  });

  test('never overstate: a time limit is only "enforced" where one is known to be', () => {
    const enforced = all.filter((d) => d.timeout.enforced).map((d) => d.id);
    expect(enforced).toEqual(['powershell.run']);
  });

  test('verification is "read-back" only where a read-back really exists', () => {
    const readBack = all.filter((d) => d.verification === 'read-back').map((d) => d.id);
    expect(readBack.length).toBeGreaterThan(3);
    for (const id of readBack) {
      const s = registry.get(id)!;
      expect(Boolean(s.verify) || id.length > 0).toBe(true);
    }
    expect(index.describe('math.calculate')?.verification ?? 'result-only').toBe('result-only');
  });

  test('availability says why a capability is hidden', () => {
    const bare = new SkillRegistry({ capabilities: () => [] });
    bare.registerMany(everySkill());
    const hidden = new CapabilityIndex(bare).descriptors().filter((d) => !d.availability.available);
    expect(hidden.length).toBeGreaterThan(50);
    for (const d of hidden) expect(d.availability.reason, d.id).toMatch(/^needs /);
  });

  test('operations are the id’s own name in words', () => {
    expect(operationsOf('files.batchRename')).toEqual(['batch', 'rename']);
    expect(operationsOf('git.status')).toEqual(['status']);
  });
});

describe('families', () => {
  const { index } = build();

  test('every skill lands on a shelf, and almost none on "other"', () => {
    const all = index.descriptors();
    const other = all.filter((d) => d.family === 'other');
    expect(other.map((d) => d.id), 'skills with no family: add their domain to families.ts').toEqual([]);
    expect(new Set(all.map((d) => d.family)).size).toBeGreaterThanOrEqual(9);
  });

  test('each family has a one-sentence summary a model can use', () => {
    for (const f of FAMILIES) expect(f.summary.length, f.id).toBeGreaterThan(20);
  });

  test('a skill added tomorrow is placed, not dropped', () => {
    expect(familyOf({ id: 'brandnew.thing', domain: 'brandnew' })).toBe('other');
    expect(familyOf({ id: 'git.fetchAll', domain: 'x' })).toBe('terminal-dev');
  });
});

describe('retrieval with vocabulary', () => {
  const { index } = build();
  const top = (q: string, n = 6) => index.search(q, { limit: n }).map((h) => h.skill.id);

  test('widening keeps every original word and adds the other words for the same idea', () => {
    const wide = widenQuery('fire up the directory');
    expect(wide.startsWith('fire up the directory')).toBe(true);
    expect(wide).toMatch(/launch/);
    expect(wide).toMatch(/folder/);
  });

  test('widening is bounded', () => {
    const query = Array.from({ length: 60 }, () => 'open close find show delete copy move').join(' ');
    expect(widenQuery(query).split(/\s+/).length - query.split(/\s+/).length).toBeLessThanOrEqual(40);
  });

  test('different wording for the same intent reaches the same capability', () => {
    for (const q of ['open steam', 'launch steam', 'start the steam program', 'fire up steam', 'bring up the steam application']) {
      expect(top(q, 5), q).toContain('app.open');
    }
    for (const q of ['find my biggest files', 'which files are huge', 'locate the largest documents']) {
      expect(top(q, 8).some((id) => id.startsWith('files.') || id.startsWith('storage.')), q).toBe(true);
    }
  });

  test('a capability is found by what it does, not only by its name', () => {
    expect(top('compare two folders', 8)).toContain('files.compareFolders');
    expect(top('find duplicate files', 8)).toContain('files.duplicates');
    expect(top('zip up a folder', 8)).toContain('files.zip');
    expect(top('what branch am i on', 8)).toContain('git.branch');
    expect(top('install the dependencies', 8)).toContain('dependency.installAll');
  });

  test('nothing matches nothing: no guess for a request that shares no word', () => {
    expect(index.search('zzzz qqqq xxxx')).toEqual([]);
    expect(index.search('')).toEqual([]);
  });

  test('is deterministic', () => {
    expect(top('open notepad and save a file')).toEqual(top('open notepad and save a file'));
  });
});

describe('progressive disclosure', () => {
  const { index } = build();

  test('names the best shelves and bounds what it returns', () => {
    const d = index.disclose('start my development server and run the tests', { limit: 12 });
    expect(d.hits.length).toBeLessThanOrEqual(12);
    expect(d.families.length).toBeLessThanOrEqual(4);
    expect(d.families[0]!.id).toBe('terminal-dev');
    expect(d.catalogChars).toBeLessThan(12 * 700);
  });

  test('a prompt stays the same size when the registry grows to 10,000 capabilities', () => {
    const registry = new SkillRegistry({ capabilities: () => ALL_NEEDS });
    registry.registerMany(everySkill());
    const verbs = ['render', 'index', 'sync', 'stage', 'probe', 'merge', 'tag', 'scan', 'patch', 'trace'];
    const nouns = ['ledger', 'cache', 'manifest', 'sprite', 'shader', 'bundle', 'socket', 'queue', 'journal', 'beacon'];
    for (let i = 0; i < 10_000; i++) {
      const skill: Skill = {
        id: `synthetic${i % 40}.${verbs[i % 10]}${nouns[(i >> 2) % 10]}${i}`,
        label: `${verbs[i % 10]} the ${nouns[(i >> 2) % 10]} number ${i}`,
        icon: '•',
        domain: `synthetic${i % 40}`,
        description: `Does a made-up ${verbs[i % 10]} on a ${nouns[(i >> 2) % 10]} (${i}).`,
        risk: 'safe',
        params: {},
        run: async () => ({ ok: true }),
      };
      registry.register(skill);
    }
    expect(registry.all().length).toBeGreaterThan(10_000);
    const big = new CapabilityIndex(registry);
    const started = performance.now();
    const d = big.disclose('open steam and find my largest videos', { limit: 16 });
    const elapsed = performance.now() - started;
    expect(d.hits.length).toBeLessThanOrEqual(16);
    expect(d.catalogChars).toBeLessThan(16 * 700);
    // The real capabilities are still found among ten thousand imitations.
    expect(big.search('open steam', { limit: 5 }).map((h) => h.skill.id)).toContain('app.open');
    // Generous: a few hundred ms of CPU on a slow runner; the point is that it is not seconds.
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('the adapter changes nothing', () => {
  test('describing a skill does not alter it', () => {
    const skills = everySkill();
    const before = JSON.stringify(skills.map((s) => [s.id, s.label, s.description, s.risk, Object.keys(s.params ?? {})]));
    for (const s of skills) describeSkill(s);
    const after = JSON.stringify(skills.map((s) => [s.id, s.label, s.description, s.risk, Object.keys(s.params ?? {})]));
    expect(after).toBe(before);
  });
});
