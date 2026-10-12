// Draws the app icons (a small board seen from above) and writes PNGs.
//   node tools/make-icons.js
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const BG = [20, 23, 26, 255];
const LIGHT = [233, 228, 216, 255];
const DARK = [63, 167, 114, 255];

// A 4x4 board in perspective-free top view, inset by `pad` of the size.
function icon(pad) {
  return (x, y, size) => {
    const u = x / size;
    const v = y / size;
    const lo = pad;
    const hi = 1 - pad;
    if (u < lo || u > hi || v < lo || v > hi) return BG;
    const f = Math.floor(((u - lo) / (hi - lo)) * 4);
    const r = Math.floor(((v - lo) / (hi - lo)) * 4);
    // One square marked, as if a move was just recorded.
    if (f === 2 && r === 1) return [240, 214, 74, 255];
    return (f + r) % 2 ? DARK : LIGHT;
  };
}

for (const [name, size, pad] of [['icon-180', 180, 0.2], ['icon-192', 192, 0.2], ['icon-512', 512, 0.2], ['icon-maskable-512', 512, 0.28]]) {
  writeFileSync(new URL(`../icons/${name}.png`, import.meta.url), png(size, icon(pad)));
}
console.log('icons written');
