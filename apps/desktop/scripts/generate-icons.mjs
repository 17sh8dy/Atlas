/**
 * Generates the Atlas application icons.
 *
 * The mark is drawn in code rather than committed as opaque binaries so it can
 * be re-rendered at any size, tweaked in one place, and reviewed in a diff. It
 * is a rounded square in the Atlas indigo with a meridian-and-parallel globe
 * cut out of it — a nod to the atlas the app is named for, legible at 16px
 * where anything more detailed turns to mush.
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

// Atlas indigo, matching --color-primary in @atlas/tokens.
const BG = [99, 102, 241];
const FG = [255, 255, 255];

/** Distance from a point to a line segment — used to stroke the globe curves. */
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
 * far more than the drawing itself here: a hard-edged circle at 32px looks
 * broken, and this is the whole reason the icon is generated rather than
 * scaled down from one big PNG.
 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3;
  const c = size / 2;
  const radius = size * 0.5;
  const corner = size * 0.22;

  // Globe geometry, as fractions of the icon.
  const globeR = size * 0.30;
  const stroke = Math.max(size * 0.045, 1.1);
  // Meridians as vertical ellipses, parallels as horizontal lines.
  const meridianRx = [globeR, globeR * 0.42];
  const parallelYs = [-globeR * 0.45, 0, globeR * 0.45];

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

          // Globe: outline, meridians, parallels.
          const gx = fx - c;
          const gy = fy - c;
          const dist = Math.hypot(gx, gy);

          let onGlobe = Math.abs(dist - globeR) <= stroke / 2;

          if (!onGlobe && dist < globeR) {
            for (const rx of meridianRx) {
              // Distance to an ellipse of half-width rx and half-height globeR.
              const norm = Math.hypot(gx / rx, gy / globeR);
              const approx = Math.abs(norm - 1) * Math.min(rx, globeR);
              if (approx <= stroke / 2) {
                onGlobe = true;
                break;
              }
            }
          }
          if (!onGlobe && dist < globeR) {
            for (const py of parallelYs) {
              const halfWidth = Math.sqrt(Math.max(0, globeR * globeR - py * py));
              if (distToSegment(gx, gy, -halfWidth, py, halfWidth, py) <= stroke / 2) {
                onGlobe = true;
                break;
              }
            }
          }
          if (onGlobe) fgCover++;
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
