/**
 * Gemini Live API — Integration / Smoke Test
 *
 * Exercises the exact same Gemini Live API protocol used by the Doublage
 * Chrome extension (extension/offscreen.js):
 *
 *   1. Connects to the Gemini Live WebSocket endpoint.
 *   2. Authenticates with the API key (same URL construction).
 *   3. Sends the same setup message (model, translation config, modalities).
 *   4. Waits for `setupComplete` — proves key valid, endpoint reachable,
 *      model available, and setup protocol unchanged.
 *   5. Sends a short synthetic PCM-16 audio chunk (exercises the audio-send
 *      pathway and stream-processing logic).
 *   6. Waits for any server content; accepts a timeout gracefully because a
 *      pure sine tone is unlikely to produce a translation transcript.
 *   7. Closes the connection cleanly.
 *
 * The test FAILS on any of:
 *   - GEMINI_API_KEY not set
 *   - WebSocket connection failure (endpoint change, network, TLS)
 *   - Authentication / permission error from the API
 *   - API-level error before or during setup
 *   - `setupComplete` not received within the timeout
 *     (model removed, protocol change, quota, etc.)
 *
 * Protocol constants are kept intentionally in sync with extension/offscreen.js.
 * If offscreen.js changes the model name, endpoint, or setup message format,
 * this file must be updated to match.
 *
 * Run locally:
 *   GEMINI_API_KEY=<your-test-key> npm run test:gemini
 *
 * SECURITY: the API key is NEVER logged, printed, or included in any
 * error message produced by this file.
 */

import { test } from 'node:test';
import assert  from 'node:assert/strict';

// ─── Protocol constants (sync with extension/offscreen.js) ────────────────────
const GEMINI_MODEL = 'models/gemini-3.5-live-translate-preview';
const GEMINI_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const AUDIO_SAMPLE_RATE = 16_000;   // PCM input sample rate expected by Gemini
const TEST_TARGET_LANG  = 'French'; // deterministic target language for the smoke test

// ─── Timeouts ─────────────────────────────────────────────────────────────────
const SETUP_TIMEOUT_MS = 30_000;   // waiting for setupComplete
const AUDIO_WAIT_MS    = 15_000;   // waiting for server content after sending audio
const MAX_RETRIES      = 2;        // additional attempts after the first
const RETRY_DELAY_MS   = 4_000;    // delay between retries

// ─── Language code map (sync with extension/offscreen.js) ─────────────────────
const LANGUAGE_CODES = {
  Afrikaans: 'af', Akan: 'ak', Albanian: 'sq', Amharic: 'am', Arabic: 'ar',
  Armenian: 'hy', Assamese: 'as', Azerbaijani: 'az', Basque: 'eu',
  Belarusian: 'be', Bengali: 'bn', Bosnian: 'bs', Bulgarian: 'bg',
  Burmese: 'my', Cebuano: 'ceb', Catalan: 'ca',
  Chinese: 'zh-Hans', Croatian: 'hr', Czech: 'cs', Danish: 'da',
  Dutch: 'nl', English: 'en', Estonian: 'et', Faroese: 'fo', Filipino: 'fil',
  Finnish: 'fi', French: 'fr', Galician: 'gl', Georgian: 'ka', German: 'de',
  Greek: 'el', Gujarati: 'gu', Hausa: 'ha', Hebrew: 'he', Hindi: 'hi',
  Hungarian: 'hu', Icelandic: 'is', Indonesian: 'id', Irish: 'ga', Italian: 'it',
  Japanese: 'ja', Kannada: 'kn', Kazakh: 'kk',
  Khmer: 'km', Korean: 'ko', Lao: 'lo', Latvian: 'lv', Lithuanian: 'lt',
  Malay: 'ms', Malayalam: 'ml', Maltese: 'mt', Maori: 'mi', Marathi: 'mr',
  Mongolian: 'mn', Nepali: 'ne', Norwegian: 'no', Odia: 'or', Oromo: 'om',
  Pashto: 'ps', Persian: 'fa', Polish: 'pl', Portuguese: 'pt-BR',
  Punjabi: 'pa', Quechua: 'qu', Romanian: 'ro', Romansh: 'rm', Russian: 'ru',
  Serbian: 'sr', Sindhi: 'sd', Sinhala: 'si', Slovak: 'sk',
  Slovenian: 'sl', Somali: 'so', Spanish: 'es', Swahili: 'sw', Swedish: 'sv',
  Tajik: 'tg', Tamil: 'ta',
  Telugu: 'te', Thai: 'th', Turkish: 'tr', Ukrainian: 'uk', Urdu: 'ur',
  Uzbek: 'uz', Vietnamese: 'vi', Welsh: 'cy', Wolof: 'wo', Yoruba: 'yo', Zulu: 'zu',
};

