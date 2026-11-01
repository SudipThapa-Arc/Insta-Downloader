// Generates the extension PNG icons (no dependencies — draws and encodes by hand).
// Usage: node tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 16 * 2, 48, 128];
const SS = 4; // supersampling factor for smooth edges

// --- tiny PNG encoder -------------------------------------------------------
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
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// --- artwork ----------------------------------------------------------------
const STOPS = [
  [0.0, [249, 206, 52]],
  [0.48, [238, 42, 123]],
  [1.0, [98, 40, 215]]
];

function gradient(t) {
  for (let i = 1; i < STOPS.length; i += 1) {
    const [pos, rgb] = STOPS[i];
    const [prevPos, prevRgb] = STOPS[i - 1];
    if (t <= pos) {
      const k = (t - prevPos) / (pos - prevPos);
      return [0, 1, 2].map((c) => Math.round(prevRgb[c] + (rgb[c] - prevRgb[c]) * k));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const inRoundedRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

// White download glyph: arrow (stem + head) above a tray.
const inGlyph = (x, y) => {
  if (inRect(x, y, 0.445, 0.2, 0.555, 0.5)) return true; // stem
  const headTop = 0.46;
  const headBottom = 0.635;
  if (y >= headTop && y <= headBottom) {
    const spread = 0.155 * (1 - (y - headTop) / (headBottom - headTop));
    if (Math.abs(x - 0.5) <= spread) return true; // head
  }
  if (inRect(x, y, 0.265, 0.645, 0.345, 0.83)) return true; // left column
  if (inRect(x, y, 0.655, 0.645, 0.735, 0.83)) return true; // right column
  if (inRect(x, y, 0.265, 0.75, 0.735, 0.83)) return true; // tray
  return false;
};

function render(size) {
  const big = size * SS;
  const buffer = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px * SS + sx + 0.5) / big;
          const y = (py * SS + sy + 0.5) / big;
          if (!inRoundedRect(x, y, 0.24)) continue;
          if (inGlyph(x, y)) {
            r += 255;
            g += 255;
            b += 255;
          } else {
            const [cr, cg, cb] = gradient((x + y) / 2);
            r += cr;
            g += cg;
            b += cb;
          }
          a += 1;
        }
      }

      const offset = (py * size + px) * 4;
      if (!a) continue;
      buffer[offset] = Math.round(r / a);
      buffer[offset + 1] = Math.round(g / a);
      buffer[offset + 2] = Math.round(b / a);
      buffer[offset + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }

  return encodePng(size, buffer);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
