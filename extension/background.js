'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let activeTabId = null;
let isTranslating = false;
let activeIconBitmapsPromise = null;

// First-install defaults. An existing empty list is respected, so users can
// still deliberately remove every favorite later.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('favoriteLanguages').then(({ favoriteLanguages }) => {
    if (!Array.isArray(favoriteLanguages)) {
      return chrome.storage.sync.set({ favoriteLanguages: ['English'] });
    }
  });
  chrome.storage.sync.get('duckVolume').then(({ duckVolume }) => {
    if (!Number.isFinite(duckVolume)) {
      return chrome.storage.sync.set({ duckVolume: 20 });
    }
  });
});

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toolbarPulse') {
    setTranslatingIcon(message.pulse).catch(err =>
      console.warn('[Doublage] Could not update toolbar status icon:', err));
    return false;
  }

  if (message.action === 'setAudioMode') {
    const { mode } = message;
    chrome.storage.sync.set({ audioMode: mode });
    sendToOffscreen({ target: 'offscreen', action: 'updateSettings',
      settings: { audioMode: mode } }).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'previewDuckVolume' || message.action === 'setDuckVolume') {
    const volume = Math.max(1, Math.min(100, Number(message.volume) || 20));
    if (message.action === 'setDuckVolume') {
      chrome.storage.sync.set({ duckVolume: volume });
    }
    sendToOffscreen({ target: 'offscreen', action: 'updateSettings',
      settings: { duckVolume: volume } }).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'updateOutputMode') {
    const { mode } = message;
    chrome.storage.sync.set({ outputMode: mode });
    // Update live settings in offscreen so output behaviour changes immediately
    sendToOffscreen({ target: 'offscreen', action: 'updateSettings',
      settings: { outputMode: mode } }).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  // Commands from popup
  if (message.action === 'startTranslation') {
    handleStartTranslation()
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (message.action === 'stopTranslation') {
    handleStopTranslation()
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getStatus') {
    sendResponse({ isTranslating, activeTabId });
    return false;
  }

  // Notifications from offscreen document
  if (message.target === 'background') {
    if (message.action === 'subtitle') {
      forwardSubtitleToTab(message.text);
    } else if (message.action === 'translationError') {
      handleTranslationError(message.error);
    } else if (message.action === 'geminiReady') {
      // Forward to popup so it can update its status label
      chrome.runtime.sendMessage({ action: 'geminiReady' }).catch(() => {});
    }
  }
});

// ─── Tab lifecycle ────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'loading') {
    handleStopTranslation();
    broadcastStatus(false, 'Tab navigated — translation stopped.');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    handleStopTranslation();
  }
});

// ─── Core handlers ────────────────────────────────────────────────────────────
async function handleStartTranslation() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  const settings = await chrome.storage.sync.get([
    'apiKey', 'targetLanguage', 'audioMode', 'outputMode', 'duckVolume'
  ]);

  if (!settings.apiKey) {
    throw new Error('Gemini API key not configured. Please open Settings.');
  }

  activeTabId = tab.id;

  // Obtain a tab-capture stream ID (valid for ~10 s)
  const streamId = await getTabStreamId(tab.id);

  // Ensure the offscreen document exists
  await ensureOffscreenDocument();

  // Start capture in the offscreen document
  const offscreenResponse = await sendToOffscreen({
    target: 'offscreen',
    action: 'startCapture',
    streamId,
    settings: {
      apiKey:          settings.apiKey,
      targetLanguage:  settings.targetLanguage  || 'English',
      audioMode:       settings.audioMode       || 'duck',
      outputMode:      settings.outputMode      || 'audio',
      duckVolume:      Math.max(1, Math.min(100, Number(settings.duckVolume) || 20))
    }
  });

  if (!offscreenResponse?.success) {
    throw new Error(offscreenResponse?.error || 'Failed to start audio capture.');
  }

  // Inject content script if not already present (used for subtitles).
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  }).catch(() => {}); // already injected — ignore

  // Clear any element-level mute left by an earlier extension version. Audio
  // level is now controlled exclusively by the captured-stream gain node.
  chrome.tabs.sendMessage(tab.id, { action: 'restoreAudio' }).catch(() => {});

  isTranslating = true;

  // Switch toolbar icon to active blue. The offscreen document subsequently
  // drives the green pulse once Gemini has completed its setup handshake.
  setTranslatingIcon(false).catch(() => {});
  chrome.action.setTitle({ title: 'Doublage — Translating… (click to open)' });

  return { success: true };
}

function resetIcon() {
  chrome.action.setIcon({
    path: { '16': 'icons/icon16.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png' }
  });
  chrome.action.setTitle({ title: 'Doublage — Real-time Translation' });
}

async function setTranslatingIcon(pulse) {
  const bitmaps = await getActiveIconBitmaps();
  const imageData = {};

  for (const [size, bitmap] of Object.entries(bitmaps)) {
    const px = Number(size);
    const canvas = new OffscreenCanvas(px, px);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, px, px);

    // A small green status light in the lower-right mirrors the popup dot.
    // Keep the status badge tucked into the corner so it does not obscure
    // the headphone mark, especially in Chrome's 16px toolbar rendering.
    const x = px * 0.80;
    const y = px * 0.80;
    const radius = px * 0.16;
    const color = pulse ? '#34a853' : '#ea4335';
    const glowColor = pulse ? '52, 168, 83' : '234, 67, 53';
    const glow = ctx.createRadialGradient(x, y, radius * 0.5, x, y, radius * 2.25);
    glow.addColorStop(0, `rgba(${glowColor}, 0.52)`);
    glow.addColorStop(1, `rgba(${glowColor}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, radius * 2.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, radius + px * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    imageData[px] = ctx.getImageData(0, 0, px, px);
  }

  await chrome.action.setIcon({ imageData });
}

function getActiveIconBitmaps() {
  if (!activeIconBitmapsPromise) {
    activeIconBitmapsPromise = Promise.all([16, 48, 128].map(async size => {
      const response = await fetch(chrome.runtime.getURL(`icons/icon${size}-active.png`));
      if (!response.ok) throw new Error(`Could not load active icon (${size}px).`);
      return [size, await createImageBitmap(await response.blob())];
    })).then(entries => Object.fromEntries(entries));
  }
  return activeIconBitmapsPromise;
}

async function handleStopTranslation() {
  isTranslating = false;
  resetIcon();

  await sendToOffscreen({ target: 'offscreen', action: 'stopCapture' }).catch(() => {});

  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'hideSubtitle' }).catch(() => {});
  }

  activeTabId = null;
  return { success: true };
}

function handleTranslationError(error) {
  isTranslating = false;
  resetIcon();

  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'hideSubtitle' }).catch(() => {});
    activeTabId = null;
  }

  broadcastStatus(false, error);
}

function forwardSubtitleToTab(text) {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'showSubtitle', text }).catch(() => {});
  }
}

function broadcastStatus(active, error = null) {
  chrome.runtime.sendMessage({ action: 'statusUpdate', isTranslating: active, error })
    .catch(() => {}); // popup may be closed — ignore
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(streamId);
      }
    });
  });
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification:
        'Captures tab audio via getUserMedia and plays back translated audio from Gemini Live API.'
    });
    // Give the document a moment to register its message listener
    await sleep(500);
  }
}

async function sendToOffscreen(message, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (i < retries - 1) {
        await sleep(300);
      } else {
        throw err;
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
