/**
 * Turning an analyser's frequency bins into the handful of numbers a
 * visualiser can actually draw.
 *
 * ── Why not just hand over the bins ─────────────────────────────────────────
 * An `AnalyserNode` with `fftSize` 1024 reports 512 bins, which is far more
 * resolution than a shape 200 pixels across can show and far more than speech
 * puts anything in. Drawing all of them produces a blur that looks identical
 * whatever is said. A small number of wide bands moves visibly, one band per
 * thing an ear would actually distinguish.
 *
 * ── Why the bands get wider as they go up ───────────────────────────────────
 * Pitch is logarithmic and FFT bins are linear, so equal-width bands would put
 * almost every vowel in the first two and leave the rest permanently still.
 * Each band here is wider than the one below it, which is a rough stand-in for
 * the spacing an ear uses and is the difference between a shape that reacts to
 * speech and one that reacts to the letter "s".
 *
 * ── Why only the bottom of the spectrum ─────────────────────────────────────
 * Voice — synthesised at 22 kHz or captured at 16 — has essentially nothing in
 * the top half of the range. Including it would average real movement against
 * a permanently silent region and flatten everything.
 */

/** How far up the spectrum is worth looking at, as a fraction of the bins. */
const USABLE = 0.55;

/**
 * Fill `out` with one 0–1 value per band, from raw byte frequency data.
 *
 * `out.length` decides how many bands there are, so a caller changing its mind
 * about the shape needs no change here.
 */
export function fillBands(frequencies: Uint8Array, out: Float32Array): void {
  const bands = out.length;
  if (bands === 0) return;

  const usable = Math.max(bands, Math.floor(frequencies.length * USABLE));

  // Widths grow geometrically across the bands and are then normalised, so the
  // set always covers exactly the usable range whatever `bands` is.
  let total = 0;
  const widths = new Array<number>(bands);
  for (let i = 0; i < bands; i++) {
    widths[i] = Math.pow(1.55, i);
    total += widths[i]!;
  }

  let start = 0;
  for (let i = 0; i < bands; i++) {
    const width = Math.max(1, Math.round((widths[i]! / total) * usable));
    const end = Math.min(usable, start + width);

    let sum = 0;
    for (let bin = start; bin < end; bin++) sum += frequencies[bin]!;
    const mean = end > start ? sum / (end - start) / 255 : 0;

    // Expanded, because raw means sit low and make a display look timid — the
    // same correction `level()` applies, kept in step with it.
    out[i] = Math.min(1, mean * 1.8);
    start = end;
  }
}
