/**
 * The phrasings for tasks, tested through the whole grammar — the way a typed sentence reaches
 * them — not just the rule in isolation.
 */
import { describe, expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';

function parse(text: string) {
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  grammar.addMany(createExtraGrammar(working));
  return grammar.parse(text);
}

describe('running a recipe', () => {
  test.each([
    ['run the pc-checkup task', { recipe: 'pc-checkup' }],
    ['run the pc checkup task', { recipe: 'pc-checkup' }],
    ['please run the pc check-up task', { recipe: 'pc-checkup' }],
    ['run the space review task on Downloads', { recipe: 'space-review', path: 'Downloads' }],
    ['run the space-review task for D:\\Dev', { recipe: 'space-review', path: 'D:\\Dev' }],
    ['run the project status task in D:\\Dev\\Atlas', { recipe: 'project-status', path: 'D:\\Dev\\Atlas' }],
  ])('“%s”', (text, args) => {
    const p = parse(text);
    expect(p?.steps).toHaveLength(1);
    expect(p!.steps[0]!.skill).toBe('task.run');
    expect(p!.steps[0]!.args).toEqual(args);
  });

  test('a made-up recipe is not claimed by this rule', () => {
    const p = parse('run the world domination task');
    expect(p?.steps[0]?.skill).not.toBe('task.run');
  });

  test('ordinary talk about tasks is left alone', () => {
    expect(parse('what is a task')?.steps[0]?.skill).not.toBe('task.run');
  });
});

describe('looking after a task', () => {
  test.each([
    ['show my tasks', 'task.list'],
    ['list recent tasks', 'task.list'],
    ['resume the task', 'task.resume'],
    ['resume the stopped task', 'task.resume'],
    ['cancel the task', 'task.cancel'],
    ['cancel the running task', 'task.cancel'],
  ])('“%s” → %s', (text, skill) => {
    expect(parse(text)?.steps[0]?.skill).toBe(skill);
  });

  test('workflow phrasings still go to workflows', () => {
    expect(parse('resume the workflow')?.steps[0]?.skill).toBe('workflow.resume');
    expect(parse('show my workflow history')?.steps[0]?.skill).toBe('workflow.history');
  });
});
