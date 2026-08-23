/**
 * Playback for synthesised speech, and the analyser the visualiser reads.
 *
 * ── Why playback lives here and not in Rust ─────────────────────────────────
 * It used to be `PlaySoundW`, one call in `speech.rs`. That failed silently —
 * async winmm playback does not outlive the worker thread that starts it — but
 * even working it was the wrong seam. Audio played by the OS is audio this
 * page cannot see, and a visualiser that reacts to Atlas's voice needs the
 * samples that are actually being heard. So Rust synthesises and the page
 * plays, which also buys real volume control and a genuine end-of-speech
 * event.
 *
 * ── One player, one voice ───────────────────────────────────────────────────
 * A single utterance at a time. Starting a new one stops the previous rather
 * than layering over it, because two Atlases talking at once is never what
 * anybody meant.
 *
 * ── An utterance arrives in pieces, and they must not be audible ────────────
 * A reply is synthesised a sentence at a time so the first one can start while
 * the rest is still being made (see `segmentForSpeech`). That only works if
 * the seams cannot be heard, and the obvious implementation — start the next
 * buffer from the previous one's `onended` — cannot deliver that. `onended` is
 * a main-thread event: it fires after the audio has already stopped, then
 * waits for the event loop, then for whatever else is queued ahead of it. The
 * gap is small, variable, and lands in the middle of a sentence, which is
 * exactly where a listener hears it as a stutter.
 *
 * So pieces are *scheduled* instead. Each buffer is started at an explicit
 * time on the `AudioContext` clock, computed by adding up the durations of the
 * pieces before it. The audio thread honours those times to the sample, no
 * main-thread work sits between one piece and the next, and a stalled frame
 * cannot open a hole in the middle of a word.
 *
 * Framework-free on purpose: this is an audio engine, and keeping React out of
 * it means the visualiser can read `level()` from an animation frame without
 * dragging a re-render along behind every sample.
 */

import { fillBands } from './spectrum';

export type SpeechState = 'idle' | 'loading' | 'speaking';

type Listener = (state: SpeechState) => void;

/**
 * How far ahead of "now" the first piece of an utterance is scheduled.
 *
 * Scheduling at exactly `currentTime` is a race: by the time the audio thread
 * reads the instruction that moment has passed, and a source told to start in
 * the past starts immediately but *skipped into* — the first few milliseconds
 * are lost, which on a word beginning with a plosive is audible as a clipped
 * consonant. This is small enough not to read as delay and large enough to
 * clear the render quantum comfortably.
 */
const LEAD_SECONDS = 0.04;

/**
 * A single spoken reply, delivered in pieces.
 *
 * Handed out by `SpeechPlayer.begin()`. The caller pushes audio as it is
 * synthesised and calls `close()` when there is no more; the player works out
 * when each piece plays and when the whole thing has finished.
 */
