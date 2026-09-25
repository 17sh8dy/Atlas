/**
 * The 1.0.3 phrasings — Brandon's own sentences first — reach the right skill
 * with no model connected, and the look-alikes they must not steal still go
 * where they went before.
 */

import { expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';

function grammar() {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

const g = grammar();
const first = (text: string) => {
  const p = g.parse(text);
  return p ? { skill: p.steps[0]!.skill, args: p.steps[0]!.args, n: p.steps.length } : null;
};

test.each([
  ['Watch this download.', 'watch.create', { when: 'this download finishes', then: '' }],
  ['Let me know when this finishes.', 'watch.create', { when: 'this finishes', then: '' }],
  [
    'Monitor this process and continue when it’s done',
    'watch.create',
    { when: 'this process finishes', then: '' },
  ],
  [
    'When this build finishes, run the tests, package it, and open the result.',
    'watch.create',
    { when: 'this build finishes', then: 'run the tests, package it, and open the result' },
  ],
  ['let me know when OBS closes', 'watch.create', { when: 'OBS closes', then: '' }],
  ['tell me when I’m back online', 'watch.create', { when: 'I’m back online', then: '' }],
  [
    'once Fortnite starts, put discord on the left',
    'watch.create',
    { when: 'Fortnite starts', then: 'put discord on the left' },
  ],
  ['in 20 minutes, open Spotify', 'watch.create', { when: '20 minutes', then: 'open Spotify' }],
  ['keep an eye on OBS', 'watch.create', { when: 'OBS finishes', then: '' }],
] as const)('%s → %s', (text, skill, args) => {
  const got = first(text);
  expect(got?.skill).toBe(skill);
  expect(got?.args).toMatchObject(args);
});

test.each([
  ['Atlas, get my PC ready for recording.', { name: 'recording' }],
  ['get ready to stream', { name: 'stream' }],
  ['prepare my pc for work', { name: 'work' }],
  ['run my morning routine', { name: 'morning' }],
  [
    'get my pc ready for streaming: open OBS and Discord, close Chrome',
    { name: 'streaming', spec: 'open OBS and Discord, close Chrome' },
  ],
] as const)('%s → setup.run', (text, args) => {
  const got = grammar().parse(text.replace(/^Atlas,\s*/, ''));
  expect(got?.steps[0]?.skill).toBe('setup.run');
  expect(got?.steps[0]?.args).toMatchObject(args);
});

test.each([
  ['what are you watching?', 'watch.list'],
  ["what's the status?", 'watch.list'],
  ['stop watching obs', 'watch.cancel'],
  ['cancel all watches', 'watch.cancel'],
  ['pause the watch', 'watch.pause'],
  ['show my setups', 'setup.list'],
  ['delete my streaming setup', 'setup.delete'],
  ['save my streaming setup as open OBS, close Chrome', 'setup.save'],
  ['put discord on the left', 'window.place'],
  ['move spotify to the right half', 'window.place'],
  ['which mic am I using?', 'system.audioDevices'],
  ['run the tests in D:\\Dev\\MyApp', 'test.run'],
  ['package the project in D:\\Dev\\MyApp', 'build.run'],
  ['build D:\\Dev\\MyApp', 'build.run'],
])('%s → %s', (text, skill) => {
  expect(first(text)?.skill).toBe(skill);
});

test('the continuation itself parses into three steps', () => {
  const p = g.parse('run the tests, package it, and open the result');
  expect(p?.steps.map((s) => s.skill)).toEqual(['test.run', 'build.run', 'project.launch']);
  expect(p?.steps[1]?.args).toEqual({ target: 'package' });
});

test.each([
  ['watch youtube', 'watch.create'],
  ['watch the new trailer on youtube', 'watch.create'],
  ['when is my next meeting?', 'watch.create'],
  ['move report.txt to D:\\Archive', 'window.place'],
  ['build me a clicker game', 'build.run'],
  ['open steam', 'watch.create'],
  // Found by the HEAD-vs-now differential: conversation that merely starts with "when".
  ['when I was young, I loved racing games', 'watch.create'],
  ['when on, the provider is told and the prompt asks for a fuller answer', 'watch.create'],
  ['let me know if you have any ideas', 'watch.create'],
])('“%s” is not claimed by %s', (text, notSkill) => {
  expect(first(text)?.skill).not.toBe(notSkill);
});
