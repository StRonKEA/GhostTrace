// GhostTrace - Temizlik zamanlamasi

import { createDomainScope, normalizeDomain } from '../domain.js';
import { isRuleProtected, RuleType } from '../rules.js';
import {
  purgeDomain, createPurgeContext, cleanHistoryForDomain, cleanDownloadsForDomain
} from '../purge/index.js';
import { getSettings, clampCleanDelay, incrementStats } from '../storage.js';
import { logInfo, logSuccess, logWarn, LogCategory } from '../logger.js';
import { pruneThirdParty } from '../session-state.js';
import {
  ALARM_PURGE_PREFIX, ALARM_WHITELIST_PREFIX, CONTINUATION_DELAY_MS,
  BULK_CONTINUE_ALARM, purgeAlarmName, whitelistAlarmName
} from './constants.js';
import { hasOpenTabInScope } from './tabs.js';
import { scheduleBadgeRefresh } from './badge.js';

/** Bekleyen bir temizlik alarmini iptal eder. */
export async function cancelScheduledPurge(host) {
  const clean = normalizeDomain(host);
  if (!clean) return;
  await Promise.all([
    chrome.alarms.clear(purgeAlarmName(clean)),
    chrome.alarms.clear(whitelistAlarmName(clean))
  ]);
}

/** Otomatik temizlik kapatildiginda tum bekleyen temizlikleri iptal eder. */
export async function cancelAllScheduledPurges() {
  try {
    const alarms = await chrome.alarms.getAll();
    const targets = alarms.filter(alarm =>
      alarm.name.startsWith(ALARM_PURGE_PREFIX) || alarm.name.startsWith(ALARM_WHITELIST_PREFIX)
    );
    await Promise.all(targets.map(alarm => chrome.alarms.clear(alarm.name)));
    if (targets.length) {
      await logInfo(LogCategory.ALARM, `${targets.length} bekleyen temizlik iptal edildi`);
    }
  } catch (err) {
    await logWarn(LogCategory.ALARM, `Bekleyen temizlikler iptal edilemedi: ${err.message}`);
  }
}

/** Beyaz listedeki bir sitenin gecmis/indirme istisnasini uygular. */
export async function runWhitelistExceptionCleanup(host) {
  const scope = createDomainScope(host);
  if (!scope) return;

  const settings = await getSettings();
  if (!settings.enabled) return;
  if (!settings.whitelistCleanHistory && !settings.whitelistCleanDownloads) return;
  if (await hasOpenTabInScope(scope)) return;

  const ctx = await createPurgeContext({ settings });
  let history = 0;
  let downloads = 0;
  let bytes = 0;
  let remaining = 0;

  if (settings.whitelistCleanHistory) {
    const result = await cleanHistoryForDomain(scope.base, ctx);
    history = result.count;
    bytes += result.bytes;
    remaining = result.remaining || 0;
  }
  if (settings.whitelistCleanDownloads) {
    downloads = (await cleanDownloadsForDomain(scope.base, ctx)).count;
  }

  // Butceye takildiysa kalani yeni bir alarmla surdur.
  if (remaining > 0) {
    await chrome.alarms.create(whitelistAlarmName(scope.base), { when: Date.now() + CONTINUATION_DELAY_MS });
    await logWarn(
      LogCategory.PURGE,
      `Beyaz liste istisnasi yarim kaldi; ${remaining} kayit icin devam alarmi kuruldu`,
      { remaining },
      scope.base
    );
  }

  if (history > 0 || downloads > 0) {
    await incrementStats({ history, downloads, bytes });
    await logSuccess(
      LogCategory.PURGE,
      `Beyaz liste istisnasi | gecmis: ${history}, indirme: ${downloads}`,
      { history, downloads, bytes },
      scope.base
    );
  }
}

/** Alarmi tetiklenmis bir temizligi calistirir (tek gercek temizlik yolu). */
export async function runScheduledPurge(host, { excludeTabId = null } = {}) {
  const scope = createDomainScope(host);
  if (!scope) return null;

  const settings = await getSettings();
  if (!settings.enabled) return null;

  if (await hasOpenTabInScope(scope, excludeTabId)) {
    await logInfo(LogCategory.TAB, 'Sekme hala acik; temizlik iptal', null, scope.base);
    return null;
  }

  const ctx = await createPurgeContext({ settings });
  // TAM koruma. keepMode 'session'/'custom' olan beyaz liste sitesi burada DURMAZ: alarm yolu (cleanDelay >= 30) sekme kapanisinin asil yolu, ve burada durmak "izleyicileri sil" ayarini gecikmeli kurulumlarda sessizce etkisiz birakirdi. purgeDomain her veri turunu kendi korumasiyla degerlendiriyor.
  if (ctx.isFullyProtected(scope.base)) {
    await logInfo(LogCategory.PURGE, 'Kural korumasi devrede; temizlik iptal', null, scope.base);
    return null;
  }

  // Host erisimi kontrolu ARTIK BURADA DEGIL: purgeDomain'in kendisinde, yani motorun tek girisinde.
  const result = await purgeDomain(scope.base, ctx);

  if (result.noHostAccess) {
    scheduleBadgeRefresh();
    return result;
  }

  // Temizlik zaman butcesine takildiysa kalani YENI bir olayda surdur.
  if (result.remaining > 0) {
    await chrome.alarms.create(purgeAlarmName(scope.base), { when: Date.now() + CONTINUATION_DELAY_MS });
    await logInfo(
      LogCategory.ALARM,
      `Temizlik yarim kaldi; ${result.remaining} kayit icin devam alarmi kuruldu`,
      { remaining: result.remaining },
      scope.base
    );
  } else {
    await pruneThirdParty(candidate => scope.matches(candidate));
  }

  scheduleBadgeRefresh();
  return result;
}

