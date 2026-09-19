import { describe, expect, test } from 'vitest';
import { describeKeyCheck, readPastedKey } from '../src/pages/settings/general/tavily-key';

const REAL = 'tvly-dev-AbCdEf0123456789_xyz-QRSTuv';

describe('readPastedKey', () => {
  test('a plain key is accepted as it is', () => {
    expect(readPastedKey(REAL)).toEqual({ ok: true, key: REAL, extracted: false });
    expect(readPastedKey(`  ${REAL}\n`)).toEqual({ ok: true, key: REAL, extracted: false });
  });

  test('a key inside a link is pulled out — the mistake that started this', () => {
    const link = `https://mcp.tavily.com/mcp/?tavilyApiKey=${REAL}`;
    expect(readPastedKey(link)).toEqual({ ok: true, key: REAL, extracted: true });
  });

  test('a key inside a header or a snippet is pulled out too', () => {
    expect(readPastedKey(`Authorization: Bearer ${REAL}`)).toMatchObject({ ok: true, key: REAL });
    expect(readPastedKey(`api_key="${REAL}"`)).toMatchObject({ ok: true, key: REAL });
  });

  test('a link with no key in it is refused, and says why', () => {
    const r = readPastedKey('https://mcp.tavily.com/mcp/?something=else');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/link|text/);
    expect((r as { message: string }).message).toMatch(/tvly-/);
  });

  test('a long block of prose is refused', () => {
    expect(readPastedKey('Connect me to Tavily please. '.repeat(20)).ok).toBe(false);
  });

  test('a single short token without the prefix is refused rather than saved', () => {
    const r = readPastedKey('abc123');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/tvly-/);
  });

  test('empty input asks for a key', () => {
    expect(readPastedKey('   ').ok).toBe(false);
  });

  test('the message never contains what was pasted', () => {
    const secretish = 'https://example.com/?k=hunter2hunter2';
    const r = readPastedKey(secretish);
    expect((r as { message: string }).message).not.toContain('hunter2');
  });
});

describe('describeKeyCheck', () => {
  test('success says it works', () => {
    expect(describeKeyCheck(undefined)).toMatchObject({ tone: 'good' });
  });

  test('a rejected key is bad and tells the user what to do', () => {
    const c = describeKeyCheck("auth: Tavily didn't accept the saved key.");
    expect(c.tone).toBe('bad');
    expect(c.message).toMatch(/API Keys/);
  });

  test('a spent allowance means the key itself is fine', () => {
    const c = describeKeyCheck('quota: used up');
    expect(c.tone).toBe('neutral');
    expect(c.message).toMatch(/accepted the key/);
  });

  test.each(['rate: slow down', 'offline: no route', 'error: boom', 'something unexpected'])(
    'other outcomes keep the key and say so: %s',
    (e) => {
      const c = describeKeyCheck(e);
      expect(c.tone).toBe('neutral');
      expect(c.message).toMatch(/saved/);
    },
  );
});
