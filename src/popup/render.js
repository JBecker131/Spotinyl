import { STATUS, formatTime, VOLUME_UNSUPPORTED } from '../lib/player-state.js';
import { armAngle } from '../lib/geometry.js';

const OVERLAY_COPY = {
  [STATUS.NEEDS_SETUP]: {
    text: 'Spotinyl needs your Spotify Client ID before it can connect.',
    action: 'Open setup',
  },
  [STATUS.NEEDS_AUTH]: {
    text: 'Connect Spotinyl to your Spotify account to see what is playing.',
    action: 'Connect to Spotify',
  },
};

const CONTROLLABLE = new Set([STATUS.READY, STATUS.NO_DEVICE, STATUS.ERROR]);

/**
 * The fader goes dead only for a device that has told us it sets its own
 * volume — a TV, a car, a phone whose hardware keys own the dial. With no
 * device on Connect there is nobody to have refused, and the router still aims
 * at the last one it saw, so the fader stays live and lets Spotify answer.
 */
export function faderEnabled({ status, deviceId, canSetVolume }) {
  if (!CONTROLLABLE.has(status)) return false;
  return !(deviceId && !canSetVolume);
}

const q = (root, selector) => root.querySelector(selector);

/**
 * SVGElement does not implement the `hidden` IDL property, so assigning to it
 * would silently create an expando and leave the icon on screen. Drive the
 * content attribute instead.
 */
function setHidden(element, hidden) {
  if (hidden) element.setAttribute('hidden', '');
  else element.removeAttribute('hidden');
}

/**
 * Decks whose tonearm has already been placed once.
 *
 * The popup opens onto playback that is already underway, so the arm belongs
 * where the track already is. Animating that first placement would show it
 * drifting in from the rest every time the popup opens, which is a rendering
 * artefact rather than something the deck is doing. Suppress the transition
 * for the first placement only; later changes — a skip cueing the arm back to
 * the lead-in — still glide.
 */
const placedDecks = new WeakSet();

function setArmAngle(root, degrees) {
  const arm = root.querySelector('.tonearm');
  arm.style.setProperty('--arm-deg', String(degrees));

  if (placedDecks.has(root)) return;
  placedDecks.add(root);

  // The glide lives on a class rather than on `.tonearm` itself, so the first
  // placement paints with no transition at all. Enabling it takes two frames:
  // the first paints the arm where the track already is, and only then does the
  // class go on — added any sooner it would land in the same style recalculation
  // as the angle and animate the arm in from the rest after all.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => arm.classList.add('tonearm--tracking'));
  });
}

export function renderProgress(root, { progressMs, durationMs, hasTrack }) {
  const ratio = hasTrack && durationMs > 0 ? Math.min(1, Math.max(0, progressMs / durationMs)) : 0;
  q(root, '.progress__fill').style.width = `${ratio * 100}%`;
  q(root, '.progress__elapsed').textContent = formatTime(hasTrack ? progressMs : 0);
  q(root, '.progress__duration').textContent = formatTime(hasTrack ? durationMs : 0);
  setArmAngle(root, armAngle({ hasTrack, progressMs, durationMs }));
}

export function render(root, state) {
  const { status, track, isPlaying, progressMs, durationMs, volumePercent, message } = state;
  const hasTrack = Boolean(track);

  root.dataset.status = status;

  // Record: spins only while genuinely playing.
  const record = q(root, '.record');
  record.dataset.spinning = String(status === STATUS.READY && isPlaying);

  const art = q(root, '.record__art');
  root.dataset.hasArt = String(Boolean(hasTrack && track.artUrl));
  if (hasTrack && track.artUrl) {
    art.src = track.artUrl;
    art.alt = `Album art for ${track.album || track.title}`;
    art.hidden = false;
  } else {
    art.removeAttribute('src');
    art.alt = '';
    art.hidden = true;
  }

  // Readout.
  q(root, '.readout__title').textContent = hasTrack ? track.title : titleFor(status);
  q(root, '.readout__artist').textContent = hasTrack ? track.artist : '';

  renderProgress(root, { progressMs, durationMs, hasTrack });

  // Transport.
  const toggle = q(root, '[data-action="toggle"]');
  const playing = status === STATUS.READY && isPlaying;
  setHidden(q(root, '.icon-play'), playing);
  setHidden(q(root, '.icon-pause'), !playing);
  toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');

  const controlsEnabled = CONTROLLABLE.has(status);
  for (const key of root.querySelectorAll('.key')) {
    key.disabled = !controlsEnabled;
  }

  const volume = q(root, '.fader__input');
  volume.disabled = !faderEnabled(state);
  volume.title = volume.disabled && controlsEnabled ? VOLUME_UNSUPPORTED : '';
  // Do not fight the user while they are dragging the fader.
  if (document.activeElement !== volume && Number.isFinite(volumePercent)) {
    volume.value = String(volumePercent);
  }

  // Notice strip.
  const notice = q(root, '.notice');
  notice.textContent = message ?? '';
  notice.hidden = !message;

  // Overlay for the two states that block everything else.
  const overlay = q(root, '.overlay');
  const copy = OVERLAY_COPY[status];
  overlay.hidden = !copy;
  if (copy) {
    q(root, '.overlay__text').textContent = copy.text;
    const action = q(root, '.overlay__action');
    action.textContent = copy.action;
    action.dataset.action = status === STATUS.NEEDS_SETUP ? 'open-options' : 'connect';
  }
}

function titleFor(status) {
  switch (status) {
    case STATUS.NEEDS_SETUP: return 'Setup required';
    case STATUS.NEEDS_AUTH: return 'Not connected';
    case STATUS.NO_DEVICE: return 'No Record Loaded..';
    case STATUS.ERROR: return 'Unavailable';
    default: return 'Nothing playing';
  }
}
