# Spotivyn — Design

**Date:** 2026-09-09
**Status:** Approved, ready for implementation planning

A Chrome extension that shows what you are playing on Spotify and lets you
skip, play/pause, and set volume, presented as a top-down turntable.

## 1. Goals and non-goals

### Goals

- Show the currently playing track: album art, title, artist, album, elapsed
  and total time.
- Control playback: previous track, play/pause, next track, volume.
- Present the whole popup as a physical turntable whose behavior reflects
  playback state.
- Work against any Spotify playback device (desktop app, phone, web player),
  not only an open browser tab.

### Non-goals

Deliberately excluded. Each is a clean later addition, none is designed for now.

- Listening history or a session log.
- Aggregate statistics (top artists, minutes listened).
- Seeking or scrubbing within a track.
- Playlist, library, or search browsing.
- Switching the active playback device.
- Firefox support.

## 2. Constraints

- **Spotify Premium is required for control.** The `/me/player` control
  endpoints return `403` for free accounts. The extension surfaces this
  clearly rather than trying to work around it.
- **One-time user setup is required.** The user must register a free app in
  the Spotify developer dashboard and supply its Client ID. A Client ID
  cannot be shipped in the extension: it is bound to a registered redirect
  URI, and the redirect URI is derived from the installed extension's ID,
  which differs per install.
- **No remote resources.** Manifest V3's default CSP forbids remote script,
  and the popup must work with a cold network. Fonts are system stacks; all
  graphics are CSS or inline SVG. The only network calls are to Spotify.
- **Spotify branding is not licensed.** Extension icons depict a generic
  vinyl record. Spotify's logo and wordmark are not shipped, and no UI text
  implies Spotify endorsement.

## 3. Architecture

Manifest V3 extension. No content scripts — nothing is injected into any page.

```
manifest.json
src/
  background/service-worker.js   message router; sole owner of tokens
  lib/auth.js                    PKCE flow, token lifecycle
  lib/spotify-api.js             endpoint calls, error mapping
  lib/player-state.js            pure: UI state derivation, progress interpolation
  lib/geometry.js                pure: progress -> tonearm angle
  popup/popup.html popup.css popup.js
  options/options.html options.css options.js
dev/preview.html                 renders the popup against mock states
test/                            node:test suites over the pure libs
icons/                           16/32/48/128 px vinyl record PNGs
README.md                        setup walkthrough
```

### Manifest

- `manifest_version: 3`
- `permissions`: `identity`, `storage`
- `host_permissions`: `https://api.spotify.com/*`, `https://accounts.spotify.com/*`
- `action.default_popup`: `src/popup/popup.html`
- `options_page`: `src/options/options.html`
- `background.service_worker` with `"type": "module"`

### Why the service worker owns the token

The service worker is the single writer for tokens and the only caller of the
Spotify API. Spotify rotates the refresh token on each refresh: if two
surfaces refreshed concurrently, one would persist a refresh token that the
other had already invalidated, silently logging the user out. Funneling every
call through one owner removes that race.

The popup holds no token and makes no direct Spotify request. It exchanges
messages with the service worker and renders the plain state objects it gets
back. MV3 service workers are evicted when idle; this is fine, because all
durable state lives in `chrome.storage.local` and the worker wakes on message.

## 4. Authentication

OAuth 2.0 Authorization Code with PKCE, run through
`chrome.identity.launchWebAuthFlow`.

- Redirect URI: `chrome.identity.getRedirectURL()`, which yields
  `https://<extension-id>.chromiumapp.org/`. The options page displays this
  string for the user to copy into the Spotify dashboard.
- Authorize endpoint: `https://accounts.spotify.com/authorize`
- Token endpoint: `https://accounts.spotify.com/api/token`
- Scopes: `user-read-playback-state`, `user-modify-playback-state`
- PKCE: `code_verifier` is 64 random characters from the unreserved set;
  `code_challenge` is base64url(SHA-256(verifier)) with
  `code_challenge_method=S256`.
- A random `state` value is generated per attempt and verified on return.

### Token lifecycle

Access tokens last 3600s. The worker refreshes when a token is within 60s of
expiry, checked lazily before each API call rather than on a timer — a timer
would not survive service worker eviction.

