import { describe, expect, test } from 'vitest';
import type { SearxngTestReport } from '@atlas/core';
import {
  PRIVATE_PREFIX,
  describeReach,
  describeSetupError,
  describeTest,
} from '../src/pages/settings/general/searxng-setup';

const report = (over: Partial<SearxngTestReport>): SearxngTestReport => ({
  ok: false,
  status: 'invalid',
  message: 'm',
  resultCount: 0,
  ...over,
});

describe('saving an address', () => {
  test('a private-network refusal asks for the confirmation and drops the code from the sentence', () => {
    const e = describeSetupError(new Error(`${PRIVATE_PREFIX} That address is on your local network. Confirm it is your own server to use it.`));
    expect(e.needsPrivateConfirmation).toBe(true);
    expect(e.message).toBe('That address is on your local network. Confirm it is your own server to use it.');
  });

  test('any other refusal is shown as it came, without a confirmation box', () => {
    const e = describeSetupError('An address on the internet has to use https://.');
    expect(e.needsPrivateConfirmation).toBe(false);
    expect(e.message).toMatch(/https/);
  });

  test('an empty rejection still says something', () => {
    expect(describeSetupError(undefined).message.length).toBeGreaterThan(5);
  });
});

describe('words for where a server is', () => {
  test('each reach has its own', () => {
    expect(describeReach('this-machine')).toMatch(/this PC/);
    expect(describeReach('private-network')).toMatch(/own network/);
    expect(describeReach('internet')).toMatch(/https/);
    expect(describeReach(null)).toBe('');
  });
});

describe('a test result', () => {
  test('working is good, an empty answer is neutral', () => {
    expect(describeTest(report({ ok: true, status: 'ok', resultCount: 5 })).tone).toBe('good');
    expect(describeTest(report({ ok: true, status: 'ok', resultCount: 0 })).tone).toBe('neutral');
  });

  test('a setup fault is bad; being offline or rate-limited is not a mistake', () => {
    for (const status of ['json-off-or-misconfigured', 'invalid', 'login-required', 'blocked'] as const) {
      expect(describeTest(report({ status })).tone, status).toBe('bad');
    }
    for (const status of ['unreachable', 'rate-limited', 'not-set-up'] as const) {
      expect(describeTest(report({ status })).tone, status).toBe('neutral');
    }
  });
});
