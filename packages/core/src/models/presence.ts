/**
 * Presence — when Atlas may make itself heard or listen by itself, and what closing the window does.
 *
 * Everything here is a limit on Atlas, never a grant: the defaults reproduce what Atlas has always done
 * (stays resident when its window is closed, no listener, no spoken announcements), and each setting can
 * only make it quieter or more deliberate than that, with ONE exception that is opt-in on its own switch
 * ("speak reminders aloud").
 *
 * ── The modes ──────────────────────────────────────────────────────────────────────────────────────────
 *   active   Atlas behaves as configured: chimes, and spoken reminders if that is switched on.
 *   quiet    No speech and no chimes of its own, except alarms the person set (an alarm that does not make a
 *            sound is not an alarm). Notifications still appear.
 *   privacy  Everything `quiet` is, and nothing starts listening by itself (no double clap, nothing hands-free).
 *            The microphone button still works when pressed.
 * A fourth mode, "presence" (Atlas volunteering things), is left for when there is something to volunteer.
 */

export type PresenceMode = 'active' | 'quiet' | 'privacy';

export const PRESENCE_MODES: readonly PresenceMode[] = ['active', 'quiet', 'privacy'];

export interface QuietHours {
  enabled: boolean;
  /** Local time, 24-hour "HH:MM". The window may cross midnight (22:00 → 07:00). */
  from: string;
  to: string;
}

export interface PresencePreferences {
  mode: PresenceMode;
  quietHours: QuietHours;
  /** Read a reminder, timer or watch result aloud when it fires. Off unless chosen. */
  speakReminders: boolean;
  /** The window's close button quits Atlas instead of putting it away. Off = stay resident (today's behaviour). */
  quitOnClose: boolean;
}

export const DEFAULT_PRESENCE: PresencePreferences = {
  mode: 'active',
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  speakReminders: false,
  quitOnClose: false,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value: string): boolean {
  return HHMM.test(value);
}

function minutesOf(value: string): number | null {
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Is `now` inside the person's quiet hours? An invalid or equal pair means never, not always. */
export function isQuietNow(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === null || to === null || from === to) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** May something start listening to the microphone without a button press? */
export function mayListenByItself(prefs: PresencePreferences): boolean {
  return prefs.mode !== 'privacy';
}

/** May Atlas speak a reminder aloud right now? */
export function maySpeakUnprompted(prefs: PresencePreferences, now: Date): boolean {
  return prefs.speakReminders && prefs.mode === 'active' && !isQuietNow(prefs.quietHours, now);
}

/** May Atlas play one of its own chimes for a notification? Alarms always may. */
export function mayChime(prefs: PresencePreferences, now: Date, isAlarm: boolean): boolean {
  if (isAlarm) return true;
  return prefs.mode === 'active' && !isQuietNow(prefs.quietHours, now);
}
