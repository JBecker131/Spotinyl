import { render, renderProgress } from './render.js';
import { STATUS, interpolateProgress } from '../lib/player-state.js';

const POLL_INTERVAL_MS = 4000;
const VOLUME_DEBOUNCE_MS = 150;
const ERROR_GRACE_MS = 2000;
// A device leaving Connect deserves longer than a failed command. Spotify goes
// quiet for a beat after a skip, and a phone that has only paused comes back on
// its own; 4.5s outlasts both, so the notice arrives only once there really is
// nothing left to talk to.
const DISCONNECT_GRACE_MS = 4500;

// Failures that are worth waiting out. A flaky Spotify command clears itself on
// the next poll; anything still failing after the grace period is real.
const HELD_STATUSES = new Set([STATUS.ERROR, STATUS.FORBIDDEN, STATUS.NO_DEVICE]);

const graceFor = (status) =>
  (status === STATUS.NO_DEVICE ? DISCONNECT_GRACE_MS : ERROR_GRACE_MS);

const deck = document.querySelector('.deck');

let state = null;
let pollTimer = null;
// Bumped when a command starts and again when it finishes. A poll that was out
// over either edge is answering from before the press, and applying it would
// put the record back into motion after a pause or the old track back on the
// deck after a skip.
let commandEpoch = 0;
let volumeTimer = null;
let pendingFailure = null;
let graceTimer = null;

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({
    ok: false,
    error: { tag: 'unknown', message: error?.message ?? 'The extension is not responding.' },
    state: null,
  }));
}

function clearPendingFailure() {
  pendingFailure = null;
  clearTimeout(graceTimer);
  graceTimer = null;
}

/** Shows a failure that outlived the grace period. */
function commitPendingFailure() {
  if (!pendingFailure) return;
  state = pendingFailure;
  clearPendingFailure();
  render(deck, state);
}

function apply(response) {
  // A response with no state at all is still a failure worth holding; carry the
  // message on the state already showing so the deck does not jump.
  const next = response?.state
    ?? (response?.error && state
      ? { ...state, status: STATUS.ERROR, message: response.error.message }
      : null);
  if (!next) return;

  const healthy = !HELD_STATUSES.has(next.status);

  // Nothing on screen yet means there is nothing to protect from a flicker.
  if (healthy || !state) {
    clearPendingFailure();
    state = next;
    render(deck, next);
    return;
  }

  // Hold the failure back and leave the deck as it is: the record keeps
  // spinning and the progress keeps interpolating off the last good state, so a
  // blip is invisible. Only a failure that persists is worth showing.
  if (pendingFailure) {
    // Keep the freshest one to commit, but not at the cost of the notice: the
    // command that failed is what knows the device is gone, while the polls
    // behind it report the same silence with nothing to say about it.
    pendingFailure = { ...next, message: next.message || pendingFailure.message };
    return;
  }
  pendingFailure = next;
  // Timed from the first sign of trouble rather than the latest, so a run of
  // failures cannot keep pushing the notice out of reach.
  graceTimer = setTimeout(commitPendingFailure, graceFor(next.status));
}

async function poll() {
  const epoch = commandEpoch;
  const response = await send({ type: 'GET_STATE' });
  if (epoch !== commandEpoch) return; // Overtaken by a command; its reply is newer.
  apply(response);
}

/**
 * Advances the progress bar and tonearm between polls, so motion is smooth at
 * display rate while the network sees only one request every four seconds.
 */
function tick() {
  if (state?.status === STATUS.READY && state.isPlaying) {
    renderProgress(deck, {
      progressMs: interpolateProgress({
        progressMs: state.progressMs,
        durationMs: state.durationMs,
        isPlaying: true,
        fetchedAt: state.fetchedAt,
        now: Date.now(),
      }),
      durationMs: state.durationMs,
      hasTrack: Boolean(state.track),
    });
  }
  requestAnimationFrame(tick);
}

/** Applies the expected outcome immediately, then reconciles from the reply. */
async function control(message, optimistic) {
  commandEpoch += 1;
  if (optimistic && state) {
    state = { ...state, ...optimistic(state), fetchedAt: Date.now() };
    render(deck, state);
  }
  const response = await send(message);
  commandEpoch += 1;
  apply(response);
}

deck.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;

  switch (target.dataset.action) {
    case 'toggle':
      return control({ type: 'TOGGLE_PLAY' }, (s) => ({
        isPlaying: !s.isPlaying,
        progressMs: interpolateProgress({ ...s, now: Date.now() }),
      }));
    case 'next':
      return control({ type: 'NEXT' }, () => ({ progressMs: 0 }));
    case 'prev':
      return control({ type: 'PREV' }, () => ({ progressMs: 0 }));
    case 'connect':
      return control({ type: 'BEGIN_AUTH' }, null);
    case 'open-options':
      return chrome.runtime.openOptionsPage();
  }
});

deck.querySelector('.fader__input').addEventListener('input', (event) => {
  const percent = Number(event.target.value);
  clearTimeout(volumeTimer);
  // Debounced so a drag produces one request, not one per pixel.
  volumeTimer = setTimeout(() => control({ type: 'SET_VOLUME', percent }, null), VOLUME_DEBOUNCE_MS);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(pollTimer);
  } else {
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }
});

poll();
pollTimer = setInterval(poll, POLL_INTERVAL_MS);
requestAnimationFrame(tick);
