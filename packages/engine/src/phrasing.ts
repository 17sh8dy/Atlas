/**
 * The one place that owns how Atlas talks.
 *
 * Every response used to be a literal string sitting wherever it happened to
 * be said — a skill's success message, the executor's confirmation prompt.
 * That works until two things need to agree (a name, a tone), so this module
 * is the single source both the executor and the core skills read from
 * instead of writing their own copies.
 *
 * Named `phrasing` rather than `voice` on purpose — a future audio layer
 * (text-to-speech, speech recognition) is a different, unbuilt thing, and
 * reusing the word here would make that later feature impossible to name
 * without confusion.
 */

import type { VoiceProfile } from '@atlas/core';

export interface Phrasing {
  opening(name: string): string;
  revealing(name: string): string;
  copied(): string;
  rightThen(stepLabels: string[]): string;
  declined(): string;
  failed(detail: string): string;
  /** What Atlas says the first time a conversation opens. */
  greeting(): string;
}

/**
 * Builds the phrasing table for a given personalization profile.
 *
 * Called with no profile (or an empty one), every string below is
 * byte-identical to what Atlas said before this module existed — that
 * constraint is deliberate, and the engine's tests hold it in place.
 */
export function createPhrasing(profile: VoiceProfile = {}): Phrasing {
  const atlasName = profile.atlasName?.trim() || 'Atlas';
  const userName = profile.userName?.trim();

  return {
    opening: (name) => `Opening ${name}.`,
    revealing: (name) => `Showing ${name} in its folder.`,
    copied: () => '📋 Copied.',

    rightThen: (stepLabels) => {
      const names = [...stepLabels];
      const last = names.pop();
      return `Right — ${names.length ? `${names.join(', ')}, then ${last}` : last}.`;
    },
    declined: () => 'Okay — left alone.',
    failed: (detail) => `⚠️ ${detail}`,

    greeting: () => {
      if (profile.greeting?.trim()) return profile.greeting.trim();
      return userName
        ? `Hey ${userName} — I'm ${atlasName}. What do you need?`
        : `Hey — I'm ${atlasName}. What do you need?`;
    },
  };
}
