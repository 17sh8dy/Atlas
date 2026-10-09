import { expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';

const g = new Grammar();
g.addMany(createCoreGrammar(new WorkingMemory()));
g.addMany(createExtraGrammar());
const route = (text: string) => {
  const p = g.parse(text);
  return p ? { skill: p.steps[0]!.skill, args: p.steps[0]!.args } : null;
};

test('documentation phrasings reach docs.research / docs.read / docs.notes, with the library when it is named', () => {
  expect(route('research how to use fetch with an abort signal in the docs')).toEqual({ skill: 'docs.research', args: { question: 'how to use fetch with an abort signal' } });
  expect(route('look up the vite config option for base path in the vite docs')).toEqual({ skill: 'docs.research', args: { question: 'the vite config option for base path', library: 'vite' } });
  expect(route('read the vite docs about base path')).toEqual({ skill: 'docs.research', args: { question: 'base path', library: 'vite' } });
  expect(route('what do the react docs say about useEffect cleanup')).toEqual({ skill: 'docs.research', args: { question: 'useEffect cleanup', library: 'react' } });
  expect(route('read the docs page https://vite.dev/config/ about base')).toEqual({ skill: 'docs.read', args: { url: 'https://vite.dev/config/', focus: 'base' } });
  expect(route('show my research notes')?.skill).toBe('docs.notes');
});

test('ordinary web questions keep their own tools', () => {
  expect(route('research the best budget laptop')?.skill).toBe('research.search');
  expect(route('search the web for tide times')?.skill).toBe('research.search');
  expect(route('look up pizza places near me')?.skill).toBe('web.search');
});

test('a documentation request that names a local path or carries a file is not turned into a web search about it', () => {
  expect(route('look up the error in C:\\Users\\Brandon\\proj\\app.ts in the docs')?.skill).not.toBe('docs.research');
});