Refresh uses `grant_type=refresh_token` with the `client_id`. **If the refresh
response contains a `refresh_token`, it must replace the stored one.** A
refresh that fails with `invalid_grant` clears stored tokens and puts the UI
into the `needs-auth` state.

### Storage schema

`chrome.storage.local`:

```js
{
  clientId: string | null,
  tokens: {
    accessToken: string,
    refreshToken: string,
    expiresAt: number,   // epoch ms
    scope: string
  } | null
}
```

`chrome.storage.local` is isolated to the extension; no web page can read it.

## 5. Spotify endpoints used

| Action | Request | Notes |
|---|---|---|
| Read state | `GET /v1/me/player` | `200` with state, or `204` when no active device |
| Play | `PUT /v1/me/player/play` | |
| Pause | `PUT /v1/me/player/pause` | |
| Next | `POST /v1/me/player/next` | |
| Previous | `POST /v1/me/player/previous` | |
| Volume | `PUT /v1/me/player/volume?volume_percent=N` | N is an integer 0–100 |

### Error mapping

`spotify-api.js` converts transport outcomes into a tagged error type so the
UI never inspects raw status codes:

| Condition | Tag | UI consequence |
|---|---|---|
| `204` from `GET /me/player` | `no-device` | Parked-tonearm state |
| `401` | `unauthorized` | Refresh once, then retry; on second failure, `needs-auth` |
| `403` | `forbidden` | Premium-required note; controls disabled |
| `429` | `rate-limited` | Back off for `Retry-After` seconds; display goes stale |
| Network failure | `offline` | Retain last state, dim it |
| Other non-2xx | `unknown` | Generic recoverable error message |

## 6. Message protocol

Popup to service worker, via `chrome.runtime.sendMessage`. Every response is
either `{ ok: true, state }` or `{ ok: false, error: { tag, message } }`, where
`state` is the freshly derived UI state and is present on every successful
response, including `SIGN_OUT` and `BEGIN_AUTH`.

| Message | Payload | Effect |
|---|---|---|
| `GET_STATE` | — | Performs a fresh `GET /me/player` and returns the derived UI state. This is the only read path; the worker caches nothing between calls beyond tokens. |
| `TOGGLE_PLAY` | — | Reads current playback state first, then pauses if playing or plays if paused. The worker decides the direction, not the popup, so the two cannot disagree. |
| `NEXT` | — | Skip forward |
| `PREV` | — | Skip back |
| `SET_VOLUME` | `{ percent }` | Sets device volume |
| `BEGIN_AUTH` | — | Runs the PKCE flow (sent by the options page) |
| `SIGN_OUT` | — | Clears stored tokens |

## 7. Polling and progress

No background polling. Nothing in scope requires state while the popup is
closed.

While the popup is open:

- One `GET /me/player` on open, then a refresh every **4000 ms**.
- Between refreshes, the progress bar and tonearm advance **locally** from
  `progressMs + (now - fetchedAt)` when playing, on `requestAnimationFrame`.
- Polling stops when the popup closes.

This keeps motion smooth at display rate while staying far under Spotify's
rate limits.

### Optimistic control

A control click updates the UI immediately — pause freezes the platter and
flips the icon before any network call completes — then fires the request. The
next poll reconciles. A failed call reverts the affected control and surfaces
the mapped error. Volume is debounced at 150 ms while dragging so a drag
produces one request, not one per pixel.

## 8. UI states

`player-state.js` derives exactly one `status` from stored config and the last
API result. These are a closed set; the popup renders one branch per status.

| `status` | Trigger | Presentation |
|---|---|---|
| `needs-setup` | No `clientId` stored | Setup panel with a link to the options page |
| `needs-auth` | Client ID present, no valid tokens | Blank white record label carrying a "Connect to Spotify" button |
| `no-device` | `204` from `GET /me/player` | Platter still, tonearm parked on its rest, controls dimmed, label reads "no record loaded" |
| `ready` | Playback state received | Full turntable; see below |
| `forbidden` | `403` from any call | If a track is known, keeps the `ready` layout and disables the controls with a Premium note; if not, falls back to the `no-device` presentation carrying the same note |
| `error` | `offline` or `unknown` | Last known state dimmed, with a retry affordance |

Within `ready`:

- **Playing** — platter rotates, tonearm tracks inward.
- **Paused** — platter freezes at its current rotation, tonearm holds position.

## 9. Visual design

