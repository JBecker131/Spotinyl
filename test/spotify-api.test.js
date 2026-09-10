import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiRequest, getPlayback, play, pause, next, previous, setVolume, clampVolume,
  getDevices, transferPlayback,
} from '../src/lib/spotify-api.js';

function response(status, { body = '', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const call = (fetchImpl, extra = {}) =>
  apiRequest({ fetchImpl, accessToken: 'tok', method: 'GET', path: '/me/player', ...extra });

test('apiRequest sends the bearer token to the v1 API', async () => {
  let seen = null;
  await call(async (url, init) => {
    seen = { url, init };
    return response(200, { body: '{"a":1}' });
  });
  assert.equal(seen.url, 'https://api.spotify.com/v1/me/player');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
});

test('apiRequest appends query parameters', async () => {
  let seen = null;
  await call(
    async (url) => { seen = url; return response(204); },
    { method: 'PUT', path: '/me/player/volume', query: { volume_percent: 40 } },
  );
  assert.equal(seen, 'https://api.spotify.com/v1/me/player/volume?volume_percent=40');
});

test('apiRequest parses a 200 JSON body', async () => {
  const result = await call(async () => response(200, { body: '{"is_playing":true}' }));
  assert.deepEqual(result, { ok: true, data: { is_playing: true } });
});

test('apiRequest treats 204 as success with no data', async () => {
  const result = await call(async () => response(204));
  assert.deepEqual(result, { ok: true, data: null });
});

test('apiRequest treats an empty 200 body as no data', async () => {
  const result = await call(async () => response(200, { body: '' }));
  assert.deepEqual(result, { ok: true, data: null });
});

test('apiRequest maps 401 to unauthorized', async () => {
  const result = await call(async () => response(401));
  assert.equal(result.ok, false);
  assert.equal(result.error.tag, 'unauthorized');
});

test('apiRequest maps 403 to forbidden with a Premium message', async () => {
  const result = await call(async () => response(403));
  assert.equal(result.error.tag, 'forbidden');
  assert.match(result.error.message, /Premium/i);
});

test('apiRequest maps 404 to no-device', async () => {
  const result = await call(async () => response(404));
  assert.equal(result.error.tag, 'no-device');
});

test('apiRequest maps 429 and reads Retry-After', async () => {
  const result = await call(async () => response(429, { headers: { 'retry-after': '7' } }));
  assert.equal(result.error.tag, 'rate-limited');
  assert.equal(result.error.retryAfterMs, 7000);
});

test('apiRequest defaults Retry-After when the header is missing or junk', async () => {
  const missing = await call(async () => response(429));
  assert.equal(missing.error.retryAfterMs, 1000);
  const junk = await call(async () => response(429, { headers: { 'retry-after': 'soon' } }));
  assert.equal(junk.error.retryAfterMs, 1000);
});

test('apiRequest maps a thrown fetch to offline', async () => {
  const result = await call(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(result.error.tag, 'offline');
});

test('apiRequest maps other failures to unknown and surfaces the API message', async () => {
  const result = await call(async () =>
    response(500, { body: '{"error":{"message":"Server error"}}' }));
  assert.equal(result.error.tag, 'unknown');
  assert.match(result.error.message, /Server error/);
});

test('apiRequest survives a non-JSON error body', async () => {
  const result = await call(async () => response(502, { body: '<html>bad gateway</html>' }));
  assert.equal(result.error.tag, 'unknown');
  assert.ok(result.error.message.length > 0);
});

test('apiRequest never throws, even on a malformed success body', async () => {
  const result = await call(async () => response(200, { body: 'not json' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.tag, 'unknown');
});

test('getPlayback issues GET /me/player', async () => {
  let seen = null;
  await getPlayback({ fetchImpl: async (url, init) => { seen = { url, init }; return response(204); }, accessToken: 't' });
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.url, 'https://api.spotify.com/v1/me/player');
});

test('transport controls use the documented methods and paths', async () => {
  const cases = [
    [play, 'PUT', 'https://api.spotify.com/v1/me/player/play'],
    [pause, 'PUT', 'https://api.spotify.com/v1/me/player/pause'],
    [next, 'POST', 'https://api.spotify.com/v1/me/player/next'],
    [previous, 'POST', 'https://api.spotify.com/v1/me/player/previous'],
  ];
  for (const [fn, method, url] of cases) {
    let seen = null;
    await fn({ fetchImpl: async (u, init) => { seen = { u, init }; return response(204); }, accessToken: 't' });
    assert.equal(seen.init.method, method, url);
    assert.equal(seen.u, url);
  }
});

test('clampVolume rounds and constrains to 0-100', () => {
  assert.equal(clampVolume(42.6), 43);
  assert.equal(clampVolume(-10), 0);
  assert.equal(clampVolume(1000), 100);
  assert.equal(clampVolume(NaN), 0);
  assert.equal(clampVolume(undefined), 0);
});

test('setVolume sends a clamped integer percent', async () => {
  let seen = null;
  await setVolume({
    fetchImpl: async (url, init) => { seen = { url, init }; return response(204); },
    accessToken: 't',
    percent: 142.7,
  });
  assert.equal(seen.init.method, 'PUT');
  assert.equal(seen.url, 'https://api.spotify.com/v1/me/player/volume?volume_percent=100');
});

test('setVolume targets a device when one is given', async () => {
  let seen = null;
  await setVolume({
    fetchImpl: async (url) => { seen = url; return response(204); },
    accessToken: 't',
    percent: 40,
    deviceId: 'PHONE',
  });
  assert.equal(
    seen,
    'https://api.spotify.com/v1/me/player/volume?volume_percent=40&device_id=PHONE',
  );
});

test('setVolume omits device_id when no device is given', async () => {
  let seen = null;
  await setVolume({
    fetchImpl: async (url) => { seen = url; return response(204); },
    accessToken: 't',
    percent: 40,
  });
  assert.equal(seen, 'https://api.spotify.com/v1/me/player/volume?volume_percent=40');
});
