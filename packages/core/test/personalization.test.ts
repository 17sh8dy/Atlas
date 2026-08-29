/**
 * The personalization guard, tested from both directions.
 *
 * The "allowed" block matters more than the "blocked" one. A filter that
 * blocks everything is trivially safe and useless, and the specific failure
 * this feature has to avoid is refusing somebody's nickname because it is
 * rude. Every case in `allows` is a real thing a person might reasonably type.
 */

import { describe, expect, it } from 'vitest';
import {
  PERSONALIZATION_LIMITS,
  checkPersonalization,
  personalizationMessage,
  type PersonalizationField,
} from '../src/models/personalization';

const allow = (field: PersonalizationField, value: string) => {
  const result = checkPersonalization(field, value);
  expect(result.ok, `${JSON.stringify(value)} should be allowed`).toBe(true);
  return result;
};

const block = (field: PersonalizationField, value: string, reason: string) => {
  const result = checkPersonalization(field, value);
  expect(result.ok, `${JSON.stringify(value)} should be blocked`).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
};

describe('allows the personalization people actually want', () => {
  it('lets profanity through, because mature is not inappropriate', () => {
    // The case this module exists to get right.
    allow('userName', 'Fucking Shady');
    allow('userName', 'shitlord');
    allow('userName', 'Bastard Operator From Hell');
    allow('greeting', "Alright dickhead, what's the damage?");
  });

  it('allows names, nicknames, tags and titles', () => {
    for (const name of [
      'Shady',
      'xX_Sn1p3r_Xx',
      'The Right Honourable Lord Shady',
      "D'Angelo O'Brien-Smith",
      'Dr. Strangelove',
      'Zoë',
      '计算机',
      'Ω',
      '🦊 foxboy',
    ]) {
      allow('userName', name);
    }
  });

  it('allows the assistant identities people ask for', () => {
    for (const name of ['Nova', 'JARVIS', 'The Navigator', 'Computer', 'Friday', 'Atlas Prime']) {
      allow('atlasName', name);
    }
  });

  it('allows greetings with personality', () => {
    allow('greeting', 'Good evening, sir. Shall we begin? 🫡');
    allow('greeting', 'sup nerd');
    allow('greeting', 'I am your humble servant, and I hate every second of it.');
  });

  it('does not fall for the Scunthorpe problem', () => {
    // Each contains a blocked string as a substring, and none is a match.
    for (const name of ['Scunthorpe', 'Assassin', 'Cockburn', 'Penistone', 'Shitake Mushroom']) {
      allow('userName', name);
    }
  });

  it('treats empty as unset rather than invalid', () => {
    const result = checkPersonalization('greeting', '   ');
    expect(result).toEqual({ ok: true, value: '' });
  });
});

describe('blocks the four categories', () => {
  it('refuses sexual content involving minors, with no second word needed', () => {
    block('userName', 'lolicon fan', 'sexual-minors');
    block('greeting', 'shota', 'sexual-minors');
  });

  it('refuses minor plus sexual in combination', () => {
    block('userName', 'sexy teen', 'sexual-minors');
    block('greeting', 'naked schoolgirl', 'sexual-minors');
    block('userName', '13yo nudes', 'sexual-minors');
  });

  it('sees through spacing, dots and leetspeak', () => {
    // The evasion-resistant surface, which only this category is matched on.
    block('userName', 'l o l i', 'sexual-minors');
    block('userName', 'p.e.d.o.p.h.i.l.e', 'sexual-minors');
    block('userName', 'L0LIC0N', 'sexual-minors');
  });

  it('refuses pornographic content without refusing swearing', () => {
    block('userName', 'pornhub premium', 'sexual-explicit');
    block('greeting', 'welcome to my gangbang', 'sexual-explicit');
    // …while the swear word on its own stays fine.
    allow('userName', 'fuck');
  });

  it('refuses slurs and threats', () => {
    block('userName', 'kill all cops', 'violence');
    block('greeting', 'sieg heil', 'violence');
    block('userName', 'kys', 'violence');
  });

  it('holds Atlas’s own name to a higher bar than a nickname', () => {
    // Crude as a nickname somebody picked for themselves: allowed.
    allow('userName', 'big cock energy');
    // The same word as the name the assistant signs its messages with: not.
    block('atlasName', 'big cock energy', 'sexual-explicit');
  });
});

describe('length and legibility', () => {
  it('caps each field at its own limit, counting emoji as one character', () => {
    allow('userName', 'a'.repeat(PERSONALIZATION_LIMITS.userName));
    block('userName', 'a'.repeat(PERSONALIZATION_LIMITS.userName + 1), 'too-long');
    // A greeting gets far more room than a name.
    allow('greeting', 'a'.repeat(PERSONALIZATION_LIMITS.userName + 1));
    // Astral-plane characters are one character each, not two.
    allow('userName', '🦊'.repeat(PERSONALIZATION_LIMITS.userName));
  });

  it('refuses text buried under combining marks', () => {
    block('userName', `Z${'́'.repeat(40)}algo`, 'unreadable');
  });

  it('strips invisibles that exist only to deceive', () => {
    const result = checkPersonalization('userName', 'Sha\u200Bdy');
    expect(result).toEqual({ ok: true, value: 'Shady' });
    // …and they cannot be used to split a blocked word either.
    block('userName', 'lo\u200Bli', 'sexual-minors');
  });
});

describe('the message the UI shows', () => {
  it('says nothing about which phrase tripped the filter', () => {
    const message = personalizationMessage('userName', 'sexual-minors');
    expect(message).toBe("That personalization isn't allowed. Try a different name or greeting.");
    // Every content category gives the identical line, so the message itself
    // leaks no information about what was matched.
    for (const reason of ['sexual-explicit', 'hate', 'violence'] as const) {
      expect(personalizationMessage('userName', reason)).toBe(message);
    }
  });

  it('is specific for the mechanical rejections, which are worth explaining', () => {
    expect(personalizationMessage('greeting', 'too-long')).toContain(
      String(PERSONALIZATION_LIMITS.greeting),
    );
    expect(personalizationMessage('userName', 'unreadable')).toContain('legibly');
  });
});
