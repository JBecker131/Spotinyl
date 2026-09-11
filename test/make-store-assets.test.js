import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeTo, STORE_SCREENSHOT } from '../tools/make-store-assets.js';

test('the target size is one the Chrome Web Store accepts', () => {
  assert.deepEqual(STORE_SCREENSHOT, { width: 1280, height: 800 });
});

test('resizeTo returns RGBA for every pixel of the requested size', () => {
  const px = resizeTo(new Uint8Array(16 * 10 * 4), 16, 10, 8, 5);
  assert.equal(px.length, 8 * 5 * 4);
});

test('resizeTo averages the block each output pixel covers', () => {
  // A 2x2 source, left half white and right half black, down to a single pixel.
  const src = new Uint8Array([
    255, 255, 255, 255, 0, 0, 0, 255,
    255, 255, 255, 255, 0, 0, 0, 255,
  ]);
  assert.deepEqual([...resizeTo(src, 2, 2, 1, 1)], [128, 128, 128, 255]);
});

// Stretching a capture that is a hair off the target ratio would skew every
// circle on a page whose subject is a record, so the crop comes first.
test('resizeTo centre-crops rather than stretching when the aspect differs', () => {
  // 3x1 strip: red, green, blue. A square output keeps the middle pixel.
  const src = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  assert.deepEqual([...resizeTo(src, 3, 1, 1, 1)], [0, 255, 0, 255]);
});

test('resizeTo passes a source through unchanged at its own size', () => {
  const src = new Uint8Array([12, 34, 56, 255, 78, 90, 123, 255]);
  assert.deepEqual([...resizeTo(src, 2, 1, 2, 1)], [...src]);
});
