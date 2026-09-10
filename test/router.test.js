import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/background/router.js';
import { STATUS } from '../src/lib/player-state.js';

const PLAYBACK = {
  is_playing: true,
  progress_ms: 1000,
  device: { volume_percent: 50 },
  item: { id: 't', name: 'Song', duration_ms: 9000, artists: [{ name: 'Band' }], album: { name: 'Al', images: [] } },
};

function memoryStorage(initial = {}) {
  let data = { clientId: null, tokens: null, ...initial };
  return {
    get: async () => ({ ...data }),
    set: async (patch) => { data = { ...data, ...patch }; },
    peek: () => ({ ...data }),
  };
}

function jsonResponse(status, body = '', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const validTokens = { accessToken: 'A', refreshToken: 'R', expiresAt: 10_000_000, scope: 's' };

function build({ storage = memoryStorage(), fetchImpl = async () => jsonResponse(204), launchAuthFlow = async () => '' } = {}) {
  return {
    storage,
    router: createRouter({
      storage,
      fetchImpl,
      launchAuthFlow,
      redirectUri: 'https://ext.chromiumapp.org/',
      now: () => 0,
      wait: async () => {}, // Scans between reads resolve at once under test.
    }),
  };
}

test('GET_STATE reports needs-setup with no client ID', async () => {
  const { router } = build();
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.ok, true);
  assert.equal(res.state.status, STATUS.NEEDS_SETUP);
});

test('GET_STATE reports needs-auth with a client ID but no tokens', async () => {
  const { router } = build({ storage: memoryStorage({ clientId: 'cid' }) });
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.state.status, STATUS.NEEDS_AUTH);
});

test('GET_STATE returns ready playback state', async () => {
  const { router } = build({
    storage: memoryStorage({ clientId: 'cid', tokens: validTokens }),
    fetchImpl: async () => jsonResponse(200, JSON.stringify(PLAYBACK)),
  });
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.state.status, STATUS.READY);
  assert.equal(res.state.track.title, 'Song');
  assert.equal(res.state.volumePercent, 50);
});

test('GET_STATE reports no-device on a 204', async () => {
  const { router } = build({
    storage: memoryStorage({ clientId: 'cid', tokens: validTokens }),
    fetchImpl: async () => jsonResponse(204),
  });
  assert.equal((await router.handle({ type: 'GET_STATE' })).state.status, STATUS.NO_DEVICE);
});

test('an expired access token is refreshed before the API call', async () => {
  const storage = memoryStorage({
    clientId: 'cid',
    tokens: { ...validTokens, accessToken: 'OLD', expiresAt: -1 },
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('accounts.spotify.com')) {
      return jsonResponse(200, JSON.stringify({ access_token: 'NEW', expires_in: 3600 }));
    }
    assert.equal(init.headers.Authorization, 'Bearer NEW');
    return jsonResponse(200, JSON.stringify(PLAYBACK));
  };
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.state.status, STATUS.READY);
  assert.ok(calls[0].includes('accounts.spotify.com'), 'refresh happens first');
  assert.equal(storage.peek().tokens.accessToken, 'NEW', 'new token is persisted');
  assert.equal(storage.peek().tokens.refreshToken, 'R', 'refresh token is preserved');
});

test('a rotated refresh token replaces the stored one', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: { ...validTokens, expiresAt: -1 } });
  const fetchImpl = async (url) =>
    url.includes('accounts.spotify.com')
      ? jsonResponse(200, JSON.stringify({ access_token: 'N', refresh_token: 'ROTATED', expires_in: 3600 }))
      : jsonResponse(204);
  const { router } = build({ storage, fetchImpl });
  await router.handle({ type: 'GET_STATE' });
  assert.equal(storage.peek().tokens.refreshToken, 'ROTATED');
});

test('an invalid_grant refresh clears tokens and reports needs-auth', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: { ...validTokens, expiresAt: -1 } });
  const fetchImpl = async () => jsonResponse(400, JSON.stringify({ error: 'invalid_grant' }));
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.state.status, STATUS.NEEDS_AUTH);
  assert.equal(storage.peek().tokens, null);
});

