/** The real-app test driver's rules: the default is NO, and nothing outside the sandbox is ever approved. */
import { describe, expect, test } from 'vitest';
// @ts-expect-error plain ES module without types
import { decideCard, pathsIn } from '../../../scripts/e2e/lib/policy.mjs';
// @ts-expect-error plain ES module without types
import { assertDisposable, SANDBOX_ROOT } from '../../../scripts/e2e/lib/sandbox.mjs';

const SB: string = `${SANDBOX_ROOT as string}\\run-abc`;
const SB_SLASH = SB.replace(/\\/g, '/');
const opts = { sandbox: SB };

describe('card policy', () => {
  test('the incident card is refused: a destructive cleanup of the real temp folder', () => {
    const card = 'Clean 459 files — old temp files, 433 MB? These are removed for good. Biggest: ffplay.exe (102 MB)';
    expect(decideCard(card, opts).answer).toBe('no');
    expect(decideCard(card, { ...opts, allowDestructiveInSandbox: true }).answer).toBe('no');
  });

  test('a card naming a path outside the sandbox is refused, even if harmless-looking', () => {
    expect(decideCard('Create the folder C:/Users/me/Documents/x', opts).answer).toBe('no');
    expect(decideCard(`Move ${SB}\\a.log into C:\\Users\\me\\Desktop`, opts).answer).toBe('no');
  });

  test('sandbox-only, non-destructive cards are approved', () => {
    expect(decideCard(`JARVIS wants to create the folder ${SB_SLASH}/reports`, opts).answer).toBe('yes');
    expect(decideCard('Work this out step by step? I can try, one step at a time', opts).answer).toBe('yes');
  });

  test('destructive cards inside the sandbox need the explicit flag', () => {
    const card = `Delete ${SB}\\old.log permanently`;
    expect(decideCard(card, opts).answer).toBe('no');
    expect(decideCard(card, { ...opts, allowDestructiveInSandbox: true }).answer).toBe('yes');
  });

  test('permission and setting changes are refused; so is a card with no checkable target', () => {
    expect(decideCard(`Add ${SB} to the allowed folders?`, opts).answer).toBe('no');
    expect(decideCard('Are you sure?', opts).answer).toBe('no');
  });

  test('paths are found in both slash styles', () => {
    expect(pathsIn('a C:/x/y and D:\\z\\w.')).toEqual(['C:/x/y', 'D:\\z\\w']);
  });
});

describe('sandbox location', () => {
  test('only a folder inside the repo sandbox root qualifies', () => {
    expect(() => assertDisposable(SB)).not.toThrow();
    for (const bad of [SANDBOX_ROOT, 'C:\\Users\\Brandon\\Downloads\\x', `${process.env.TEMP}\\x`, 'C:\\Windows\\x', 'D:\\Dev\\Atlas\\src']) {
      expect(() => assertDisposable(bad as string), bad as string).toThrow();
    }
  });
  test('a sandbox path that is also under Temp is refused', () => {
    expect(() => assertDisposable(`${SANDBOX_ROOT as string}\\x`, { TEMP: SANDBOX_ROOT, USERPROFILE: 'C:\\Users\\nobody' })).toThrow();
  });
});
