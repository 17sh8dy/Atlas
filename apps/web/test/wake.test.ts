import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validWakePhrase } from '@atlas/core';
import { matchWake } from '../src/speech/activation/wake';

describe('matching a typed wake phrase against what was heard', () => {
  const hey = 'Hey Atlas';

  it('hears the phrase, alone', () => {
    expect(matchWake('Hey Atlas.', hey)).toEqual({ matched: true, rest: '' });
    expect(matchWake('hey, atlas', hey).matched).toBe(true);
  });

  it('returns what followed, as one gesture', () => {
    expect(matchWake('Hey Atlas, open Spotify.', hey)).toEqual({
      matched: true,
      rest: 'open Spotify.',
    });
    expect(matchWake('Hey Atlas what is the weather like', hey).rest).toBe(
      'what is the weather like',
    );
  });

  it('forgives how transcribers mishear a name', () => {
    for (const heard of [
      'Hey at last',
      'hey atlus',
      'Hey Atlas',
      'hay atlas',
      'Hey Atlast',
      'hey, at lass',
    ]) {
      expect(matchWake(heard, hey).matched, heard).toBe(true);
    }
  });

  it('forgives a misheard greeting, but never the name alone', () => {
    expect(matchWake('Pay Atlas, open Spotify.', hey)).toEqual({
      matched: true,
      rest: 'open Spotify.',
    });
    expect(matchWake('Hay at last', hey).matched).toBe(true);
    expect(matchWake('Atlas, open Spotify', hey).matched).toBe(false);
    expect(matchWake('I was reading an Atlas of the world', hey).matched).toBe(false);
    expect(matchWake('Tonight Atlas will', hey).matched).toBe(false);
  });

  it('allows a word or two before it', () => {
    expect(matchWake('Okay, hey Atlas open the calculator', hey)).toEqual({
      matched: true,
      rest: 'open the calculator',
    });
  });

  it('does not fire on ordinary talk, or the phrase buried in a sentence', () => {
    for (const heard of [
      'What are you doing tomorrow',
      'Hey, how are you',
      'I was reading about the Atlas mountains yesterday and then',
      'My atlas is on the shelf',
      'Hey Alexa play some music',
      'hey adam',
      '',
    ]) {
      expect(matchWake(heard, hey).matched, heard).toBe(false);
    }
  });

  it('works for any phrase the person chooses', () => {
    expect(matchWake('Computer, lights on', 'Computer')).toEqual({
      matched: true,
      rest: 'lights on',
    });
    expect(matchWake('wake up jarvis', 'Wake up Jarvis').matched).toBe(true);
    expect(matchWake('Jarvis are you there', 'Hey Jarvis').matched).toBe(false);
    expect(matchWake('Yo Nova open notes', 'Yo Nova').rest).toBe('open notes');
  });

  it('a long phrase is allowed more slack than a short one, a short one almost none', () => {
    expect(matchWake('computr', 'Computer').matched).toBe(true);
    expect(matchWake('compost', 'Computer').matched).toBe(false);
  });
});

describe('which phrases are accepted', () => {
  it('accepts names and short phrases', () => {
    for (const p of [
      'Hey Atlas',
      'Atlas',
      'Computer',
      'Wake up Jarvis',
      "Okay Nova's",
      'Hey 4Runner',
    ]) {
      expect(validWakePhrase(p).ok, p).toBe(true);
    }
  });
  it('refuses what it could not tell from ordinary talk', () => {
    for (const p of [
      '',
      'hey',
      'ok',
      'the',
      'hi you',
      'a b',
      'x'.repeat(41),
      'one two three four five',
      'hey!!!',
      '<script>',
    ]) {
      expect(validWakePhrase(p).ok, p).toBe(false);
    }
  });
  it('trims and tidies the spaces', () => {
    expect(validWakePhrase('  Hey    Atlas ')).toEqual({ ok: true, phrase: 'Hey Atlas' });
  });
});

describe('against what the real transcriber produced', () => {
  // 48 sentences spoken by the bundled voice (eight different speakers) and transcribed by the bundled whisper
  // engine with the wake phrase leading its prompt (listen.rs `wake_lead`). Synthetic voices are kinder than a
  // real room, so this guards the matcher against regressions; it is not a promise about a microphone.
  const rows: Array<{ said: string; heard: string }> = JSON.parse(
    readFileSync(new URL('./fixtures/wake-transcripts.json', import.meta.url), 'utf8'),
  );

  it('wakes on the phrase (with or without a request) and never on the sentences that merely sound close', () => {
    let wakeTotal = 0;
    let woke = 0;
    let carried = 0;
    let withRequest = 0;
    const falseWakes: string[] = [];
    for (const r of rows) {
      const m = matchWake(r.heard, 'Hey Atlas');
      if (/^Hey Atlas/i.test(r.said)) {
        wakeTotal += 1;
        if (m.matched) woke += 1;
        if (/Spotify|weather/.test(r.said)) {
          withRequest += 1;
          if (m.matched && /spotify|weather/i.test(m.rest)) carried += 1;
        }
      } else if (m.matched) falseWakes.push(r.heard);
    }
    expect(wakeTotal).toBe(24);
    expect(woke).toBeGreaterThanOrEqual(23);
    expect(carried).toBeGreaterThanOrEqual(withRequest - 1);
    expect(falseWakes).toEqual([]);
  });
});