test('a 401 triggers exactly one refresh-and-retry', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens });
  let playerCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('accounts.spotify.com')) {
      refreshCalls++;
      return jsonResponse(200, JSON.stringify({ access_token: 'FRESH', expires_in: 3600 }));
    }
    playerCalls++;
    return playerCalls === 1 ? jsonResponse(401) : jsonResponse(200, JSON.stringify(PLAYBACK));
  };
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.state.status, STATUS.READY);
  assert.equal(refreshCalls, 1);
  assert.equal(playerCalls, 2);
});

test('a persistent 401 gives up rather than looping', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens });
  let playerCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('accounts.spotify.com')) {
      return jsonResponse(200, JSON.stringify({ access_token: 'FRESH', expires_in: 3600 }));
    }
    playerCalls++;
    return jsonResponse(401);
  };
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'GET_STATE' });
  assert.equal(res.state.status, STATUS.NEEDS_AUTH);
  assert.equal(playerCalls, 2, 'one original call plus one retry');
});

test('TOGGLE_PLAY pauses when Spotify reports playing', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return url.endsWith('/me/player')
      ? jsonResponse(200, JSON.stringify(PLAYBACK))
      : jsonResponse(204);
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.ok, true);
  assert.ok(seen.some((c) => c === 'PUT https://api.spotify.com/v1/me/player/pause'));
});

test('TOGGLE_PLAY plays when Spotify reports paused', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return url.endsWith('/me/player')
      ? jsonResponse(200, JSON.stringify({ ...PLAYBACK, is_playing: false }))
      : jsonResponse(204);
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  await router.handle({ type: 'TOGGLE_PLAY' });
  assert.ok(seen.some((c) => c === 'PUT https://api.spotify.com/v1/me/player/play'));
});

test('NEXT and PREV hit the skip endpoints', async () => {
  for (const [type, path] of [['NEXT', 'next'], ['PREV', 'previous']]) {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(`${init.method} ${url}`);
      return url.endsWith('/me/player') ? jsonResponse(200, JSON.stringify(PLAYBACK)) : jsonResponse(204);
    };
    const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
    await router.handle({ type });
    assert.ok(seen.some((c) => c === `POST https://api.spotify.com/v1/me/player/${path}`), type);
  }
});

test('SET_VOLUME clamps the requested percent', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url.includes('/me/player/volume') ? jsonResponse(204) : jsonResponse(200, JSON.stringify(PLAYBACK));
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  await router.handle({ type: 'SET_VOLUME', percent: 250 });
  assert.ok(seen.some((u) => u.endsWith('volume_percent=100')));
});

test('a control call refused with 403 reports forbidden and keeps the track', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/me/player') ? jsonResponse(200, JSON.stringify(PLAYBACK)) : jsonResponse(403);
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'NEXT' });
  assert.equal(res.ok, false);
  assert.equal(res.error.tag, 'forbidden');
  assert.equal(res.state.status, STATUS.FORBIDDEN);
  assert.equal(res.state.track.title, 'Song');
});

test('control messages are refused before setup instead of calling the API', async () => {
  let called = false;
  const { router } = build({ fetchImpl: async () => { called = true; return jsonResponse(204); } });
  const res = await router.handle({ type: 'NEXT' });
  assert.equal(res.ok, false);
  assert.equal(res.state.status, STATUS.NEEDS_SETUP);
  assert.equal(called, false);
});

