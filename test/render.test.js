import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faderEnabled } from '../src/popup/render.js';
import { STATUS } from '../src/lib/player-state.js';

const state = (extra) => ({
  status: STATUS.READY, deviceId: 'PHONE', canSetVolume: true, ...extra,
});

test('faderEnabled allows a device that takes volume', () => {
  assert.equal(faderEnabled(state()), true);
});

test('faderEnabled blocks a device that sets its own volume', () => {
  assert.equal(faderEnabled(state({ canSetVolume: false })), false);
});

// Nothing is on Connect, so there is no device to have refused. The router
// still aims at the last one it saw, so leave the fader live rather than
// greying it out on a phone that would have answered.
test('faderEnabled stays live when no device is known', () => {
  assert.equal(
    faderEnabled(state({ status: STATUS.NO_DEVICE, deviceId: null, canSetVolume: false })),
    true,
  );
});

test('faderEnabled blocks states that control nothing', () => {
  assert.equal(faderEnabled(state({ status: STATUS.NEEDS_AUTH })), false);
  assert.equal(faderEnabled(state({ status: STATUS.FORBIDDEN })), false);
});
