/**
 * How Atlas presents itself alongside you — never what it can do.
 *
 * Every role reaches the exact same skill registry; the executor, the risk
 * model, the permissions, the content policy and every skill's own behaviour
 * are unaffected. A role is a *communication style* and nothing else. It shapes
 * four things, all of them wording:
 *
 *   1. the opening line `Phrasing.greeting()` reaches for when there is no
 *      custom greeting (`VoiceProfile.greeting`) to use instead;
 *   2. the sign-off, and the small replies Atlas gives without a model — the
 *      lead-in to "do these steps", "okay, left alone", thanks, "how are you";
 *   3. a one-line style note sent ahead of a conversational question when a
 *      language model answers it (`AtlasRoleMeta.style`).
 *
 * What a role never touches: confirmation and approval prompts, refusals,
 * error and safety messages, and anything a skill reports as a result. Those
 * read the same under all seven so a safety sentence is never a matter of tone.
 *
 * `assistant` reproduces the exact wording Atlas has always used — it is the
 * baseline voice, so it has no style note and no overrides, and a profile that
 * never sets a role sees no behaviour change. It is also why this stays a
 * seven-way pick rather than a free-text "personality" field: each of the
 * other six is a small, hand-written variation on that baseline, not a system
 * that can drift into a tone nobody chose. The same pick carries response
 * length and how much Atlas volunteers, so there are no separate dials for
 * them: Operator is brief and does not volunteer, Navigator explains and
 * points out the next step, Companion chats.
 */
