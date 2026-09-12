// GhostTrace - Sekme yardimcilari

import { isInternalUrl } from '../domain.js';
import { logWarn, LogCategory } from '../logger.js';

/** Bu sekme bizim yonetim alanimizda mi? Gizli pencere HARIC. */
export function isManagedTab(tab) {
  if (!tab) return false;
  if (tab.incognito === true) return false;
  const url = tab.url || tab.pendingUrl;
  if (!url || isInternalUrl(url)) return false;
  return true;
}

/** Kapsama giren ACIK bir sekme var mi? */
export async function hasOpenTabInScope(scope, excludeTabId = null) {
  if (!scope) return false;
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.some(tab => {
      if (excludeTabId !== null && tab.id === excludeTabId) return false;
      // Gizli sekmeler normal profildeki temizligi engellemez.
      if (!isManagedTab(tab)) return false;
      const url = tab.url || tab.pendingUrl;
      return url ? scope.matches(url) : false;
    });
  } catch (err) {
    // Emin olamiyorsak veri silmemek tarafinda kaliriz.
    await logWarn(LogCategory.TAB, `Acik sekme kontrolu basarisiz: ${err.message}`);
    return true;
  }
}

/** Yalnizca http/https ve GIZLI OLMAYAN sekmeler. */
export async function openWebTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    // Gizli sekmelere gozlemci enjekte etmeyiz: gizli gezinti sirasinda gorulen 3. taraflar oturum haritasina yazilir ve sonra NORMAL profilde temizlik tetikler.
    return tabs.filter(tab => tab.incognito !== true);
  } catch {
    return [];
  }
}
