'use strict';

const statusDot    = document.getElementById('statusDot');
const statusLabel  = document.getElementById('statusLabel');
const langPill     = document.getElementById('langPill');
const errorBanner  = document.getElementById('errorBanner');
const errorText    = document.getElementById('errorText');
const errorDismiss = document.getElementById('errorDismiss');
const favPills     = document.getElementById('favPills');
const mainBtn      = document.getElementById('mainBtn');
const btnIcon      = document.getElementById('btnIcon');
const btnText      = document.getElementById('btnText');
const settingsBtn  = document.getElementById('settingsBtn');

// Control buttons
const ctrlMute  = document.getElementById('ctrlMute');
const ctrlDuck  = document.getElementById('ctrlDuck');
const ctrlAudio = document.getElementById('ctrlAudio');
const ctrlText  = document.getElementById('ctrlText');
const ctrlBoth  = document.getElementById('ctrlBoth');

let translating      = false;
let currentLang      = 'English';
let favList          = [];
let currentAudioMode = 'duck';
let currentOutputMode = 'audio';

// ─── Initialise ───────────────────────────────────────────────────────────────
async function init() {
  const s = await chrome.storage.sync.get([
    'targetLanguage', 'audioMode', 'outputMode', 'apiKey', 'favoriteLanguages'
  ]);

  const hasSavedFavorites = Array.isArray(s.favoriteLanguages);
  favList           = hasSavedFavorites ? s.favoriteLanguages : ['English'];
  // A saved popup choice wins. Otherwise the first selected favorite is the
  // default, which makes the list order meaningful to the user.
  currentLang       = favList.includes(s.targetLanguage)
    ? s.targetLanguage
    : (favList[0] || 'English');
  currentAudioMode  = s.audioMode       || 'duck';
  currentOutputMode = s.outputMode      || 'audio';

  if (currentLang !== s.targetLanguage || !hasSavedFavorites) {
    await chrome.storage.sync.set({
      targetLanguage: currentLang,
      ...(hasSavedFavorites ? {} : { favoriteLanguages: favList })
    });
  }

  updateLangPill(currentLang);
  renderFavorites();
  renderControls();

  if (!s.apiKey) showError('API key not configured — open Settings first.');

  const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
  if (status?.isTranslating) setActive(true);
}

// ─── Favorites quick-pick ─────────────────────────────────────────────────────
function renderFavorites() {
  favPills.innerHTML = '';

  if (favList.length === 0) {
    favPills.innerHTML = '<span class="fav-empty">No favorites yet — add them in ⚙ Settings.</span>';
    return;
  }

  favList.forEach(lang => {
    const btn = document.createElement('button');
    btn.className   = 'fav-pill' + (lang === currentLang ? ' active' : '');
    btn.textContent = lang;
    btn.title       = lang;
    btn.addEventListener('click', () => selectFavorite(lang));
    favPills.appendChild(btn);
  });
}

async function selectFavorite(lang) {
  if (lang === currentLang) return;

  currentLang = lang;
  await chrome.storage.sync.set({ targetLanguage: lang });
  updateLangPill(lang);
  renderFavorites();

  // If actively translating, restart with the new language
  if (translating) {
    mainBtn.disabled    = true;
    statusLabel.textContent = 'Switching language…';

    await chrome.runtime.sendMessage({ action: 'stopTranslation' });
    await sleep(200);
    const res = await chrome.runtime.sendMessage({ action: 'startTranslation' });

    if (res?.success) {
      setActive(true);
    } else {
      setActive(false);
      showError(res?.error || 'Failed to restart with new language.');
    }
    mainBtn.disabled = false;
  }
}

// ─── Mode controls ────────────────────────────────────────────────────────────
function renderControls() {
  // Audio mode
  ctrlMute.classList.toggle('active', currentAudioMode === 'mute');
  ctrlDuck.classList.toggle('active', currentAudioMode === 'duck');
  // Output mode
  ctrlAudio.classList.toggle('active', currentOutputMode === 'audio');
  ctrlText.classList.toggle('active',  currentOutputMode === 'text');
  ctrlBoth.classList.toggle('active',  currentOutputMode === 'both');
}

async function setAudioMode(mode) {
  if (mode === currentAudioMode) return;
  currentAudioMode = mode;
  renderControls();
  // Save and propagate to tab immediately
  await chrome.runtime.sendMessage({ action: 'setAudioMode', mode });
}

async function setOutputMode(mode) {
  if (mode === currentOutputMode) return;
  currentOutputMode = mode;
  renderControls();
  await chrome.runtime.sendMessage({ action: 'updateOutputMode', mode });
}

ctrlMute.addEventListener('click',  () => setAudioMode('mute'));
ctrlDuck.addEventListener('click',  () => setAudioMode('duck'));
ctrlAudio.addEventListener('click', () => setOutputMode('audio'));
ctrlText.addEventListener('click',  () => setOutputMode('text'));
ctrlBoth.addEventListener('click',  () => setOutputMode('both'));

// ─── Main button ──────────────────────────────────────────────────────────────
let startTimeoutId = null;

mainBtn.addEventListener('click', async () => {
  hideError();
  mainBtn.disabled = true;

  if (!translating) {
    statusLabel.textContent = 'Starting…';

    // Safety-net: if the background never replies within 12 s (e.g. the MV3
    // service worker was killed mid-await), reset to a usable state.
    startTimeoutId = setTimeout(() => {
      startTimeoutId = null;
      if (!translating) {
        setActive(false);
        showError('Connection timed out. Check your network and API key, then try again.');
        mainBtn.disabled = false;
      }
    }, 12000);

    const res = await chrome.runtime.sendMessage({ action: 'startTranslation' });
    clearTimeout(startTimeoutId);
    startTimeoutId = null;

    if (res?.success) {
      // Tab audio acquired — show intermediate state while Gemini handshakes
      translating             = true;
      statusDot.className     = 'dot active';
      statusLabel.textContent = 'Connecting to Gemini…';
      mainBtn.className       = 'btn-main stop';
      btnIcon.textContent     = '■';
      btnText.textContent     = 'Stop Translation';
    } else {
      setActive(false);
      showError(res?.error || 'Failed to start translation.');
    }
  } else {
    clearTimeout(startTimeoutId);
    await chrome.runtime.sendMessage({ action: 'stopTranslation' });
    setActive(false);
  }

  mainBtn.disabled = false;
});

// ─── Error dismiss ────────────────────────────────────────────────────────────
errorDismiss.addEventListener('click', async () => {
  // Force-stop if somehow still active
  if (translating) {
    await chrome.runtime.sendMessage({ action: 'stopTranslation' });
    setActive(false);
  }
  hideError();
});

settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ─── Status updates from background ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'statusUpdate') {
    clearTimeout(startTimeoutId);
    setActive(message.isTranslating);
    if (message.error) showError(message.error);
  } else if (message.action === 'geminiReady' && translating) {
    // Gemini WebSocket handshake complete — translation is fully live
    statusLabel.textContent = 'Translating…';
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setActive(active) {
  translating = active;

  statusDot.className     = 'dot' + (active ? ' active' : '');
  statusLabel.textContent = active ? 'Translating…' : 'Inactive';

  mainBtn.className   = 'btn-main ' + (active ? 'stop' : 'start');
  btnIcon.textContent = active ? '■' : '▶';
  btnText.textContent = active ? 'Stop Translation' : 'Start Translation';
}

function updateLangPill(lang) {
  langPill.textContent = lang.slice(0, 3).toUpperCase();
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.add('visible');
}

function hideError() {
  errorBanner.classList.remove('visible');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

init();

