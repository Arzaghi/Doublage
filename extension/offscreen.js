'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let captureAudioContext = null;   // 16 kHz — converts tab audio to PCM16 for Gemini
let outputAudioContext  = null;   // 24 kHz — plays translated audio from Gemini
let originalAudioContext = null;  // native rate — plays the captured tab back
let captureSourceNode   = null;
let captureWorkletNode  = null;
let nullGainNode        = null;
let originalSourceNode  = null;
let originalGainNode    = null;
let capturedStream      = null;
let websocket           = null;
let isCapturing         = false;
let currentSettings     = null;

let audioOutputQueue    = [];     // PCM buffers waiting to be played
let isPlayingAudio      = false;

// Subtitle state: fixed 500-char rolling buffer
let subtitleBuffer     = '';
let subtitleClearTimer = null;
let toolbarPulseTimer  = null;

const SUBTITLE_MAX_CHARS = 500;

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'startCapture') {
    startCapture(message.streamId, message.settings)
      .then(() => sendResponse({ success: true }))
      .catch(err => {
        console.error('[Doublage offscreen] start error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async
  }

  if (message.action === 'updateSettings') {
    if (currentSettings && message.settings) {
      Object.assign(currentSettings, message.settings);
      if (message.settings.audioMode || Number.isFinite(message.settings.duckVolume)) {
        setOriginalAudioMode();
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'stopCapture') {
    stopCapture().then(() => sendResponse({ success: true }));
    return true;
  }
});

// ─── Start capture ────────────────────────────────────────────────────────────
async function startCapture(streamId, settings) {
  if (isCapturing) await stopCapture();
  currentSettings = settings;

  // 1 ── Acquire the tab audio stream
  capturedStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // 2 ── Capture pipeline at 16 kHz (Gemini input requirement)
  captureAudioContext = new AudioContext({ sampleRate: 16000 });
  captureSourceNode   = captureAudioContext.createMediaStreamSource(capturedStream);

  // AudioWorklet replaces the deprecated ScriptProcessorNode. It runs off
  // the main thread and emits short PCM chunks through its message port.
  await captureAudioContext.audioWorklet.addModule('audio-capture-worklet.js');
  captureWorkletNode = new AudioWorkletNode(captureAudioContext, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  captureWorkletNode.port.onmessage = ({ data }) => handleAudioInput(data);
  nullGainNode  = captureAudioContext.createGain();
  nullGainNode.gain.value = 0;

  captureSourceNode.connect(captureWorkletNode);
  captureWorkletNode.connect(nullGainNode);
  nullGainNode.connect(captureAudioContext.destination);

  // 3 ── tabCapture suppresses normal tab playback. Replay the captured audio
  // at the native sample rate through a gain node, so volume control applies to all
  // sites, including players built with the Web Audio API.
  originalAudioContext = new AudioContext();
  originalSourceNode = originalAudioContext.createMediaStreamSource(capturedStream);
  originalGainNode = originalAudioContext.createGain();
  originalSourceNode.connect(originalGainNode);
  originalGainNode.connect(originalAudioContext.destination);
  setOriginalAudioMode(settings.audioMode);

  // 4 ── Output pipeline at 24 kHz (Gemini audio output sample rate)
  outputAudioContext = new AudioContext({ sampleRate: 24000 });

  isCapturing = true;

  // 5 ── Connect to Gemini Live API *asynchronously*.
  //      We return immediately so the popup never hangs waiting for the
  //      WebSocket handshake (which can take several seconds and could
  //      cause the MV3 service worker to be killed mid-await).
  //      Audio streaming starts only once setupComplete is acknowledged.
  connectToGemini(settings)
    .then(() => {
      if (!isCapturing) return;
      startToolbarPulse();
      // Tell the background (and popup) that Gemini is fully live
      chrome.runtime.sendMessage({ target: 'background', action: 'geminiReady' }).catch(() => {});
    })
    .catch(err => {
      if (!isCapturing) return;
      notifyError(err.message);
      stopCapture();
    });
}

// ─── Audio input → Gemini ─────────────────────────────────────────────────────
function handleAudioInput(float32) {
  if (!isCapturing || !websocket || websocket.readyState !== WebSocket.OPEN) return;

  const pcm16   = float32ToPcm16(float32);
  const b64     = arrayBufferToBase64(pcm16.buffer);

  try {
    websocket.send(JSON.stringify({
      realtimeInput: {
        audio: { mimeType: 'audio/pcm;rate=16000', data: b64 }
      }
    }));
  } catch (err) {
    console.error('[Doublage] Send error:', err);
  }
}

function setOriginalAudioMode(mode = currentSettings?.audioMode) {
  if (!originalGainNode || !originalAudioContext) return;

  const rawVolume = Number(currentSettings?.duckVolume);
  const duckVolume = Number.isFinite(rawVolume) ? Math.max(0, Math.min(100, rawVolume)) : 20;
  const gain = mode === 'mute' ? 0 : duckVolume / 100;
  originalGainNode.gain.setTargetAtTime(gain, originalAudioContext.currentTime, 0.02);
}

function startToolbarPulse() {
  stopToolbarPulse();
  let pulse = true;
  chrome.runtime.sendMessage({ action: 'toolbarPulse', pulse }).catch(() => {});
  toolbarPulseTimer = setInterval(() => {
    pulse = !pulse;
    chrome.runtime.sendMessage({ action: 'toolbarPulse', pulse }).catch(() => {});
  }, 900);
}

function stopToolbarPulse() {
  clearInterval(toolbarPulseTimer);
  toolbarPulseTimer = null;
}

// ─── Subtitle Cue Processor (Movie-Style 1-2 Lines Windowing) ─────────────────
function processSubtitleChunk(newText) {
  const now = Date.now();
  // If there has been a pause between utterances (> 2.8 s), start a fresh subtitle cue
  if (now - lastSubtitleTime > 2800) {
    currentSubtitleChunk = '';
  }
  lastSubtitleTime = now;

  currentSubtitleChunk += newText;
  const trimmed = currentSubtitleChunk.trim();
  if (!trimmed) return;

  // Split into sentence-like clauses based on punctuation and newlines
  const sentenceRegex = /[^.!?。！？\n]+[.!?。！？\n]*/g;
  const matches = trimmed.match(sentenceRegex) || [trimmed];

  let displayCue = '';
  if (matches.length > 1) {
    const last = matches[matches.length - 1].trim();
    const prev = matches[matches.length - 2].trim();

    // If the combined previous and current sentence is short, show both (max 2 lines)
    if (last.length < 32 && (prev + ' ' + last).length <= 80) {
      displayCue = prev + ' ' + last;
    } else {
      displayCue = last;
      // Truncate the buffer to only keep the active sentence
      currentSubtitleChunk = last;
    }
  } else {
    displayCue = matches[0].trim();
    // If a sentence without punctuation grows too long (> 90 chars), keep the last clause at a word boundary
    if (displayCue.length > 90) {
      const words = displayCue.split(/\s+/);
      let shortCue = '';
      for (let i = words.length - 1; i >= 0; i--) {
        const candidate = words.slice(i).join(' ');
        if (candidate.length <= 75) {
          shortCue = candidate;
        } else {
          break;
        }
      }
      displayCue = shortCue || displayCue.slice(-75);
      currentSubtitleChunk = displayCue;
    }
  }

  notifySubtitle(displayCue);

  clearTimeout(subtitleClearTimer);
  subtitleClearTimer = setTimeout(() => {
    currentSubtitleChunk = '';
    notifySubtitle('');
  }, 2800);
}

// ─── Gemini Live WebSocket ────────────────────────────────────────────────────
function connectToGemini(settings) {
  return new Promise((resolve, reject) => {
    const key   = encodeURIComponent(settings.apiKey);
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

    websocket = new WebSocket(wsUrl);
    let phase = 'opening WebSocket';
    let settled = false;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(setupTimer);
      reject(new Error(`Gemini ${phase}: ${message}`));
    };

    const setupTimer = setTimeout(() => {
      // Do not leave a stale session open after a failed handshake.
      websocket?.close(1000, 'Setup timed out');
      fail('timed out waiting for setupComplete. Open the offscreen document console and look for the logged setup response.');
    }, 45000);

    websocket.onopen = () => {
      phase = 'waiting for setup response';
      console.log('[Doublage] Gemini WebSocket opened; sending setup.');
      const setupMsg = {
        setup: {
          model: 'models/gemini-3.5-live-translate-preview',
          // Live API setup fields. The server rejects these when nested in
          // generationConfig (even though some older examples show that form).
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: languageCode(settings.targetLanguage),
              echoTargetLanguage: false
            }
          }
        }
      };

      websocket.send(JSON.stringify(setupMsg));
    };

    websocket.onmessage = async (event) => {
      let data;
      try {
        // Text is normal, but accepting Blob/ArrayBuffer responses makes the
        // handler reliable if Chrome changes the WebSocket frame type.
        const payload = event.data instanceof Blob
          ? await event.data.text()
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : event.data;
        data = JSON.parse(payload);
      } catch (err) {
        console.warn('[Doublage] Ignored non-JSON Gemini WebSocket message:', err);
        return;
      }

      console.debug('[Doublage] Gemini server message:', data);

      // ── Setup acknowledged
      if (Object.hasOwn(data, 'setupComplete')) {
        clearTimeout(setupTimer);
        settled = true;
        resolve();
        return;
      }

      // ── API-level error (e.g. bad key, quota exceeded)
      if (data.error) {
        const msg = data.error.message || 'Gemini API error';
        fail(msg);
        notifyError(msg);
        return;
      }

      if (data.goAway) {
        fail(data.goAway.timeLeft
          ? `server is ending the session in ${data.goAway.timeLeft}.`
          : 'server ended the session before setup completed.');
        return;
      }

      // ── Translated content parts
      const mode = currentSettings?.outputMode || 'both';
      if (data.serverContent?.modelTurn?.parts) {
        for (const part of data.serverContent.modelTurn.parts) {
          if (part.inlineData?.mimeType?.includes('audio/pcm') &&
              (mode === 'audio' || mode === 'both')) {
            enqueueAudio(base64ToArrayBuffer(part.inlineData.data));
          }
        }
      }

      const translatedText = data.serverContent?.outputTranscription?.text;
      if (translatedText && (mode === 'text' || mode === 'both')) {
        // Append text; if buffer exceeds cap, clear and start fresh
        if (subtitleBuffer.length + translatedText.length > SUBTITLE_MAX_CHARS) {
          subtitleBuffer = '';
        }
        subtitleBuffer += translatedText;
        notifySubtitle(subtitleBuffer);
      }

      // ── Turn complete — schedule subtitle clear after a pause
      if (data.serverContent?.turnComplete) {
        clearTimeout(subtitleClearTimer);
        subtitleClearTimer = setTimeout(() => {
          subtitleBuffer = '';
          notifySubtitle('');
        }, 4000);
      }
    };

    websocket.onerror = () => {
      const msg = 'WebSocket error. Check the API key, model access, and network connection.';
      fail(msg);
      if (isCapturing) notifyError(msg);
    };

    websocket.onclose = (evt) => {
      if (!settled) {
        fail(`socket closed before setup completed (code ${evt.code}${evt.reason ? `, ${evt.reason}` : ''})`);
      }
      if (isCapturing && !evt.wasClean) {
        notifyError(`Connection closed unexpectedly (code ${evt.code}).`);
      }
    };
  });
}

// ─── Translated audio playback queue ─────────────────────────────────────────
function enqueueAudio(pcmBuffer) {
  audioOutputQueue.push(pcmBuffer);
  if (!isPlayingAudio) playNextChunk();
}

function playNextChunk() {
  if (!outputAudioContext || audioOutputQueue.length === 0) {
    isPlayingAudio = false;
    return;
  }
  isPlayingAudio = true;

  const pcmBuffer = audioOutputQueue.shift();
  try {
    const pcm16   = new Int16Array(pcmBuffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    const audioBuf = outputAudioContext.createBuffer(1, float32.length, 24000);
    audioBuf.copyToChannel(float32, 0);

    const src    = outputAudioContext.createBufferSource();
    src.buffer   = audioBuf;
    src.onended  = playNextChunk;
    src.connect(outputAudioContext.destination);
    src.start();
  } catch (err) {
    console.error('[Doublage] Playback error:', err);
    playNextChunk(); // skip damaged chunk
  }
}

// ─── Stop capture ─────────────────────────────────────────────────────────────
async function stopCapture() {
  isCapturing = false;
  stopToolbarPulse();

  if (websocket) {
    websocket.onclose = null; // suppress error notification on intentional close
    websocket.close();
    websocket = null;
  }

  if (captureWorkletNode) {
    captureWorkletNode.port.onmessage = null;
    captureWorkletNode.disconnect();
    captureWorkletNode = null;
  }

  nullGainNode?.disconnect();
  nullGainNode = null;

  captureSourceNode?.disconnect();
  captureSourceNode = null;

  originalSourceNode?.disconnect();
  originalSourceNode = null;
  originalGainNode?.disconnect();
  originalGainNode = null;

  capturedStream?.getTracks().forEach(t => t.stop());
  capturedStream = null;

  await captureAudioContext?.close().catch(() => {});
  captureAudioContext = null;

  await originalAudioContext?.close().catch(() => {});
  originalAudioContext = null;

  await outputAudioContext?.close().catch(() => {});
  outputAudioContext = null;

  audioOutputQueue   = [];
  isPlayingAudio     = false;
  subtitleBuffer     = '';
  clearTimeout(subtitleClearTimer);
  notifySubtitle('');
  currentSettings    = null;
}

// ─── Background notifications ─────────────────────────────────────────────────
function notifySubtitle(text) {
  const lang = currentSettings?.targetLanguage || '';
  chrome.runtime.sendMessage({ target: 'background', action: 'subtitle', text, lang }).catch(() => {});
}

function notifyError(error) {
  chrome.runtime.sendMessage({ target: 'background', action: 'translationError', error }).catch(() => {});
}

// ─── PCM / Base64 utilities ───────────────────────────────────────────────────
function float32ToPcm16(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i]  = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToArrayBuffer(b64) {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function languageCode(language) {
  const codes = {
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
    Uzbek: 'uz', Vietnamese: 'vi', Welsh: 'cy', Wolof: 'wo', Yoruba: 'yo', Zulu: 'zu'
  };
  return codes[language] || language || 'en';
}
