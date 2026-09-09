export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SCOPES = ['user-read-playback-state', 'user-modify-playback-state'];
export const REFRESH_SKEW_MS = 60_000;

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(length, randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += UNRESERVED[bytes[i] % UNRESERVED.length];
  return out;
}

export async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function computeExpiry(expiresInSeconds, now) {
  return now + expiresInSeconds * 1000;
}

export function shouldRefresh(tokens, now, skewMs = REFRESH_SKEW_MS) {
  if (!tokens?.accessToken || !Number.isFinite(tokens.expiresAt)) return true;
  return tokens.expiresAt - skewMs <= now;
}

export function tokensFromResponse(response, now, existing = null) {
  return {
    accessToken: response.access_token,
    // Spotify rotates refresh tokens. Adopt a new one; otherwise keep ours.
    refreshToken: response.refresh_token ?? existing?.refreshToken ?? null,
    expiresAt: computeExpiry(response.expires_in, now),
    scope: response.scope ?? existing?.scope ?? '',
  };
}

export function buildAuthUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
    scope: SCOPES.join(' '),
  });
  return `${AUTHORIZE_URL}?${params}`;
}

export function parseAuthRedirect(redirectUrl, expectedState) {
  const params = new URL(redirectUrl).searchParams;
  const error = params.get('error');
  if (error) throw new Error(`Spotify returned "${error}".`);
  if (params.get('state') !== expectedState) {
    throw new Error('Authorization state did not match. Please try connecting again.');
  }
  const code = params.get('code');
  if (!code) throw new Error('Spotify did not return an authorization code.');
  return { code };
}

async function postToken(fetchImpl, body) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error_description ?? payload.error ?? `Token request failed (${response.status}).`);
    if (payload.error === 'invalid_grant') error.tag = 'invalid-grant';
    throw error;
  }
  return payload;
}

export async function exchangeCode({ fetchImpl, clientId, code, redirectUri, codeVerifier, now }) {
  const payload = await postToken(fetchImpl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  return tokensFromResponse(payload, now);
}

export async function refreshTokens({ fetchImpl, clientId, tokens, now }) {
  const payload = await postToken(fetchImpl, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  });
  return tokensFromResponse(payload, now, tokens);
}
