/**
 * Generate the extension's PNG icons.
 *
 *   node scripts/make-icons.mjs
 *
 * Committed output lives in public/icons/, so this only needs re-running when
 * the mark changes. Written by hand rather than pulled from an image library:
 * one build-time dependency for four flat-colour circles is a poor trade, and
 * the PNG encoder below is about thirty lines.
 *
 * The mark is a lens - a ring with a bright centre - for "see clearly".
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const SIZES = [16, 32, 48, 128];

const ACCENT = [30, 95, 191]; // #1e5fbf, matches the panel accent
const LIGHT = [255, 255, 255];

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode RGBA pixel data (size x size) as a PNG buffer. */
function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type byte (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark --------------------------------------------------------------

/** Coverage of a pixel by a disc, sampled 3x3 so edges are not jagged. */
function discCoverage(px, py, cx, cy, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const x = px + (sx + 0.5) / 3;
      const y = py + (sy + 0.5) / 3;
      if (Math.hypot(x - cx, y - cy) <= radius) hits += 1;
    }
  }
  return hits / 9;
}

function blend(base, colour, alpha) {
  for (let i = 0; i < 3; i += 1) {
    base[i] = Math.round(base[i] * (1 - alpha) + colour[i] * alpha);
  }
  base[3] = Math.round(base[3] * (1 - alpha) + 255 * alpha);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4); // transparent
  const c = size / 2;

  const outer = size * 0.47;
  const inner = size * 0.30;
  const pupil = size * 0.14;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const px = [0, 0, 0, 0];

      // Accent disc, then a light disc punched out of it, then an accent dot:
      // reads as a lens at 128px and stays legible as a ring at 16px.
      blend(px, ACCENT, discCoverage(x, y, c, c, outer));
      blend(px, LIGHT, discCoverage(x, y, c, c, inner));
      blend(px, ACCENT, discCoverage(x, y, c, c, pupil));

      pixels[offset] = px[0];
      pixels[offset + 1] = px[1];
      pixels[offset + 2] = px[2];
      pixels[offset + 3] = px[3];
    }
  }

  return encodePng(size, pixels);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