function languageCode(name) {
  return LANGUAGE_CODES[name] ?? name ?? 'en';
}

// ─── Synthetic PCM-16 audio ───────────────────────────────────────────────────
// Generates `durationSec` seconds of a 440 Hz sine wave at 16 kHz PCM-16.
// This is not speech, so the model will not produce a translation transcript,
// but it exercises the audio-send pathway and verifies the stream is accepted
// without a protocol error.  Amplitude is kept at ~25 % to avoid clipping.
function syntheticPCM16(durationSec = 1.0) {
  const n   = Math.floor(AUDIO_SAMPLE_RATE * durationSec);
  const buf = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / AUDIO_SAMPLE_RATE) * 8192);
  }
  return buf;
}

// ─── Utility ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Returns true if the error message indicates an authentication problem.
 * Only matches errors that originate from the API, NOT our own timeout messages.
 */
function isAuthError(msg) {
  // Only match messages that begin with our 'API error' prefix (i.e. came from
  // the server's data.error handler).  This prevents our own timeout message —
  // which mentions 'quota' as a diagnostic hint — from being misclassified.
  if (!(msg ?? '').startsWith('API error')) return false;
  const s = msg.toLowerCase();
  return s.includes('api_key')        ||
         s.includes('api key')        ||
         s.includes('unauthenticated') ||
         s.includes('unauthorized')   ||
         s.includes('permission')     ||
         s.includes('403')            ||
         s.includes('401');
}

// ─── Single test attempt ──────────────────────────────────────────────────────
/**
 * Opens one Gemini Live WebSocket session, performs the full setup handshake,
 * sends a synthetic audio chunk, then waits for any server content or a timeout.
 *
 * Resolves with a result object on success; rejects with an Error on failure.
 * The API key is NEVER included in any error message.
 */
