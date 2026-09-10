import { STATUS, deriveState, toTrack, VOLUME_UNSUPPORTED } from '../lib/player-state.js';
import {
  shouldRefresh, refreshTokens, exchangeCode,
  randomString, challengeFromVerifier, buildAuthUrl, parseAuthRedirect,
} from '../lib/auth.js';
import {
  getPlayback, play, pause, next, previous, setVolume, getDevices, transferPlayback,
} from '../lib/spotify-api.js';

const VERIFIER_LENGTH = 64;

// Spotify's player endpoints are write-then-eventually-readable: /me/player
// keeps describing the moment before the press for a beat after it has accepted
// a command. A skip is the case we cannot simply assert our way past — only
// Spotify knows what came next — so read again, briefly, until it tells us.
const SKIP_SCAN_READS = 3;
const SKIP_SCAN_DELAY_MS = 200;
const WAKE_FAILED = 'Could not wake your last Spotify device. Open Spotify there and press play.';
const NO_DEVICES = 'Spotify sees no devices. Open Spotify where you want it and press play.';

/**
 * A device that has left Connect cannot be reached at all, so the way out is
 * whatever Spotify can still see. Naming those beats a dead end.
 */
const deviceGone = (devices) => (devices.length === 0
  ? NO_DEVICES
  : `Your last device is gone. Spotify still sees: ${devices.map((d) => d?.name).filter(Boolean).join(', ')}.`);

