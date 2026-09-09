export const STATUS = Object.freeze({
  NEEDS_SETUP: 'needs-setup',
  NEEDS_AUTH: 'needs-auth',
  NO_DEVICE: 'no-device',
  READY: 'ready',
  FORBIDDEN: 'forbidden',
  ERROR: 'error',
});

const PREMIUM_MESSAGE = 'Spotify Premium is required to control playback.';

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function pickArtwork(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  // Prefer the largest image that still fits the 64px label without waste;
  // if every image is oversized, take the smallest one available.
  const chosen = sorted.find((image) => (image.width ?? 0) <= 400) ?? sorted[sorted.length - 1];
  return chosen?.url ?? null;
}

export function toTrack(playback) {
  const item = playback?.item;
  if (!item) return null;
  const artists = Array.isArray(item.artists)
    ? item.artists.map((a) => a?.name).filter(Boolean)
    : [];
  return {
    id: item.id ?? null,
    title: item.name ?? 'Unknown track',
    artist: artists.length > 0 ? artists.join(', ') : 'Unknown artist',
    album: item.album?.name ?? '',
    artUrl: pickArtwork(item.album?.images),
    durationMs: Number.isFinite(item.duration_ms) ? item.duration_ms : 0,
  };
}

export function interpolateProgress({ progressMs, durationMs, isPlaying, fetchedAt, now }) {
  if (!Number.isFinite(progressMs)) return 0;
  // Math.max guards against a clock that appears to run backwards.
  const elapsed = isPlaying ? Math.max(0, (now ?? 0) - (fetchedAt ?? 0)) : 0;
  const advanced = Math.max(0, progressMs + elapsed);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return advanced;
  return Math.min(advanced, durationMs);
}

function base(status, extra = {}) {
  return {
    status,
    track: null,
    isPlaying: false,
    progressMs: 0,
    durationMs: 0,
    volumePercent: null,
    fetchedAt: 0,
    message: '',
    ...extra,
  };
}

export function deriveState({ clientId, hasTokens, result, previousTrack = null, fetchedAt = 0 }) {
  if (!clientId) return base(STATUS.NEEDS_SETUP);
  if (!hasTokens) return base(STATUS.NEEDS_AUTH);

  if (result?.ok) {
    const playback = result.data;
    if (!playback || !playback.item) return base(STATUS.NO_DEVICE, { fetchedAt });
    const track = toTrack(playback);
    return base(STATUS.READY, {
      track,
      isPlaying: Boolean(playback.is_playing),
      progressMs: Number.isFinite(playback.progress_ms) ? playback.progress_ms : 0,
      durationMs: track.durationMs,
      volumePercent: Number.isFinite(playback.device?.volume_percent)
        ? playback.device.volume_percent
        : null,
      fetchedAt,
    });
  }

  const { tag, message } = result?.error ?? { tag: 'unknown', message: 'Something went wrong.' };
  switch (tag) {
    case 'no-device':
      return base(STATUS.NO_DEVICE, { fetchedAt });
    case 'unauthorized':
      return base(STATUS.NEEDS_AUTH);
    case 'forbidden':
      return base(STATUS.FORBIDDEN, {
        track: previousTrack,
        durationMs: previousTrack?.durationMs ?? 0,
        message: PREMIUM_MESSAGE,
      });
    default:
      return base(STATUS.ERROR, {
        track: previousTrack,
        durationMs: previousTrack?.durationMs ?? 0,
        message,
      });
  }
}
