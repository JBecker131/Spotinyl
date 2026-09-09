import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPES,
  REFRESH_SKEW_MS,
  base64UrlEncode,
  randomString,
  challengeFromVerifier,
  computeExpiry,
  shouldRefresh,
  tokensFromResponse,
  buildAuthUrl,
  parseAuthRedirect,
  exchangeCode,
  refreshTokens,
} from '../src/lib/auth.js';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 10_000, scope: 'x' };

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

test('base64UrlEncode produces URL-safe output with no padding', () => {
  assert.equal(base64UrlEncode(new Uint8Array([251, 255, 190])), '-_--');
  assert.equal(base64UrlEncode(new Uint8Array([1])), 'AQ');
  assert.doesNotMatch(base64UrlEncode(new Uint8Array([1, 2])), /[+/=]/);
});

test('randomString has the requested length and only unreserved characters', () => {
  const s = randomString(64);
  assert.equal(s.length, 64);
  assert.match(s, /^[A-Za-z0-9\-._~]+$/);
});

test('randomString derives every character from the supplied bytes', () => {
  const s = randomString(4, (n) => new Uint8Array(n).fill(0));
  assert.equal(s, 'AAAA');
});

test('challengeFromVerifier matches the RFC 7636 test vector', async () => {
  const challenge = await challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('computeExpiry converts seconds to an absolute epoch milliseconds', () => {
  assert.equal(computeExpiry(3600, 1_000_000), 1_000_000 + 3_600_000);
});

test('shouldRefresh is true when there are no tokens at all', () => {
  assert.equal(shouldRefresh(null, 0), true);
  assert.equal(shouldRefresh({ refreshToken: 'r' }, 0), true);
});

test('shouldRefresh is false while the token is comfortably valid', () => {
  // The shared fixture expires inside the skew window, so lift it clear of it.
  assert.equal(shouldRefresh({ ...tokens, expiresAt: 10_000 + REFRESH_SKEW_MS }, 0), false);
});

test('shouldRefresh turns true once inside the skew window', () => {
  assert.equal(shouldRefresh(tokens, 10_000 - REFRESH_SKEW_MS - 1), false);
  assert.equal(shouldRefresh(tokens, 10_000 - REFRESH_SKEW_MS), true);
  assert.equal(shouldRefresh(tokens, 20_000), true);
});

test('tokensFromResponse builds a token record from a fresh grant', () => {
  const result = tokensFromResponse(
    { access_token: 'new', refresh_token: 'newR', expires_in: 3600, scope: 's' },
    1000,
  );
  assert.deepEqual(result, { accessToken: 'new', refreshToken: 'newR', expiresAt: 3_601_000, scope: 's' });
});

test('tokensFromResponse adopts a rotated refresh token', () => {
  const result = tokensFromResponse(
    { access_token: 'new', refresh_token: 'rotated', expires_in: 60 },
    0,
    tokens,
  );
  assert.equal(result.refreshToken, 'rotated');
});

test('tokensFromResponse keeps the existing refresh token when none is returned', () => {
  const result = tokensFromResponse({ access_token: 'new', expires_in: 60 }, 0, tokens);
  assert.equal(result.refreshToken, 'r');
  assert.equal(result.scope, 'x');
});

test('buildAuthUrl carries every PKCE parameter', () => {
  const url = new URL(buildAuthUrl({
    clientId: 'cid', redirectUri: 'https://x.chromiumapp.org/', codeChallenge: 'chal', state: 'st',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x.chromiumapp.org/');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
});

test('parseAuthRedirect returns the authorization code', () => {
  const result = parseAuthRedirect('https://x.chromiumapp.org/?code=abc&state=st', 'st');
  assert.deepEqual(result, { code: 'abc' });
});

test('parseAuthRedirect rejects a mismatched state', () => {
  assert.throws(
    () => parseAuthRedirect('https://x.chromiumapp.org/?code=abc&state=other', 'st'),
    /state/i,
  );
});

test('parseAuthRedirect surfaces a denial from the authorize screen', () => {
  assert.throws(
    () => parseAuthRedirect('https://x.chromiumapp.org/?error=access_denied&state=st', 'st'),
    /access_denied/,
  );
});

test('parseAuthRedirect rejects a response with no code', () => {
  assert.throws(() => parseAuthRedirect('https://x.chromiumapp.org/?state=st', 'st'), /code/i);
});

test('exchangeCode posts the PKCE verifier and returns tokens', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: 's' });
  };
  const result = await exchangeCode({
    fetchImpl, clientId: 'cid', code: 'c', redirectUri: 'https://x/', codeVerifier: 'v', now: 0,
  });
  assert.equal(seen.url, 'https://accounts.spotify.com/api/token');
  assert.equal(seen.init.method, 'POST');
  const body = new URLSearchParams(seen.init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'c');
  assert.equal(body.get('code_verifier'), 'v');
  assert.equal(body.get('client_id'), 'cid');
  assert.equal(result.accessToken, 'A');
  assert.equal(result.expiresAt, 3_600_000);
});

test('exchangeCode throws with the Spotify error description', async () => {
  const fetchImpl = async () => jsonResponse(400, { error_description: 'bad verifier' });
  await assert.rejects(
    () => exchangeCode({ fetchImpl, clientId: 'c', code: 'c', redirectUri: 'r', codeVerifier: 'v', now: 0 }),
    /bad verifier/,
  );
});

test('refreshTokens sends the refresh grant and merges the response', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = new URLSearchParams(init.body);
    return jsonResponse(200, { access_token: 'A2', expires_in: 60 });
  };
  const result = await refreshTokens({ fetchImpl, clientId: 'cid', tokens, now: 0 });
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'r');
  assert.equal(body.get('client_id'), 'cid');
  assert.equal(result.accessToken, 'A2');
  assert.equal(result.refreshToken, 'r', 'preserves the refresh token when none is returned');
});

test('refreshTokens tags an invalid_grant rejection so callers can sign out', async () => {
  const fetchImpl = async () => jsonResponse(400, { error: 'invalid_grant' });
  await assert.rejects(
    () => refreshTokens({ fetchImpl, clientId: 'cid', tokens, now: 0 }),
    (err) => err.tag === 'invalid-grant',
  );
});
