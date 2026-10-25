/**
 * Presence rules: only ever quieter than today's behaviour, with alarms as the one thing quiet never silences.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESENCE,
  isQuietNow,
  mayChime,
  mayListenByItself,
  maySpeakUnprompted,
  type PresencePreferences,
} from '../src/models/presence';

const at = (h: number, m = 0) => new Date(2026, 9, 25, h, m);
const withQuiet = (
  from: string,
  to: string,
  over: Partial<PresencePreferences> = {},
): PresencePreferences => ({
  ...DEFAULT_PRESENCE,
  ...over,
  quietHours: { enabled: true, from, to },
});

describe('quiet hours', () => {
  it('are off by default', () => {
    expect(isQuietNow(DEFAULT_PRESENCE.quietHours, at(3))).toBe(false);
  });
  it('a same-day window', () => {
    const q = { enabled: true, from: '13:00', to: '15:00' };
    expect(isQuietNow(q, at(12, 59))).toBe(false);
    expect(isQuietNow(q, at(13, 0))).toBe(true);
    expect(isQuietNow(q, at(14, 59))).toBe(true);
    expect(isQuietNow(q, at(15, 0))).toBe(false);
  });
  it('a window across midnight', () => {
    const q = { enabled: true, from: '22:00', to: '07:00' };
    for (const [h, m, want] of [
      [21, 59, false],
      [22, 0, true],
      [23, 30, true],
      [0, 0, true],
      [6, 59, true],
      [7, 0, false],
      [12, 0, false],
    ] as const) {
      expect(isQuietNow(q, at(h, m)), `${h}:${m}`).toBe(want);
    }
  });
  it('a broken or empty window means never, not always', () => {
    expect(isQuietNow({ enabled: true, from: '22:00', to: '22:00' }, at(22))).toBe(false);
    expect(isQuietNow({ enabled: true, from: 'late', to: '07:00' }, at(2))).toBe(false);
    expect(isQuietNow({ enabled: true, from: '25:00', to: '07:00' }, at(2))).toBe(false);
  });
});

describe('what Atlas may do on its own', () => {
  it('speaks nothing unprompted unless that was switched on', () => {
    expect(maySpeakUnprompted(DEFAULT_PRESENCE, at(12))).toBe(false);
    expect(maySpeakUnprompted({ ...DEFAULT_PRESENCE, speakReminders: true }, at(12))).toBe(true);
  });
  it('never speaks in quiet or privacy mode, or in quiet hours', () => {
    const on = { ...DEFAULT_PRESENCE, speakReminders: true };
    expect(maySpeakUnprompted({ ...on, mode: 'quiet' }, at(12))).toBe(false);
    expect(maySpeakUnprompted({ ...on, mode: 'privacy' }, at(12))).toBe(false);
    expect(maySpeakUnprompted(withQuiet('22:00', '07:00', { speakReminders: true }), at(23))).toBe(
      false,
    );
    expect(maySpeakUnprompted(withQuiet('22:00', '07:00', { speakReminders: true }), at(12))).toBe(
      true,
    );
  });
  it('chimes follow the mode and quiet hours, but an alarm always sounds', () => {
    expect(mayChime(DEFAULT_PRESENCE, at(12), false)).toBe(true);
    expect(mayChime({ ...DEFAULT_PRESENCE, mode: 'quiet' }, at(12), false)).toBe(false);
    expect(mayChime({ ...DEFAULT_PRESENCE, mode: 'quiet' }, at(12), true)).toBe(true);
    expect(mayChime(withQuiet('22:00', '07:00'), at(2), false)).toBe(false);
    expect(mayChime(withQuiet('22:00', '07:00'), at(2), true)).toBe(true);
    expect(mayChime({ ...DEFAULT_PRESENCE, mode: 'privacy' }, at(12), true)).toBe(true);
  });
  it('only privacy stops things listening by themselves', () => {
    expect(mayListenByItself(DEFAULT_PRESENCE)).toBe(true);
    expect(mayListenByItself({ ...DEFAULT_PRESENCE, mode: 'quiet' })).toBe(true);
    expect(mayListenByItself({ ...DEFAULT_PRESENCE, mode: 'privacy' })).toBe(false);
  });
  it('the defaults are exactly what Atlas did before this existed', () => {
    expect(DEFAULT_PRESENCE).toEqual({
      mode: 'active',
      quietHours: { enabled: false, from: '22:00', to: '07:00' },
      speakReminders: false,
      quitOnClose: false,
    });
  });
});
