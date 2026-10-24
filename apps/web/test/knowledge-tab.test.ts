import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CalibrationRow, KnowledgeStatus } from '@atlas/platform';
import {
  AUTO_REFRESH_EXPLAINER,
  LIVE_LOOKUPS_EXPLAINER,
  packDate,
  packNote,
  ratioLabel,
  sortCalibration,
  sourceLabel,
  whenMs,
} from '../src/pages/settings/knowledgeView';
import { SECTIONS } from '../src/pages/Settings';

const status = (over: Partial<KnowledgeStatus> = {}): KnowledgeStatus => ({
  source: 'bundled',
  seq: 3,
  builtAt: '2026-10-24T00:00:00Z',
  bundledSeq: 3,
  provisioned: true,
  autoRefresh: true,
  liveLookups: true,
  lastCheckedMs: 0,
  lastUpdatedMs: 0,
  lastError: null,
  bundledProblem: null,
  ...over,
});

const row = (model: string, samples: number, inUse: boolean): CalibrationRow => ({
  provider: 'local',
  model,
  kind: 'prose',
  samples,
  ratioPermille: 1043,
  inUse,
});

describe('Knowledge tab wording', () => {
  test('unknown values are a dash or "Never", never a made-up date', () => {
    expect(packDate(null)).toBe('—');
    expect(packDate('not a date')).toBe('—');
    expect(whenMs(0)).toBe('Never');
    expect(packDate('2026-10-24T12:00:00Z')).toContain('2026');
  });

  test('source labels say where the copy came from', () => {
    expect(sourceLabel(status({ source: 'bundled' }))).toBe('Built into this Atlas');
    expect(sourceLabel(status({ source: 'refreshed' }))).toBe('Refreshed copy');
    expect(sourceLabel(status({ source: 'none' }))).toBe('None available');
  });

  test('the note leads with the problem, and says so when refresh is off', () => {
    expect(packNote(status({ provisioned: false }))).toContain("can't verify");
    expect(packNote(status({ source: 'none', bundledProblem: 'signature mismatch' }))).toBe('signature mismatch');
    expect(packNote(status({ autoRefresh: false }))).toContain('refresh is off');
    expect(packNote(status())).toContain('signature verifies');
  });

  test('each switch says what it contacts and that nothing about the person is sent', () => {
    expect(AUTO_REFRESH_EXPLAINER).toContain('GitHub');
    expect(AUTO_REFRESH_EXPLAINER).toContain('Nothing about you');
    expect(LIVE_LOOKUPS_EXPLAINER).toContain("Nova's public pages");
    expect(LIVE_LOOKUPS_EXPLAINER).toContain('sends nothing about you');
  });

  test('calibration rows: ratio is a multiplier, in-use first, input untouched', () => {
    expect(ratioLabel(1043)).toBe('×1.04');
    const input = [row('a', 5, false), row('b', 40, true), row('c', 30, false)];
    const copy = [...input];
    expect(sortCalibration(input).map((r) => r.model)).toEqual(['b', 'c', 'a']);
    expect(input).toEqual(copy);
  });
});

describe('Knowledge tab wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/pages/settings/Knowledge.tsx', import.meta.url)),
    'utf8',
  );

  test('is on the rail', () => {
    expect(SECTIONS.map((s) => s.id)).toContain('knowledge');
  });

  test('every control calls its native binding', () => {
    for (const fn of [
      'knowledgeSetAutoRefresh',
      'knowledgeSetLiveLookups',
      'knowledgeCheckNow',
      'calibrationReset',
      'calibrationStatus',
      'knowledgeStatus',
    ]) {
      expect(src, fn).toContain(fn);
    }
  });

  test('both switches are labelled for assistive tech and the check button exists', () => {
    expect(src).toContain('Refresh Nova knowledge automatically');
    expect(src).toContain("Look up current information from Nova's public pages");
    expect(src).toContain('Check now');
    expect(src).toContain('Reset token accuracy');
  });
});