test('BEGIN_AUTH runs the PKCE flow and stores the tokens', async () => {
  const storage = memoryStorage({ clientId: 'cid' });
  let authUrl = null;
  const launchAuthFlow = async (url) => {
    authUrl = new URL(url);
    return `https://ext.chromiumapp.org/?code=CODE&state=${authUrl.searchParams.get('state')}`;
  };
  const fetchImpl = async (url, init) => {
    if (url.includes('accounts.spotify.com')) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('code'), 'CODE');
      assert.ok(body.get('code_verifier').length >= 43);
      return jsonResponse(200, JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: 's' }));
    }
    return jsonResponse(200, JSON.stringify(PLAYBACK));
  };
  const { router } = build({ storage, fetchImpl, launchAuthFlow });
  const res = await router.handle({ type: 'BEGIN_AUTH' });
  assert.equal(res.ok, true);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(storage.peek().tokens.accessToken, 'A');
  assert.equal(res.state.status, STATUS.READY);
});

test('BEGIN_AUTH refuses without a client ID', async () => {
  const { router } = build();
  const res = await router.handle({ type: 'BEGIN_AUTH' });
  assert.equal(res.ok, false);
  assert.equal(res.state.status, STATUS.NEEDS_SETUP);
});

test('BEGIN_AUTH reports a rejected authorization without storing tokens', async () => {
  const storage = memoryStorage({ clientId: 'cid' });
  const launchAuthFlow = async () => 'https://ext.chromiumapp.org/?error=access_denied&state=zzz';
  const { router } = build({ storage, launchAuthFlow });
  const res = await router.handle({ type: 'BEGIN_AUTH' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /access_denied/);
  assert.equal(storage.peek().tokens, null);
});

test('SIGN_OUT clears tokens and returns to needs-auth', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens });
  const { router } = build({ storage });
  const res = await router.handle({ type: 'SIGN_OUT' });
  assert.equal(res.ok, true);
  assert.equal(storage.peek().tokens, null);
  assert.equal(storage.peek().clientId, 'cid', 'the client ID survives sign-out');
  assert.equal(res.state.status, STATUS.NEEDS_AUTH);
});

test('an unknown message type is rejected', async () => {
  const { router } = build();
  const res = await router.handle({ type: 'NOPE' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /NOPE/);
});

test('a control action reuses the token the state read just rotated', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: { ...validTokens, expiresAt: -1 } });
  let refreshes = 0;
  const fetchImpl = async (url) => {
    if (url.includes('accounts.spotify.com')) {
      refreshes += 1;
      // Spotify rotates the refresh token, so replaying the old one is rejected.
      return refreshes === 1
        ? jsonResponse(200, JSON.stringify({ access_token: 'NEW', refresh_token: 'ROTATED', expires_in: 3600 }))
        : jsonResponse(400, JSON.stringify({ error: 'invalid_grant' }));
    }
    return url.endsWith('/me/player') ? jsonResponse(200, JSON.stringify(PLAYBACK)) : jsonResponse(204);
  };
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(refreshes, 1, 'the freshly rotated token is reused, not refreshed again');
  assert.equal(res.ok, true);
  assert.equal(storage.peek().tokens.refreshToken, 'ROTATED');
});

test('a control action retries once when Spotify returns a transient 5xx', async () => {
  let commands = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/me/player')) return jsonResponse(200, JSON.stringify(PLAYBACK));
    commands += 1;
    return commands === 1 ? jsonResponse(502, '<html>Bad gateway</html>') : jsonResponse(204);
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'NEXT' });
  assert.equal(commands, 2, 'the failed command is retried once');
  assert.equal(res.ok, true, 'a recovered command reports success, not an error');
});

test('a control action that keeps failing reports the status it got', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/me/player') ? jsonResponse(200, JSON.stringify(PLAYBACK)) : jsonResponse(502, '');
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'NEXT' });
  assert.equal(res.ok, false);
  assert.match(res.state.message, /502/, 'the message names the status so it can be diagnosed');
});

const ON_PHONE = { ...PLAYBACK, device: { id: 'PHONE', volume_percent: 50 } };

test('the device behind live playback is remembered', async () => {
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens });
  const { router } = build({ storage, fetchImpl: async () => jsonResponse(200, JSON.stringify(ON_PHONE)) });
  await router.handle({ type: 'GET_STATE' });
  assert.equal(storage.peek().lastDeviceId, 'PHONE');
});

const listing = (devices) => jsonResponse(200, JSON.stringify({ devices }));

