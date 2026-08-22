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
scripts/
  build.mjs                     Bumps the version and builds the signed CRX + ZIP
dist/                           Build output (CRX, ZIP, version file) — gitignored
package.json                    Node build-tool dependencies (crx3)
.github/workflows/build-crx.yml Signed-CRX build and GitHub Release workflow
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

Every push to `master` triggers
[`.github/workflows/build-crx.yml`](./.github/workflows/build-crx.yml). The
workflow automatically:

1. **Bumps the patch version** in `extension/manifest.json`
   (e.g. `1.0.0` → `1.0.1`) and commits that bump back to `master`;
2. signs the extension directory with the stored private key and builds a
   **signed CRX3** package and a plain **ZIP** (both in the `dist/` directory);
3. attaches both files to a **GitHub Release** named after the version
   (`v1.0.1`), where they are ready to download and publish.

### What to do after a push

1. Open **Actions** and confirm the "Build signed CRX and release" run passes.
2. Open the **Releases** page and grab `Doublage-vX.Y.Z.crx` and
   `Doublage-vX.Y.Z.zip` from the latest release.
3. Publish from the **ZIP** file — go to the [Chrome Web Store Developer
   Dashboard](https://chrome.google.com/webstore/devconsole), select the item,
   and upload the new ZIP. Chrome Web Store generates/owns the key and ID for a
   ZIP-based item, so you do not need (and cannot reuse) the store ID for a
   signed CRX.

The **signed CRX** is for installing/sideloading the extension outside the
store (enterprise policy, developer testing, private distribution). Chrome
derives the extension ID from the public key embedded in the CRX, so:

- the first build generates `extension.pem` and that key becomes the ID of the
  signed CRX;
- every later release must be signed with **the same key**, otherwise Chrome
  treats it as a different extension;
- the store item’s ID (currently `eeefnfeallmjjhfhajgbobpdjhepmdek`) is
  **independent** of this key — publishing to the store is always done via ZIP.

Because the version is bumped automatically, you normally never edit
`extension/manifest.json` by hand for releases.

### Required rule: version must always increase

Chrome Web Store rejects uploads whose version is not higher than the version
already in the Store. Each push bumps the patch number, so consecutive releases
always differ. If the Store already has `1.0.1`, make the next push bump to at
least `1.0.2`, or raise the committed `extension/manifest.json` version manually
before pushing. Chrome’s four-part numeric format (`1.0.1.0`) is also supported.

### Release checklist

1. Test the unpacked extension locally (`chrome://extensions` → **Load
   unpacked** → select `extension/`).
2. Commit your changes and push to `master`.
3. Confirm the workflow run succeeds and the version bump is committed.
4. Download the ZIP from the new GitHub Release.
5. Upload the ZIP in the Chrome Web Store Developer Dashboard and submit for
   review.

### One-time setup: the private key

The workflow signs the CRX with a **private key** (`extension.pem`) that must be
the same on every run. It is retrieved from a GitHub repository secret, so it is
never stored in the repo.

1. Generate once — building locally (`npm run build:crx`) creates it, or pack
   with Chrome: `chrome --pack-extension=extension`.
2. Keep `extension.pem` — it is the only key that can recreate the same
   extension ID for your signed CRX.
3. Set the repository secret `EXTENSION_PRIVATE_KEY` to the **base64** of that
   PEM. On any machine:

   ```bash
   base64 -w0 < extension.pem   # prints the value to store in the secret
   ```

4. The workflow fails if the secret is missing, so the CRX ID always stays
   stable.

No other secrets (Google OAuth, publisher ID, etc.) are needed — the old
auto-publish-to-Web-Store workflow was removed.

## License

Copyright © 2026 Hamid Reza Arzaghi

Doublage is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

See [LICENSE](./LICENSE) for the full license text.
