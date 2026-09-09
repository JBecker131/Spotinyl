import { render, renderProgress } from './render.js';
import { STATUS, interpolateProgress } from '../lib/player-state.js';

const POLL_INTERVAL_MS = 4000;
const VOLUME_DEBOUNCE_MS = 150;

const deck = document.querySelector('.deck');

let state = null;
let pollTimer = null;
let volumeTimer = null;

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({
    ok: false,
    error: { tag: 'unknown', message: error?.message ?? 'The extension is not responding.' },
    state: null,
  }));
}

function apply(response) {
  if (response?.state) {
    state = response.state;
    render(deck, state);
  } else if (response?.error) {
    // No state came back at all — surface the error without wiping the display.
    const notice = deck.querySelector('.notice');
    notice.textContent = response.error.message;
    notice.hidden = false;
  }
}

async function poll() {
  apply(await send({ type: 'GET_STATE' }));
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
  if (optimistic && state) {
    state = { ...state, ...optimistic(state), fetchedAt: Date.now() };
    render(deck, state);
  }
  apply(await send(message));
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
