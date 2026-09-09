const API_BASE = 'https://api.spotify.com/v1';
const DEFAULT_RETRY_AFTER_MS = 1000;

const MESSAGES = {
  unauthorized: 'Your Spotify session expired.',
  forbidden: 'Spotify Premium is required to control playback.',
  'no-device': 'No active Spotify device. Start playing something first.',
  'rate-limited': 'Spotify is rate limiting us. Retrying shortly.',
  offline: 'Cannot reach Spotify. Check your connection.',
  unknown: 'Something went wrong talking to Spotify.',
};

const failure = (tag, extra = {}) => ({
  ok: false,
  error: { tag, message: MESSAGES[tag], ...extra },
});

function retryAfterMs(headers) {
  const seconds = Number.parseInt(headers?.get?.('Retry-After') ?? '', 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

export async function apiRequest({ fetchImpl, accessToken, method, path, query }) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return failure('offline');
  }

  if (response.status === 204) return { ok: true, data: null };
  if (response.status === 401) return failure('unauthorized');
  if (response.status === 403) return failure('forbidden');
  if (response.status === 404) return failure('no-device');
  if (response.status === 429) {
    return failure('rate-limited', { retryAfterMs: retryAfterMs(response.headers) });
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    return failure('unknown');
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.parse(text)?.error?.message ?? '';
    } catch {
      // A non-JSON error body is expected from proxies; the status alone will do.
    }
    // Name the status: a bare "something went wrong" gives nobody anything to act on.
    const message = detail
      ? `Spotify returned ${response.status}: ${detail}`
      : `Spotify returned ${response.status}.`;
    return { ok: false, error: { tag: 'unknown', message, status: response.status } };
  }

  if (!text) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return failure('unknown', {
      message: "Spotify's response could not be read.",
      status: response.status,
    });
  }
}

export const getPlayback = ({ fetchImpl, accessToken }) =>
  apiRequest({ fetchImpl, accessToken, method: 'GET', path: '/me/player' });

export const play = ({ fetchImpl, accessToken }) =>
  apiRequest({ fetchImpl, accessToken, method: 'PUT', path: '/me/player/play' });

export const pause = ({ fetchImpl, accessToken }) =>
  apiRequest({ fetchImpl, accessToken, method: 'PUT', path: '/me/player/pause' });

export const next = ({ fetchImpl, accessToken }) =>
  apiRequest({ fetchImpl, accessToken, method: 'POST', path: '/me/player/next' });

export const previous = ({ fetchImpl, accessToken }) =>
  apiRequest({ fetchImpl, accessToken, method: 'POST', path: '/me/player/previous' });

export function clampVolume(percent) {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export const setVolume = ({ fetchImpl, accessToken, percent }) =>
  apiRequest({
    fetchImpl,
    accessToken,
    method: 'PUT',
    path: '/me/player/volume',
    query: { volume_percent: clampVolume(percent) },
  });
