/**
 * How Atlas presents itself alongside you — never what it can do.
 *
 * Every role reaches the exact same skill registry; the executor, the risk
 * model, and every skill's own phrasing are unaffected. The only thing a role
 * changes is the opening line `Phrasing.greeting()` reaches for when there is
 * no custom greeting (`VoiceProfile.greeting`) to use instead — the one
 * sentence Atlas says before anything has been asked of it, where a
 * relationship ("we", "I'm with you") reads differently from a straight
 * question ("what do you need?").
 *
 * `assistant` reproduces the exact sentence Atlas has always opened with —
 * `Hey {userName} — I'm {atlasName}. What do you need?` — so a profile that
 * never sets a role sees no behavior change. It is also why this stays a
 * seven-way pick rather than a free-text "personality" field: each of the
 * other six is a deliberately small, hand-written variation on that one line,
 * not a system that can drift into a tone nobody chose.
 */
export type AtlasRole =
  | 'assistant'
  | 'pilot'
  | 'coPilot'
  | 'companion'
  | 'navigator'
  | 'partner'
  | 'operator';

export const DEFAULT_ATLAS_ROLE: AtlasRole = 'assistant';

/** Settings order — `assistant` first because it is the no-change default. */
export const ATLAS_ROLES: readonly AtlasRole[] = [
  'assistant',
  'pilot',
  'coPilot',
  'companion',
  'navigator',
  'partner',
  'operator',
];

export interface AtlasRoleMeta {
  icon: string;
  label: string;
  /** The relationship, not a feature list — shown next to the label in Settings. */
  feeling: string;
  /**
   * The opening line, in place of "Hey {name} — I'm {atlasName}. What do you
   * need?". Takes `atlasName` even though most roles don't say it, so
   * `assistant` can reproduce the original sentence exactly rather than
   * approximating it.
   */
  greeting(atlasName: string, userName?: string): string;
  /**
   * The sign-off `smallTalk('goodbye', ...)` reaches for instead of its
   * generic rotation. Optional and absent on `assistant` on purpose — the
   * same reason `assistant` has no distinct greeting variation: the default
   * role changes nothing about how Atlas already talked. A role picks up a
   * farewell only when it is deliberately given one, never by falling back
   * to a generated tone.
   */
  farewell?(userName?: string): string;
}

export const ATLAS_ROLE_META: Record<AtlasRole, AtlasRoleMeta> = {
  assistant: {
    icon: '🎯',
    label: 'Assistant',
    feeling: 'Straightforward and practical.',
    greeting: (atlasName, userName) =>
      userName
        ? `Hey ${userName} — I'm ${atlasName}. What do you need?`
        : `Hey — I'm ${atlasName}. What do you need?`,
  },
  pilot: {
    icon: '🧭',
    label: 'Pilot',
    feeling: 'Capable, proactive, focused.',
    greeting: (_atlasName, userName) =>
      userName ? `We're ready, ${userName}. What's the objective?` : "We're ready. What's the objective?",
    farewell: (userName) =>
      userName ? `Standing down, ${userName}. Call when you're ready.` : "Standing down. Call when you're ready.",
  },
  coPilot: {
    icon: '✈️',
    label: 'Co-Pilot',
    feeling: 'Works alongside you.',
    greeting: (_atlasName, userName) =>
      userName ? `I'm with you, ${userName}. What should we tackle?` : "I'm with you. What should we tackle?",
    farewell: (userName) =>
      userName ? `Signing off, ${userName} — shout if you need me.` : 'Signing off — shout if you need me.',
  },
  companion: {
    icon: '🤝',
    label: 'Companion',
    feeling: 'Friendly, conversational.',
    greeting: (_atlasName, userName) =>
      userName ? `Hey ${userName}! What are you working on?` : 'Hey! What are you working on?',
    farewell: (userName) => (userName ? `Catch you later, ${userName}!` : 'Catch you later!'),
  },
  navigator: {
    // Not the same compass as Pilot's — this one is about finding things,
    // Pilot's is about flying. Sharing an icon would make the picker look
    // like it had a typo in it.
    icon: '🗺️',
    label: 'Navigator',
    feeling: 'Guides you and helps you find things.',
    greeting: (_atlasName, userName) =>
      userName ? `Where should we go, ${userName}?` : 'Where should we go?',
    farewell: (userName) =>
      userName
        ? `I'll be here when you're ready to move again, ${userName}.`
        : "I'll be here when you're ready to move again.",
  },
  partner: {
    icon: '🧠',
    label: 'Partner',
    feeling: 'Collaborative, problem-solving.',
    greeting: (_atlasName, userName) =>
      userName ? `Let's figure it out, ${userName}.` : "Let's figure it out.",
    farewell: (userName) =>
      userName ? `Good session, ${userName}. I'm around when you need me.` : "Good session. I'm around when you need me.",
  },
  operator: {
    icon: '🛠️',
    label: 'Operator',
    feeling: 'Task-focused and efficient.',
    greeting: (_atlasName, userName) =>
      userName ? `Ready, ${userName}. What's the task?` : "Ready. What's the task?",
    farewell: (userName) => (userName ? `Standing by, ${userName}.` : 'Standing by.'),
  },
};

/** Defends a value read back from storage — a hand-edited file, an older build. */
export function isAtlasRole(value: unknown): value is AtlasRole {
  return typeof value === 'string' && (ATLAS_ROLES as readonly string[]).includes(value);
}
