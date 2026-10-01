/**
 * Reminders, alarms and the stopwatch: what is understood, what is kept, and
 * what happens when the moment arrives — including while Atlas was closed.
 */

import { assert, test } from 'vitest';
import type { Storage } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { parseWhen, splitWhen } from '../src/text/when';
import { ReminderScheduler } from '../src/reminders/scheduler';
import { createReminderSkills } from '../src/skills/reminder-skills';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) => {
  const p = grammar().parse(text);
  return p?.steps.map((s) => [s.skill, s.args]);
};

// A Wednesday, 3:00pm local.
const NOW = new Date(2026, 9, 7, 15, 0, 0);
const at = (h: number, m = 0, addDays = 0) => new Date(2026, 9, 7 + addDays, h, m, 0).getTime();

function memoryStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return data.get(k) as T | undefined;
    },
    async set(k: string, v: unknown) {
      data.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k: string) {
      data.delete(k);
    },
  };
}

// ---- time phrases -----------------------------------------------------------------

test('relative times', () => {
  assert.equal(parseWhen('in 10 minutes', NOW)?.at, NOW.getTime() + 600_000);
  assert.equal(parseWhen('in half an hour', NOW)?.at, NOW.getTime() + 1_800_000);
  assert.equal(parseWhen('in 2 hours', NOW)?.at, NOW.getTime() + 7_200_000);
  assert.equal(parseWhen('in an hour and a half', NOW)?.at, NOW.getTime() + 5_400_000);
});

test('a bare hour means the soonest one still ahead', () => {
  assert.equal(parseWhen('at 5', NOW)?.at, at(17)); // 3pm -> 5pm today
  assert.equal(parseWhen('at 2', NOW)?.at, at(2, 0, 1)); // 2pm has passed; 2am tomorrow is next
});

test('explicit meridiem and 24 hour clocks are taken literally', () => {
  assert.equal(parseWhen('at 5am', NOW)?.at, at(5, 0, 1));
  assert.equal(parseWhen('5:30pm', NOW)?.at, at(17, 30));
  assert.equal(parseWhen('at 17:45', NOW)?.at, at(17, 45));
  assert.equal(parseWhen('at noon', NOW)?.at, at(12, 0, 1));
});

test('tomorrow, tonight, weekdays', () => {
  assert.equal(parseWhen('tomorrow at 9', NOW)?.at, at(9, 0, 1));
  assert.equal(parseWhen('tomorrow at 9:30am', NOW)?.at, at(9, 30, 1));
  assert.equal(parseWhen('tonight at 8', NOW)?.at, at(20));
  assert.equal(parseWhen('friday at 3pm', NOW)?.at, at(15, 0, 2));
  assert.equal(parseWhen('on monday', NOW)?.at, at(9, 0, 5));
});

test('repeating', () => {
  const daily = parseWhen('every day at 8', NOW)!;
  assert.equal(daily.repeat, 'daily');
  assert.equal(daily.at, at(20)); // no am/pm: the soonest 8 ahead of 3pm is 8pm, and the reply says so
  const weekdays = parseWhen('every weekday at 7:30am', NOW)!;
  assert.equal(weekdays.repeat, 'weekdays');
  assert.notEqual(new Date(weekdays.at).getDay() % 6, 0, 'never a weekend');
});

test('what it does not understand it refuses', () => {
  for (const bad of ['', 'soonish', 'at 25', 'in banana minutes', 'at 13pm', 'in 0 minutes']) {
    assert.equal(parseWhen(bad, NOW), null, bad);
  }
});

test('splitting "what" from "when"', () => {
  assert.equal(splitWhen('call mom at 5', NOW)?.what, 'call mom');
  assert.equal(splitWhen('take the bins out tomorrow at 7', NOW)?.what, 'take the bins out');
  assert.equal(splitWhen('buy milk', NOW), null);
  assert.equal(splitWhen('pick up the 5 kids', NOW), null, 'a number in the sentence is not a time');
});

// ---- how it is understood ---------------------------------------------------------

