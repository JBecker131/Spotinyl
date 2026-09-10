import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { encodePng, decodePng, resizeToSquare } from '../tools/make-icons.js';

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

test('decodePng round-trips pixels written by encodePng', () => {
  const rgba = new Uint8Array([
    10, 20, 30, 255, 40, 50, 60, 128,
    70, 80, 90, 255, 100, 110, 120, 0,
  ]);
  const decoded = decodePng(encodePng(2, 2, rgba));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.rgba], [...rgba]);
});

test('decodePng reads the logo artwork the icons are cut from', () => {
  const logo = decodePng(readFileSync(new URL('../assets/spotinyl-logo.png', import.meta.url)));
  assert.ok(logo.width > 0 && logo.height > 0);
  assert.equal(logo.rgba.length, logo.width * logo.height * 4);
});

test('resizeToSquare returns RGBA for every pixel of a square image', () => {
  const px = resizeToSquare(new Uint8Array(8 * 8 * 4), 8, 8, 4);
  assert.equal(px.length, 4 * 4 * 4);
});

test('resizeToSquare averages the block each output pixel covers', () => {
  // A 2x2 source where the left half is white and the right half is black.
  const src = new Uint8Array([
    255, 255, 255, 255, 0, 0, 0, 255,
    255, 255, 255, 255, 0, 0, 0, 255,
  ]);
  const px = resizeToSquare(src, 2, 2, 1);
  assert.deepEqual([...px], [128, 128, 128, 255]);
});

test('resizeToSquare centre-crops a wide image to a square', () => {
  // 3x1 strip: red, green, blue. The square crop keeps the middle pixel.
  const src = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  ]);
  const px = resizeToSquare(src, 3, 1, 1);
  assert.deepEqual([...px], [0, 255, 0, 255]);
});
