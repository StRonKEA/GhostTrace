// GhostTrace - Baslangic hazirligi

import { isInternalUrl } from '../domain.js';
import { getSessionScopedHosts, pruneExpiredRules } from '../rules.js';
import { createPurgeContext, purgeDomain, purgeAllNonWhitelisted, readRemovalPolicy } from '../purge/index.js';
import { getSettings, mutateRules, clearStatsHistory } from '../storage.js';
import { logSuccess, logWarn, logError, LogCategory } from '../logger.js';
import { notify } from '../notify.js';
import {
  getTabMap, reconcileTabMap, claimBootstrap, clearThirdParty, setRemovalPolicy
} from '../session-state.js';
import { ensurePeriodicAlarm, ensureMaintenanceAlarm } from './alarms.js';
import { syncContentScriptRegistration } from './observer.js';
import { sweepOrphanDomains } from './sweep.js';
import { settleBulkPurge } from './scheduler.js';
import { scheduleBadgeRefresh } from './badge.js';

/** Depolamayi yalnizca guvenilir baglamlara kapatir. */
export async function hardenStorageAccess() {
  if (typeof chrome.storage?.local?.setAccessLevel !== 'function') return;
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (err) {
    // Idempotent bir islem; ayni deger tekrar yazilirsa veya surum desteklemiyorsa sessizce gecilir.
    await logWarn(LogCategory.SYSTEM, `storage erisim seviyesi ayarlanamadi: ${err.message}`);
  }
}

/** Her SW uyanisinda calisan HAFIF hazirlik. */
export async function lightBootstrap() {
  await hardenStorageAccess();
  await ensureMaintenanceAlarm();
  await ensurePeriodicAlarm();

  // Sekme haritasi bossa (yeni oturum veya session temizlendi) yeniden kur.
  const tabMap = await getTabMap();
  if (Object.keys(tabMap).length === 0) {
    await reconcileTabMap(isInternalUrl);
  }
}

/** Kurumsal politika gecmis silmeyi engelliyor mu? */
export async function checkRemovalPolicy() {
  const policy = await readRemovalPolicy();
  if (!policy) return;
  await setRemovalPolicy(policy);

  if (!policy.history || !policy.downloads) {
    const blocked = [
      !policy.history ? 'gecmis' : null,
      !policy.downloads ? 'indirmeler' : null
    ].filter(Boolean).join(' ve ');
    await logError(
      LogCategory.SYSTEM,
      `Bu profilde ${blocked} silme izni yok; bu turler temizlenemeyecek. Kurumsal politika (AllowDeletingBrowserHistory) engelliyor olabilir.`,
      { policy }
    );
  }
}

/** Tarayici oturumu basina BIR KEZ calisan agir hazirlik. */
export async function sessionBootstrap({ isBrowserStartup = false } = {}) {
  if (!await claimBootstrap()) return;

  // Saklama suresi 'session' ise kalici gecmis tarayici kapanisinda gider.
  // Burasi oturum basina BIR KEZ kosar (claimBootstrap isareti storage.session'da).
  if ((await getSettings()).statsHistoryRetention === 'session') {
    await clearStatsHistory();
  }

  await reconcileTabMap(isInternalUrl);
  await clearThirdParty();
  await syncContentScriptRegistration();
  await checkRemovalPolicy();

  if (isBrowserStartup) {
    await runStartupCleanup();
  }
  await sweepOrphanDomains({ force: true });
}

/** Tarayici acilisinda: gri liste (oturumluk) kurallari ve suresi dolmus gecici izinler silinir, verileri yok edilir.
 * cleanOnStartup aciksa korumasiz tum veriler tam supurulur. */
export async function runStartupCleanup() {
  try {
    const settings = await getSettings();
    const greyHosts = await getSessionScopedHosts();
    const expiredHosts = await pruneExpiredRules();

    // Gri liste kurallari oturum sonunda kalkar.
    if (greyHosts.length > 0) {
      await mutateRules(rules => {
        for (const host of greyHosts) delete rules[host];
        return rules;
      });
    }

    if (settings.cleanOnStartup && settings.enabled) {
      const result = await purgeAllNonWhitelisted({ settings });
      await settleBulkPurge(result);
      scheduleBadgeRefresh();

      if (settings.notifyOnClean && (result.cookies > 0 || result.history > 0)) {
        await notify({
          titleKey: 'serviceWorker.startupCleanTitle',
          messageKey: 'serviceWorker.startupCleanMsg',
          params: { count: result.cookies + result.history },
          tag: 'startup'
        });
      }
      return;
    }

    const hosts = [...new Set([...greyHosts, ...expiredHosts])];
    if (hosts.length === 0) return;

    const ctx = await createPurgeContext();
    let cleaned = 0;
    for (const host of hosts) {
      const result = await purgeDomain(host, ctx);
      if (!result.protected) cleaned++;
    }

    await logSuccess(
      LogCategory.SYSTEM,
      `Oturum basi temizligi: ${cleaned} sitenin kurali ve verisi kaldirildi`,
      { greyHosts: greyHosts.length, expiredHosts: expiredHosts.length }
    );

    if (cleaned > 0 && settings.notifyOnClean) {
      await notify({
        titleKey: 'serviceWorker.startupCleanTitle',
        messageKey: 'serviceWorker.startupCleanMsg',
        params: { count: cleaned },
        tag: 'startup'
      });
    }
  } catch (err) {
    await logError(LogCategory.SYSTEM, `Oturum basi temizligi hatasi: ${err.message}`, { error: String(err) });
  }
}