test('reminders reach reminder.set, with the time as words', () => {
  assert.deepEqual(plan('remind me to call mom at 5'), [
    ['reminder.set', { text: 'call mom', when: 'at 5' }],
  ]);
  assert.deepEqual(plan('remind me in 5 minutes to stretch'), [
    ['reminder.set', { text: 'stretch', when: 'in 5 minutes' }],
  ]);
  assert.deepEqual(plan('remind me tomorrow at 9 to call the dentist'), [
    ['reminder.set', { text: 'call the dentist', when: 'tomorrow at 9' }],
  ]);
});

test('"remind me to X" with no time is still a to-do', () => {
  assert.equal(grammar().parse('remind me to buy milk')?.steps[0]?.skill, 'todo.add');
});

test('alarms', () => {
  assert.deepEqual(plan('set an alarm for 7am'), [['alarm.set', { when: 'at 7am' }]]);
  assert.deepEqual(plan('wake me up at 6:30'), [['alarm.set', { when: 'at 6:30' }]]);
  assert.deepEqual(plan('wake me up tomorrow at 7'), [['alarm.set', { when: 'tomorrow at 7' }]]);
});

test('list, cancel and the stopwatch', () => {
  assert.equal(grammar().parse('what are my reminders')?.steps[0]?.skill, 'reminder.list');
  assert.deepEqual(plan('cancel my reminder about mom'), [['reminder.cancel', { which: 'mom' }]]);
  assert.deepEqual(plan('cancel all alarms'), [['reminder.cancel', { which: 'all' }]]);
  assert.deepEqual(plan('start a stopwatch'), [['stopwatch', { action: 'start' }]]);
  assert.deepEqual(plan('stop the stopwatch'), [['stopwatch', { action: 'stop' }]]);
  assert.deepEqual(plan('how long on the stopwatch'), [['stopwatch', { action: 'check' }]]);
});

// ---- the wrong-route fixes ----------------------------------------------------------

test('spoken hotkeys are hotkeys, not a click on a control called "alt tab"', () => {
  assert.deepEqual(plan('press alt tab'), [['input.hotkey', { combo: 'alt+tab' }]]);
  assert.deepEqual(plan('press windows d'), [['input.hotkey', { combo: 'win+d' }]]);
  assert.deepEqual(plan('press control alt delete'), [
    ['input.hotkey', { combo: 'ctrl+alt+delete' }],
  ]);
  assert.equal(grammar().parse('press save')?.steps[0]?.skill, 'uia.invoke', 'a button is still a button');
});

test('"push to github" is a git push, not a click on "to github"', () => {
  assert.equal(grammar().parse('push to github')?.steps[0]?.skill, 'git.push');
  assert.equal(grammar().parse('push the save button')?.steps[0]?.skill, 'uia.invoke');
});

test('"as administrator" is never dropped', () => {
  for (const s of [
    'run notepad as administrator',
    'open notepad as admin',
    'launch as administrator notepad',
  ]) {
    assert.deepEqual(plan(s), [['app.runAsAdmin', { name: 'notepad' }]], s);
  }
});

test('a sentence is not an app name', () => {
  for (const s of [
    'run npm audit',
    'open an incognito window',
    'open a new tab',
    'open a pull request',
  ]) {
    assert.equal(grammar().parse(s), null, s);
  }
  assert.equal(grammar().parse('run backup every night at 2am')?.steps[0]?.skill, 'routine.create');
  // these two used to be swallowed as app names; they are project actions now
  assert.equal(grammar().parse('open the terminal in this folder')?.steps[0]?.skill, 'project.terminal');
  assert.equal(grammar().parse('open this project in vscode')?.steps[0]?.skill, 'project.editor');
  assert.deepEqual(plan('open visual studio code'), [['app.open', { name: 'visual studio code' }]]);
});

// ---- keeping them ---------------------------------------------------------------------

test('a reminder fires once, then is gone', async () => {
  const storage = memoryStorage();
  let clock = NOW.getTime();
  const fired: string[] = [];
  const s = new ReminderScheduler({
    storage,
    now: () => clock,
    notify: (t, b) => fired.push(`${t}: ${b}`),
  });
  const r = await s.add({ text: 'call mom', at: clock + 60_000, kind: 'reminder' });
  assert.ok(!('error' in r));
  await s.start();
  s.tick();
  assert.deepEqual(fired, []);
  clock += 61_000;
  s.tick();
  assert.deepEqual(fired, ['Reminder: call mom']);
  s.tick();
  assert.equal(fired.length, 1);
  assert.deepEqual(await s.list(), []);
  s.dispose();
});

