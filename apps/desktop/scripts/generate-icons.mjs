/**
 * Generates the Atlas application icons.
 *
 * The mark is drawn in code rather than committed as opaque binaries so it can
 * be re-rendered at any size, tweaked in one place, and reviewed in a diff.
 * It is the Atlas diamond — a rotated square split at its vertical centre,
 * outline on the left and solid on the right, round joins throughout — on a
 * dark rounded-square tile. Geometry and colour follow the needle-mark spec
 * at `design/logo/README.md` (and `design/logo/atlas-mark.svg`) exactly: a 5:6
 * width:height diamond that widens toward 1:1 below 32px so it never reads as
 * a thin sliver at tray/favicon sizes, with stroke weight rising as a
 * percentage of icon size the smaller it gets.
 *
 *   node scripts/generate-icons.mjs
 *
 * Outputs PNGs at every size Tauri asks for, plus an .ico wrapping them.
 * Pure Node — no image library, no network.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');

// The needle-mark spec's tile fill and mark colour (README.md in the logo
// package: "Primary (dark neutral tile)").
const BG = [0x2c, 0x2c, 0x2a];
const FG = [0xf1, 0xef, 0xe8];

/**
 * Piecewise-linear lookup over the spec's named checkpoints, flat outside
 * the given range. Both `STROKE_PCT` and `RATIO` below are transcribed
 * directly from the README's size table rather than derived, since the
 * table's values (particularly the "~1:1" note at 32px) are themselves
 * already an approximation the designer chose — interpolating between exact
 * numbers this code invented would drift from what was actually specified.
 */
function lerpTable(points, size) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (size <= sorted[0][0]) return sorted[0][1];
  if (size >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [s0, v0] = sorted[i];
    const [s1, v1] = sorted[i + 1];
    if (size >= s0 && size <= s1) {
      const t = (size - s0) / (s1 - s0);
      return v0 + (v1 - v0) * t;
    }
  }
  return sorted[sorted.length - 1][1];
}

const RATIO_5_6 = 5 / 6;

// Stroke as a fraction of icon size — README's "Stroke %" column, plus the
// 512px master's 12/512 as the upper anchor (2.34%, "full canonical
// geometry" begins at 64px and above, where this is nearly the same number).
const STROKE_PCT = [
  [16, 0.075],
  [20, 0.075],
  [24, 0.075],
  [32, 0.063],
  [48, 0.052],
  [64, 0.047],
  [512, 12 / 512],
];

// Half-width : half-height. 5:6 at 64px and above ("full canonical
// geometry"); square (1:1) at 24px and below ("floor size, maximum weight");
// the widening happens between those two, which is where the spec's own
// "~1:1" approximation at 32px falls out naturally rather than needing its
// own entry.
const RATIO_TABLE = [
  [24, 1],
  [48, RATIO_5_6],
];

/** Point-in-triangle via the sign of each edge's cross product. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Distance from a point to a line segment — used to stroke the diamond's edges. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Render the mark at `size`, returning RGBA bytes.
 *
 * Coverage is sampled at 3×3 per pixel and averaged. Real antialiasing matters
 * far more than the drawing itself here: a hard-edged diamond at 32px looks
 * broken, and this is the whole reason the icon is generated rather than
 * scaled down from one big PNG.
 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3;
  const c = size / 2;
  const radius = size * 0.5;
  const corner = size * 0.22;

  // Diamond geometry. Half-height is fixed at the master's proportion
  // (192/512) regardless of size — only the width breathes, per RATIO_TABLE
  // — so the mark's vertical extent (and therefore its clear space) never
  // changes shape, only how wide it sits inside that extent.
  const halfH = size * (192 / 512);
  const halfW = halfH * lerpTable(RATIO_TABLE, size);
  const stroke = Math.max(size * lerpTable(STROKE_PCT, size), 1);

  const top = [c, c - halfH];
  const right = [c + halfW, c];
  const bottom = [c, c + halfH];
  const left = [c - halfW, c];
  const edges = [
    [...top, ...right],
    [...right, ...bottom],
    [...bottom, ...left],
    [...left, ...top],
  ];
  const joints = [top, right, bottom, left];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCover = 0;
      let fgCover = 0;

      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;

          // Rounded-square background.
          const dx = Math.abs(fx - c) - (radius - corner);
          const dy = Math.abs(fy - c) - (radius - corner);
          const outside =
            dx > 0 && dy > 0 ? Math.hypot(dx, dy) - corner : Math.max(dx, dy) - corner;
          if (outside > 0) continue;
          bgCover++;

          // The right half is solid fill. The left half shows only where the
          // outline stroke lands — matching "outline on the left, solid on
          // the right" from the mark's own spec.
          let onMark = inTriangle(fx, fy, ...top, ...right, ...bottom);

          if (!onMark) {
            for (const [x1, y1, x2, y2] of edges) {
              if (distToSegment(fx, fy, x1, y1, x2, y2) <= stroke / 2) {
                onMark = true;
                break;
              }
            }
          }
          // Round joins: a stroked polyline alone mitres at each vertex: a
          // small disc at each joint is what makes the corner read as round
          // rather than pointed, the same way `stroke-linejoin: round` does.
          if (!onMark) {
            for (const [jx, jy] of joints) {
              if (Math.hypot(fx - jx, fy - jy) <= stroke / 2) {
                onMark = true;
                break;
              }
            }
          }
          if (onMark) fgCover++;
        }
      }

      const total = S * S;
      if (bgCover === 0) continue;

      const alpha = Math.round((bgCover / total) * 255);
      const fgMix = fgCover / bgCover;
      const i = (y * size + x) * 4;
      px[i] = Math.round(BG[0] + (FG[0] - BG[0]) * fgMix);
      px[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * fgMix);
      px[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * fgMix);
      px[i + 3] = alpha;
    }
  }
  return px;
}

// ---- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10–12: compression, filter, interlace — all zero.

  // Filter byte 0 (None) per scanline. The image is tiny and already
  // compresses well; a smarter filter would save bytes nobody will notice.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico containing PNG-compressed entries, which every modern Windows accepts. */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32BE(0, o + 8);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ---- go ----------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const PNG_SIZES = [
  [32, '32x32.png'],
  [128, '128x128.png'],
  [256, '128x128@2x.png'],
  [512, 'icon.png'],
];

for (const [size, name] of PNG_SIZES) {
  writeFileSync(join(OUT, name), encodePng(size, render(size)));
  console.log(`  ${name.padEnd(16)} ${size}×${size}`);
}

const icoEntries = [16, 32, 48, 64, 128, 256].map((size) => ({
  size,
  png: encodePng(size, render(size)),
}));
writeFileSync(join(OUT, 'icon.ico'), encodeIco(icoEntries));
console.log(`  icon.ico         ${icoEntries.map((e) => e.size).join(', ')}`);
