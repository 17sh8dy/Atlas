/**
 * A double-clap detector: plain signal analysis on the microphone stream, no model, no network, nothing kept.
 *
 * ── What a clap is, acoustically ─────────────────────────────────────────────────────────────────────
 * A clap is the opposite of speech and music: it arrives all at once (a block ten times louder than the
 * one before it), it is broadband (a lot of its energy is high-frequency, which shows up as a large
 * difference between neighbouring samples), and it is over almost immediately (about 100 ms later the
 * room is back to what it was). Each of those rejects something different:
 *   · loudness over the room's own noise      → a quiet room is not a clap
 *   · a sudden rise                           → a loud steady sound (a fan, music) is not a clap
 *   · high-frequency content                  → a door, a desk knock, a bass drum are not claps
 *   · a quick decay                           → speech and music do not fall silent straight after the peak
 * and then TWO such events, 150–800 ms apart, and not three or more (applause is not a command), with a
 * cooldown afterwards so one gesture cannot fire twice.
 *
 * ── What it never does ───────────────────────────────────────────────────────────────────────────────
 * It looks at one 8 ms block at a time and keeps four numbers about the recent past. No audio is stored,
 * not even briefly; there is nothing to leak. Whether the microphone is open at all is decided elsewhere
 * (the setting, and the hook that owns the stream).
 *
 * Tunable by one number, `sensitivity` 1–5, because rooms and microphones differ more than any constant
 * could cover. The defaults were chosen to err towards missing a clap rather than answering a door.
 */

export interface ClapOptions {
  sampleRate: number;
  /**
   * Numbers only (levels, sharpness, which test failed), for tuning on a real microphone. Never audio. Called at
   * most every ~150 ms and only for sounds loud enough to have been a candidate.
   */
  onTrace?: (line: string) => void;
  /** A single clap was recognised (before it is known whether a second follows). For on-screen feedback. */
  onClap?: () => void;
  /** 1 (needs a loud, clean clap) to 5 (a soft clap in a quiet room). Default 3. */
  sensitivity?: number;
}

/** Louder than the room by this much, per sensitivity step. */
const RISE_MULTIPLE = [0, 10, 8, 6, 4.5, 3.5];
/** …and louder than this in absolute terms (full scale is 1). */
// Measured on a line-level interface input with its gain at a normal setting (room 0.002, claps 0.05 to 0.23). The
// room-relative test above does most of the work, so the absolute floor only has to keep a silent room from being
// infinitely sensitive.
const MIN_LEVEL = [0, 0.09, 0.05, 0.03, 0.02, 0.012];

const BLOCK_MS = 8;
const MIN_GAP_MS = 150;
const MAX_GAP_MS = 800;
const COOLDOWN_MS = 2000;
/** After the second clap, wait this long for a third: three or more is applause, not a command. */
const CONFIRM_MS = 600;
/** How long after the peak the sound must have fallen away. */
const DECAY_CHECK_MS = 96;
const DECAY_TO = 0.4;
/** Sharpness: how much of the block is high-frequency (≈1.4 for white noise, ≈0.04 for a low thud). */
const MIN_SHARPNESS = 0.6;

export class ClapDetector {
  private readonly block: number;
  /** The sample distance sharpness is measured over: about 1/16000 s whatever the device rate. */
  private readonly lag: number;
  private readonly onTrace?: (line: string) => void;
  private readonly onClap?: () => void;
  private lastTraceAt = -1000;
  private readonly rise: number;
  private readonly minLevel: number;

  private carry: number[] = [];
  private t = 0; // ms of audio seen
  private background = 0.005;
  private prevRms = 0;

  /** An onset waiting to be confirmed by its decay. */
  private pending: { at: number; peak: number; blocks: number; sharp: boolean } | null = null;
  private claps: number[] = [];
  private lockedUntil = 0;
  /** When the second clap of a pair was heard; it fires once nothing more follows. */
  private armedAt: number | null = null;
  /** Set while a loud sound is still going: no new onset counts until it has fallen quiet. */
  private waitForQuiet = false;

  constructor(options: ClapOptions) {
    const s = Math.min(5, Math.max(1, Math.round(options.sensitivity ?? 3)));
    this.block = Math.max(32, Math.round((options.sampleRate * BLOCK_MS) / 1000));
    // Sharpness is how much of a block is HIGH frequency. Comparing neighbouring samples measures that at 16 kHz, but
    // at 48 kHz (what real devices run) the same sound has far smaller neighbour differences, so a real clap fell below
    // the threshold. Comparing samples a third of the way apart at 48 kHz gives the same answer at any rate.
    this.lag = Math.max(1, Math.round(options.sampleRate / 16000));
    this.onTrace = options.onTrace;
    this.onClap = options.onClap;
    this.rise = RISE_MULTIPLE[s]!;
    this.minLevel = MIN_LEVEL[s]!;
  }

