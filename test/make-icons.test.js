import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng, drawRecord } from '../tools/make-icons.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('encodePng emits the PNG signature', () => {
  const png = encodePng(2, 2, new Uint8Array(2 * 2 * 4));
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
});

test('encodePng writes an IHDR chunk carrying the dimensions', () => {
  const png = encodePng(16, 32, new Uint8Array(16 * 32 * 4));
  // 8 signature + 4 length + 4 type, then width/height
  assert.equal(png.readUInt32BE(16), 16, 'width');
  assert.equal(png.readUInt32BE(20), 32, 'height');
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'colour type RGBA');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
});

test('encodePng round-trips pixel data through the IDAT chunk', () => {
  const rgba = new Uint8Array([
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255,
  ]);
  const png = encodePng(2, 2, rgba);
  const idatStart = png.indexOf(Buffer.from('IDAT', 'latin1'));
  const idatLength = png.readUInt32BE(idatStart - 4);
  const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLength));
  // Each row is prefixed with a filter byte of 0.
  assert.deepEqual([...raw], [0, 1, 2, 3, 255, 4, 5, 6, 255, 0, 7, 8, 9, 255, 10, 11, 12, 255]);
});

test('encodePng ends with an IEND chunk', () => {
  const png = encodePng(1, 1, new Uint8Array(4));
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND');
});

test('drawRecord returns RGBA for every pixel', () => {
  const px = drawRecord(48);
  assert.equal(px.length, 48 * 48 * 4);
});

test('drawRecord punches a transparent spindle hole at the centre', () => {
  const size = 48;
  const px = drawRecord(size);
  const centre = ((size / 2) * size + size / 2) * 4;
  assert.equal(px[centre + 3], 0, 'centre pixel must be transparent');
});

test('drawRecord leaves the corners transparent so the disc reads as round', () => {
  const px = drawRecord(48);
  assert.equal(px[3], 0, 'top-left corner alpha');
});

test('drawRecord paints an opaque amber label ring around the hole', () => {
  const size = 64;
  const px = drawRecord(size);
  // A fifth of the radius out from centre lands inside the label.
  const x = Math.round(size / 2 + size * 0.1);
  const i = ((size / 2) * size + x) * 4;
  assert.equal(px[i + 3], 255, 'label must be opaque');
  assert.ok(px[i] > px[i + 2], 'label is amber: more red than blue');
});
