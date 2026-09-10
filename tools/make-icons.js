import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Enough of the PNG spec to read the logo: 8-bit RGB or RGBA, no interlacing.
export function decodePng(buffer) {
  const bytes = Buffer.from(buffer);
  let width = 0, height = 0, channels = 0;
  const parts = [];

  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth: ${data[8]}`);
      if (data[9] !== 2 && data[9] !== 6) throw new Error(`unsupported colour type: ${data[9]}`);
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height) throw new Error('no IHDR chunk found');

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const lines = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prior = out - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? lines[out + x - channels] : 0;
      const up = y > 0 ? lines[prior + x] : 0;
      const upLeft = y > 0 && x >= channels ? lines[prior + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported filter type: ${filter}`);
      lines[out + x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: new Uint8Array(lines) };

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < lines.length; i += 3, j += 4) {
    rgba[j] = lines[i];
    rgba[j + 1] = lines[i + 1];
    rgba[j + 2] = lines[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

// Centre-crops the source to a square and box-filters it down to size x size,
// which keeps the artwork's edges clean at 16px.
export function resizeToSquare(source, width, height, size) {
  const side = Math.min(width, height);
  const left = (width - side) / 2;
  const top = (height - side) / 2;
  const px = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(top + (y * side) / size);
    const y1 = Math.max(y0 + 1, Math.floor(top + ((y + 1) * side) / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(left + (x * side) / size);
      const x1 = Math.max(x0 + 1, Math.floor(left + ((x + 1) * side) / size));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          const alpha = source[i + 3] / 255;
          r += source[i] * alpha; // weight colour by coverage so edges don't halo
          g += source[i + 1] * alpha;
          b += source[i + 2] * alpha;
          a += source[i + 3];
          n++;
        }
      }

      const i = (y * size + x) * 4;
      const coverage = a / (n * 255);
      px[i] = coverage ? Math.round(r / n / coverage) : 0;
      px[i + 1] = coverage ? Math.round(g / n / coverage) : 0;
      px[i + 2] = coverage ? Math.round(b / n / coverage) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// Running this file directly regenerates the icon set from the logo artwork.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(root, 'icons');
  const logo = decodePng(readFileSync(join(root, 'assets', 'spotinyl-logo.png')));
  mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const px = resizeToSquare(logo.rgba, logo.width, logo.height, size);
    writeFileSync(join(outDir, `icon-${size}.png`), encodePng(size, size, px));
    console.log(`wrote icons/icon-${size}.png`);
  }
}
