// GhostTrace - tema uygulayici (options + popup ortak).

import { THEMES } from '../lib/storage.js';

/** Secimi belgeye uygular. Gecersiz deger sisteme duser. */
export function applyTheme(theme) {
  const kok = document.documentElement;
  if (!THEMES.includes(theme) || theme === 'system') {
    kok.removeAttribute('data-theme');
    return 'system';
  }
  kok.setAttribute('data-theme', theme);
  return theme;
}

/** Ilk yuklemede uygular ve ayar degistikce izler. */
export function watchTheme(getSettings) {
  const uygula = async () => {
    try {
      applyTheme((await getSettings())?.theme);
    } catch {
      // Ayar okunamadi: sistem temasinda birak, sayfayi bosa dusurme.
      applyTheme('system');
    }
  };

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && 'theme' in changes) uygula();
  });

  return uygula();
}