test('it survives a restart, and what came due while closed is reported as missed', async () => {
  const storage = memoryStorage();
  let clock = NOW.getTime();
  const first = new ReminderScheduler({ storage, now: () => clock, notify: () => {} });
  await first.add({ text: 'take the tablet', at: clock + 3_600_000, kind: 'reminder' });
  first.dispose();

  clock += 3 * 3_600_000; // Atlas was closed for three hours
  const fired: string[] = [];
  const second = new ReminderScheduler({ storage, now: () => clock, notify: (_t, b) => fired.push(b) });
  await second.start();
  assert.equal(fired.length, 1);
  assert.match(fired[0]!, /take the tablet \(missed — it was due 2 hours ago\)/);
  second.dispose();
});

test('a repeating reminder is rescheduled, not removed, and does not fire a backlog', async () => {
  const storage = memoryStorage();
  let clock = NOW.getTime();
  const fired: string[] = [];
  const s = new ReminderScheduler({ storage, now: () => clock, notify: (_t, b) => fired.push(b) });
  await s.add({ text: 'stretch', at: clock + 1000, repeat: 'daily', kind: 'reminder' });
  await s.start();
  clock += 5 * 86_400_000; // five days pass
  s.tick();
  assert.equal(fired.length, 1, 'one notification, not five');
  const [left] = await s.list();
  assert.ok(left && left.at > clock);
  s.dispose();
});

test('the past and the far future are refused', async () => {
  const s = new ReminderScheduler({
    storage: memoryStorage(),
    now: () => NOW.getTime(),
    notify: () => {},
  });
  assert.ok('error' in (await s.add({ text: 'x', at: NOW.getTime() - 1, kind: 'reminder' })));
  assert.ok(
    'error' in (await s.add({ text: 'x', at: NOW.getTime() + 400 * 86_400_000, kind: 'reminder' })),
  );
});

test('cancelling by a word, refusing an ambiguous one', async () => {
  const s = new ReminderScheduler({
    storage: memoryStorage(),
    now: () => NOW.getTime(),
    notify: () => {},
  });
  await s.add({ text: 'call mom', at: NOW.getTime() + 1000, kind: 'reminder' });
  await s.add({ text: 'call the dentist', at: NOW.getTime() + 2000, kind: 'reminder' });
  assert.ok('error' in (await s.cancel('call')), 'matches two');
  const out = await s.cancel('dentist');
  assert.ok('removed' in out && out.removed.length === 1);
  assert.equal((await s.list()).length, 1);
  assert.ok('error' in (await s.cancel('zebra')));
});

// ---- the skills ------------------------------------------------------------------------

test('the skills speak plainly, and refuse a time they cannot read', async () => {
  const s = new ReminderScheduler({
    storage: memoryStorage(),
    now: () => NOW.getTime(),
    notify: () => {},
  });
  const skills = Object.fromEntries(createReminderSkills(s, () => NOW.getTime()).map((k) => [k.id, k]));
  const ctx = {} as never;
  const ok = await skills['reminder.set']!.run({ text: 'call mom', when: 'at 5' }, ctx);
  assert.equal(ok.ok, true);
  assert.match(String(ok.ok && ok.message), /remind you .* call mom/i);
  const bad = await skills['reminder.set']!.run({ text: 'x', when: 'soonish' }, ctx);
  assert.equal(bad.ok, false);
  const listed = await skills['reminder.list']!.run({}, ctx);
  assert.match(String(listed.ok && listed.message), /call mom/);
});

test('the stopwatch counts, stops and resets', async () => {
  let clock = 0;
  const s = new ReminderScheduler({ storage: memoryStorage(), notify: () => {} });
  const sw = createReminderSkills(s, () => clock).find((k) => k.id === 'stopwatch')!;
  const ctx = {} as never;
  const say = async (action: string) =>
    String(((await sw.run({ action }, ctx)) as { message: string }).message);
  await say('start');
  clock = 65_000;
  assert.match(await say('check'), /1m 5s/);
  await say('stop');
  clock = 500_000;
  assert.match(await say('check'), /1m 5s \(stopped\)/);
  await say('reset');
  assert.match(await say('check'), /not been started/);
});