function runAttempt(apiKey) {
  return new Promise((resolve, reject) => {
    // Build the URL exactly as offscreen.js does.
    const wsUrl = `${GEMINI_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
      // Force binary frames to arrive as ArrayBuffer so we can decode them
      // synchronously with TextDecoder.  Node.js defaults to 'blob' which
      // would require an async .text() call and would silently break parsing.
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      return reject(new Error(`Failed to construct WebSocket: ${e.message}`));
    }

    let phase       = 'connecting';
    let settled     = false;
    let gotSetup    = false;
    let gotContent  = false;
    let setupTimer  = null;
    let audioTimer  = null;

    /** Finalise the attempt (success or failure) and tidy up. */
    const finish = (ok, valueOrError) => {
      if (settled) return;
      settled = true;
      clearTimeout(setupTimer);
      clearTimeout(audioTimer);
      // Suppress the onclose handler so it does not fire another finish() call.
      ws.onclose = null;
      try { ws.close(1000, 'test done'); } catch { /* ignore */ }
      if (ok) {
        resolve(valueOrError);
      } else {
        reject(valueOrError instanceof Error ? valueOrError : new Error(String(valueOrError)));
      }
    };

    // ── Global setup timeout ─────────────────────────────────────────────────
    setupTimer = setTimeout(() => {
      finish(false, new Error(
        `[phase: ${phase}] Timed out after ${SETUP_TIMEOUT_MS} ms waiting for setupComplete. ` +
        'Possible causes: invalid key, quota exhausted, model unavailable, or protocol change.'
      ));
    }, SETUP_TIMEOUT_MS);

    // ── WebSocket event handlers ─────────────────────────────────────────────
    ws.onopen = () => {
      phase = 'awaiting setupComplete';

      // Send the same setup message as extension/offscreen.js.
      ws.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          inputAudioTranscription:  {},
          outputAudioTranscription: {},
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: languageCode(TEST_TARGET_LANG),
              echoTargetLanguage: false,
            },
          },
        },
      }));
    };

    ws.onmessage = (event) => {
      // Parse message — mirrors the offscreen.js onmessage handler.
      // binaryType='arraybuffer' ensures binary frames arrive as ArrayBuffer,
      // not Blob, so we can decode them synchronously.
      let data;
      try {
        const text = typeof event.data === 'string'
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : String(event.data);
        data = JSON.parse(text);
      } catch {
        return; // ignore non-JSON frames
      }

      // ── API-level error ────────────────────────────────────────────────────
      if (data.error) {
        // Deliberately omit request details / key from the error text.
        finish(false, new Error(
          `API error (code ${data.error.code ?? 'unknown'}): ` +
          `${data.error.message ?? 'no message'}`
        ));
        return;
      }

      // ── Server-initiated session termination ───────────────────────────────
      if (data.goAway) {
        finish(false, new Error(`Server sent goAway during phase "${phase}".`));
        return;
      }

      // ── Setup acknowledged ─────────────────────────────────────────────────
      if (!gotSetup && Object.hasOwn(data, 'setupComplete')) {
        gotSetup = true;
        clearTimeout(setupTimer);
        phase = 'sending audio';

        // Send 1 s of synthetic PCM-16 to verify the audio-send pathway.
        const pcm = syntheticPCM16(1.0);
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: 'audio/pcm;rate=16000',
              data: Buffer.from(pcm.buffer).toString('base64'),
            },
          },
        }));

        phase = 'awaiting server response';

        // A pure sine tone is unlikely to trigger a translation transcript,
        // so we give the model AUDIO_WAIT_MS to respond and then accept a
        // timeout as a pass — the absence of an error proves the pipeline works.
        audioTimer = setTimeout(() => {
          finish(true, { gotSetup: true, gotContent: false });
        }, AUDIO_WAIT_MS);

        return;
      }

      // ── Server content (translation output) ───────────────────────────────
      if (gotSetup && data.serverContent) {
        gotContent = true;
        const transcription = data.serverContent?.outputTranscription?.text ?? null;
        if (data.serverContent.turnComplete || transcription) {
          finish(true, { gotSetup: true, gotContent: true, transcription });
        }
      }
    };

    ws.onerror = () => {
      // The error event carries no useful details in the WHATWG API; the close
      // event will follow with a code.  Report the phase for diagnosis.
      finish(false, new Error(
        `WebSocket error during phase "${phase}". ` +
        'This may indicate: unreachable endpoint, TLS failure, or DNS change.'
      ));
    };

    ws.onclose = (evt) => {
      if (!settled) {
        finish(false, new Error(
          `WebSocket closed unexpectedly during phase "${phase}" ` +
          `(code ${evt.code}${evt.reason ? ': ' + evt.reason : ''}).`
        ));
      }
    };
  });
}

// ─── Test ─────────────────────────────────────────────────────────────────────
test(
  'Gemini Live API — connection, authentication, setup, and audio pathway',
  // Give the test runner a hard upper bound that covers all retry attempts.
  { timeout: (SETUP_TIMEOUT_MS + AUDIO_WAIT_MS) * (MAX_RETRIES + 1) + 15_000 },
  async () => {
    // ── Guard: require GEMINI_API_KEY ────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    assert.ok(
      typeof apiKey === 'string' && apiKey.trim().length > 0,
      'Required environment variable GEMINI_API_KEY is not configured.'
    );

    // ── Run with retries ─────────────────────────────────────────────────────
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        const result = await runAttempt(apiKey);

        // ── Core assertion: setup handshake completed ────────────────────────
        assert.strictEqual(
          result.gotSetup, true,
          'setupComplete was not received. ' +
          'Possible causes: invalid API key, model removed, quota exceeded, ' +
          'endpoint change, or setup message format change.'
        );

        // ── Report result (no secrets logged) ───────────────────────────────
        if (result.gotContent) {
          const note = result.transcription
            ? `Server returned a transcription (${result.transcription.length} char(s)).`
            : 'Server content / turnComplete received (no text transcription).';
          console.log(`[Gemini smoke test] PASS — ${note}`);
        } else {
          console.log(
            '[Gemini smoke test] PASS — setupComplete received; audio accepted without error. ' +
            '(No translation output from synthetic tone — expected.)'
          );
        }

        return; // success

      } catch (err) {
        lastError = err;

        // Do not retry authentication failures — retrying will not help and
        // wastes quota / increases delay before the test reports failure.
        if (isAuthError(err.message)) {
          throw new Error(
            'Authentication failure — verify that GEMINI_API_KEY is correct ' +
            'and has access to the Gemini Live API. ' +
            `Detail: ${err.message}`
          );
        }

        if (attempt <= MAX_RETRIES) {
          console.warn(
            `[Gemini smoke test] Attempt ${attempt} failed (${err.message}). ` +
            `Retrying in ${RETRY_DELAY_MS} ms…`
          );
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw new Error(
      `Gemini integration test failed after ${MAX_RETRIES + 1} attempt(s). ` +
      `Last error: ${lastError?.message}`
    );
  }
);
