/** notify.send: tidied text, honest failures. */
import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';

function notifier(notify: (title: string, body?: string) => Promise<boolean>) {
  const skills = createCoreSkills({ notify } as unknown as Platform, {} as never, new SkillRegistry(), {} as never);
  const s = skills.find((x) => x.id === 'notify.send')!;
  return (args: Record<string, unknown>) => s.run(args, {} as never) as Promise<{ ok: boolean; message?: string; error?: string; data?: { title: string; body: string; shortened: boolean } }>;
}

test('control characters and blank runs are removed, and the title is one line', async () => {
  const sent: Array<[string, string | undefined]> = [];
  const send = notifier(async (t, b) => (sent.push([t, b]), true));
  const r = await send({ title: '  Build\u0007 \n done  ', message: 'line one\u0000\n\n\n\n\nline   two' });
  assert.isTrue(r.ok);
  assert.deepEqual(sent[0], ['Build done', 'line one\n\nline two']);
  assert.isFalse(r.data!.shortened);
});

test('long text is cut at a fixed length, and the reply says it was shortened', async () => {
  const sent: Array<[string, string | undefined]> = [];
  const send = notifier(async (t, b) => (sent.push([t, b]), true));
  const r = await send({ title: 'T'.repeat(200), message: 'x'.repeat(400) });
  assert.isTrue(r.ok);
  assert.isAtMost(sent[0]![0].length, 64);
  assert.isAtMost(sent[0]![1]!.length, 240);
  assert.match(String(r.message), /shortened to fit/);
  assert.isTrue(r.data!.shortened);
});

test('an empty message, or one that is only control characters, is refused', async () => {
  const send = notifier(async () => true);
  assert.isFalse((await send({ message: '   ' })).ok);
  assert.isFalse((await send({ message: '\u0000\u0007' })).ok);
  assert.isFalse((await send({})).ok);
});

test('a missing title becomes Atlas', async () => {
  const sent: Array<[string, string | undefined]> = [];
  const send = notifier(async (t, b) => (sent.push([t, b]), true));
  await send({ message: 'hello', title: '   ' });
  assert.equal(sent[0]![0], 'Atlas');
});

test('Windows refusing says how to turn notifications on; a thrown failure is reported, not thrown', async () => {
  const denied = await notifier(async () => false)({ message: 'hi' });
  assert.isFalse(denied.ok);
  assert.match(String(denied.error), /Settings → System → Notifications → Atlas/);
  const broke = await notifier(async () => {
    throw new Error('plugin missing');
  })({ message: 'hi' });
  assert.isFalse(broke.ok);
  assert.match(String(broke.error), /couldn't post the notification: plugin missing/);
});
