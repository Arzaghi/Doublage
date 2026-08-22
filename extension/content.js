'use strict';

// RTL languages list for text direction detection
const RTL_LANGUAGES = new Set([
  'Arabic', 'Hebrew', 'Persian', 'Urdu', 'Pashto', 'Sindhi', 'Kurdish',
  'Uyghur', 'Divehi', 'Syriac', 'Thaana'
]);

// Guard against double-injection (content_scripts may run on every navigation)
if (!window.__doublageInjected) {
  window.__doublageInjected = true;

  // ─── Subtitle overlay ──────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__doublage-subtitle';
  Object.assign(overlay.style, {
    position:        'fixed',
    bottom:          '72px',
    left:            '50%',
    transform:       'translateX(-50%)',
    zIndex:          '2147483647',
    width:           '640px',
    maxWidth:        '90vw',
    minHeight:       '80px',
    background:      'rgba(0, 0, 0, 0.84)',
    color:           '#ffffff',
    fontSize:        '16px',
    fontFamily:      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    lineHeight:      '1.55',
    padding:         '10px 18px',
    borderRadius:    '10px',
    textAlign:       'left',
    direction:       'ltr',
    pointerEvents:   'none',
    display:         'none',
    wordWrap:        'break-word',
    overflowWrap:    'break-word',
    whiteSpace:      'pre-wrap',
    border:          '1px solid rgba(66, 133, 244, 0.45)',
    boxShadow:       '0 4px 24px rgba(0,0,0,0.55)',
    opacity:         '0',
    transition:      'opacity 0.25s ease',
    backdropFilter:  'blur(4px)',
    webkitBackdropFilter: 'blur(4px)',
    boxSizing:       'border-box',
  });
  document.documentElement.appendChild(overlay);

  let hideTimer = null;

  function showSubtitle(text, lang) {
    if (!text) { fadeOut(); return; }

    // Set text direction based on language
    const isRtl = RTL_LANGUAGES.has(lang);
    overlay.style.direction = isRtl ? 'rtl' : 'ltr';
    overlay.style.textAlign = isRtl ? 'right' : 'left';

    overlay.textContent = text;
    overlay.style.display = 'block';
    // Force reflow so transition fires
    void overlay.offsetWidth;
    overlay.style.opacity = '1';

    clearTimeout(hideTimer);
    hideTimer = setTimeout(fadeOut, 5000);
  }

  function fadeOut() {
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 260);
  }

  // ─── Audio control ─────────────────────────────────────────────────────────
  let currentMode = null;

  // Watch for dynamically added media elements and apply the current mode
  const mutationObserver = new MutationObserver(() => {
    if (currentMode) applyModeToAll(currentMode);
  });

  function applyModeToAll(mode) {
    document.querySelectorAll('audio, video').forEach(el => {
      if (mode === 'mute') {
        if (!el.dataset.doublageOrigMuted) {
          el.dataset.doublageOrigMuted  = el.muted ? '1' : '0';
          el.dataset.doublageOrigVolume = String(el.volume);
        }
        el.muted = true;
      } else if (mode === 'duck') {
        if (!el.dataset.doublageOrigVolume) {
          el.dataset.doublageOrigMuted  = el.muted ? '1' : '0';
          el.dataset.doublageOrigVolume = String(el.volume);
        }
        el.volume = 0.20;
      }
    });
  }

  function restoreAll() {
    mutationObserver.disconnect();
    currentMode = null;
    document.querySelectorAll('audio, video').forEach(el => {
      el.muted  = el.dataset.doublageOrigMuted === '1';
      el.volume = parseFloat(el.dataset.doublageOrigVolume ?? '1') || 1;
      delete el.dataset.doublageOrigMuted;
      delete el.dataset.doublageOrigVolume;
    });
  }

  // ─── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.action) {
      case 'showSubtitle':
        showSubtitle(message.text, message.lang || '');
        break;

      case 'hideSubtitle':
        fadeOut();
        clearTimeout(hideTimer);
        break;

      case 'setAudioMode':
        currentMode = message.mode;
        applyModeToAll(message.mode);
        mutationObserver.observe(document.body, { childList: true, subtree: true });
        break;

      case 'restoreAudio':
        restoreAll();
        break;
    }
  });
}
