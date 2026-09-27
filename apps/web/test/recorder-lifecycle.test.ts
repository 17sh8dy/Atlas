/**
 * The microphone must never stay open unless the button left it open.
 *
 * Brandon (2026-09-26): dictation "seems like it's recording without me
 * pressing the button — it should NEVER record without it being pressed".
 * The recorder had a gap: `getUserMedia` takes a moment and `this.stream`
 * stayed null until it resolved, so a second press in that moment started a
 * SECOND open that overwrote the first stream without stopping it, and a stop
 * in that moment found nothing to stop. Either way a live microphone was left
 * behind that no button could reach.
 *
 * These drive the real `Recorder` against a fake device whose open is held
 * until the test releases it, so each race is reproduced exactly.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Recorder } from '../src/speech/recorder';

interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

let opened: Array<{ tracks: FakeTrack[] }> = [];
let pending: Array<{ resolve(): void; reject(err: unknown): void }> = [];

function fakeStream() {
  const track: FakeTrack = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = { tracks: [track], getTracks: () => [track] };
  opened.push(stream);
  return stream;
}

/** Microphones still recording: opened and never stopped. */
const live = () => opened.filter((s) => s.tracks.some((t) => !t.stopped)).length;

class FakeNode {
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  state = 'running';
  createMediaStreamSource() {
    return new FakeNode();
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 512 });
  }
  createScriptProcessor() {
    return Object.assign(new FakeNode(), { onaudioprocess: null });
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
  get destination() {
    return new FakeNode();
  }
  async resume() {}
  async close() {}
}

beforeEach(() => {
  opened = [];
  pending = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      // Held open until the test calls `release()` — the real device takes
      // tens to hundreds of milliseconds, and that window is the whole bug.
      getUserMedia: () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve: () => resolve(fakeStream()), reject });
        }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Let the device open, then let the recorder's awaits run. */
async function release(index = 0) {
  pending[index]!.resolve();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('Recorder: the microphone closes whenever the button says off', () => {
  test('stop pressed while the device is still opening: the stream is closed when it arrives', async () => {
    const r = new Recorder();
    const starting = r.start({});
    r.stop();
    await release();
    await starting;
    expect(live()).toBe(0);
    expect(r.getState()).toBe('idle');
  });

  test('pressed twice quickly: only one device is ever opened, and the second press turns it off', async () => {
    const r = new Recorder();
    const states: string[] = [];
    const handlers = { onState: (s: string) => states.push(s) };
    const first = r.start(handlers);
    // The button reads "on" from the first press, so the UI's second press is
    // a stop, not another start.
    expect(r.getState()).toBe('waiting');
    // A second start while opening is ignored — it must not open another device.
    void r.start(handlers);
    expect(pending).toHaveLength(1);
    r.stop();
    await release();
    await first;
    expect(live()).toBe(0);
    expect(r.getState()).toBe('idle');
  });

  test('a normal press opens exactly one device, and stop closes it', async () => {
    const r = new Recorder();
    const starting = r.start({});
    await release();
    await starting;
    expect(live()).toBe(1);
    expect(r.getState()).toBe('waiting');
    r.stop();
    expect(live()).toBe(0);
    expect(r.getState()).toBe('idle');
  });

  test('stop, then press again: the stale open cannot come back to life', async () => {
    const r = new Recorder();
    const first = r.start({});
    r.stop();
    const second = r.start({});
    await release(0);
    await release(1);
    await Promise.all([first, second]);
    // Exactly one live device — the second press's — and stopping it leaves none.
    expect(live()).toBe(1);
    r.stop();
    expect(live()).toBe(0);
  });

  test('a device that fails to open returns the button to off', async () => {
    const r = new Recorder();
    const errors: string[] = [];
    const starting = r.start({ onError: (m) => errors.push(m) });
    pending[0]!.reject(new Error('busy'));
    await starting;
    expect(r.getState()).toBe('idle');
    expect(errors[0]).toContain('busy');
  });
});
