/**
 * The double-clap detector against synthetic sounds. Real rooms and microphones differ, so these pin the
 * SHAPE of the decision (what must and must not trigger); the sensitivity setting is for the rest.
 */
import { describe, expect, it } from 'vitest';
import { ClapDetector } from '../src/speech/activation/clap';

const SR = 16000;

/** Deterministic noise so the tests do not flake. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

class Scene {
  samples: number[] = [];
  private rand = rng(7);
  constructor(private roomNoise = 0.01) {}
  at(ms: number) {
    return Math.round((ms / 1000) * SR);
  }
  silence(ms: number) {
    for (let i = 0; i < this.at(ms); i++) this.samples.push(this.rand() * 2 * this.roomNoise);
    return this;
  }
  /** A clap: a broadband burst that dies away in a few tens of milliseconds. */
  clap(amp = 0.6) {
    const n = this.at(120);
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (0.012 * SR));
      this.samples.push(this.rand() * 2 * amp * env + this.rand() * 2 * this.roomNoise);
    }
    return this;
  }
  /** A door or desk knock: low-frequency, damped. */
  knock(amp = 0.7) {
    const n = this.at(150);
    for (let i = 0; i < n; i++)
      this.samples.push(
        amp * Math.sin((2 * Math.PI * 90 * i) / SR) * Math.exp(-i / (0.02 * SR)) +
          this.rand() * 2 * this.roomNoise,
      );
    return this;
  }
  /** Speech-like: voiced harmonics, syllable-rate loudness changes, lasting a while. */
  speech(ms: number, amp = 0.4) {
    const n = this.at(ms);
    for (let i = 0; i < n; i++) {
      const syllable = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SR);
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 140 * h * i) / SR) / h;
      this.samples.push(amp * syllable * v * 0.5 + this.rand() * 2 * this.roomNoise);
    }
    return this;
  }
  /** A loud steady sound with a hissy top: a fan, a kettle, "sssss". */
  hiss(ms: number, amp = 0.3) {
    const n = this.at(ms);
    for (let i = 0; i < n; i++) this.samples.push(this.rand() * 2 * amp);
    return this;
  }
  run(sensitivity = 3): number {
    const d = new ClapDetector({ sampleRate: SR, sensitivity });
    const all = Float32Array.from(this.samples);
    let fired = 0;
    // In odd-sized chunks, like a real audio callback.
    for (let i = 0; i < all.length; i += 1000)
      if (d.process(all.subarray(i, i + 1000)) === 'double') fired += 1;
    return fired;
  }
}

describe('double clap', () => {
  it('fires once for two claps about a third of a second apart', () => {
    expect(new Scene().silence(1500).clap().silence(250).clap().silence(1500).run()).toBe(1);
  });
  it('works across the range of natural spacing', () => {
    for (const gap of [200, 300, 450, 600]) {
      expect(
        new Scene().silence(1500).clap().silence(gap).clap().silence(1500).run(),
        `gap ${gap}`,
      ).toBe(1);
    }
  });
  it('does not fire for one clap', () => {
    expect(new Scene().silence(1500).clap().silence(3000).run()).toBe(0);
  });
  it('does not fire for two claps far apart', () => {
    expect(new Scene().silence(1500).clap().silence(1800).clap().silence(1500).run()).toBe(0);
  });
  it('does not fire for applause (three or more)', () => {
    expect(
      new Scene()
        .silence(1500)
        .clap()
        .silence(250)
        .clap()
        .silence(250)
        .clap()
        .silence(250)
        .clap()
        .silence(2000)
        .run(),
    ).toBe(0);
  });
  it('does not fire twice for one gesture', () => {
    expect(new Scene().silence(1500).clap().silence(250).clap().silence(1500).run()).toBe(1);
  });
  it('can fire again after the cooldown', () => {
    expect(
      new Scene()
        .silence(1500)
        .clap()
        .silence(250)
        .clap()
        .silence(3500)
        .clap()
        .silence(250)
        .clap()
        .silence(1500)
        .run(),
    ).toBe(2);
  });
});

describe('what must NOT trigger it', () => {
  it('speech', () => {
    expect(
      new Scene().silence(500).speech(3000).silence(500).speech(2000).silence(1000).run(),
    ).toBe(0);
  });
  it('knocks and thuds, even two of them', () => {
    expect(new Scene().silence(1500).knock().silence(300).knock().silence(1500).run()).toBe(0);
  });
  it('a steady loud hiss', () => {
    expect(new Scene().silence(500).hiss(4000).silence(500).run()).toBe(0);
  });
  it('a loud room with nothing sharp in it', () => {
    expect(new Scene(0.05).silence(4000).run()).toBe(0);
  });
  it('a quiet tap, at the default sensitivity', () => {
    expect(new Scene().silence(1500).clap(0.03).silence(250).clap(0.03).silence(1500).run(3)).toBe(
      0,
    );
  });
});

describe('sensitivity', () => {
  it('a soft double clap needs a higher setting', () => {
    const soft = () => new Scene().silence(1500).clap(0.1).silence(250).clap(0.1).silence(1500);
    expect(soft().run(1)).toBe(0);
    expect(soft().run(5)).toBe(1);
  });
  it('claps in a noisy-ish room still count at the default', () => {
    expect(new Scene(0.02).silence(1500).clap(0.7).silence(300).clap(0.7).silence(1500).run()).toBe(
      1,
    );
  });
  it('claps right after speech still count', () => {
    expect(
      new Scene()
        .silence(500)
        .speech(1500)
        .silence(800)
        .clap()
        .silence(300)
        .clap()
        .silence(1500)
        .run(),
    ).toBe(1);
  });
});