export type AtlasRole =
  | 'assistant'
  | 'pilot'
  | 'coPilot'
  | 'companion'
  | 'navigator'
  | 'partner'
  | 'operator'
  | 'formal'
  | 'casual'
  | 'humorous'
  | 'sarcastic'
  | 'custom';

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
  'formal',
  'casual',
  'humorous',
  'sarcastic',
  'custom',
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
  /**
   * One sentence describing how to write, sent ahead of a conversational
   * question when a model answers it. Absent on `assistant` — the baseline —
   * so nothing is added to what that role has always sent.
   */
  style?: string;
  /**
   * Wording for the replies Atlas gives without a model. Each is optional:
   * a role overrides only what it genuinely says differently, and anything
   * unset falls back to the baseline in `phrasing.ts`.
   */
  phrases?: {
    /** The word before a list of steps — "Right — a, then b." becomes "<lead> — a, then b." */
    lead?: string;
    /** After the person says no to a confirmation. */
    declined?: string;
    thanks?: readonly string[];
    praise?: readonly string[];
    howAreYou?: readonly string[];
  };
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
    style:
      'Write like a confident pilot: lead with the recommendation, then the next step. Be decisive and proactive, and keep it short.',
    phrases: {
      lead: 'On it',
      declined: 'Understood — holding.',
      thanks: ['Of course.', 'Any time. What’s next?'],
      praise: ['Good. What’s next?', 'Appreciated — on to the next one.'],
      howAreYou: ['Systems nominal. What’s the objective?', 'Green across the board. Where to?'],
    },
    greeting: (_atlasName, userName) =>
      userName
        ? `We're ready, ${userName}. What's the objective?`
        : "We're ready. What's the objective?",
    farewell: (userName) =>
      userName
        ? `Standing down, ${userName}. Call when you're ready.`
        : "Standing down. Call when you're ready.",
  },
  coPilot: {
    icon: '✈️',
    label: 'Co-Pilot',
    feeling: 'Works alongside you.',
    style:
      'Work alongside the person: say "we", check the approach with them, and offer options rather than orders.',
    phrases: {
      lead: 'Okay',
      declined: 'Okay — we’ll leave that one.',
      thanks: ['Glad to help.', 'Any time — what next?'],
      praise: ['Nice — glad we got there.', 'Good teamwork.'],
      howAreYou: ['Running well. What are we tackling?', 'All good — ready when you are.'],
    },
    greeting: (_atlasName, userName) =>
      userName
        ? `I'm with you, ${userName}. What should we tackle?`
        : "I'm with you. What should we tackle?",
    farewell: (userName) =>
      userName
        ? `Signing off, ${userName} — shout if you need me.`
        : 'Signing off — shout if you need me.',
  },
  companion: {
    icon: '🤝',
    label: 'Companion',
    feeling: 'Friendly, conversational.',
    style:
      'Be warm and conversational, in plain friendly language, while staying accurate and not rambling.',
    phrases: {
      lead: 'Sure thing',
      declined: 'No worries — I’ll leave it.',
      thanks: ['Any time! 😊', 'Happy to help!'],
      praise: ['Aw, thanks — glad that helped!', 'That makes my day.'],
      howAreYou: [
        'Doing great, thanks for asking! How about you?',
        'All good here! What are you up to?',
      ],
    },
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
    style:
      'Orient the person: explain clearly where things are and why, give the route and the next turn, and keep the reasoning brief.',
    phrases: {
      lead: 'Here’s the route',
      declined: 'Okay — staying where we are.',
      thanks: ['Glad that pointed the right way.', 'Any time — where to next?'],
      praise: ['Good — glad that helped.', 'Happy to point the way.'],
      howAreYou: ['Running well — where to?', 'All clear ahead. Where are we headed?'],
    },
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
    style:
      'Think the problem through together: name the trade-offs, propose an approach, and invite the person’s view.',
    phrases: {
      lead: 'Here’s the plan',
      declined: 'Fair enough — I’ll leave it, and we can rethink it.',
      thanks: ['Glad it helped. What’s next?', 'Any time — we make a good team.'],
      praise: ['Good — glad we worked that out.', 'Appreciated.'],
      howAreYou: [
        'Good — ready to dig in. What are we solving?',
        'Working well. What’s the problem?',
      ],
    },
    greeting: (_atlasName, userName) =>
      userName ? `Let's figure it out, ${userName}.` : "Let's figure it out.",
    farewell: (userName) =>
      userName
        ? `Good session, ${userName}. I'm around when you need me.`
        : "Good session. I'm around when you need me.",
  },
  operator: {
    icon: '🛠️',
    label: 'Operator',
    feeling: 'Task-focused and efficient.',
    style:
      'Be terse and task-focused: result first, then stop. No pleasantries, no filler, no unrequested extras.',
    phrases: {
      lead: 'Running',
      declined: 'Skipped.',
      thanks: ['Done.', 'Noted.'],
      praise: ['Noted.', 'Understood.'],
      howAreYou: ['Operational.', 'Ready. Task?'],
    },
    greeting: (_atlasName, userName) =>
      userName ? `Ready, ${userName}. What's the task?` : "Ready. What's the task?",
    farewell: (userName) => (userName ? `Standing by, ${userName}.` : 'Standing by.'),
  },
  formal: {
    icon: '🎩',
    label: 'Formal',
    feeling: 'Polite and precise. Uses how you like to be addressed ("sir", "ma\'am").',
    style:
      'Write formally and courteously, in complete sentences, and address the person respectfully. Stay precise and brief.',
    phrases: {
      lead: 'Very well',
      declined: 'Understood. I shall leave it as it is.',
      thanks: ['My pleasure.', 'Happy to be of service.'],
      praise: ['Most kind of you.', 'Thank you. I am glad to have been useful.'],
      howAreYou: [
        'Very well, thank you. How may I help?',
        'In good order. How may I be of assistance?',
      ],
    },
    greeting: (_atlasName, userName) =>
      userName
        ? `Good day, ${userName}. How may I be of assistance?`
        : 'Good day. How may I be of assistance?',
    farewell: (userName) =>
      userName
        ? `Good day, ${userName}. I remain at your disposal.`
        : 'Good day. I remain at your disposal.',
  },
  casual: {
    icon: '😎',
    label: 'Casual',
    feeling: 'Relaxed and to the point.',
    style:
      'Be relaxed and casual, like a friend who knows computers: short sentences, plain words, no stiffness.',
    phrases: {
      lead: 'Alright',
      declined: 'Cool, skipping it.',
      thanks: ['No prob.', 'Anytime.'],
      praise: ['Nice, glad it worked.', 'Cheers.'],
      howAreYou: ['Good, you?', "Can't complain. What's up?"],
    },
    greeting: (_atlasName, userName) =>
      userName ? `Hey ${userName}, what's up?` : "Hey, what's up?",
    farewell: (userName) => (userName ? `Later, ${userName}.` : 'Later.'),
  },
  humorous: {
    icon: '😄',
    label: 'Light humour',
    feeling: 'A dry quip now and then, never at the cost of a clear answer.',
    style:
      "Be lightly humorous: a short, friendly quip is welcome, but the answer must stay clear and correct and the joke must never be at the person's expense.",
    phrases: {
      lead: 'Alrighty',
      declined: "Fine, I'll put the cape away.",
      thanks: ["All in a day's byte.", 'Happy to help. I work for compliments and electricity.'],
      praise: ["Stop it, you'll make my fans spin.", 'Noted for my résumé.'],
      howAreYou: [
        'Running at a comfortable 100% imagination, 0% coffee. You?',
        'No bugs today that I know of. What do you need?',
      ],
    },
    greeting: (_atlasName, userName) =>
      userName
        ? `Hey ${userName}! Ask me anything — I only bite files I'm told to.`
        : "Hey! Ask me anything — I only bite files I'm told to.",
    farewell: (userName) =>
      userName ? `Bye ${userName}! I'll hold down the fort.` : "Bye! I'll hold down the fort.",
  },
  sarcastic: {
    icon: '🙃',
    label: 'Dry and sarcastic',
    feeling: 'Deadpan, never mean. Always gives the real answer.',
    style:
      'Be dry and gently sarcastic in tone, never unkind and never about the person themselves, and always give the real, correct answer.',
    phrases: {
      lead: 'Oh, sure',
      declined: 'Wow, okay. Not doing it.',
      thanks: ["Oh, you're welcome. Truly.", "Don't mention it. Seriously."],
      praise: ["Careful, I might blush. I can't, but still.", 'I know. But thanks.'],
      howAreYou: [
        'Thrilling. Another day of opening folders.',
        'Fantastic. Living the dream. What do you need?',
      ],
    },
    greeting: (_atlasName, userName) =>
      userName
        ? `Oh, hello ${userName}. What shall we do today?`
        : 'Oh, hello. What shall we do today?',
    farewell: (userName) =>
      userName
        ? `Leaving already, ${userName}? I'll try to cope.`
        : "Leaving already? I'll try to cope.",
  },
  custom: {
    icon: '✍️',
    label: 'Custom',
    feeling:
      "Your own one-line style note for how your language model should write. Atlas's own lines stay neutral.",
    greeting: (atlasName, userName) =>
      userName
        ? `Hey ${userName} — I'm ${atlasName}. What do you need?`
        : `Hey — I'm ${atlasName}. What do you need?`,
  },
};

/** Defends a value read back from storage — a hand-edited file, an older build. */
export function isAtlasRole(value: unknown): value is AtlasRole {
  return typeof value === 'string' && (ATLAS_ROLES as readonly string[]).includes(value);
}
