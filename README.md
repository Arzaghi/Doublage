# Doublage

**Doublage** is a Manifest V3 Chrome extension that translates audio from the
currently active browser tab in real time with the Gemini Live API. It can play
the translated voice, display translated subtitles, and lower or mute the
original tab audio while translation is active.

## Features

- Real-time tab-audio translation using Gemini Live
- Spoken translation, subtitles, or both
- Original-audio controls: duck or mute
- Fast target-language selection and saved user preferences
- Animated toolbar status indicator while translation is active
- No remotely hosted executable code

## Requirements

- Google Chrome 116 or later
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- A Gemini API key with access to the Gemini Live API

## Local development

1. Clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the [`extension`](./extension) directory — not the repository root.
6. Open **Settings** in the extension and enter your Gemini API key.

After changing extension files, click **Reload** on the extension card in
`chrome://extensions` before testing again.

## Project structure

```text
extension/
  manifest.json                 Extension manifest and version
  background.js                 Manifest V3 service worker
  offscreen.js                  Tab-audio capture, Gemini connection, playback
  audio-capture-worklet.js      AudioWorklet PCM capture processor
  content.js                    Subtitle overlay in the selected tab
  popup.html / popup.js         Main extension interface
  options.html / options.js     Extension settings
  icons/                        Toolbar and extension icons
.github/workflows/publish.yml   Chrome Web Store publishing workflow
```

## Privacy and data handling

Translation begins only after the user starts it from the extension popup.
While active, the audio from the selected tab is sent directly to the Gemini
Live API to generate translated audio and/or subtitles. The extension stores
the user’s API key and preferences in Chrome extension storage. It does not
download or execute remotely hosted JavaScript or WebAssembly.

Before publishing, provide an accurate privacy policy and complete the Chrome
Web Store Privacy tab to reflect these practices.

## Release and Chrome Web Store publishing

Pushing to `main` triggers [`.github/workflows/publish.yml`](./.github/workflows/publish.yml).
The workflow creates `extension.zip`, uploads it to the existing Chrome Web
Store item, and submits the uploaded version for publication.

Chrome Web Store review can still be required; a successful workflow means the
package was uploaded and submitted, not necessarily that it is immediately
available to every user.

### Required rule: bump the manifest version before every release

**Before every push to `main`, increase `extension/manifest.json` → `version`.**
Chrome Web Store rejects uploads when the uploaded version is not higher than
the version already in the Store.

For example:

```json
{
  "version": "1.0.1"
}
```

Use Chrome’s four-part numeric version format when needed, such as
`1.0.1.0`. Do not reuse an already published version.

### Release checklist

1. Test the unpacked extension locally.
2. Update `extension/manifest.json` with a new, higher version.
3. Review the Chrome Web Store listing and privacy disclosures if data handling
   or permissions changed.
4. Commit all changes.
5. Push to `main`.
6. Open the GitHub Actions run and confirm both upload and publish steps pass.
7. Monitor the Chrome Web Store Developer Dashboard for review status.

### One-time publishing setup

The workflow updates an **existing** Chrome Web Store item. Create the initial
listing manually in the Chrome Web Store Developer Dashboard, complete its
Store Listing and Privacy tabs, and record its extension ID.

In GitHub, add the following repository secrets used by `publish.yml`:

| Secret | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from your Google Cloud project |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret from the same client |
| `GOOGLE_REFRESH_TOKEN` | Refresh token authorized with the `chromewebstore` scope and the Store-owner account |
| `CHROME_PUBLISHER_ID` | Publisher ID from Chrome Web Store Developer Dashboard → Publisher settings |
| `CHROME_EXTENSION_ID` | ID of the initial Chrome Web Store item |

The OAuth client must be configured in a Google Cloud project with the **Chrome
Web Store API** enabled. Generate the refresh token using the Google account
that owns the Chrome Web Store item and the scope:

```text
https://www.googleapis.com/auth/chromewebstore
```

Keep all five values in GitHub Secrets only. Never commit API keys, OAuth
credentials, refresh tokens, or Chrome Web Store identifiers to source control.

For the official setup and API requirements, see the [Chrome Web Store API
guide](https://developer.chrome.com/docs/webstore/using-api).

## License

Copyright © 2026 Hamid Reza Arzaghi

Doublage is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

See [LICENSE](./LICENSE) for the full license text.
