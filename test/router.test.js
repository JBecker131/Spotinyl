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
