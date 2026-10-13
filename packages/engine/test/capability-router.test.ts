/**
 * The capability router: deterministic, dependency-free ranking of skills for a request.
 */
import { describe, expect, test } from 'vitest';
import type { Skill } from '@atlas/core';
import { rankSkills, scoreSkills, tokenize } from '../src/skills/router';
import { SkillRegistry } from '../src/skills/registry';

function skill(id: string, label: string, description: string, examples: string[] = []): Skill {
  return { id, label, domain: id.split('.')[0]!, description, risk: 'safe', params: {}, examples, run: async () => ({ ok: true }) };
}

const CATALOG: Skill[] = [
  skill('archive.zip', 'Zip files', 'Compress files and folders into a zip archive.', ['zip my downloads']),
  skill('archive.unzip', 'Unzip', 'Extract a zip archive into a folder.', ['unzip that']),
  skill('files.createFolder', 'Create a folder', 'Create a new folder at a given path.', ['make a folder']),
  skill('git.status', 'Git status', 'Show which files changed in a git repository.', ['git status']),
  skill('system.info', 'System status', 'Show CPU, memory and disk use.', ['how is my pc doing']),
  skill('web.search', 'Search the web', 'Look something up on the internet.', ['search for cats']),
  skill('notes.add', 'Add a note', 'Save a short note.', ['note that milk is low']),
];

describe('tokenize', () => {
  test('splits ids and camelCase, drops filler, folds simple endings', () => {
    expect(tokenize('files.createFolder')).toEqual(['file', 'create', 'folder']);
    expect(tokenize('please zip the files')).toEqual(['zip', 'file']);
    expect(tokenize('folders and entries')).toEqual(['folder', 'entry']);
    expect(tokenize('zipping')).toEqual(['zip']);
  });
});

describe('ranking', () => {
  test('the skill named by the request comes first', () => {
    expect(rankSkills(CATALOG, 'zip my files')[0]!.skill.id).toBe('archive.zip');
    expect(rankSkills(CATALOG, 'make a new folder')[0]!.skill.id).toBe('files.createFolder');
    expect(rankSkills(CATALOG, 'what changed in git')[0]!.skill.id).toBe('git.status');
  });

  test('a word in the label outranks the same word in a description', () => {
    const skills = [
      skill('a.one', 'Something else', 'Also mentions the weather in passing.'),
      skill('b.two', 'Weather', 'Tells you the forecast.'),
    ];
    expect(rankSkills(skills, 'weather')[0]!.skill.id).toBe('b.two');
  });

  test('the same input always gives the same order, ties keep registration order', () => {
    const twins = [skill('x.a', 'Alpha tool', 'does the thing'), skill('x.b', 'Alpha tool', 'does the thing')];
    const first = rankSkills(twins, 'alpha').map((r) => r.skill.id);
    expect(first).toEqual(['x.a', 'x.b']);
    expect(rankSkills(twins, 'alpha').map((r) => r.skill.id)).toEqual(first);
  });

  test('no match means no result, never a guess', () => {
    expect(rankSkills(CATALOG, 'quantum gravity')).toEqual([]);
    expect(scoreSkills(CATALOG, 'quantum gravity').every((s) => s === 0)).toBe(true);
    expect(rankSkills(CATALOG, '')).toEqual([]);
  });

  test('a prefix extends a word, but a substring does not', () => {
    const skills = [skill('d.thing', 'Documents', 'Find documentation pages.')];
    expect(rankSkills(skills, 'docu')).toHaveLength(1); // a prefix of "documents"
    expect(rankSkills(skills, 'doc')).toHaveLength(0); // too short to extend
    expect(rankSkills(skills, 'ment')).toHaveLength(0); // inside the word, not its start
  });

  test('a boost reorders matches but cannot make a non-match appear', () => {
    const boosted = rankSkills(CATALOG, 'file', { boost: (s) => (s.id === 'git.status' ? 10 : 0) });
    expect(boosted[0]!.skill.id).toBe('git.status');
    const none = rankSkills(CATALOG, 'quantum', { boost: () => 100 });
    expect(none).toEqual([]);
  });

  test('limit caps the list', () => {
    expect(rankSkills(CATALOG, 'file', { limit: 1 })).toHaveLength(1);
  });

  test('a few hundred skills are ranked in a fraction of a second', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      skill(`d${i % 20}.skill${i}`, `Skill number ${i}`, `Does thing ${i} with files and folders and git ${i % 7}`, [`do ${i}`]),
    );
    const t0 = performance.now();
    rankSkills(many, 'create a folder and zip the files from git');
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('the planner catalog uses the router', () => {
  test('a trimmed catalog keeps the skills that match the request', () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    const filler = Array.from({ length: 400 }, (_, i) =>
      skill(`pad${i % 10}.s${i}`, `Padding skill ${i}`, `A deliberately long description so the whole catalog exceeds its size budget. `.repeat(3)),
    );
    registry.registerMany([...filler, skill('archive.zip', 'Zip files', 'Compress files into a zip archive.')]);
    const catalog = registry.catalog('zip these files please');
    expect(catalog).toContain('archive.zip');
  });
});
