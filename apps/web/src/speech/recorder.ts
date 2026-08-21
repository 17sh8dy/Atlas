/**
 * The microphone: capture, silence detection, and the WAV that comes out.
 *
 * ── Why the surface records and Rust only transcribes ───────────────────────
 * The mirror of `player.ts`. Rust owns the neural model because that needs the
 * machine; this owns the microphone because that needs the things a webview
 * already has and a native process would have to rebuild: echo cancellation
 * good enough that Atlas does not interrupt himself, a resampler, a level to
 * draw, and the browser's own permission prompt. It also means the Rust half
 * of the app has no way to start listening — it can only be handed something
 * already recorded.
 *
 * ── Nothing opens the microphone until asked ────────────────────────────────
 * `getUserMedia` is called from `start()` and nowhere else. There is no warm
 * stream kept ready, no level meter running in the background, no "prime the
 * permission on launch". The stream's tracks are stopped on `stop()`, which is
 * what puts the operating system's recording indicator out.
 *
 * ── The capture context runs at 16 kHz on purpose ───────────────────────────
 * whisper wants 16 kHz mono, and asking for an `AudioContext` at that rate
 * makes the browser's own resampler do the work on the way in. The
 * alternative — capturing at the device rate and decimating by hand — is a
 * worse resampler written by us. It is a *separate* context from playback,
 * which runs at the voice model's 22.05 kHz; one context cannot be both
 * without degrading one of them.
 */

import { fillBands } from './spectrum';

export type ListeningState =
  /** Not recording. The microphone is closed and the OS indicator is off. */
  | 'idle'
  /** Microphone open, waiting for you to start talking. */
  | 'waiting'
  /** You are talking and it is being kept. */
  | 'hearing';

export interface Utterance {
  /** 16 kHz mono WAV, ready for the transcriber. */
  audio: ArrayBuffer;
  /** How long you spoke, in milliseconds. */
  durationMs: number;
}

export interface RecorderHandlers {
  onState?(state: ListeningState): void;
  /** A complete utterance: speech, then enough silence to call it finished. */
  onUtterance?(utterance: Utterance): void;
  /** Speech began. Used for barge-in, which must not wait for the sentence. */
  onSpeechStart?(): void;
  onError?(message: string): void;
}

/** Capture rate. Fixed by what the transcription model expects. */
const SAMPLE_RATE = 16_000;

/**
 * How much audio to keep from *before* speech was detected.
 *
 * Detection necessarily lags the first syllable — a threshold is only crossed
 * after the sound arrives. Without a pre-roll every utterance starts clipped,
 * which the transcriber reports as a missing first word rather than as a
 * quiet one.
 */
const PREROLL_MS = 300;

/** Below this, an "utterance" is a cough or a door. */
const MIN_SPEECH_MS = 250;

/** A ceiling, so a stuck-open microphone cannot record forever. */
const MAX_UTTERANCE_MS = 30_000;

/**
 * How far above the room's own noise counts as speech.
 *
 * A fixed threshold cannot work across microphones: a gaming headset and a
 * laptop array differ by more than speech differs from silence. So the floor
 * is measured for a moment and the gate sits a multiple above it, with an
 * absolute minimum so a *silent* room does not make the gate infinitely
 * sensitive.
 */
const NOISE_MULTIPLE = 3.5;
const MIN_THRESHOLD = 0.012;
const FLOOR_SAMPLE_MS = 400;

