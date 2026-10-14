import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TaskStep } from '@atlas/core';
import { stepNote } from '../src/pages/settings/Tasks';

const step = (over: Partial<TaskStep>): TaskStep => ({
  id: 's',
  skill: 'x.y',
  args: {},
  label: 'A step',
  status: 'pending',
  attempts: 0,
  safeToRepeat: true,
  ...over,
});

describe('what a step row says', () => {
  test('confirmed only where the result was read back', () => {
    expect(stepNote(step({ status: 'done', verified: 'confirmed', evidence: 'there.txt is there' }))).toBe(
      'confirmed — there.txt is there',
    );
    expect(stepNote(step({ status: 'done', verified: 'unconfirmed', evidence: 'nothing is at x' }))).toMatch(
      /^done, but not confirmed — nothing is at x/,
    );
  });

  test('a finished step with nothing to read back claims nothing', () => {
    expect(stepNote(step({ status: 'done' }))).toBeNull();
    expect(stepNote(step({ status: 'done', readOnly: true }))).toBe('read-only');
  });

  test('a step that did not finish says why, in the books’ own words', () => {
    expect(stepNote(step({ status: 'failed', error: 'It is not found.' }))).toBe('It is not found.');
    expect(stepNote(step({ status: 'blocked', reason: 'needs “A”, which did not finish' }))).toMatch(/needs “A”/);
    expect(stepNote(step({ status: 'uncertain', reason: 'was in progress when it stopped' }))).toMatch(/in progress/);
  });
});

describe('the page cannot run anything', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/pages/settings/Tasks.tsx', import.meta.url)), 'utf8');

  test('it reads the books and offers only Cancel and Resume-in-conversation', () => {
    expect(source).not.toMatch(/\.run\(|\.invoke\(|\.resume\(|platform/);
    expect(source).toMatch(/onResume/);
    expect(source).toMatch(/tasks\.cancel\(/);
  });
});
