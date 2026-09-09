import { STATUS, formatTime } from '../lib/player-state.js';
import { armAngle } from '../lib/geometry.js';

const OVERLAY_COPY = {
  [STATUS.NEEDS_SETUP]: {
    text: 'Spotivyn needs your Spotify Client ID before it can connect.',
    action: 'Open setup',
  },
  [STATUS.NEEDS_AUTH]: {
    text: 'Connect Spotivyn to your Spotify account to see what is playing.',
    action: 'Connect to Spotify',
  },
};

const CONTROLLABLE = new Set([STATUS.READY, STATUS.NO_DEVICE, STATUS.ERROR]);

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

export function renderProgress(root, { progressMs, durationMs, hasTrack }) {
  const ratio = hasTrack && durationMs > 0 ? Math.min(1, Math.max(0, progressMs / durationMs)) : 0;
  q(root, '.progress__fill').style.width = `${ratio * 100}%`;
  q(root, '.progress__elapsed').textContent = formatTime(hasTrack ? progressMs : 0);
  q(root, '.progress__duration').textContent = formatTime(hasTrack ? durationMs : 0);
  root.querySelector('.tonearm').style.setProperty(
    '--arm-deg',
    String(armAngle({ hasTrack, progressMs, durationMs })),
  );
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
  for (const control of root.querySelectorAll('.key, .fader__input')) {
    control.disabled = !controlsEnabled;
  }

  const volume = q(root, '.fader__input');
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
    case STATUS.NO_DEVICE: return 'No record loaded';
    case STATUS.ERROR: return 'Unavailable';
    default: return 'Nothing playing';
  }
}