export class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levels: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));

  private state: ListeningState = 'idle';
  private handlers: RecorderHandlers = {};

  /** Audio kept since speech began. */
  private captured: Float32Array[] = [];
  /** A rolling window of the recent past, for PREROLL_MS. */
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;

  private speaking = false;
  private speechStartedAt = 0;
  private lastLoudAt = 0;
  private silenceMs = 900;

  /** Measured noise floor, and the gate derived from it. */
  private floorSum = 0;
  private floorCount = 0;
  private threshold = MIN_THRESHOLD;
  private measuringUntil = 0;

  /**
   * Set while Atlas is speaking, so the gate can be raised.
   *
   * Echo cancellation removes most of Atlas's own voice from the microphone,
   * but "most" is not "all", and a false barge-in — Atlas cutting himself off
   * mid-sentence — is far more startling than a missed one. The gate goes up
   * rather than the microphone going off, because barge-in has to be able to
   * hear you over him.
   */
  private duckedUntilQuiet = false;

  getState(): ListeningState {
    return this.state;
  }

  private setState(next: ListeningState) {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onState?.(next);
  }

  /**
   * How loud the room is right now, 0 to 1.
   *
   * Read from an animation frame, never from render — a value that changes
   * sixty times a second is a source of frames, not of renders. Returns 0 when
   * the microphone is closed, which is what lets a visualiser fall back to its
   * idle animation on its own.
   */
  level(): number {
    if (!this.analyser || this.state === 'idle') return 0;
    this.analyser.getByteFrequencyData(this.levels);
    const usable = Math.floor(this.levels.length / 2);
    let total = 0;
    for (let i = 0; i < usable; i++) total += this.levels[i]!;
    return Math.min(1, total / usable / 255 / 0.55);
  }

  /** The shape of what is being heard. See `SpeechPlayer.bands`. */
  bands(out: Float32Array): void {
    if (!this.analyser || this.state === 'idle') {
      out.fill(0);
      return;
    }
    this.analyser.getByteFrequencyData(this.levels);
    fillBands(this.levels, out);
  }

  /** True while Atlas should be treated as talking over the microphone. */
  setDucked(ducked: boolean) {
    this.duckedUntilQuiet = ducked;
  }

  async start(handlers: RecorderHandlers, options?: { silenceMs?: number }): Promise<void> {
    if (this.stream) return;
    this.handlers = handlers;
    this.silenceMs = options?.silenceMs ?? 900;

    // `mediaDevices` is absent rather than failing in a non-secure context,
    // and reading through it would throw a TypeError that says nothing about
    // microphones. Named here so the message points at the real problem.
    if (!navigator.mediaDevices?.getUserMedia) {
      handlers.onError?.(
        'This page cannot reach the microphone at all — the browser exposes no capture API here.',
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // All three are the browser doing signal processing that would
          // otherwise have to be written here, badly. Echo cancellation is
          // the one barge-in depends on: without it the microphone hears
          // Atlas through the speakers and he interrupts himself.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      this.handlers.onError?.(
        denied
          ? 'Windows or the app has blocked the microphone. Allow it and try again.'
          : `The microphone could not be opened (${err instanceof Error ? err.message : String(err)}).`,
      );
      return;
    }

    this.stream = stream;

    // Everything from here on is guarded, and that is not defensive habit: an
    // exception thrown building the graph used to escape this method, escape
    // the hook that called it, and land as an unhandled rejection — leaving a
    // screen that said "microphone off" with no error anywhere, which is the
    // exact failure shape that cost a debugging session on the speaking side.
    // A microphone that will not open has to say so.
    try {
      await this.build(stream);
    } catch (err) {
      this.stop();
      handlers.onError?.(
        `The microphone opened but its audio graph failed (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
      return;
    }

    this.reset();
    this.measuringUntil = performance.now() + FLOOR_SAMPLE_MS;
    this.setState('waiting');
  }

  /** Wire the capture graph. Separated so `start` can guard it as one thing. */
  private async build(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.levels = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

    // A ScriptProcessor rather than an AudioWorklet. The worklet is the
    // modern node and would run off the main thread, but it has to be loaded
    // from a separate module URL, which under this app's `script-src 'self'`
    // CSP and Vite's asset pipeline is a build concern for a node that
    // processes 16 kHz mono — a workload the main thread does not notice.
    // Revisit if capture ever grows past this.
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => this.consume(event.inputBuffer.getChannelData(0));

    this.source.connect(this.analyser);
    this.analyser.connect(this.processor);
    // A ScriptProcessor only runs when it is connected to a destination, but
    // routing the microphone to the speakers would echo the room back into it.
    // A zeroed gain node keeps the graph pulling without making a sound.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(ctx.destination);
  }

  private reset() {
    this.captured = [];
    this.preroll = [];
    this.prerollSamples = 0;
    this.speaking = false;
    this.floorSum = 0;
    this.floorCount = 0;
    this.threshold = MIN_THRESHOLD;
  }

  private consume(input: Float32Array) {
    const now = performance.now();

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
    const rms = Math.sqrt(sum / input.length);

    // The floor is measured once, when listening starts, from a room that is
    // assumed not to be mid-sentence. Re-measuring continuously would let a
    // long steady voice raise the gate above itself.
    if (now < this.measuringUntil) {
      this.floorSum += rms;
      this.floorCount++;
      this.keepPreroll(input);
      return;
    }
    if (this.floorCount > 0) {
      this.threshold = Math.max(MIN_THRESHOLD, (this.floorSum / this.floorCount) * NOISE_MULTIPLE);
      this.floorCount = 0;
    }

    const gate = this.duckedUntilQuiet ? this.threshold * 2.2 : this.threshold;
    const loud = rms > gate;

    if (!this.speaking) {
      this.keepPreroll(input);
      if (!loud) return;

      // Speech begins. The pre-roll is promoted to the front of the capture so
      // the first syllable survives.
      this.speaking = true;
      this.speechStartedAt = now;
      this.lastLoudAt = now;
      this.captured = [...this.preroll, new Float32Array(input)];
      this.preroll = [];
      this.prerollSamples = 0;
      this.setState('hearing');
      this.handlers.onSpeechStart?.();
      return;
    }

    this.captured.push(new Float32Array(input));
    if (loud) this.lastLoudAt = now;

    const spokenMs = now - this.speechStartedAt;
    const quietMs = now - this.lastLoudAt;
    if (quietMs < this.silenceMs && spokenMs < MAX_UTTERANCE_MS) return;

    this.finish(spokenMs);
  }

  private keepPreroll(input: Float32Array) {
    this.preroll.push(new Float32Array(input));
    this.prerollSamples += input.length;
    const max = (PREROLL_MS / 1000) * SAMPLE_RATE;
    while (this.prerollSamples > max && this.preroll.length > 1) {
      this.prerollSamples -= this.preroll.shift()!.length;
    }
  }

  private finish(spokenMs: number) {
    const chunks = this.captured;
    this.captured = [];
    this.speaking = false;
    this.setState('waiting');

    // Trailing silence is kept: whisper reads it as the end of a sentence and
    // punctuates better for it. Only the too-short is thrown away.
    if (spokenMs >= MIN_SPEECH_MS) {
      this.handlers.onUtterance?.({ audio: encodeWav(chunks), durationMs: spokenMs });
    }
  }

  stop(): void {
    this.processor?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.analyser?.disconnect();
    this.source?.disconnect();
    // Stopping the tracks is what closes the device and puts out the
    // operating system's recording indicator. Suspending the context is not
    // enough and leaves the light on, which is its own kind of lie.
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.ctx?.close();

    this.processor = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.reset();
    this.setState('idle');
  }
}

/**
 * Float samples to a 16-bit PCM WAV.
 *
 * Written by hand because the alternative is a dependency for forty-four bytes
 * of header and a multiply. The engine reads plain PCM WAV and nothing else
 * here needs a container.
 */
export function encodeWav(chunks: Float32Array[]): ArrayBuffer {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;

  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      // Clamped before scaling: a sample above 1 wraps to a loud click
      // otherwise, which reads to the transcriber as a consonant.
      const sample = Math.max(-1, Math.min(1, chunk[i]!));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}
