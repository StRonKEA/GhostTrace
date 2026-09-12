// GhostTrace - Depolama ve onbellek temizligi (localStorage, IndexedDB, cache)

import { normalizeDomain } from '../domain.js';
import { logSuccess, logWarn, LogCategory } from '../logger.js';

/** Origin filtresiyle gonderilebilecek veri turlerini ayarlardan uretir. */
export function storageTypesFor(settings) {
  const types = {
    // cache: onbellege alinmis kaynak diskte kalirsa "hic girmemis gibi" saglanmaz.
    cache: true,
    cacheStorage: true,
    // OPFS kalintilarini kapsar.
    fileSystems: true
  };
  if (settings.cleanLocalStorage !== false) types.localStorage = true;
  if (settings.cleanIndexedDB !== false) types.indexedDB = true;
  if (settings.cleanServiceWorkers !== false) types.serviceWorkers = true;
  // webSQL yok: Chrome 152'de API'den kaldirildi, gondermek sahte bir "temizlendi" gostergesi uretir.
  return types;
}

/** Kapsamdaki tum origin'lerin depolamasini siler. discoveredHosts: cerez ve gecmisten kesfedilen gercek alt alan adlari - bu olmadan kok temizliginde mail.example.com'un depolamasi diskte kalir. */
export async function cleanStorageForScope(scope, ctx, discoveredHosts = new Set()) {
  if (!scope) return { count: 0, origins: [] };

  const candidateHosts = new Set([scope.base]);
  for (const host of discoveredHosts) {
    if (host && scope.matches(host)) candidateHosts.add(normalizeDomain(host));
  }

  const allowedHosts = [...candidateHosts].filter(host => host && !ctx.isStorageProtected(host));
  if (allowedHosts.length === 0) return { count: 0, origins: [] };

  const origins = scope.originsFor(allowedHosts);
  if (origins.length === 0) return { count: 0, origins: [] };

  try {
    await chrome.browsingData.remove({
      origins,
      // protectedWeb sart: varsayilan yalnizca unprotectedWeb'dir, yani uygulama olarak kurulmus siteler sessizce atlanir. extension: true ASLA verilmez - kendi verimizi ve diger eklentileri siler.
      originTypes: { unprotectedWeb: true, protectedWeb: true }
    }, storageTypesFor(ctx.settings));
    await logSuccess(LogCategory.STORAGE, `${origins.length} origin icin depolama temizlendi`, { originCount: origins.length }, scope.base);
    return { count: allowedHosts.length, origins };
  } catch (err) {
    await logWarn(LogCategory.STORAGE, `Depolama temizleme uyarisi: ${err.message}`, { error: String(err) }, scope.base);
    return { count: 0, origins };
  }
}
