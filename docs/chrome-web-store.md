# Publishing Spotinyl to the Chrome Web Store

## Building the upload

```
npm test && npm run package
```

`tools/package.js` writes `dist/spotinyl-<version>.zip` from an allowlist of the
files the extension actually runs — manifest, icons, `src/**`, and the two
fonts. Tests, build scripts, plans, the logo artwork and the font licence stay
out. The build is reproducible: the same tree packs to the same bytes.

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
4. Register `https://<published-id>.chromiumapp.org/` in your Spotify app.

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
| At least one screenshot, exactly 1280x800 or 640x400 | **missing** — `docs/screenshot.png` is 504x603 |
| Privacy policy URL | written — must be shared publicly before submitting, see below |
| Single purpose statement | "Control Spotify playback from the toolbar" |

### Permission justifications

Each needs a sentence in the dashboard:

- **identity** — runs the Spotify OAuth flow; no other identity data is read.
- **storage** — keeps the user's Client ID, OAuth tokens and last-seen device
  in `chrome.storage.local` so the popup does not re-authenticate on every open.
- **api.spotify.com** — reads playback state and sends transport commands.
- **accounts.spotify.com** — the OAuth authorize and token endpoints.

### Privacy policy

The policy is published at
<https://claude.ai/code/artifact/f5322f26-50b7-4986-b2dc-b51d367c12d0>. It lists
the five `chrome.storage.local` keys by name, the two Spotify hosts the manifest
allows, and the two scopes the auth flow requests, so it can be checked against
the code rather than taken on trust.

Two things before it can go in the dashboard field:

1. **Fill in the contact.** The Contact clause has a marked placeholder rather
   than an address, because publishing an email is your call to make.
2. **Make the page public.** It is private to your account as published, and the
   store requires a URL a reviewer can open. Share it from the page's share menu.

A page on claude.ai is fine for getting through review, but it is tied to this
account. Once the repo has a remote, GitHub Pages is the more durable home for
it, and the policy should move there and be versioned with the code it
describes.

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
