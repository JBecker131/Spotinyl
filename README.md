# Spotinyl

A Chrome extension that shows what you are playing on Spotify as a spinning
record, and lets you skip, pause, and set the volume from a turntable-styled
popup.

![The popup is a top-down turntable: a brushed aluminium plate, a spinning
record with the album art as its label, a tonearm that tracks inward as the
track plays, three chunky transport keys, and a volume fader.](docs/screenshot.png)

## Requirements

- Google Chrome (or any Chromium browser: Edge, Brave, Arc).
- **Spotify Premium**, to use the controls. Spotify's Web API refuses play,
  pause, skip, and volume requests on free accounts. The now-playing display
  works on a free account.
- Nothing else. Spotinyl has zero dependencies and needs no build step.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and select this folder.
2. Click the Spotinyl icon, then **Open setup** (or right-click the icon and
   choose **Options**).

## Connect it to Spotify

Spotinyl uses your own Spotify developer credentials, so nothing is shared with
anyone else. This is a one-time, roughly five-minute setup.

1. On the setup page, **copy the redirect URI**. It looks like
   `https://<extension-id>.chromiumapp.org/` and is unique to your install.
2. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and click **Create app**. Give it any name and description.
3. Paste the redirect URI into **Redirect URIs**, tick **Web API**, and save.
4. Copy the app's **Client ID** and paste it into the setup page, then **Save**.
   Ignore the Client Secret — Spotinyl uses PKCE and never needs it.
5. Click **Connect to Spotify** and approve the two permissions it asks for.

Start playing something on any Spotify device, then open the popup.

## What the turntable is telling you

| What you see | What it means |
|---|---|
| Record spinning, tonearm tracking inward | Playing. The arm's position is the track's progress. |
| Record frozen, tonearm holding still | Paused. |
| Record still, tonearm parked on its rest | Nothing is playing, or no Spotify device is active. |
| Blank white record label | Not connected to Spotify yet. |
| Amber lamp lit | Spotinyl has a live read on your playback. |

## Troubleshooting

**"INVALID_CLIENT: Invalid redirect URI"** — the redirect URI in your Spotify
app does not match this install. Re-copy it from the setup page. Note that the
extension ID, and therefore the URI, changes if you load the extension from a
different folder.

**Controls are dimmed and mention Premium** — Spotify returned `403`. Playback
control is a Premium-only API.

**"No Record Loaded"** — Spotify reports no active device. Play something in
the Spotify app, phone, or web player, then reopen the popup.

## Privacy

Your tokens are stored in `chrome.storage.local`, which is readable only by
this extension. Nothing is sent anywhere except `accounts.spotify.com` and
`api.spotify.com`. Spotinyl keeps no listening history and collects no
analytics.

## Development

```bash
npm test          # run every unit test (node:test, no dependencies)
npm run icons     # regenerate icons/ from tools/make-icons.js
```

`dev/preview.html` renders the popup against mock data for every UI state, so
the visuals can be worked on without Spotify credentials. It needs an HTTP
origin — serve the repository root and open
`http://localhost:8080/dev/preview.html`.

Spotinyl is not affiliated with or endorsed by Spotify.
