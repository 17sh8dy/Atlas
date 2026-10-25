/**
 * The microphone stream that listens for a double clap, and nothing else.
 *
 * Same promises as `Recorder`, stricter in one way:
 *   · `getUserMedia` is called from `start()` and nowhere else, and only because the person switched this on;
 *   · `stop()` stops every track, which is what puts Windows' own recording indicator out;
 *   · nothing is recorded, buffered or sent anywhere: samples go through the detector one block at a time and
 *     are dropped (see clap.ts);
 *   · `live` is read from the real track, not from a flag, so the indicator Atlas shows is the truth.
 *
 * The browser's voice processing is switched OFF for this stream. Noise suppression treats a clap as noise and
 * removes it, and automatic gain control squashes it, which would leave nothing for the detector to find.
 * (Echo cancellation is off too: Atlas is not talking while this runs — see `paused` in the hook.)
 */

import { ClapDetector } from './clap';

export interface ClapListenerHandlers {
  onDouble(): void;
  /** The stream opened or closed, or failed. Drives the visible indicator. */
  onLive(live: boolean): void;
  onError(message: string): void;
}

export class ClapListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private detector: ClapDetector | null = null;
  /** Bumped by every start and stop, so an open still in flight can tell it was cancelled. */
  private session = 0;
  private opening = false;

  get live(): boolean {
    return Boolean(this.stream?.getAudioTracks().some((t) => t.readyState === 'live'));
  }

  async start(handlers: ClapListenerHandlers, sensitivity: number): Promise<void> {
    if (this.stream || this.opening) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      handlers.onError('This page cannot reach the microphone at all.');
      return;
    }
    const mine = ++this.session;
    this.opening = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      if (mine !== this.session) return;
      this.opening = false;
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      handlers.onError(
        denied
          ? 'Windows or the app has blocked the microphone, so a double clap cannot be heard.'
          : `The microphone could not be opened (${err instanceof Error ? err.message : String(err)}).`,
      );
      return;
    }
    if (mine !== this.session) {
      stream.getTracks().forEach((t) => t.stop()); // switched off while the device was opening
      return;
    }
    this.stream = stream;
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      this.detector = new ClapDetector({ sampleRate: ctx.sampleRate, sensitivity });
      this.source = ctx.createMediaStreamSource(stream);
      // See Recorder.build for why this is a ScriptProcessor and not a worklet.
      this.processor = ctx.createScriptProcessor(2048, 1, 1);
      this.processor.onaudioprocess = (event) => {
        if (this.detector?.process(event.inputBuffer.getChannelData(0)) === 'double')
          handlers.onDouble();
      };
      this.source.connect(this.processor);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      this.processor.connect(mute);
      mute.connect(ctx.destination);
    } catch (err) {
      if (mine !== this.session) return;
      this.stop();
      handlers.onError(
        `The microphone opened but could not be analysed (${err instanceof Error ? err.message : String(err)}).`,
      );
      return;
    }
    if (mine !== this.session) return;
    this.opening = false;
    // The OS can end a stream (device unplugged, permission revoked); say so rather than keep showing "listening".
    stream.getAudioTracks().forEach((t) => (t.onended = () => handlers.onLive(this.live)));
    handlers.onLive(true);
  }

  stop(): void {
    this.session += 1;
    this.opening = false;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.detector = null;
  }
}