360 px wide, approximately 470 px tall. All surfaces are CSS; no raster assets
in the UI.

### Materials

| Surface | Treatment |
|---|---|
| Plinth shell | Deep walnut `#3a2618`, subtle vertical grain |
| Top plate | Brushed aluminum: base `#b0b4b8` with a low-alpha `repeating-linear-gradient` at ~8° |
| Platter mat | Near-black felt `#14151a` with faint noise |
| Vinyl | `#0a0a0c` with grooves from `repeating-radial-gradient`, plus a `conic-gradient` sheen for light catching the surface |
| Power indicator | Amber LED `#e8a33d` with a soft bloom |

Typography is system stacks only — a condensed grotesk for deck labels, a
neutral sans for track metadata.

### The record

Album art is the record's center label: circle-clipped, with a spindle hole
punched through the middle. Rotation is a CSS keyframe at **1.8 s per
revolution**, which is a true 33 1/3 rpm. Pause toggles `animation-play-state`
rather than removing the animation, so the record freezes in place and resumes
from where it stopped instead of snapping back to zero.

### The tonearm

An element rotating about a `transform-origin` at its pivot, driven by
playback progress. The arm is a second progress indicator; the conventional
bar beneath it provides precision. Angles, tuned during visual work:

- `ARM_PARKED_DEG = 0` — resting off the record
- `ARM_LEAD_IN_DEG = 18` — the outer groove, at 0% progress
- `ARM_INNER_DEG = 32` — the inner groove, at 100% progress

Motion between poll updates is interpolated locally, and the arm transitions
smoothly rather than stepping on each poll.

### Controls

Buttons are chunky keys whose depth comes from layered box-shadows — light
top-left, dark bottom-right — that collapse on `:active` alongside a 1 px
`translateY`, so they physically depress. Volume is a real
`<input type="range">` restyled as a mixing-desk fader: a recessed channel
with an inset shadow and a ridged cap.

### Accessibility

- Controls are real `<button>` and `<input>` elements with `aria-label`s, so
  the popup is fully keyboard-operable.
- Focus rings are visible and tuned to the metal palette.
- Album art carries descriptive `alt` text; the now-playing region is an
  `aria-live="polite"` region so track changes are announced.
- `prefers-reduced-motion: reduce` stops the platter rotation and the arm
  sweep, leaving the numeric readout and bar as the progress indicators.
- Text contrast meets WCAG AA against its surface.

Because the popup depicts a physical object with fixed materials, it commits
to one appearance and does not offer a light/dark variant.

## 10. Icons

16, 32, 48, and 128 px PNGs of a vinyl record — concentric grooves with a
colored center label. Generated by a small build script that writes PNG bytes
directly using Node's `zlib`, so the repository carries no binary-authoring
dependency and the icons can be regenerated from source.

## 11. Testing

### Unit tests — `node:test`, no dependencies

- `geometry.js` — parked angle when no track; lead-in at 0% progress; inner
  groove at 100%; monotonic in between; clamps progress outside `[0, 1]`;
  handles `durationMs` of 0 without dividing by zero.
- `player-state.js` — each `status` is derived from the right inputs; progress
  interpolation advances while playing, holds while paused, and never exceeds
  `durationMs`.
- `auth.js` — `shouldRefresh` respects the 60 s skew; `computeExpiry` is
  correct; a refresh response containing a new `refresh_token` replaces the
  stored one, and one without leaves it intact; `invalid_grant` clears tokens.
- `spotify-api.js` — against a fake `fetch`, each of `200`, `204`, `401`,
  `403`, `429`, and a network rejection maps to the right error tag; `429`
  honors `Retry-After`.

### Visual verification — `dev/preview.html`

Renders the real popup markup and CSS against mock state objects, one panel
per `status` in section 8 plus playing and paused. This makes every state,
including the error states, reviewable without live credentials.

### Manual verification

Load unpacked in Chrome; confirm the OAuth round trip, live now-playing
display, and each of the four controls against a real account.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Setup friction loses the user partway | Options page walks through it in order, with the redirect URI shown and one-click copyable; README mirrors it |
| Tester lacks Premium | `403` is a designed, explained state, not a crash |
| Extension ID changes, invalidating the redirect URI | Documented in the README; the options page always shows the current URI |
| Skeuomorphic CSS becomes unmaintainable | Materials are CSS custom properties in one block, not scattered literals |
