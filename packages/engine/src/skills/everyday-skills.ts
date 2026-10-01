/**
 * Email and calendar, without an account.
 *
 * Atlas does not sign in to anyone's mail or calendar, and does not send on a
 * person's behalf — that needs a per-provider login and is on the always-ask
 * list. What it can do honestly, and what is genuinely useful, is get you to the
 * last step: open a **new message already addressed and worded** in your own
 * mail app, or open a **calendar event already filled in** in your own calendar.
 * You press Send, or Save. Nothing leaves the machine until you do.
 */

import type { Platform, Skill } from '@atlas/core';
import { parseWhen } from '../text/when';

const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/;

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

/** RFC 5545 text escaping. */
const ics = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The text of a one-event calendar file, in local ("floating") time. */
export function buildIcs(title: string, start: Date, minutes: number, where?: string, now: Date = new Date()): string {
  const end = new Date(start.getTime() + minutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Atlas//Assistant//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}@atlas.local`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${ics(title)}`,
    ...(where ? [`LOCATION:${ics(where)}`] : []),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${ics(title)}`,
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

export function createEverydaySkills(platform: Platform, now: () => Date = () => new Date()): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'mail.compose',
    label: 'Write an email',
    icon: '✉️',
    domain: 'comms',
    description:
      'Open a new email in your mail app, already addressed and filled in. It does not send anything — you read it and press Send.',
    needs: ['network'],
    risk: 'safe',
    examples: ['email bob@example.com about the meeting'],
    params: {
      to: { type: 'string', required: false, description: 'who to, separated by commas' },
      subject: { type: 'string', required: false, description: 'the subject line' },
      body: { type: 'string', required: false, description: 'what it says' },
    },
    async run(args) {
      const to = String(args.to ?? '')
        .split(/[\s,;]+/)
        .filter(Boolean);
      const bad = to.find((a) => !EMAIL.test(a));
      if (bad) return { ok: false, error: `“${bad}” doesn't look like an email address.` };
      if (to.length > 5) return { ok: false, error: "I'll address an email to at most five people." };
      const subject = String(args.subject ?? '').slice(0, 200);
      const body = String(args.body ?? '').slice(0, 1500);
      const query = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean).join('&');
      const url = `mailto:${to.map(encodeURIComponent).join(',')}${query ? `?${query}` : ''}`;
      try {
        const ok = await platform.openUrl!(url);
        if (!ok) return { ok: false, error: "I couldn't open your mail app." };
        return {
          ok: true,
          message: `✉️ Opened a new email${to.length ? ` to ${to.join(', ')}` : ''}${subject ? ` — “${subject}”` : ''}. I haven't sent it; that's yours to do.`,
        };
      } catch (e) {
        return fail(e, "I couldn't open your mail app.");
      }
    },
  });

  skills.push({
    id: 'calendar.add',
    label: 'Add to my calendar',
    icon: '📅',
    domain: 'comms',
    description:
      'Make a calendar event from a title and a time, and open it in your calendar app to save. It does not log in to anything.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['add dentist to my calendar tomorrow at 3pm'],
    params: {
      title: { type: 'string', required: true, description: 'what the event is' },
      when: { type: 'string', required: true, description: 'when, in words: "tomorrow at 3pm", "friday at 2"' },
      minutes: { type: 'number', required: false, description: 'how long, default 60' },
      where: { type: 'string', required: false, description: 'a location' },
    },
    async run(args) {
      const title = String(args.title ?? '').trim().slice(0, 200);
      if (!title) return { ok: false, error: 'What is the event called?' };
      const when = parseWhen(String(args.when ?? ''), now());
      if (!when) {
        return { ok: false, error: `I couldn't tell when “${String(args.when ?? '')}” is. Try "tomorrow at 3pm" or "friday at 2".` };
      }
      const minutes = Math.min(24 * 60, Math.max(5, Math.round(Number(args.minutes ?? 60)) || 60));
      const text = buildIcs(title, new Date(when.at), minutes, args.where ? String(args.where).slice(0, 200) : undefined, now());
      try {
        const docs = await platform.knownFolder!('documents');
        const dir = `${docs.replace(/[\\/]+$/, '')}\\Atlas Events`;
        await platform.createFolder!(dir).catch(() => false); // already there is fine
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
        const path = `${dir}\\${slug}-${now().getTime().toString(36)}.ics`;
        await platform.createFile!(path, text);
        const opened = await platform.openPath!(path);
        const when_ = new Date(when.at).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return {
          ok: true,
          message: opened
            ? `📅 Opened “${title}” for ${when_} in your calendar — press Save there. (The file is in Documents\\Atlas Events.)`
            : `📅 Made “${title}” for ${when_}, saved in Documents\\Atlas Events — open it to add it to your calendar.`,
          data: path,
        };
      } catch (e) {
        return fail(e, "I couldn't make that calendar event.");
      }
    },
  });

  return skills;
}
