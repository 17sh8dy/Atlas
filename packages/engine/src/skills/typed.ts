import type { Platform } from '@atlas/core';

/**
 * What to say after typing: the text, exactly as it was sent, and which window
 * was in front when it went. The window is read back after the fact — it is a
 * report of where the keystrokes landed, not a promise about what is now on
 * screen, which Atlas cannot see.
 */
export async function typedMessage(platform: Platform, text: string): Promise<string> {
  const shown = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  const front = (await platform.activeWindow?.().catch(() => null))?.title?.trim();
  return front ? `Typed “${shown}” — in front: “${front}”.` : `Typed “${shown}”.`;
}
