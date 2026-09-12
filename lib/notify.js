// GhostTrace - Masaustu Bildirimleri

import { initI18n, isI18nReady, t } from './i18n.js';

let counter = 0;

/** Ceviri anahtarlariyla bildirim gosterir. */
export async function notify({ titleKey, messageKey, params = {}, tag = 'gt', iconUrl = 'icons/icon-128.png' }) {
  if (!chrome.notifications?.create) return false;

  try {
    if (!isI18nReady()) await initI18n();
    const id = `${tag}_${Date.now().toString(36)}_${counter++}`;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl,
      title: t(titleKey),
      message: t(messageKey, params)
    });
    return true;
  } catch (err) {
    console.warn('[GhostTrace] Bildirim gosterilemedi:', err);
    return false;
  }
}
