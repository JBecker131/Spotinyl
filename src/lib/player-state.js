export const STATUS = Object.freeze({
  NEEDS_SETUP: 'needs-setup',
  NEEDS_AUTH: 'needs-auth',
  NO_DEVICE: 'no-device',
  READY: 'ready',
  FORBIDDEN: 'forbidden',
  ERROR: 'error',
});

const PREMIUM_MESSAGE = 'Spotify Premium is required to control playback.';

// Shown both by the router, when it refuses to send the command, and by the
// fader itself as the tooltip explaining why it is dead.
export const VOLUME_UNSUPPORTED = 'This device sets its own volume. Use its buttons or dial instead.';

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

/**
 * Whether Spotify will accept a volume change for a device. `supports_volume`
 * is false on plenty of Connect targets — a TV, a car head unit, a phone whose
 * volume belongs to its hardware keys — and `is_restricted` refuses every
 * command. Spotify only added `supports_volume` later and still omits it on
 * some clients, so a missing flag means "try it", not "no".
 */
export function canSetVolume(device) {
  if (!device) return false;
  if (device.is_restricted) return false;
  return device.supports_volume !== false;
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
    deviceId: null,
    canSetVolume: false,
    fetchedAt: 0,
    message: '',
    ...extra,
  };
}

export function deriveState({
  clientId, hasTokens, result, previousTrack = null, previousProgressMs = 0, fetchedAt = 0,
}) {
  if (!clientId) return base(STATUS.NEEDS_SETUP);
  if (!hasTokens) return base(STATUS.NEEDS_AUTH);

  if (result?.ok) {
    const playback = result.data;
    // Spotify reports nothing at all once the last device leaves Connect, which
    // a phone does within seconds of a pause. What was on the deck is still what
    // the user paused, so hold it there rather than clearing to an empty deck.
    if (!playback || !playback.item) {
      return base(STATUS.NO_DEVICE, {
        fetchedAt,
        track: previousTrack,
        progressMs: previousTrack ? previousProgressMs : 0,
        durationMs: previousTrack?.durationMs ?? 0,
      });
    }
    const track = toTrack(playback);
    return base(STATUS.READY, {
      track,
      isPlaying: Boolean(playback.is_playing),
      progressMs: Number.isFinite(playback.progress_ms) ? playback.progress_ms : 0,
      durationMs: track.durationMs,
      volumePercent: Number.isFinite(playback.device?.volume_percent)
        ? playback.device.volume_percent
        : null,
      deviceId: playback.device?.id ?? null,
      canSetVolume: canSetVolume(playback.device),
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
