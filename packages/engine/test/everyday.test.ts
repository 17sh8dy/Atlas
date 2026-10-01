/**
 * Email and calendar (compose, never send), the look-it-up phrasings, and
 * "move X to my second monitor".
 */

import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { buildIcs, createEverydaySkills } from '../src/skills/everyday-skills';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

// ---- understanding -----------------------------------------------------------------------

test('email', () => {
  assert.deepEqual(plan('email bob@example.com about lunch saying see you at noon'), [
    ['mail.compose', { to: 'bob@example.com', subject: 'lunch', body: 'see you at noon' }],
  ]);
  assert.deepEqual(plan('send an email to a@b.co and c@d.io'), [['mail.compose', { to: 'a@b.co,c@d.io' }]]);
  assert.deepEqual(plan('compose an email'), [['mail.compose', {}]]);
});

test('calendar: the time may follow "calendar" or end the title; no time is not enough', () => {
  assert.deepEqual(plan('add dentist to my calendar tomorrow at 3pm'), [['calendar.add', { title: 'dentist', when: 'tomorrow at 3pm' }]]);
  assert.deepEqual(plan('put lunch with sam on my calendar friday at noon'), [['calendar.add', { title: 'lunch with sam', when: 'friday at noon' }]]);
  assert.deepEqual(plan('schedule dentist tomorrow at 3pm'), [['calendar.add', { title: 'dentist', when: 'tomorrow at 3pm' }]]);
  assert.equal(grammar().parse('schedule a meeting'), null);
});

test('look-ups are web searches the person asked for', () => {
  assert.deepEqual(plan('define ephemeral'), [['web.search', { query: 'define ephemeral' }]]);
  assert.deepEqual(plan('what does ubiquitous mean'), [['web.search', { query: 'define ubiquitous' }]]);
  assert.deepEqual(plan('whats the weather in paris'), [['web.search', { query: 'weather paris' }]]);
  assert.deepEqual(plan('latest news about spacex'), [['web.search', { query: 'spacex news' }]]);
  assert.deepEqual(plan('stock price of nvidia'), [['web.search', { query: 'nvidia stock price' }]]);
  assert.deepEqual(plan('how long to drive to las vegas'), [['web.searchMaps', { query: 'las vegas', directions: true }]]);
  assert.equal(grammar().parse('translate hello to spanish')?.steps[0]?.args.url, 'https://translate.google.com/?sl=auto&tl=es&text=hello&op=translate');
  // a general question is still a question
  assert.equal(grammar().parse('what is the capital of peru'), null);
  assert.equal(grammar().parse('translate hello to klingon'), null, 'an unknown language is not guessed');
});

test('a window to another monitor', () => {
  assert.deepEqual(plan('move spotify to my second monitor'), [['window.place', { name: 'spotify', position: 'center', display: 2 }]]);
  assert.deepEqual(plan('send discord to monitor 2'), [['window.place', { name: 'discord', position: 'center', display: 2 }]]);
});

// ---- behaviour ------------------------------------------------------------------------------

function machine() {
  const opened: string[] = [];
  const files: Record<string, string> = {};
  const platform = {
    openUrl: async (u: string) => {
      opened.push(u);
      return true;
    },
    knownFolder: async () => 'C:\\U\\Documents',
    createFolder: async () => true,
    createFile: async (p: string, c?: string) => {
      files[p] = c ?? '';
      return true;
    },
    openPath: async (p: string) => {
      opened.push(p);
      return true;
    },
  } as unknown as Platform;
  const skills = Object.fromEntries(createEverydaySkills(platform, () => new Date(2026, 9, 7, 15, 0, 0)).map((s) => [s.id, s]));
  const run = (id: string, args: Record<string, unknown>) => skills[id]!.run(args, {} as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { opened, files, run };
}

test('an email opens addressed and worded, and says it was not sent', async () => {
  const m = machine();
  const r = await m.run('mail.compose', { to: 'bob@example.com,al@x.org', subject: 'Lunch & learn', body: 'see you\nat noon' });
  assert.equal(r.ok, true);
  assert.equal(m.opened[0], 'mailto:bob%40example.com,al%40x.org?subject=Lunch%20%26%20learn&body=see%20you%0Aat%20noon');
  assert.match(String(r.message), /haven't sent it/);
});

test('a bad address or too many are refused before anything opens', async () => {
  const m = machine();
  assert.equal((await m.run('mail.compose', { to: 'not-an-address' })).ok, false);
  assert.equal((await m.run('mail.compose', { to: 'a@b.co,b@b.co,c@b.co,d@b.co,e@b.co,f@b.co' })).ok, false);
  assert.equal(m.opened.length, 0);
});

test('a header injection through the subject cannot add a field', async () => {
  const m = machine();
  await m.run('mail.compose', { to: 'a@b.co', subject: 'hi\r\nBcc: evil@x.com' });
  assert.ok(!/Bcc/i.test(decodeURIComponent(m.opened[0]!).replace(/\r?\n/g, ' ').split('subject=')[0]!));
  assert.ok(m.opened[0]!.includes('%0D%0ABcc'), 'it stays inside the subject, encoded');
});

test('the calendar file has the right shape, escaped, with a reminder', () => {
  const text = buildIcs('Lunch; with, Sam', new Date(2026, 9, 8, 12, 0, 0), 90, 'Cafe\\1', new Date(Date.UTC(2026, 9, 7, 19, 0, 0)));
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /\r\nDTSTART:20261008T120000\r\n/);
  assert.match(text, /\r\nDTEND:20261008T133000\r\n/);
  assert.match(text, /\r\nSUMMARY:Lunch\\; with\\, Sam\r\n/);
  assert.match(text, /\r\nLOCATION:Cafe\\\\1\r\n/);
  assert.match(text, /TRIGGER:-PT15M/);
  assert.match(text, /END:VCALENDAR\r\n$/);
});

test('add to calendar writes the file in Documents and opens it', async () => {
  const m = machine();
  const r = await m.run('calendar.add', { title: 'Dentist', when: 'tomorrow at 3pm' });
  assert.equal(r.ok, true);
  const [path] = Object.keys(m.files);
  assert.match(path!, /^C:\\U\\Documents\\Atlas Events\\dentist-[a-z0-9]+\.ics$/);
  assert.match(m.files[path!]!, /DTSTART:20261008T150000/);
  assert.equal(m.opened[0], path);
  assert.match(String(r.message), /press Save there/);
});

test('an event with no readable time is not made', async () => {
  const m = machine();
  const r = await m.run('calendar.add', { title: 'Dentist', when: 'soonish' });
  assert.equal(r.ok, false);
  assert.equal(Object.keys(m.files).length, 0);
});