/** Sekmesi kapanan / terk edilen alan adi icin temizligi planlar. */
export async function scheduleDomainPurge(hostOrUrl, { excludeTabId = null, reason = 'tab-closed' } = {}) {
  let scope = createDomainScope(hostOrUrl);
  if (!scope) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const ctx = await createPurgeContext({ settings });

  // Kapsami KAYIT EDILEBILIR ALAN ADINA genislet.
  if (!scope.isRoot
    && ctx.matchFor(scope.base).type === RuleType.DEFAULT
    && !isRuleProtected(ctx.matchFor(scope.root))) {
    scope = createDomainScope(scope.root) || scope;
  }

  if (await hasOpenTabInScope(scope, excludeTabId)) return;

  const match = ctx.matchFor(scope.base);

  // 1. Beyaz liste: yalnizca istisna (gecmis/indirme) temizligi olabilir.
  if (match.type === RuleType.WHITE && ctx.isFullyProtected(scope.base)) {
    if (!settings.whitelistCleanHistory && !settings.whitelistCleanDownloads) return;
    const delay = clampCleanDelay(settings.cleanDelay);
    if (delay === 0) {
      await runWhitelistExceptionCleanup(scope.base);
    } else {
      await chrome.alarms.create(whitelistAlarmName(scope.base), { when: Date.now() + delay * 1000 });
      await logInfo(LogCategory.ALARM, `Beyaz liste istisnasi ${delay} sn sonra`, { delay }, scope.base);
    }
    return;
  }

  // 2. Gri liste, aktif gecici izin ve TAM korumali beyaz liste.
  if (ctx.isFullyProtected(scope.base)) {
    await logInfo(LogCategory.PURGE, `Korumali (${match.type}); temizlik planlanmadi`, null, scope.base);
    return;
  }

  // 3. Varsayilan: temizle.
  const delay = clampCleanDelay(settings.cleanDelay);
  if (delay === 0) {
    await runScheduledPurge(scope.base, { excludeTabId });
    return;
  }

  await chrome.alarms.create(purgeAlarmName(scope.base), { when: Date.now() + delay * 1000 });
  await logInfo(LogCategory.ALARM, `Temizlik ${delay} sn sonra planlandi`, { delay, reason }, scope.base);
}

/** Kullanici istegiyle TEK siteyi hemen temizler. */
export async function purgeSiteNow(urlOrHost) {
  const scope = createDomainScope(urlOrHost);
  if (!scope) return { ok: false, reason: 'INVALID_DOMAIN' };

  const ctx = await createPurgeContext();
  const match = ctx.matchFor(scope.base);
  // Yalnizca TAM korumada duruyoruz: keepMode 'session'/'custom' olan bir sitede kullanici zaten "bazi cerezleri sil" demis, "Simdi Temizle" dugmesi de onu uygulamali.
  if (ctx.isFullyProtected(scope.base)) {
    // GUNLUGE YAZILIR.
    await logInfo(LogCategory.PURGE, `Korumali liste (${match.type}); temizlik yapilmadi`,
      { ruleType: match.type, reason: 'manual' }, scope.base);
    return { ok: false, reason: 'PROTECTED', domain: scope.base, match };
  }

  const result = await purgeDomain(scope.base, ctx);

  // Erisim kisitliysa hicbir sey silinmedi. "Temizlendi" demek ve 3. taraf kaydini dusurmek, temizlenmemis veriyi kullanicidan GIZLEMEK olur.
  if (result.noHostAccess) {
    scheduleBadgeRefresh();
    return { ok: false, reason: 'NO_HOST_ACCESS', domain: scope.base };
  }

  await pruneThirdParty(candidate => scope.matches(candidate));
  scheduleBadgeRefresh();
  return { ok: true, domain: scope.base, result };
}

/** Toplu temizlik sonucunu sonuclandirir. */
export async function settleBulkPurge(result) {
  if (result.remaining > 0) {
    await chrome.alarms.create(BULK_CONTINUE_ALARM, { when: Date.now() + CONTINUATION_DELAY_MS });
    await logWarn(
      LogCategory.PURGE,
      `Toplu temizlik yarim kaldi; ${result.remaining} kayit icin devam alarmi kuruldu`,
      { remaining: result.remaining }
    );
    return false;
  }
  // Yalnizca GERCEKTEN temizlenen hostlarin kaydi dusulur: kayit, o alan adinda veri bulundugunun tek sinyali.
  const atlanan = new Set(result.skippedOpenDomains || []);
  const ctx = await createPurgeContext();
  await pruneThirdParty(host => {
    if (isRuleProtected(ctx.matchFor(host))) return false;
    for (const base of atlanan) {
      const scope = createDomainScope(base);
      if (scope && scope.matches(host)) return false;
    }
    return true;
  });
  return true;
}
