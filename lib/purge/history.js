// GhostTrace - Gecmis temizligi

import { createDomainScope } from '../domain.js';
import { deleteHistoryForScope } from '../history.js';
import { logSuccess, logWarn, logError, LogCategory } from '../logger.js';
import { HISTORY_BUDGET_MS } from './constants.js';
import { createPurgeContext } from './context.js';

/** Kurumsal politikanin gecmis/indirme silmeyi engelleyip engellemedigini okur. */
export async function readRemovalPolicy() {
  if (typeof chrome.browsingData?.settings !== 'function') return null;
  try {
    const result = await chrome.browsingData.settings();
    const permitted = result?.dataRemovalPermitted;
    if (!permitted) return null;
    return {
      // Alan hic yoksa "engelli" varsayilmaz; bilinmeyen serbest sayilir.
      history: permitted.history !== false,
      downloads: permitted.downloads !== false
    };
  } catch {
    return null;
  }
}

/** Kapsama giren gecmis kayitlarini siler. */
export async function cleanHistoryForScope(scope, ctx) {
  if (!scope) return { count: 0, bytes: 0, failed: 0, origins: new Set(), truncated: false };

  try {
    const result = await deleteHistoryForScope(scope, {
      isHostProtected: (url) => ctx.isHistoryProtected(url),
      budgetMs: HISTORY_BUDGET_MS
    });
    if (result.count > 0) {
      await logSuccess(LogCategory.PURGE, `${result.count} gecmis kaydi silindi`, { count: result.count, bytes: result.bytes }, scope.base);
    }
    if (result.failed > 0) {
      // Chrome deleteUrl'i reddetti.
      await logWarn(
        LogCategory.PURGE,
        `${result.failed} gecmis kaydi silinemedi (kurumsal politika gecmis silmeyi engelliyor olabilir)`,
        { failed: result.failed, deleted: result.count },
        scope.base
      );
    }
    if (result.truncated) {
      await logWarn(LogCategory.PURGE, 'Gecmis taramasi sayfa sinirina takildi; kalanlar bir sonraki temizlikte islenecek', null, scope.base);
    }
    if (result.remaining > 0) {
      await logWarn(
        LogCategory.PURGE,
        `Zaman butcesi doldu; ${result.remaining} gecmis kaydi bir sonraki turda silinecek`,
        { remaining: result.remaining },
        scope.base
      );
    }
    return result;
  } catch (err) {
    await logError(LogCategory.PURGE, `Gecmis temizleme hatasi: ${err.message}`, { error: String(err) }, scope.base);
    return { count: 0, bytes: 0, failed: 0, origins: new Set(), truncated: false };
  }
}

/** Tek alan adi icin gecmis temizligi (beyaz liste istisnasi yolu kullanir). */
export async function cleanHistoryForDomain(hostOrUrl, contextOverrides = {}) {
  const scope = createDomainScope(hostOrUrl);
  if (!scope) return { count: 0, bytes: 0, origins: new Set(), truncated: false };
  const ctx = contextOverrides.matchFor ? contextOverrides : await createPurgeContext(contextOverrides);
  return cleanHistoryForScope(scope, ctx);
}