  /** Feed audio in any chunk size. Returns 'double' at the moment a double clap is recognised. */
  process(samples: Float32Array): 'double' | null {
    let result: 'double' | null = null;
    for (let i = 0; i < samples.length; i++) {
      this.carry.push(samples[i]!);
      if (this.carry.length >= this.block) {
        const found = this.onBlock(this.carry);
        this.carry = [];
        if (found) result = 'double';
      }
    }
    return result;
  }

  /** Forget everything about the past (the stream was closed and reopened). */
  reset(): void {
    this.carry = [];
    this.pending = null;
    this.claps = [];
    this.armedAt = null;
    this.prevRms = 0;
    this.waitForQuiet = false;
  }

  private onBlock(block: number[]): boolean {
    this.t += BLOCK_MS;
    let sum = 0;
    let diff = 0;
    for (let i = 0; i < block.length; i++) {
      const v = block[i]!;
      sum += v * v;
      if (i >= this.lag) {
        const d = v - block[i - this.lag]!;
        diff += d * d;
      }
    }
    const rms = Math.sqrt(sum / block.length);
    const sharp = rms > 1e-6 ? Math.sqrt(diff / (block.length - this.lag)) / rms : 0;
    const quiet = rms < Math.max(this.background * 2, this.minLevel * 0.35);
    let doubled = false;

    if (this.armedAt !== null && this.t - this.armedAt >= CONFIRM_MS) {
      this.armedAt = null;
      this.lockedUntil = this.t + COOLDOWN_MS;
      doubled = true;
    }

    if (this.pending) {
      const p = this.pending;
      p.blocks += 1;
      p.peak = Math.max(p.peak, rms);
      p.sharp = p.sharp || sharp >= MIN_SHARPNESS;
      if (p.blocks * BLOCK_MS >= DECAY_CHECK_MS) {
        // Confirmed only if it has fallen away since the peak; a sound that is still loud is not a clap.
        const fell = rms < p.peak * DECAY_TO;
        this.onTrace?.(
          `${fell ? 'clap' : 'sustained (not a clap)'} peak=${p.peak.toFixed(3)} after=${rms.toFixed(3)}`,
        );
        this.pending = null;
        if (fell) {
          this.onClap?.();
          this.registerClap(p.at);
        } else this.waitForQuiet = true;
      }
    } else {
      if (this.waitForQuiet && quiet) this.waitForQuiet = false;
      const onset =
        !this.waitForQuiet &&
        this.t >= this.lockedUntil &&
        rms > this.minLevel &&
        rms > this.background * this.rise &&
        this.prevRms < rms * 0.85 &&
        sharp >= MIN_SHARPNESS;
      if (
        this.onTrace &&
        !onset &&
        rms > Math.max(this.background * 2.5, this.minLevel * 0.3) &&
        this.t - this.lastTraceAt >= 150
      ) {
        // Which of the tests a loud-enough sound failed: the whole point of the trace.
        const failed = [
          this.waitForQuiet && 'waiting-for-quiet',
          this.t < this.lockedUntil && 'cooldown',
          !(rms > this.minLevel) && 'too-quiet',
          !(rms > this.background * this.rise) && 'not-above-room',
          !(this.prevRms < rms * 0.85) && 'not-sudden',
          !(sharp >= MIN_SHARPNESS) && 'not-sharp',
        ].filter(Boolean);
        this.lastTraceAt = this.t;
        this.onTrace(
          `rejected rms=${rms.toFixed(3)} sharp=${sharp.toFixed(2)} room=${this.background.toFixed(4)} need>${this.minLevel} and >${(this.background * this.rise).toFixed(3)}: ${failed.join(',')}`,
        );
      }
      if (onset) {
        this.pending = { at: this.t, peak: rms, blocks: 0, sharp: true };
        this.onTrace?.(
          `onset rms=${rms.toFixed(3)} sharp=${sharp.toFixed(2)} room=${this.background.toFixed(4)}`,
        );
      } else if (!this.waitForQuiet) {
        // The room's own level follows slowly, and only while nothing is happening.
        this.background = Math.max(0.002, this.background * 0.98 + rms * 0.02);
      }
    }
    this.prevRms = rms;
    return doubled;
  }

  private registerClap(at: number): void {
    if (this.armedAt !== null) {
      // A third clap after a pair: applause, a drum, a noisy room. Not a command; stay quiet for a while.
      this.armedAt = null;
      this.claps = [];
      this.lockedUntil = this.t + COOLDOWN_MS;
      return;
    }
    this.claps = this.claps.filter((c) => at - c <= MAX_GAP_MS);
    const last = this.claps[this.claps.length - 1];
    if (last !== undefined && at - last < MIN_GAP_MS) return; // ringing / echo of the same clap
    this.claps.push(at);
    if (this.claps.length === 2) {
      this.claps = [];
      this.armedAt = this.t;
    }
  }
}
