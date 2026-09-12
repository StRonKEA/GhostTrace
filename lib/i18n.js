// GhostTrace - Coklu Dil Motoru

import dictionaries, { AVAILABLE_LANGUAGES } from '../locales/index.js';
import { getSettings, updateSettings } from './storage.js';

const FALLBACK_CHAIN = ['tr', 'en'];

let activeLanguage = 'tr';
let configuredLanguage = 'auto';
let initialized = false;

/** DOM erisimi mumkun mu? (service worker'da degil) */
function hasDom() {
  return typeof document !== 'undefined' && document !== null;
}

/** Tarayici arayuz dilinden desteklenen bir dil secer. */
export function detectBrowserLanguage() {
  try {
    const raw = (chrome?.i18n?.getUILanguage?.()
      || (typeof navigator !== 'undefined' ? navigator.language : '')
      || 'en').toLowerCase();
    return raw.startsWith('tr') ? 'tr' : 'en';
  } catch {
    return 'en';
  }
}

function resolveActive(code) {
  if (code === 'auto' || !code) return detectBrowserLanguage();
  return dictionaries[code] ? code : detectBrowserLanguage();
}

/** Motoru baslatir. */
export async function initI18n() {
  try {
    const settings = await getSettings();
    configuredLanguage = settings.language || 'auto';
  } catch {
    configuredLanguage = 'auto';
  }
  activeLanguage = resolveActive(configuredLanguage);
  initialized = true;

  if (hasDom()) {
    applyTranslationsToDOM();
    document.documentElement?.setAttribute('lang', activeLanguage);
  }
  return activeLanguage;
}

/** Motor baslatildi mi? */
export function isI18nReady() {
  return initialized;
}

/** Etkin dil kodu ('tr' | 'en'). */
export function getLanguage() {
  return activeLanguage;
}

/** Kullanicinin sectigi tercih ('auto' | 'tr' | 'en'). */
export function getConfiguredLanguage() {
  return configuredLanguage;
}

/** Intl API'leri icin BCP-47 etiketi. */
export function getLocaleTag() {
  return activeLanguage === 'tr' ? 'tr-TR' : 'en-US';
}

/** Dili degistirir, kaydeder ve DOM'u yeniler. */
export async function setLanguage(langCode) {
  configuredLanguage = langCode || 'auto';
  activeLanguage = resolveActive(configuredLanguage);
  await updateSettings({ language: configuredLanguage });

  if (hasDom()) {
    applyTranslationsToDOM();
    document.documentElement?.setAttribute('lang', activeLanguage);
    document.dispatchEvent(new CustomEvent('ghosttrace:languageChanged', {
      detail: { language: activeLanguage }
    }));
  }
  return activeLanguage;
}

function lookup(dictionary, keys) {
  let current = dictionary;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

/** Ceviri getirir. {param} yer tutucularini doldurur. */
export function t(path, params = {}) {
  if (!path) return '';

  const keys = String(path).split('.');
  let template = lookup(dictionaries[activeLanguage], keys);

  if (template === undefined) {
    for (const fallback of FALLBACK_CHAIN) {
      if (fallback === activeLanguage) continue;
      template = lookup(dictionaries[fallback], keys);
      if (template !== undefined) break;
    }
  }

  if (template === undefined) {
    console.warn(`[GhostTrace i18n] Eksik ceviri anahtari: ${path}`);
    return path;
  }

  return template.replace(/\{(\w+)\}/g, (match, name) =>
    (params[name] === undefined || params[name] === null ? match : String(params[name]))
  );
}

/** Bir anahtarin tanimli olup olmadigini soyler (testler ve teshis icin). */
export function hasTranslation(path) {
  const keys = String(path || '').split('.');
  return FALLBACK_CHAIN.some(lang => lookup(dictionaries[lang], keys) !== undefined);
}

// data-i18n-html BILINCLI olarak YOK.
const DOM_BINDINGS = [
  ['data-i18n', (el, value) => { el.textContent = value; }],
  ['data-i18n-title', (el, value) => { el.title = value; }],
  ['data-i18n-placeholder', (el, value) => { el.placeholder = value; }],
  ['data-i18n-aria', (el, value) => { el.setAttribute('aria-label', value); }],
  ['data-i18n-value', (el, value) => { el.value = value; }]
];

/** data-i18n* niteliklerini gunceller. Service worker'da hicbir sey yapmaz. */
export function applyTranslationsToDOM(root = null) {
  if (!hasDom()) return;
  const scope = root || document;
  if (!scope.querySelectorAll) return;

  for (const [attribute, apply] of DOM_BINDINGS) {
    for (const el of scope.querySelectorAll(`[${attribute}]`)) {
      const key = el.getAttribute(attribute);
      if (key) apply(el, t(key));
    }
  }
}

export { AVAILABLE_LANGUAGES };
