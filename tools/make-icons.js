import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const source = Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    source.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Radial colour profile of the record, sampled by distance from centre.
function sampleRecord(distance, radius) {
  if (distance > radius) return [0, 0, 0, 0]; // outside the disc
  if (distance < radius * 0.09) return [0, 0, 0, 0]; // spindle hole
  if (distance < radius * 0.34) return [232, 163, 61, 255]; // amber label
  const groove = Math.sin(distance * 1.15) > 0 ? 30 : 15;
  return [groove, groove, groove + 4, 255];
}

export function drawRecord(size) {
  const SS = 4; // supersample factor, for antialiased edges
  const n = size * SS;
  const centre = (n - 1) / 2;
  const radius = n / 2;
  const px = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const d = Math.hypot(x * SS + sx - centre, y * SS + sy - centre);
          const [sr, sg, sb, sa] = sampleRecord(d, radius);
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const m = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / m);
      px[i + 1] = Math.round(g / m);
      px[i + 2] = Math.round(b / m);
      px[i + 3] = Math.round(a / m);
    }
  }
  return px;
}

// Running this file directly regenerates the icon set.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
  mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(outDir, `icon-${size}.png`), encodePng(size, size, drawRecord(size)));
    console.log(`wrote icons/icon-${size}.png`);
  }
}
