/**
 * What Atlas remembers about listening, and about where voice work happens.
 *
 * Same `MemoryStore`-backed `Fact` pattern as `speech-preferences.ts` —
 * subject-keyed, `kind: 'preference'` — rather than a new place for settings
 * to live. Read defensively on the way out for the same reason: a preferences
 * file is a plain JSON document a person can edit, and a hand-typed
 * `silenceMs` of `"quick"` must degrade to the default rather than reach the
 * gate that decides when you have finished talking.
 *
 * ⚠️ `listening.enabled` and `voice.online` both default to **false**, and the
 * read is written so that a missing, malformed, or half-written file produces
 * false rather than true. That asymmetry is deliberate: every other preference
 * here can fail safe in either direction, but a corrupt file must never be
 * able to open a microphone or reach a network.
 */

import type { Storage, ListeningPreferences } from '@atlas/core';
import { ACTIVATION_MODES, DEFAULT_LISTENING, validWakePhrase } from '@atlas/core';
import type { ActivationMode } from '@atlas/core';
import { MemoryStore } from './memory-store';

const ENABLED = 'listening.enabled';
const HANDS_FREE = 'listening.handsFree';
const BARGE_IN = 'listening.bargeIn';
const SILENCE = 'listening.silenceMs';
const ACTIVATION = 'listening.activation';
const CLAP_SENSITIVITY = 'listening.clapSensitivity';
const WAKE_PHRASE = 'listening.wakePhrase';

/** Bounds on the silence gate, matching what the Voice tab's slider offers. */
const MIN_SILENCE = 400;
const MAX_SILENCE = 2500;

export async function readListeningPreferences(storage: Storage): Promise<ListeningPreferences> {
  const memory = new MemoryStore(storage);
  const [enabled, handsFree, bargeIn, silence, activation, clap, wake] = await Promise.all([
    memory.fact('preference', ENABLED),
    memory.fact('preference', HANDS_FREE),
    memory.fact('preference', BARGE_IN),
    memory.fact('preference', SILENCE),
    memory.fact('preference', ACTIVATION),
    memory.fact('preference', CLAP_SENSITIVITY),
    memory.fact('preference', WAKE_PHRASE),
  ]);

  const parsedSilence = Number(silence?.value);
  const parsedClap = Number(clap?.value);

  return {
    // Opt-in, and only on an exact match. Anything else — missing, "1",
    // "yes", a truncated write — leaves the microphone shut.
    enabled: enabled?.value === 'true',
    // These two only matter once `enabled` is true, so they may default on:
    // they shape a session you already asked for.
    handsFree: handsFree ? handsFree.value === 'true' : DEFAULT_LISTENING.handsFree,
    bargeIn: bargeIn ? bargeIn.value === 'true' : DEFAULT_LISTENING.bargeIn,
    silenceMs: Number.isFinite(parsedSilence)
      ? Math.min(Math.max(parsedSilence, MIN_SILENCE), MAX_SILENCE)
      : DEFAULT_LISTENING.silenceMs,
    // Opt-in on an exact match, like `enabled`: a damaged file leaves the microphone alone.
    activation: (ACTIVATION_MODES as readonly string[]).includes(activation?.value ?? '')
      ? (activation!.value as ActivationMode)
      : 'off',
    wakePhrase:
      wake && validWakePhrase(wake.value).ok ? wake.value.trim() : DEFAULT_LISTENING.wakePhrase,
    clapSensitivity: Number.isFinite(parsedClap)
      ? Math.min(Math.max(Math.round(parsedClap), 1), 5)
      : DEFAULT_LISTENING.clapSensitivity,
  };
}

export async function writeListeningPreferences(
  storage: Storage,
  next: Partial<ListeningPreferences>,
): Promise<void> {
  const memory = new MemoryStore(storage);
  if (next.enabled !== undefined) {
    await memory.remember('preference', ENABLED, String(next.enabled));
  }
  if (next.handsFree !== undefined) {
    await memory.remember('preference', HANDS_FREE, String(next.handsFree));
  }
  if (next.bargeIn !== undefined) {
    await memory.remember('preference', BARGE_IN, String(next.bargeIn));
  }
  if (next.silenceMs !== undefined) {
    await memory.remember('preference', SILENCE, String(next.silenceMs));
  }
  if (
    next.activation !== undefined &&
    (ACTIVATION_MODES as readonly string[]).includes(next.activation)
  ) {
    await memory.remember('preference', ACTIVATION, next.activation);
  }
  if (next.wakePhrase !== undefined) {
    const checked = validWakePhrase(next.wakePhrase);
    if (checked.ok) await memory.remember('preference', WAKE_PHRASE, checked.phrase);
  }
  if (next.clapSensitivity !== undefined) {
    await memory.remember('preference', CLAP_SENSITIVITY, String(next.clapSensitivity));
  }
}
