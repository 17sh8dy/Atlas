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
 * A single source node at a time. Starting a new utterance stops the previous
 * one rather than layering over it, because two Atlases talking at once is
 * never what anybody meant.
 *
 * Framework-free on purpose: this is an audio engine, and keeping React out of
 * it means the visualiser can read `level()` from an animation frame without
 * dragging a re-render along behind every sample.
 */

import { fillBands } from './spectrum';

export type SpeechState = 'idle' | 'loading' | 'speaking';

type Listener = (state: SpeechState) => void;

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
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

  async play(audio: ArrayBuffer): Promise<void> {
    const { ctx, gain } = this.ensure();
    const mine = ++this.generation;

    this.stopSource();
    this.setState('loading');

    // Autoplay policy parks a fresh context in "suspended"; resuming inside
    // the gesture that led here is what actually starts the clock.
    if (ctx.state === 'suspended') await ctx.resume();

    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches the buffer it is given, so a copy is passed —
      // otherwise replaying the same reply a second time decodes empty.
      buffer = await ctx.decodeAudioData(audio.slice(0));
    } catch (err) {
      // Rethrown rather than swallowed. A decode that fails is the one failure
      // mode of this class that looks *exactly* like success from the outside:
      // synthesis worked, playback was asked for, nothing came out. Reporting
      // it is what turns a silent app into a fixable one.
      if (mine === this.generation) this.setState('idle');
      throw new Error(
        `The audio couldn't be decoded (${audio.byteLength} bytes${
          err instanceof Error && err.message ? `: ${err.message}` : ''
        }).`,
      );
    }

    // Something newer started (or stopped everything) while we decoded.
    if (mine !== this.generation) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        this.setState('idle');
      }
    };
    this.source = source;
    this.setState('speaking');
    source.start();
  }

  private stopSource() {
    const source = this.source;
    if (!source) return;
    this.source = null;
    // Detach the handler first: stop() fires `onended`, which would otherwise
    // report idle for an utterance that is being replaced, not finished.
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped. Nothing to do, and nothing worth saying.
    }
    source.disconnect();
  }

  stop(): void {
    this.generation++;
    this.stopSource();
    this.setState('idle');
  }

  setVolume(volume: number): void {
    const { gain } = this.ensure();
    gain.gain.value = Math.min(Math.max(volume, 0), 1);
  }
}
