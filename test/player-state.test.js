import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS,
  formatTime,
  toTrack,
  interpolateProgress,
  deriveState,
} from '../src/lib/player-state.js';

const playback = {
  is_playing: true,
  progress_ms: 107000,
  device: { volume_percent: 62 },
  item: {
    id: 'track-1',
    name: 'Midnight City',
    duration_ms: 243000,
    artists: [{ name: 'M83' }],
    album: {
      name: "Hurry Up, We're Dreaming",
      images: [
        { url: 'https://img/640', width: 640 },
        { url: 'https://img/300', width: 300 },
        { url: 'https://img/64', width: 64 },
      ],
    },
  },
};

const ok = (data) => ({ ok: true, data });
const fail = (tag, message = 'boom') => ({ ok: false, error: { tag, message } });

test('formatTime renders minutes and zero-padded seconds', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9000), '0:09');
  assert.equal(formatTime(107000), '1:47');
  assert.equal(formatTime(243000), '4:03');
  assert.equal(formatTime(3723000), '62:03');
});

test('formatTime is defensive about bad input', () => {
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime(undefined), '0:00');
});

test('toTrack maps the Spotify payload onto the view model', () => {
  const track = toTrack(playback);
  assert.equal(track.id, 'track-1');
  assert.equal(track.title, 'Midnight City');
  assert.equal(track.artist, 'M83');
  assert.equal(track.album, "Hurry Up, We're Dreaming");
  assert.equal(track.durationMs, 243000);
});

test('toTrack joins multiple artists', () => {
  const many = { item: { ...playback.item, artists: [{ name: 'A' }, { name: 'B' }] } };
  assert.equal(toTrack(many).artist, 'A, B');
});

test('toTrack picks the largest artwork at or below 400px', () => {
  assert.equal(toTrack(playback).artUrl, 'https://img/300');
});

test('toTrack falls back to the smallest artwork when all are oversized', () => {
  const big = {
    item: { ...playback.item, album: { name: 'x', images: [{ url: 'https://img/640', width: 640 }] } },
  };
  assert.equal(toTrack(big).artUrl, 'https://img/640');
});

test('toTrack survives missing artwork and missing metadata', () => {
  const bare = { item: { name: 'Untitled', duration_ms: 1000 } };
  const track = toTrack(bare);
  assert.equal(track.artUrl, null);
  assert.equal(track.artist, 'Unknown artist');
  assert.equal(track.album, '');
});

test('toTrack returns null when there is no item', () => {
  assert.equal(toTrack(null), null);
  assert.equal(toTrack({}), null);
  assert.equal(toTrack({ item: null }), null);
});

test('interpolateProgress advances by wall-clock time while playing', () => {
  const ms = interpolateProgress({
    progressMs: 1000, durationMs: 10000, isPlaying: true, fetchedAt: 500, now: 3500,
  });
  assert.equal(ms, 4000);
});

test('interpolateProgress holds still while paused', () => {
  const ms = interpolateProgress({
    progressMs: 1000, durationMs: 10000, isPlaying: false, fetchedAt: 500, now: 9999,
  });
  assert.equal(ms, 1000);
});

test('interpolateProgress never runs past the end of the track', () => {
  const ms = interpolateProgress({
    progressMs: 9000, durationMs: 10000, isPlaying: true, fetchedAt: 0, now: 60000,
  });
  assert.equal(ms, 10000);
});

test('interpolateProgress ignores a clock that runs backwards', () => {
  const ms = interpolateProgress({
    progressMs: 5000, durationMs: 10000, isPlaying: true, fetchedAt: 9000, now: 1000,
  });
  assert.equal(ms, 5000);
});

test('interpolateProgress tolerates an unknown duration', () => {
  const ms = interpolateProgress({
    progressMs: 1000, durationMs: 0, isPlaying: true, fetchedAt: 0, now: 2000,
  });
  assert.equal(ms, 3000);
});

test('deriveState reports needs-setup before a client ID is stored', () => {
  const state = deriveState({ clientId: null, hasTokens: false, result: ok(playback) });
  assert.equal(state.status, STATUS.NEEDS_SETUP);
  assert.equal(state.track, null);
});

test('deriveState reports needs-auth when configured but not connected', () => {
  const state = deriveState({ clientId: 'abc', hasTokens: false, result: ok(playback) });
  assert.equal(state.status, STATUS.NEEDS_AUTH);
});

test('deriveState reports ready with full playback detail', () => {
  const state = deriveState({
    clientId: 'abc', hasTokens: true, result: ok(playback), fetchedAt: 1234,
  });
  assert.equal(state.status, STATUS.READY);
  assert.equal(state.isPlaying, true);
  assert.equal(state.progressMs, 107000);
  assert.equal(state.durationMs, 243000);
  assert.equal(state.volumePercent, 62);
  assert.equal(state.fetchedAt, 1234);
  assert.equal(state.track.title, 'Midnight City');
});

test('deriveState reports no-device when the API returns no content', () => {
  const state = deriveState({ clientId: 'abc', hasTokens: true, result: ok(null) });
  assert.equal(state.status, STATUS.NO_DEVICE);
  assert.equal(state.track, null);
  assert.equal(state.isPlaying, false);
});

test('deriveState maps the no-device error tag onto the no-device status', () => {
  const state = deriveState({ clientId: 'abc', hasTokens: true, result: fail('no-device') });
  assert.equal(state.status, STATUS.NO_DEVICE);
});

test('deriveState maps unauthorized onto needs-auth', () => {
  const state = deriveState({ clientId: 'abc', hasTokens: true, result: fail('unauthorized') });
  assert.equal(state.status, STATUS.NEEDS_AUTH);
});

test('deriveState keeps the last track visible when a control call is forbidden', () => {
  const previousTrack = toTrack(playback);
  const state = deriveState({
    clientId: 'abc', hasTokens: true, result: fail('forbidden'), previousTrack,
  });
  assert.equal(state.status, STATUS.FORBIDDEN);
  assert.equal(state.track.title, 'Midnight City');
  assert.match(state.message, /Premium/i);
});

test('deriveState still reports forbidden when no track is known', () => {
  const state = deriveState({ clientId: 'abc', hasTokens: true, result: fail('forbidden') });
  assert.equal(state.status, STATUS.FORBIDDEN);
  assert.equal(state.track, null);
});

test('deriveState maps transport failures onto the error status, keeping the last track', () => {
  const previousTrack = toTrack(playback);
  for (const tag of ['offline', 'rate-limited', 'unknown']) {
    const state = deriveState({ clientId: 'abc', hasTokens: true, result: fail(tag, 'nope'), previousTrack });
    assert.equal(state.status, STATUS.ERROR, tag);
    assert.equal(state.track.title, 'Midnight City', tag);
    assert.equal(state.message, 'nope', tag);
  }
});

test('deriveState never reports playing in a non-ready status', () => {
  for (const result of [fail('offline'), fail('forbidden'), ok(null)]) {
    assert.equal(deriveState({ clientId: 'abc', hasTokens: true, result }).isPlaying, false);
  }
});
