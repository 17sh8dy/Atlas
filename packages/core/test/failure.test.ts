import { test, assert, describe } from 'vitest';
import { RECOVERY, classifyFailure, recoveryFor, type FailureKind } from '../src/models/failure';

describe('classifying a failure', () => {
  const cases: Array<[string, FailureKind]> = [
    ["I couldn't find D:\Dev\Missing.", 'not-found'],
    ['That path doesn’t exist.', 'not-found'],
    ['Steam isn’t installed.', 'not-found'],
    ['Access is denied.', 'permission'],
    ['This needs administrator rights.', 'permission'],
    ['That path is outside the folders Atlas can touch.', 'refused'],
    ['I won’t do that.', 'refused'],
    ['That file is in use by another program.', 'busy'],
    ['The request timed out.', 'timeout'],
    ['More than one window matches — which one?', 'ambiguous'],
    ['The network is offline.', 'unavailable'],
    ["I can't read the driver list in this build.", 'unavailable'],
    ['Give me a full path.', 'invalid'],
    ['Something odd happened.', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [text, kind] of cases) {
    test(`“${text}” is ${kind}`, () => assert.equal(classifyFailure(text), kind));
  }

  test('a skipped step is declined whatever its text says', () => {
    assert.equal(classifyFailure('Skipped.', { skipped: true }), 'declined');
    assert.equal(classifyFailure('Cancelled.'), 'declined');
    assert.equal(classifyFailure('Skipped.'), 'declined');
  });

  test('a halt is recognised by the stop’s own prefix', () => {
    assert.equal(classifyFailure('Atlas is halted — nothing else runs until you send something new.'), 'halted');
  });
});

describe('the recovery table', () => {
  const kinds = Object.keys(RECOVERY) as FailureKind[];

  test('every kind has a recovery and a hint', () => {
    assert.isAbove(kinds.length, 8);
    for (const kind of kinds) {
      assert.isString(recoveryFor(kind).hint);
      assert.isAbove(recoveryFor(kind).hint.length, 10);
    }
  });

  test('nothing that was refused, denied or declined recovers by itself', () => {
    for (const kind of ['refused', 'permission', 'declined', 'halted'] as FailureKind[]) {
      assert.isFalse(recoveryFor(kind).automatic, kind);
      assert.notEqual(recoveryFor(kind).action, 'retry-once', kind);
      assert.notEqual(recoveryFor(kind).action, 'try-alternative', kind);
    }
  });

  test('only transient failures retry, and only once', () => {
    const retrying = kinds.filter((k) => recoveryFor(k).action === 'retry-once');
    assert.sameMembers(retrying, ['busy', 'timeout']);
  });

  test('an unrecognised failure stops and says so, never guesses', () => {
    assert.equal(recoveryFor('unknown').action, 'stop');
    assert.isFalse(recoveryFor('unknown').automatic);
  });
});
