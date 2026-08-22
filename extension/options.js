'use strict';

// ─── Complete Gemini Live API language list (97 languages) ────────────────────
const ALL_LANGUAGES = [
  'Afrikaans', 'Akan', 'Albanian', 'Amharic', 'Arabic', 'Armenian', 'Assamese',
  'Azerbaijani', 'Basque', 'Belarusian', 'Bengali', 'Bosnian', 'Bulgarian',
  'Burmese', 'Catalan', 'Cebuano', 'Chinese', 'Croatian', 'Czech', 'Danish',
  'Dutch', 'English', 'Estonian', 'Faroese', 'Filipino', 'Finnish', 'French',
  'Galician', 'Georgian', 'German', 'Greek', 'Gujarati', 'Hausa', 'Hebrew',
  'Hindi', 'Hungarian', 'Icelandic', 'Indonesian', 'Irish', 'Italian',
  'Japanese', 'Kannada', 'Kazakh', 'Khmer', 'Kinyarwanda', 'Korean', 'Kurdish',
  'Kyrgyz', 'Lao', 'Latvian', 'Lithuanian', 'Macedonian', 'Malay', 'Malayalam',
  'Maltese', 'Maori', 'Marathi', 'Mongolian', 'Nepali', 'Norwegian', 'Odia',
  'Oromo', 'Pashto', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Quechua',
  'Romanian', 'Romansh', 'Russian', 'Serbian', 'Sindhi', 'Sinhala', 'Slovak',
  'Slovenian', 'Somali', 'Southern Sotho', 'Spanish', 'Swahili', 'Swedish',
  'Tajik', 'Tamil', 'Telugu', 'Thai', 'Tswana', 'Turkish', 'Turkmen',
  'Ukrainian', 'Urdu', 'Uzbek', 'Vietnamese', 'Welsh', 'Western Frisian',
  'Wolof', 'Yoruba', 'Zulu'
];

// ─── State ────────────────────────────────────────────────────────────────────
let favorites = [];
let apiKeySaveTimer = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const apiKeyInput    = document.getElementById('apiKey');
const eyeBtn         = document.getElementById('eyeBtn');
const langSearch     = document.getElementById('langSearch');
const langList       = document.getElementById('langList');
const favPreviewWrap = document.getElementById('favPreviewWrap');
const favPreview     = document.getElementById('favPreview');
const toast          = document.getElementById('toast');

// ─── Appearance / Theme ───────────────────────────────────────────────────────
function applyTheme(themeSetting) {
  let effective = themeSetting;
  if (!themeSetting || themeSetting === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
}

function updateThemeRadios(theme) {
  const selected = theme || 'system';
  const radio = document.querySelector(`input[name="theme"][value="${selected}"]`);
  if (radio) radio.checked = true;
}

document.querySelectorAll('input[name="theme"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    const theme = radio.value;
    chrome.storage.sync.set({ theme });
    applyTheme(theme);
  });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  chrome.storage.sync.get('theme').then(({ theme }) => {
    if (!theme || theme === 'system') applyTheme('system');
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.theme) {
    const newTheme = changes.theme.newValue || 'system';
    updateThemeRadios(newTheme);
    applyTheme(newTheme);
  }
});

// ─── Build language list ──────────────────────────────────────────────────────
function buildList(filter = '') {
  const q       = filter.trim().toLowerCase();
  const visible = q ? ALL_LANGUAGES.filter(l => l.toLowerCase().includes(q)) : ALL_LANGUAGES;

  langList.innerHTML = '';

  if (visible.length === 0) {
    langList.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:13px">No languages match your search.</div>';
    return;
  }

  for (const lang of visible) {
    const isFavorite = favorites.includes(lang);

    const row = document.createElement('label');
    row.className    = 'lang-item' + (isFavorite ? ' selected' : '');
    row.dataset.lang = lang;

    row.innerHTML = `
      <input class="fav-checkbox" type="checkbox" ${isFavorite ? 'checked' : ''}>
      <span class="lang-name">${lang}</span>
    `;

    row.querySelector('.fav-checkbox').addEventListener('change', () => toggleFavorite(lang));

    langList.appendChild(row);
  }
}

function toggleFavorite(lang) {
  if (favorites.includes(lang)) {
    favorites = favorites.filter(l => l !== lang);
  } else {
    favorites.push(lang);
  }
  buildList(langSearch.value);
  updateFavPreview();
  chrome.storage.sync.set({ favoriteLanguages: favorites });
}

function updateFavPreview() {
  favPreview.innerHTML = '';
  if (favorites.length === 0) { favPreviewWrap.style.display = 'none'; return; }
  favPreviewWrap.style.display = 'block';
  favorites.forEach(lang => {
    const chip = document.createElement('span');
    chip.className   = 'fav-chip';
    const label = document.createElement('span');
    label.textContent = lang;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'fav-chip-remove';
    removeButton.textContent = '×';
    removeButton.title = `Remove ${lang} from favorites`;
    removeButton.setAttribute('aria-label', `Remove ${lang} from favorites`);
    removeButton.addEventListener('click', () => toggleFavorite(lang));
    chip.append(label, removeButton);
    favPreview.appendChild(chip);
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────
langSearch.addEventListener('input', () => buildList(langSearch.value));

// ─── Show / hide API key ──────────────────────────────────────────────────────
eyeBtn.addEventListener('click', () => {
  const hidden       = apiKeyInput.type === 'password';
  apiKeyInput.type   = hidden ? 'text' : 'password';
  eyeBtn.textContent = hidden ? '🙈' : '👁';
});

// ─── Save changes immediately ─────────────────────────────────────────────────
function saveApiKey() {
  clearTimeout(apiKeySaveTimer);
  chrome.storage.sync.set({ apiKey: apiKeyInput.value.trim() });
}

apiKeyInput.addEventListener('input', () => {
  clearTimeout(apiKeySaveTimer);
  apiKeySaveTimer = setTimeout(saveApiKey, 450);
});
apiKeyInput.addEventListener('blur', saveApiKey);

function showToast(msg, type) {
  toast.textContent   = msg;
  toast.className     = 'toast ' + type;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// ─── Load saved settings ──────────────────────────────────────────────────────
(async () => {
  const s = await chrome.storage.sync.get(['apiKey', 'favoriteLanguages', 'theme']);

  const currentTheme = s.theme || 'system';
  updateThemeRadios(currentTheme);
  applyTheme(currentTheme);

  if (s.apiKey) apiKeyInput.value = s.apiKey;

  const hasSavedFavorites = Array.isArray(s.favoriteLanguages);
  favorites   = hasSavedFavorites ? s.favoriteLanguages : ['English'];
  if (!hasSavedFavorites) {
    await chrome.storage.sync.set({ favoriteLanguages: favorites });
  }

  buildList();
  updateFavPreview();
})();
