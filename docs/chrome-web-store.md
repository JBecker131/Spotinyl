# Publishing Spotinyl to the Chrome Web Store

## Building the upload

```
npm test && npm run package && npm run store-assets
```

`tools/package.js` writes `dist/spotinyl-<version>.zip` from an allowlist of the
files the extension actually runs — manifest, icons, `src/**`, and the two
fonts. Tests, build scripts, plans, the logo artwork and the font licence stay
out. The build is reproducible: the same tree packs to the same bytes.

`npm run store-assets` rebuilds the listing screenshot into `dist/store/`.
The capture in `assets/` is taken at a device pixel ratio of 1.5, so it lands at
1918x1198; the store takes 1280x800 and nothing near it, so the image is
centre-cropped to 16:10 and box-filtered down to exactly that. `dev/store-shot.html`
is the page the capture comes from, sized to 1280x800 and rendered from the real
popup markup so the listing cannot drift from the product.

Bump `version` in `manifest.json` before every upload. The store rejects a
package whose version is not higher than the one already published.

## The redirect URI, and the extension ID it is built from

Auth goes through `chrome.identity.launchWebAuthFlow`, so the redirect URI is
`https://<extension-id>.chromiumapp.org/`. An unpacked extension takes its ID
from the folder path; the store assigns a different, permanent one on first
upload.

This does not affect the people who install from the store. They all share the
published ID, and the options page prints their live
`chrome.identity.getRedirectURL()` next to a Copy button, which is the value the
setup steps tell them to paste into their own Spotify app.

It affects you. Your local build and the published build answer to different
IDs, so your own Spotify app needs both redirect URIs registered — or you pin
the local build to the published ID.

### The published extension ID

    ijehfghbdikmiodjcddcchiofghmgbmb

which makes the redirect URI to register in the Spotify app:

    https://ijehfghbdikmiodjcddcchiofghmgbmb.chromiumapp.org/

Every store install shares this ID, so this one URI covers all of them. Keep the
unpacked build's own URI registered alongside it, unless the local manifest is
pinned as below.

### Pinning the local build to the published ID

The order matters, because the store will not accept a first upload whose
manifest carries a `key`; it fails with "key field is not allowed in manifest".
On later uploads it accepts the field and ignores it.

1. Upload `dist/spotinyl-<version>.zip` to the developer dashboard. Do not
   publish it. This is what mints the permanent extension ID.
2. On the item's **Package** tab, click **View public key**, and copy the body
   between the `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`
   markers.
3. Add it to `manifest.json` as a top-level `"key"`, then reload the unpacked
   extension. It now reports the published extension ID.
4. Register `https://ijehfghbdikmiodjcddcchiofghmgbmb.chromiumapp.org/` in
   your Spotify app.

`tools/package.js` strips `key` from the manifest it packs, so the field can
live in the repo permanently without breaking that first upload or any upload
after it. The local file keeps it; the archive never sees it.

## Listing requirements

| Item | Status |
| --- | --- |
| Package under 2 GB | 75 KB |
| Name, 45 char max | "Spotinyl", 8 |
| Description, 132 char max | 92 |
| 128x128 store icon | `icons/icon-128.png` |
| At least one screenshot, exactly 1280x800 or 640x400 | `dist/store/screenshot-1280x800.png` |
| Privacy policy URL | `docs/privacy-policy.html`, once Pages is enabled |
| Single purpose statement | "Control Spotify playback from the toolbar" |

### Permission justifications

Each needs a sentence in the dashboard:

- **identity** — runs the Spotify OAuth flow; no other identity data is read.
- **storage** — keeps the user's Client ID, OAuth tokens and last-seen device
  in `chrome.storage.local` so the popup does not re-authenticate on every open.
- **api.spotify.com** — reads playback state and sends transport commands.
- **accounts.spotify.com** — the OAuth authorize and token endpoints.

### Privacy policy

`docs/privacy-policy.html` is the policy, versioned in this repo alongside the
code it describes, so a change in behaviour and the policy update land together.
Served by GitHub Pages at:

    https://jbecker131.github.io/Spotinyl/privacy-policy.html

Enable it once under **Settings -> Pages -> Deploy from a branch -> `main` ->
`/docs`**. Confirm the exact URL afterwards: the subdomain lowercases the owner,
and the repository segment keeps its own casing.

It lists the five `chrome.storage.local` keys by name, the two Spotify hosts the
manifest allows, and the two scopes the auth flow requests, so it can be checked
against the code rather than taken on trust.

### Data disclosure

Spotinyl stores the Client ID and OAuth tokens locally and talks only to
Spotify. It runs no analytics and has no backend, so the disclosure form is
"authentication information, stored locally, not sold or transferred".

## Review risk: setup is required before the extension does anything

Spotinyl needs the user's own Spotify Client ID before it can connect, and a
reviewer who installs it sees an empty deck until they create a Spotify app.
Spell the setup out in the listing description and repeat it in the reviewer
notes field, with the redirect URI to paste. An extension that appears to do
nothing on install is a common rejection.
