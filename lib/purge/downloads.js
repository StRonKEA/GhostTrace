// GhostTrace - Indirme KAYITLARI temizligi

import { createDomainScope } from '../domain.js';
import { logSuccess, logError, LogCategory } from '../logger.js';
import { createPurgeContext } from './context.js';

/** Kapsama giren indirme kayitlarini siler. */
export async function cleanDownloadsForScope(scope, ctx) {
  if (!scope || !chrome.downloads?.search) return { count: 0 };

  try {
    // `query` ON FILTRESI: Chrome terimleri url / finalUrl / dosya adi icinde arar, yani TUM indirme listesini cekmek yerine aday kumesi daraltilir.
    const items = await chrome.downloads.search({ query: [scope.base] });
    const targets = items.filter(item => {
      if (!item?.url) return false;
      if (!scope.matches(item.url)) return false;
      return !ctx.isDownloadProtected(item.url);
    });

    const results = await Promise.all(
      targets.map(item => chrome.downloads.erase({ id: item.id }).then(() => true, () => false))
    );
    const count = results.filter(Boolean).length;

    if (count > 0) {
      await logSuccess(LogCategory.PURGE, `${count} indirme kaydi silindi`, { count }, scope.base);
    }
    return { count };
  } catch (err) {
    await logError(LogCategory.PURGE, `Indirme kaydi temizleme hatasi: ${err.message}`, { error: String(err) }, scope.base);
    return { count: 0 };
  }
}

/** Tek alan adi icin indirme kaydi temizligi. */
export async function cleanDownloadsForDomain(hostOrUrl, contextOverrides = {}) {
  const scope = createDomainScope(hostOrUrl);
  if (!scope) return { count: 0 };
  const ctx = contextOverrides.matchFor ? contextOverrides : await createPurgeContext(contextOverrides);
  return cleanDownloadsForScope(scope, ctx);
}
