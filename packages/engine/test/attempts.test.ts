/**
 * `attemptGoal` — the bounded, goal-directed attempt ladder skills build on.
 * Tested standalone from any particular skill, since the guarantees it makes
 * (bounded, ordered, stop-on-commit) have to hold regardless of who calls it.
 */

import { test, assert } from 'vitest';
import { attemptGoal, MAX_ATTEMPTS, type Attempt } from '../src/planner/attempts';

function spyAttempt(id: string, outcome: Awaited<ReturnType<Attempt<unknown>['run']>>) {
  const calls: number[] = [];
  return {
    id,
    calls,
    run: () => {
      calls.push(Date.now());
      return outcome;
    },
  };
}

test('the first successful attempt stops the ladder — nothing after it runs', async () => {
  const first = spyAttempt('first', { result: { ok: true, message: 'done' } });
  const second = spyAttempt('second', { result: { ok: true, message: 'should never run' } });

  const log = await attemptGoal([first, second]);

  assert.isTrue(log.final);
  assert.equal(log.result.message, 'done');
  assert.deepEqual(log.tried, ['first']);
  assert.equal(second.calls.length, 0, 'a strategy after a success must never run');
});

test('a failed attempt falls through to the next relevant one, in order', async () => {
  const first = spyAttempt('first', { result: { ok: false, error: 'no' } });
  const second = spyAttempt('second', { result: { ok: true, message: 'got it' } });

  const log = await attemptGoal([first, second]);

  assert.isTrue(log.final);
  assert.equal(log.result.message, 'got it');
  assert.deepEqual(log.tried, ['first', 'second']);
});

test('a "final" failure stops the ladder without trying anything unrelated afterward', async () => {
  // Committed but unsuccessful — e.g. a real launch was attempted and the
  // program wouldn't start. The honest answer is that failure, never a
  // different strategy invented because attempts remained.
  const first = spyAttempt('first', { final: true, result: { ok: false, error: 'crashed' } });
  const second = spyAttempt('second', { result: { ok: true, message: 'should never run' } });

  const log = await attemptGoal([first, second]);

  assert.isTrue(log.final);
  assert.equal(log.result.error, 'crashed');
  assert.deepEqual(log.tried, ['first']);
  assert.equal(second.calls.length, 0);
});

test('exhausting every strategy without a commit is reported honestly, not invented', async () => {
  const strategies = [
    spyAttempt('a', { result: { ok: false, error: 'not applicable' } }),
    spyAttempt('b', { result: { ok: false, error: 'not applicable' } }),
    spyAttempt('c', { result: { ok: false, error: 'not applicable' } }),
  ];

  const log = await attemptGoal(strategies);

  assert.isFalse(log.final);
  assert.deepEqual(log.tried, ['a', 'b', 'c']);
});

test('never more than MAX_ATTEMPTS strategies run, even if more are declared', async () => {
  assert.equal(MAX_ATTEMPTS, 3, 'small and predictable — see the module doc');

  const strategies = Array.from({ length: 6 }, (_, i) =>
    spyAttempt(`strategy-${i}`, { result: { ok: false, error: 'no' } }),
  );

  const log = await attemptGoal(strategies);

  assert.lengthOf(log.tried, MAX_ATTEMPTS);
  assert.deepEqual(
    log.tried,
    strategies.slice(0, MAX_ATTEMPTS).map((s) => s.id),
  );
});

test('each strategy runs at most once — the ladder cannot loop', async () => {
  let firstCalls = 0;
  const first: Attempt<unknown> = {
    id: 'first',
    run: () => {
      firstCalls += 1;
      return { result: { ok: false, error: 'no' } };
    },
  };
  const second = spyAttempt('second', { result: { ok: false, error: 'no' } });

  await attemptGoal([first, second]);

  assert.equal(firstCalls, 1);
  assert.equal(second.calls.length, 1);
});
