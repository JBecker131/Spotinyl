import { STATUS, deriveState, toTrack } from '../lib/player-state.js';
import {
  shouldRefresh, refreshTokens, exchangeCode,
  randomString, challengeFromVerifier, buildAuthUrl, parseAuthRedirect,
} from '../lib/auth.js';
import { getPlayback, play, pause, next, previous, setVolume } from '../lib/spotify-api.js';

const VERIFIER_LENGTH = 64;

export function createRouter({ storage, fetchImpl, launchAuthFlow, redirectUri, now }) {
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
    return deriveState({
      clientId: config.clientId,
      hasTokens: Boolean(liveTokens),
      result,
      fetchedAt: now(),
    });
  }

  const okResponse = (state) => ({ ok: true, state });
  const errResponse = (tag, message, state) => ({ ok: false, error: { tag, message }, state });

  /** Runs a control action, then re-reads playback so the popup gets fresh truth. */
  async function control(config, action) {
    const { result } = await callApi(config, action);
    const after = await storage.get();
    if (!result.ok) {
      const previousTrack = toTrack(await lastPlayback(after));
      const state = deriveState({
        clientId: after.clientId,
        hasTokens: Boolean(after.tokens),
        result,
        previousTrack,
        fetchedAt: now(),
      });
      return errResponse(result.error.tag, result.error.message, state);
    }
    return okResponse(await readState(after));
  }

  /** Best-effort read used only to keep a track on screen when a control fails. */
  async function lastPlayback(config) {
    if (!config.tokens) return null;
    const { result } = await callApi(config, (accessToken) => getPlayback({ fetchImpl, accessToken }));
    return result.ok ? result.data : null;
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
        if (message.type === 'TOGGLE_PLAY') {
          const action = state.isPlaying ? pause : play;
          return control(config, (accessToken) => action({ fetchImpl, accessToken }));
        }
        if (message.type === 'NEXT') {
          return control(config, (accessToken) => next({ fetchImpl, accessToken }));
        }
        if (message.type === 'PREV') {
          return control(config, (accessToken) => previous({ fetchImpl, accessToken }));
        }
        return control(config, (accessToken) =>
          setVolume({ fetchImpl, accessToken, percent: message.percent }));
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