export interface Utterance {
  /**
   * Queue one piece of audio. Resolves once it is decoded and scheduled —
   * which is *not* when it has been heard.
   */
  push(audio: ArrayBuffer): Promise<void>;
  /** No more pieces are coming. */
  close(): void;
  /** True once something newer replaced this, or `stop()` was called. */
  readonly cancelled: boolean;
}

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** Every source scheduled for the current utterance and not yet finished. */
  private scheduled = new Set<AudioBufferSourceNode>();
  /** When the next piece should start, on the context clock. */
  private nextAt = 0;
  /** Set by `close()`: no more pieces will be pushed for this utterance. */
  private closed = true;
  // Typed against a real ArrayBuffer rather than ArrayBufferLike, which is
  // what `getByteFrequencyData` insists on under the current lib types.
  private frequencies: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private listeners = new Set<Listener>();
  private state: SpeechState = 'idle';
  /** Guards against an out-of-order decode finishing after a newer stop(). */
  private generation = 0;

  /**
   * The context is created on first use rather than at construction.
   *
   * Browsers refuse to start audio without a user gesture, and an
   * `AudioContext` built at import time lands in `suspended` and stays there.
   * Every route into this class runs from a click or a submitted message, so
   * creating it lazily means it is always created inside a gesture.
   */
  private ensure(): { ctx: AudioContext; gain: GainNode; analyser: AnalyserNode } {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      // 1024 is a deliberate middle: enough resolution for a lively bar
      // display, few enough bins that reading it every frame is free.
      analyser.fftSize = 1024;
      // Without smoothing the visualiser strobes on every consonant. This is
      // the difference between "alive" and "broken".
      analyser.smoothingTimeConstant = 0.8;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
      this.analyser = analyser;
      this.frequencies = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }
    return { ctx: this.ctx, gain: this.gain!, analyser: this.analyser! };
  }

  /**
   * Build and resume the audio graph ahead of needing it.
   *
   * Creating an `AudioContext` and bringing it out of `suspended` takes real
   * time — the device has to be opened — and doing it lazily puts that cost in
   * front of the first thing Atlas ever says, which is the one utterance a
   * person is judging the whole app by. Calling this from a gesture that
   * *precedes* speech (opening the voice screen, sending a message) moves the
   * cost somewhere nobody is waiting.
   *
   * Safe to call repeatedly; does nothing once the context is running.
   */
  prime(): void {
    const { ctx } = this.ensure();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(next: SpeechState) {
    if (this.state === next) return;
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  getState(): SpeechState {
    return this.state;
  }

  /**
   * How loud Atlas is right now, 0 to 1.
   *
   * Read from an animation frame, never from React state — a value that
   * changes sixty times a second is a source of frames, not of renders.
   * Returns 0 when silent, which is what makes the idle breathing animation
   * take over on its own.
   */
  level(): number {
    if (!this.analyser || this.state !== 'speaking') return 0;
    this.analyser.getByteFrequencyData(this.frequencies);

    // Mean of the lower half of the spectrum. Speech energy sits well below
    // the top bins, and including them just adds hiss that never moves.
    const usable = Math.floor(this.frequencies.length / 2);
    let total = 0;
    for (let i = 0; i < usable; i++) total += this.frequencies[i]!;
    const mean = total / usable / 255;

    // Gently expanded: raw means hover low and make the blob look timid.
    return Math.min(1, mean * 1.8);
  }

  /**
   * The shape of what is being said, as one 0–1 value per band.
   *
   * `level()` answers "how loud", which makes a circle that pulses. This
   * answers "loud where", which is what lets a shape move differently for a
   * vowel than for a consonant — the difference between a meter and something
   * that looks like it is speaking.
   */
  bands(out: Float32Array): void {
    if (!this.analyser || this.state !== 'speaking') {
      out.fill(0);
      return;
    }
    this.analyser.getByteFrequencyData(this.frequencies);
    fillBands(this.frequencies, out);
  }

  /**
   * Start a new utterance, cancelling anything currently being said.
   *
   * The handle is bound to a generation, so a piece that finishes decoding
   * after the utterance was replaced is dropped instead of being spliced into
   * whatever is playing now.
   */
  begin(): Utterance {
    const { ctx, gain } = this.ensure();
    this.stopAll();
    const mine = ++this.generation;

    this.closed = false;
    this.nextAt = 0;
    this.setState('loading');

    // Autoplay policy parks a fresh context in "suspended"; resuming here is
    // what actually starts the clock, and it must happen before any time on
    // that clock is used to schedule against.
    if (ctx.state === 'suspended') void ctx.resume();

    // Arrow functions, so `this` is the player without aliasing it. The
    // getter below closes over `isCancelled` rather than reading `this`,
    // because inside an object literal's getter `this` is the literal.
    const isCancelled = () => mine !== this.generation;

    const push = async (audio: ArrayBuffer): Promise<void> => {
      if (isCancelled()) return;

      let buffer: AudioBuffer;
      try {
        // decodeAudioData detaches the buffer it is given, so a copy is
        // passed — otherwise replaying the same reply a second time decodes
        // empty.
        buffer = await ctx.decodeAudioData(audio.slice(0));
      } catch (err) {
        // Rethrown rather than swallowed. A decode that fails is the one
        // failure mode of this class that looks *exactly* like success from
        // the outside: synthesis worked, playback was asked for, nothing came
        // out. Reporting it is what turns a silent app into a fixable one.
        if (!isCancelled()) this.finishIfDone();
        throw new Error(
          `The audio couldn't be decoded (${audio.byteLength} bytes${
            err instanceof Error && err.message ? `: ${err.message}` : ''
          }).`,
        );
      }

      // Something newer started (or stopped everything) while we decoded.
      if (isCancelled()) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);

      // Where this piece goes on the clock. Two cases, and the second is the
      // one that matters: if synthesis has fallen behind playback — a long
      // sentence, a cold model, a busy machine — `nextAt` is already in the
      // past, and scheduling there would drop the start of the piece. Better
      // to take the small audible gap and play the words in full.
      const now = ctx.currentTime;
      const at = this.nextAt > now ? this.nextAt : now + LEAD_SECONDS;
      this.nextAt = at + buffer.duration;

      source.onended = () => {
        this.scheduled.delete(source);
        source.disconnect();
        if (!isCancelled()) this.finishIfDone();
      };

      this.scheduled.add(source);
      source.start(at);
      this.setState('speaking');
    };

    const close = (): void => {
      if (isCancelled()) return;
      this.closed = true;
      this.finishIfDone();
    };

    return {
      get cancelled() {
        return isCancelled();
      },
      push,
      close,
    };
  }

  /**
   * Speak one complete buffer. The whole-utterance-at-once path, kept for
   * Settings' preview button, where there is nothing to pipeline.
   */
  async play(audio: ArrayBuffer): Promise<void> {
    const utterance = this.begin();
    try {
      await utterance.push(audio);
    } finally {
      utterance.close();
    }
  }

  /**
   * Idle once the last piece has been heard and no more are coming.
   *
   * Both conditions are needed. An empty `scheduled` set on its own happens
   * routinely mid-utterance, when synthesis has not yet handed over the next
   * piece — reporting idle there would end the speaking state in the middle of
   * a reply and stop the visualiser dead.
   */
  private finishIfDone(): void {
    if (this.closed && this.scheduled.size === 0) this.setState('idle');
  }

  /** Cancel every scheduled source, played or not. */
  private stopAll(): void {
    for (const source of this.scheduled) {
      // Detach the handler first: stop() fires `onended`, which would
      // otherwise report on an utterance that is being replaced, not finished.
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped, or never started. Nothing to do, and nothing worth
        // saying.
      }
      source.disconnect();
    }
    this.scheduled.clear();
    this.nextAt = 0;
  }

  stop(): void {
    this.generation++;
    this.closed = true;
    this.stopAll();
    this.setState('idle');
  }

  setVolume(volume: number): void {
    const { gain } = this.ensure();
    gain.gain.value = Math.min(Math.max(volume, 0), 1);
  }
}
