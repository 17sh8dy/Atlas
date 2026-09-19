/**
 * What Atlas remembers about speaking: whether to, in whose voice, how fast,
 * how loud.
 *
 * Same `MemoryStore`-backed `Fact` pattern as `preferences.ts` and
 * `local-ai-settings.ts` — subject-keyed, `kind: 'preference'` — rather than a
 * fourth place that settings can live. Several modules sharing one store is
 * the reason "where is that setting saved?" still has a single answer.
 *
 * Values are read defensively on the way out. A preferences file is a plain
 * JSON document on disk that a person can edit, so a pace of `"fast"` or a
 * voice id that was renamed between versions has to degrade to the default
 * rather than reach the synthesiser.
 */

import type { Storage, SpeechPreferences } from '@atlas/core';
import { DEFAULT_SPEECH } from '@atlas/core';
import { MemoryStore } from './memory-store';

const ENABLED = 'speech.enabled';
const VOICE = 'speech.voiceId';
const PACE = 'speech.pace';
const VOLUME = 'speech.volume';

export async function readSpeechPreferences(storage: Storage): Promise<SpeechPreferences> {
  const memory = new MemoryStore(storage);
  const [enabled, voiceId, pace, volume] = await Promise.all([
    memory.fact('preference', ENABLED),
    memory.fact('preference', VOICE),
    memory.fact('preference', PACE),
    memory.fact('preference', VOLUME),
  ]);

  const parsedPace = Number(pace?.value);
  const parsedVolume = Number(volume?.value);

  return {
    enabled: enabled?.value === 'true',
    voiceId: voiceId?.value?.trim() || DEFAULT_SPEECH.voiceId,
    // Matches the clamp on the Rust side. Out of range or unparseable means
    // the default, never silence.
    pace: Number.isFinite(parsedPace)
      ? Math.min(Math.max(parsedPace, 0.6), 2)
      : DEFAULT_SPEECH.pace,
    // Same defensive read. Note the floor is 0, which is a legitimate choice
    // (mute) rather than a bad value — only a non-number falls back.
    volume: Number.isFinite(parsedVolume)
      ? Math.min(Math.max(parsedVolume, 0), 1)
      : DEFAULT_SPEECH.volume,
  };
}

export async function writeSpeechPreferences(
  storage: Storage,
  next: Partial<SpeechPreferences>,
): Promise<void> {
  const memory = new MemoryStore(storage);
  if (next.enabled !== undefined) {
    await memory.remember('preference', ENABLED, String(next.enabled));
  }
  if (next.voiceId !== undefined) {
    await memory.remember('preference', VOICE, next.voiceId);
  }
  if (next.pace !== undefined) {
    await memory.remember('preference', PACE, String(next.pace));
  }
  if (next.volume !== undefined) {
    await memory.remember('preference', VOLUME, String(next.volume));
  }
}
