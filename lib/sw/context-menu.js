// GhostTrace - Sag tik menusu

import { matchDomainRule, isRuleFullyProtected, RuleType } from '../rules.js';
import { getSettings, getRules } from '../storage.js';
import { initI18n, t } from '../i18n.js';
import { logWarn, LogCategory } from '../logger.js';
import { MENU_ROOT, MENU_PURGE, MENU_WHITELIST } from './constants.js';
import { isManagedTab } from './tabs.js';

/** Menu ogesi olusturur ve BASARISIZLIGI YAKALAR. */
function olustur(props) {
  return new Promise((coz) => {
    // Varlik kontrolu SART: API kaybolmussa geri cagirma hic gelmez ve bu soz sonsuza kadar asili kalir (menu kurulumu da onunla birlikte).
    if (!chrome.contextMenus?.create) {
      coz(new Error('contextMenus API yok'));
      return;
    }
    chrome.contextMenus.create(props, () => {
      const hata = chrome.runtime.lastError;
      coz(hata ? new Error(hata.message) : null);
    });
  }).then((hata) => {
    if (hata) throw hata;
  });
}

/** Sag tik menusunu ayara gore kurar veya kaldirir. */
async function runContextMenuSync() {
  const settings = await getSettings();

  if (!chrome.contextMenus?.removeAll) {
    // Ayar KAPALIYKEN API'nin olmamasi beklenen durum; soylenecek bir sey yok.
    if (settings.contextMenuEnabled) {
      await logWarn(LogCategory.SYSTEM,
        'Sag tik menusu acik ama contextMenus izni yok; menu kurulamadi');
    }
    return;
  }

  try {
    await chrome.contextMenus.removeAll();
    if (!settings.contextMenuEnabled) return;

    await initI18n();
    await olustur({
      id: MENU_ROOT,
      title: t('common.appName'),
      contexts: ['page']
    });
    await olustur({
      id: MENU_PURGE,
      parentId: MENU_ROOT,
      title: t('contextMenu.purgeSite'),
      contexts: ['page']
    });
    await olustur({
      id: MENU_WHITELIST,
      parentId: MENU_ROOT,
      title: t('contextMenu.addWhitelist'),
      contexts: ['page']
    });
  } catch (err) {
    await logWarn(LogCategory.SYSTEM, `Sag tik menusu guncellenemedi: ${err.message}`);
  }
}

// Cagrilar SIRAYA girer (observer.js ile ayni gerekce): ayni ayar yazmasi bu isi iki yoldan tetikliyor ve paralel kostuklarinda biri otekinin kurdugu koku siliyordu -> "Cannot find menu item with id gt:menu:root" uyarisi.
let menuZinciri = Promise.resolve();

export function syncContextMenus() {
  const next = () => runContextMenuSync();
  menuZinciri = menuZinciri.then(next, next);
  return menuZinciri;
}

/** Menu etiketlerini aktif sekmeye gore gunceller. */
export function refreshContextMenuLabels(tab) {
  // Ayni zincir: yeniden kurulum sirasinda update cagirmak "menu ogesi yok" hatasi uretir ve etiket sessizce eski kalirdi.
  const next = () => runLabelRefresh(tab);
  menuZinciri = menuZinciri.then(next, next);
  return menuZinciri;
}

async function runLabelRefresh(tab) {
  if (!chrome.contextMenus?.update) return;
  const settings = await getSettings();
  if (!settings.contextMenuEnabled) return;
  if (!isManagedTab(tab)) return;

  try {
    await initI18n();
    const rules = await getRules();
    const match = matchDomainRule(tab.url, rules);
    const isWhite = match.type === RuleType.WHITE;
    await chrome.contextMenus.update(MENU_WHITELIST, {
      title: t(isWhite ? 'contextMenu.removeWhitelist' : 'contextMenu.addWhitelist')
    });
    await chrome.contextMenus.update(MENU_PURGE, {
      // TAM koruma. keepMode 'session'/'custom' olan bir sitede temizlik ARTIK CALISIYOR (bkz. lib/rules.js isRuleFullyProtected); burada isRuleProtected kalmisti ve menu, isleyen bir eylemi soluk gosteriyordu - popup'taki "Simdi Temizle" ile celisiyordu.
      enabled: !isRuleFullyProtected(match)
    });
  } catch {
    // Menu henuz kurulmamis olabilir; sonraki senkronizasyon duzeltir.
  }
}
