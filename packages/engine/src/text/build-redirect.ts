/**
 * "There is not an app, you have to build it."
 *
 * After "I couldn't find an app called X" the person's next words are often not a better name but
 * an instruction: the thing does not exist yet, so make it. Read as a name, that sentence became
 * "I couldn't find an app called “there is not app, you have to build it”". These are the few ways of
 * saying it, recognised so they can be turned into the build request they are.
 *
 * Deliberately narrow: a sentence has to say that the thing is missing or tell Atlas to build/make/
 * create "it". Anything else is still taken as a name.
 */

import { chooseTemplate } from '../templates';

const MAKE = String.raw`(?:build|make|create|write|code|develop|generate)`;

/** "there is not an app, you have to build it" / "it doesn't exist, make it" / "no app, build it". */
const MISSING_THEN_BUILD = new RegExp(
  String.raw`^\s*(?:(?:no|nope|well|so|ok(?:ay)?|but|hey)[,.!]?\s+)*` +
    String.raw`(?:there\s+(?:is|'s|isn't|is\s+not|are\s+no|is\s+no|isn't\s+one)|there's\s+(?:no|not)|it\s+(?:doesn't|does\s+not|isn't|is\s+not)|that\s+(?:doesn't|does\s+not|isn't|is\s+not)|(?:i\s+)?(?:don't|do\s+not)\s+have|no\s+such|(?:no|not)\s+(?:an?\s+)?(?:app|application|program|game|one)|nothing\s+(?:like\s+that|called))` +
    String.raw`[^.?!]*?\b${MAKE}\b[^.?!]*[.!?]*$`,
  'i',
);

/** "build it" / "you have to build it" / "just make it yourself" / "then create one for me". */
const JUST_BUILD_IT = new RegExp(
  String.raw`^\s*(?:(?:no|nope|well|so|then|ok(?:ay)?|but|just|please)[,.!]?\s+)*` +
    String.raw`(?:(?:you|u)\s+(?:have|need|should|must|gotta)\s+to\s+|you\s+(?:can|could|will|should)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?|(?:please\s+)?)` +
    String.raw`${MAKE}\s+(?:it|that|one|this|them)(?:\s+(?:for\s+me|yourself|instead|then|now|please|from\s+scratch|anyway))*\s*[.!?]*$`,
  'i',
);

export function isBuildItRedirect(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 160) return false;
  return JUST_BUILD_IT.test(t) || MISSING_THEN_BUILD.test(t);
}

/** "open Nova.Play" / "launch the Infinite Clicker app" → what was being opened, or null. */
export function openTargetOf(text: string): string | null {
  const m = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:open|launch|start|run|play)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)\s*[.!?]*$/i.exec(text);
  if (!m) return null;
  const name = m[1]!.replace(/\s+(?:app|application|program)$/i, '').trim();
  return name.length >= 2 && name.length <= 60 ? name : null;
}

/** The build request for a thing that was asked to be opened and does not exist. */
export function buildSentenceFor(name: string): string {
  return chooseTemplate(name) ? `build me ${name}` : `build me an app called ${name}`;
}
