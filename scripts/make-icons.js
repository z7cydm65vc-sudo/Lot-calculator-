// Renders the PNG app icons (same design as icons/icon.svg) with no dependencies.
// Usage: node scripts/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [11, 15, 23], GREEN = [34, 197, 94], BLUE = [59, 130, 246];

// Colour at a point in the 512×512 design space (full-bleed background; iOS rounds corners itself).
function shade(x, y) {
  const dx = x - 256, dy = y - 256, d = Math.hypot(dx, dy);
  const inBar = (top) => {
    const cy = Math.min(Math.max(y, top + 18), top + 110 - 18);
    return Math.hypot(x - 256, y - cy) <= 18;
  };
  if (inBar(60) || inBar(342)) return BLUE;
  if (d <= 58 || Math.abs(d - 150) <= 18) return GREEN;
  return BG;
}

function render(size) {
  const ss = 4, scale = 512 / size;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = shade((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(acc[0] / (ss * ss));
      raw[o + 1] = Math.round(acc[1] / (ss * ss));
      raw[o + 2] = Math.round(acc[2] / (ss * ss));
      raw[o + 3] = 255;
    }
  }
  return png(size, size, raw);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'icons');
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(out, name), render(size));
  console.log('wrote icons/' + name);
}