test('TOGGLE_PLAY hands the session back to the remembered device when nothing is active', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ method: init.method, url, body: init.body ?? null });
    // A mobile client that has dropped off Connect: Spotify reports no playback,
    // but still lists the device.
    if (url.endsWith('/me/player/devices')) return listing([{ id: 'PHONE', is_active: false }]);
    return jsonResponse(204);
  };
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  await router.handle({ type: 'TOGGLE_PLAY' });
  const transfer = seen.find((c) => c.method === 'PUT' && c.url === 'https://api.spotify.com/v1/me/player');
  assert.ok(transfer, `expected a transfer, got ${JSON.stringify(seen.map((c) => `${c.method} ${c.url}`))}`);
  assert.deepEqual(JSON.parse(transfer.body), { device_ids: ['PHONE'], play: true });
});

test('a device Spotify no longer lists is reported as gone rather than commanded', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    if (url.endsWith('/me/player/devices')) return listing([]);
    return jsonResponse(204);
  };
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.ok, false);
  assert.match(res.state.message, /no devices/i, 'the notice says Spotify can see nothing at all');
  assert.ok(
    !seen.includes('PUT https://api.spotify.com/v1/me/player'),
    'a device Spotify has forgotten is not worth commanding',
  );
});

test('a gone device is reported alongside what Spotify can still see', async () => {
  const fetchImpl = async (url) => (url.endsWith('/me/player/devices')
    ? listing([{ id: 'DESK', name: 'Desktop' }, { id: 'TV', name: 'Living Room' }])
    : jsonResponse(204));
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.ok, false);
  assert.match(res.state.message, /Desktop/, 'naming a reachable device is the way out');
  assert.match(res.state.message, /Living Room/);
});

test('a device listing that fails is reported as itself, not as a missing device', async () => {
  const fetchImpl = async (url) => (url.endsWith('/me/player/devices')
    ? jsonResponse(500, '')
    : jsonResponse(204));
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.ok, false);
  assert.match(res.state.message, /500/, 'the real failure is named');
  assert.doesNotMatch(res.state.message, /no devices|still sees/i, 'and is not dressed up as a gone device');
});

test('TOGGLE_PLAY does not drag playback back to the remembered device', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return url.endsWith('/me/player')
      ? jsonResponse(200, JSON.stringify({ ...PLAYBACK, is_playing: false, device: { id: 'DESKTOP', volume_percent: 50 } }))
      : jsonResponse(204);
  };
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  await router.handle({ type: 'TOGGLE_PLAY' });
  assert.ok(
    seen.some((c) => c === 'PUT https://api.spotify.com/v1/me/player/play'),
    `play on a live device should not name one, got ${JSON.stringify(seen)}`,
  );
});

test('a listed device that refuses the transfer is reported as unwakeable', async () => {
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/me/player/devices')) return listing([{ id: 'PHONE' }]);
    return init.method === 'PUT' ? jsonResponse(404) : jsonResponse(204);
  };
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.ok, false);
  assert.match(res.state.message, /wake/i, 'the message should say the device could not be woken');
});

test('a track stays on screen after its device drops off Connect', async () => {
  let live = true;
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens });
  const fetchImpl = async () =>
    live ? jsonResponse(200, JSON.stringify({ ...ON_PHONE, is_playing: false, progress_ms: 4200 })) : jsonResponse(204);
  const { router } = build({ storage, fetchImpl });

  await router.handle({ type: 'GET_STATE' });
  live = false; // The phone leaves Connect a few seconds after the pause.
  const res = await router.handle({ type: 'GET_STATE' });

  assert.equal(res.state.status, STATUS.NO_DEVICE);
  assert.equal(res.state.track.title, 'Song', 'the record stays on the deck');
  assert.equal(res.state.progressMs, 4200, 'paused where it was left');
  assert.equal(res.state.isPlaying, false);
});

