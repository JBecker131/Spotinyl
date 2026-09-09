import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARM_PARKED_DEG,
  ARM_LEAD_IN_DEG,
  ARM_INNER_DEG,
  progressRatio,
  armAngle,
} from '../src/lib/geometry.js';

test('progressRatio is the plain quotient inside range', () => {
  assert.equal(progressRatio(50, 200), 0.25);
});

test('progressRatio clamps below zero and above one', () => {
  assert.equal(progressRatio(-10, 200), 0);
  assert.equal(progressRatio(400, 200), 1);
});

test('progressRatio returns 0 rather than dividing by zero', () => {
  assert.equal(progressRatio(50, 0), 0);
  assert.equal(progressRatio(50, -1), 0);
});

test('progressRatio returns 0 for non-finite input', () => {
  assert.equal(progressRatio(NaN, 200), 0);
  assert.equal(progressRatio(50, Infinity), 0);
  assert.equal(progressRatio(undefined, 200), 0);
});

test('armAngle parks the arm when no track is loaded', () => {
  assert.equal(armAngle({ hasTrack: false, progressMs: 5000, durationMs: 10000 }), ARM_PARKED_DEG);
});

test('armAngle sits on the lead-in groove at the start of a track', () => {
  assert.equal(armAngle({ hasTrack: true, progressMs: 0, durationMs: 10000 }), ARM_LEAD_IN_DEG);
});

test('armAngle reaches the inner groove at the end of a track', () => {
  assert.equal(armAngle({ hasTrack: true, progressMs: 10000, durationMs: 10000 }), ARM_INNER_DEG);
});

test('armAngle interpolates linearly across the record', () => {
  const mid = armAngle({ hasTrack: true, progressMs: 5000, durationMs: 10000 });
  assert.equal(mid, (ARM_LEAD_IN_DEG + ARM_INNER_DEG) / 2);
});

test('armAngle increases monotonically as the track plays', () => {
  let previous = -Infinity;
  for (let p = 0; p <= 10000; p += 500) {
    const angle = armAngle({ hasTrack: true, progressMs: p, durationMs: 10000 });
    assert.ok(angle >= previous, `angle regressed at ${p}ms`);
    previous = angle;
  }
});

test('armAngle rests on the lead-in when duration is unknown', () => {
  assert.equal(armAngle({ hasTrack: true, progressMs: 5000, durationMs: 0 }), ARM_LEAD_IN_DEG);
});

test('the arm always swings inward, never past the inner groove', () => {
  assert.ok(ARM_PARKED_DEG < ARM_LEAD_IN_DEG);
  assert.ok(ARM_LEAD_IN_DEG < ARM_INNER_DEG);
});