export function createRouter({
  storage, fetchImpl, launchAuthFlow, redirectUri, now,
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  /**
   * Ensures a usable access token, refreshing when it is expired or nearly so.
   * Returns null when the user must reconnect; tokens are cleared in that case.
   */
  async function ensureToken(config) {
    if (!config.tokens?.refreshToken) return null;
    if (!shouldRefresh(config.tokens, now())) return config.tokens;
    try {
      const refreshed = await refreshTokens({
        fetchImpl, clientId: config.clientId, tokens: config.tokens, now: now(),
      });
      await storage.set({ tokens: refreshed });
      return refreshed;
    } catch (error) {
      if (error.tag === 'invalid-grant') await storage.set({ tokens: null });
      return null;
    }
  }

  /**
   * Runs an API call with one refresh-and-retry on 401, so a token that expired
   * between our skew check and the request does not surface as a sign-out.
   */
  async function callApi(config, fn) {
    let tokens = await ensureToken(config);
    if (!tokens) return { tokens: null, result: { ok: false, error: { tag: 'unauthorized', message: 'Reconnect to Spotify.' } } };

    let result = await fn(tokens.accessToken);
    if (result.ok || result.error.tag !== 'unauthorized') return { tokens, result };

    try {
      tokens = await refreshTokens({ fetchImpl, clientId: config.clientId, tokens, now: now() });
      await storage.set({ tokens });
    } catch (error) {
      if (error.tag === 'invalid-grant') await storage.set({ tokens: null });
      return { tokens: null, result };
    }
    return { tokens, result: await fn(tokens.accessToken) };
  }

  async function readState(config, tokensOverride) {
    const tokens = tokensOverride ?? config.tokens;
    if (!config.clientId) return deriveState({ clientId: null, hasTokens: false, result: { ok: true, data: null } });
    if (!tokens) return deriveState({ clientId: config.clientId, hasTokens: false, result: { ok: true, data: null } });

    const { tokens: liveTokens, result } = await callApi(config, (accessToken) =>
      getPlayback({ fetchImpl, accessToken }));
    await rememberPlayback(config, result);
    return deriveState({
      clientId: config.clientId,
      hasTokens: Boolean(liveTokens),
      result,
      previousTrack: config.lastTrack ?? null,
      previousProgressMs: config.lastProgressMs ?? 0,
      fetchedAt: now(),
    });
  }

  /**
   * Records what was playing and where. A mobile client leaves Spotify Connect
   * within seconds of a pause, after which Spotify reports no device and no
   * track; this snapshot is what keeps the record on the deck and what lets
   * play wake the device again.
   */
  async function rememberPlayback(config, result) {
    if (!result.ok || !result.data) return;
    const patch = {};
    const deviceId = result.data.device?.id ?? null;
    if (deviceId && deviceId !== config.lastDeviceId) patch.lastDeviceId = deviceId;
    const track = toTrack(result.data);
    if (track) {
      patch.lastTrack = track;
      patch.lastProgressMs = Number.isFinite(result.data.progress_ms) ? result.data.progress_ms : 0;
    }
    if (Object.keys(patch).length > 0) await storage.set(patch);
  }

  /** Rewrites a failed wake so the notice says what actually went wrong. */
  function asWakeFailure(response) {
    if (response.error?.tag !== 'no-device') return response;
    return {
      ...response,
      error: { ...response.error, message: WAKE_FAILED },
      state: { ...response.state, message: WAKE_FAILED },
    };
  }

  const okResponse = (state) => ({ ok: true, state });
  const errResponse = (tag, message, state) => ({ ok: false, error: { tag, message }, state });

  /**
   * Runs a control action, then reconciles playback so the popup gets fresh
   * truth. `reconcile` is how a caller reads back a command whose effect
   * /me/player has not caught up with yet; plain `readState` is the default.
   */
  async function control(config, action, reconcile = readState) {
    let { result } = await callApi(config, action);

    // Spotify's player endpoints return transient 5xx often enough that a single
    // failure is not worth reporting: the command usually lands on a second try.
    if (!result.ok && result.error.status >= 500) {
      result = (await callApi(await storage.get(), action)).result;
    }

    const after = await storage.get();
    if (!result.ok) {
      const state = deriveState({
        clientId: after.clientId,
        hasTokens: Boolean(after.tokens),
        result,
        // What the read before this command recorded, so a failure keeps the
        // record on the deck instead of clearing it.
        previousTrack: after.lastTrack ?? null,
        fetchedAt: now(),
      });
      return errResponse(result.error.tag, result.error.message, state);
    }
    return okResponse(await reconcile(after));
  }

  /**
   * Takes the command we just sent at its word.
   *
   * Spotify answers pause with a 204 and then goes on reporting `is_playing:
   * true` for a moment. Handing that read-back to the popup is what put the
   * record back into motion and set the timer running again straight after a
   * pause. The next poll reports plain truth four seconds later, so a command
   * that silently did not land still corrects itself.
   */
  async function readAsCommanded(config, isPlaying) {
    const state = await readState(config);
    // Only a deck with a record on it plays or pauses; leave the rest alone.
    if (state.status !== STATUS.READY) return state;
    return { ...state, isPlaying };
  }

  /**
   * Reads playback back after a skip, scanning until the new track appears.
   *
   * The first read after a next/previous still names the track that was already
   * playing, which left the old record on the deck until the next poll. A
   * couple of quick re-reads catch the change while the press still feels
   * connected to it; if it has not landed by then the poll will pick it up.
   */
  async function readAfterSkip(config, previousTrackId) {
    let state = await readState(config);
    for (let read = 1; read < SKIP_SCAN_READS; read += 1) {
      if (!previousTrackId || state.track?.id !== previousTrackId) break;
      await wait(SKIP_SCAN_DELAY_MS);
      state = await readState(await storage.get());
    }
    return state;
  }

  /**
   * Starts playback on a device that has dropped off Connect. Plain play only
   * resumes a session that is still live, so Spotify 404s it once the phone has
   * gone; handing the session over is what its own device picker does. A device
   * Spotify has forgotten entirely cannot be reached at all, and says so.
   */
  async function wake(config, deviceId) {
    const { result: listed } = await callApi(config, (accessToken) =>
      getDevices({ fetchImpl, accessToken }));
    // A listing we could not read says nothing about the device; report the
    // failure we actually had rather than pinning it on the phone.
    if (!listed.ok) return await failWith(listed.error.tag, listed.error.message);

    const devices = listed.data?.devices ?? [];
    if (!devices.some((d) => d?.id === deviceId)) {
      return await failWith('no-device', deviceGone(devices));
    }
    const response = await control(
      await storage.get(),
      (accessToken) => transferPlayback({ fetchImpl, accessToken, deviceId }),
      (after) => readAsCommanded(after, true),
    );
    return response.ok ? response : asWakeFailure(response);
  }

  /** Reports a failure over the current state, with the notice spelled out. */
  async function failWith(tag, message) {
    const state = await readState(await storage.get());
    return errResponse(tag, message, { ...state, message });
  }

  async function beginAuth(config) {
    if (!config.clientId) {
      return errResponse('needs-setup', 'Add your Spotify Client ID first.', await readState(config));
    }
    const verifier = randomString(VERIFIER_LENGTH);
    const challenge = await challengeFromVerifier(verifier);
    const state = randomString(24);
    try {
      const redirect = await launchAuthFlow(
        buildAuthUrl({ clientId: config.clientId, redirectUri, codeChallenge: challenge, state }),
      );
      const { code } = parseAuthRedirect(redirect, state);
      const tokens = await exchangeCode({
        fetchImpl, clientId: config.clientId, code, redirectUri, codeVerifier: verifier, now: now(),
      });
      await storage.set({ tokens });
      return okResponse(await readState(await storage.get()));
    } catch (error) {
      return errResponse('auth-failed', error.message, await readState(await storage.get()));
    }
  }

  async function handle(message) {
    const config = await storage.get();

    switch (message?.type) {
      case 'GET_STATE':
        return okResponse(await readState(config));

      case 'BEGIN_AUTH':
        return beginAuth(config);

      case 'SIGN_OUT':
        await storage.set({ tokens: null });
        return okResponse(await readState(await storage.get()));

      case 'TOGGLE_PLAY':
      case 'NEXT':
      case 'PREV':
      case 'SET_VOLUME': {
        const state = await readState(config);
        if (state.status === STATUS.NEEDS_SETUP || state.status === STATUS.NEEDS_AUTH) {
          return errResponse(state.status, 'Connect Spotinyl to Spotify first.', state);
        }
        // Re-read storage: the state read above may have refreshed the token, and
        // Spotify rotates the refresh token when it does. Carrying the stale
        // config into the command would replay a refresh token Spotify has
        // already invalidated, failing every button press that lands on expiry.
        const current = await storage.get();
        if (message.type === 'TOGGLE_PLAY') {
          if (state.isPlaying) {
            return control(
              current,
              (accessToken) => pause({ fetchImpl, accessToken }),
              (after) => readAsCommanded(after, false),
            );
          }
          // Nothing active means the device we last saw has left Connect rather
          // than gone away, and waking it is a different command from resuming.
          // While a device is live it stays the target, so pressing play never
          // drags playback off the speaker the user is actually listening to.
          if (state.status === STATUS.NO_DEVICE && current.lastDeviceId) {
            return wake(current, current.lastDeviceId);
          }
          return control(
            current,
            (accessToken) => play({ fetchImpl, accessToken }),
            (after) => readAsCommanded(after, true),
          );
        }
        if (message.type === 'NEXT' || message.type === 'PREV') {
          const skip = message.type === 'NEXT' ? next : previous;
          const from = state.track?.id ?? null;
          return control(
            current,
            (accessToken) => skip({ fetchImpl, accessToken }),
            (after) => readAfterSkip(after, from),
          );
        }
        // A device on the deck that refuses volume would swallow the change
        // silently, leaving the fader sitting somewhere the speaker never went.
        if (state.deviceId && !state.canSetVolume) {
          return errResponse('volume-unsupported', VOLUME_UNSUPPORTED, {
            ...state, message: VOLUME_UNSUPPORTED,
          });
        }
        // Name the target. Without an id Spotify picks whatever it currently
        // calls active, which is how a drag meant for the phone lands on the
        // desktop app instead; the remembered id also still reaches a phone
        // that has slipped off Connect but is not yet forgotten.
        const deviceId = state.deviceId ?? current.lastDeviceId ?? null;
        return control(current, (accessToken) =>
          setVolume({ fetchImpl, accessToken, percent: message.percent, deviceId }));
      }

      default:
        return errResponse(
          'unknown',
          `Unknown message type "${message?.type}".`,
          await readState(config),
        );
    }
  }

  return { handle };
}