test('SET_VOLUME targets the device that is actually playing', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url.includes('/me/player/volume')
      ? jsonResponse(204)
      : jsonResponse(200, JSON.stringify(ON_PHONE));
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  await router.handle({ type: 'SET_VOLUME', percent: 30 });
  assert.ok(seen.some((u) => u.endsWith('volume_percent=30&device_id=PHONE')));
});

// A phone drops off Connect seconds after a pause, but Spotify will still take
// a volume change addressed to it by id while it lingers as a known device.
test('SET_VOLUME falls back to the remembered device when none is active', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url.includes('/me/player/volume') ? jsonResponse(204) : jsonResponse(204);
  };
  const storage = memoryStorage({ clientId: 'cid', tokens: validTokens, lastDeviceId: 'PHONE' });
  const { router } = build({ storage, fetchImpl });
  await router.handle({ type: 'SET_VOLUME', percent: 30 });
  assert.ok(seen.some((u) => u.endsWith('volume_percent=30&device_id=PHONE')));
});

test('SET_VOLUME refuses a device whose volume Spotify cannot set', async () => {
  const seen = [];
  const noVolume = { ...PLAYBACK, device: { id: 'TV', volume_percent: 50, supports_volume: false } };
  const fetchImpl = async (url) => {
    seen.push(url);
    return jsonResponse(200, JSON.stringify(noVolume));
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'SET_VOLUME', percent: 30 });
  assert.equal(res.ok, false);
  assert.match(res.state.message, /volume/i);
  assert.ok(!seen.some((u) => u.includes('/me/player/volume')));
});

// Spotify's /me/player is eventually consistent: it keeps describing the moment
// before the press for a beat after it has accepted a command. These cover the
// two ways that read-back used to reach the deck as truth.

test('TOGGLE_PLAY reports paused while Spotify still reports playing', async () => {
  const fetchImpl = async (url) => (url.endsWith('/me/player')
    ? jsonResponse(200, JSON.stringify(PLAYBACK)) // Never catches up.
    : jsonResponse(204));
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.ok, true);
  assert.equal(res.state.isPlaying, false, 'the pause we just sent is the truth on the deck');
});

test('TOGGLE_PLAY reports playing while Spotify still reports paused', async () => {
  const fetchImpl = async (url) => (url.endsWith('/me/player')
    ? jsonResponse(200, JSON.stringify({ ...PLAYBACK, is_playing: false }))
    : jsonResponse(204));
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.state.isPlaying, true);
});

test('a stale read-back does not override a state that is not playable', async () => {
  const fetchImpl = async (url) => jsonResponse(204); // No device, no item.
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'TOGGLE_PLAY' });
  assert.equal(res.state.status, STATUS.NO_DEVICE);
  assert.equal(res.state.isPlaying, false);
});

test('NEXT scans again until the skip shows up in playback', async () => {
  const NEXT_TRACK = {
    ...PLAYBACK,
    item: { ...PLAYBACK.item, id: 't2', name: 'Second Song' },
  };
  let reads = 0;
  const fetchImpl = async (url) => {
    if (!url.endsWith('/me/player')) return jsonResponse(204);
    reads += 1;
    // Read 1 is the pre-command read; read 2 is Spotify still lagging.
    return jsonResponse(200, JSON.stringify(reads >= 3 ? NEXT_TRACK : PLAYBACK));
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'NEXT' });
  assert.equal(res.ok, true);
  assert.equal(res.state.track.title, 'Second Song', 'the skip is on the deck, not four seconds later');
});

test('NEXT stops scanning rather than chasing a track that never changes', async () => {
  let reads = 0;
  const fetchImpl = async (url) => {
    if (!url.endsWith('/me/player')) return jsonResponse(204);
    reads += 1;
    return jsonResponse(200, JSON.stringify(PLAYBACK));
  };
  const { router } = build({ storage: memoryStorage({ clientId: 'cid', tokens: validTokens }), fetchImpl });
  const res = await router.handle({ type: 'NEXT' });
  assert.equal(res.ok, true);
  assert.ok(reads <= 4, `bounded scan, saw ${reads} reads`);
});
