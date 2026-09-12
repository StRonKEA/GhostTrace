// GhostTrace - Mesaj isleyicileri

import {
  createDomainScope, extractHostname, getRootDomain, isInternalUrl, normalizeDomain
} from '../domain.js';
import {
  deleteDomainRule, matchDomainRule, normalizeRule, RuleType, setDomainRule, SNOOZE_ALARM_PREFIX
} from '../rules.js';
import {
  cleanHistoryForDomain, createPurgeContext, purgeAllNonWhitelisted, purgeDomains
} from '../purge/index.js';
import {
  clampCleanDelay, clearStatsHistory, DEFAULT_SETTINGS, getRules, getSettings, getStats,
  getStatsHistory, incrementStats, resetOnlyRules, saveRules, updateSettings
} from '../storage.js';
import { initI18n, t } from '../i18n.js';
import {
  clearCleanupSummaries, clearLogs, formatLogsAsJSON, formatLogsAsText, getLogs, LogCategory, logInfo, logSuccess, logWarn} from '../logger.js';
import { Action } from '../messaging.js';
import {
  clearThirdPartySeen, clearVisitedRoots, countThirdPartyUnder, getRemovalPolicy, getStorageEstimates, getTabMap, getThirdPartyMap, getThirdPartySeen, getVisitedRoots, pruneThirdParty, recordStorageEstimate, recordThirdParty, resetSweepThrottle
} from '../session-state.js';
import { applyHardening, hasHostAccess, readHardeningState } from '../privacy.js';
import {
  ALARM_PERIODIC_SWEEP, CONTINUATION_DELAY_MS, purgeAlarmName
} from './constants.js';
import { getTraceMetrics, scheduleBadgeRefresh } from './badge.js';
import {
  cancelAllScheduledPurges, cancelScheduledPurge, purgeSiteNow, scheduleDomainPurge, settleBulkPurge
} from './scheduler.js';
import { collectStoredDomains, describeDomainCookies } from './site-data.js';
import { syncContextMenus } from './context-menu.js';
import { notify } from '../notify.js';
import { ensurePeriodicAlarm } from './alarms.js';
import { syncContentScriptRegistration } from './observer.js';
import { sweepOrphanDomains } from './sweep.js';

export const handlers = {
  async [Action.GET_ACTIVE_TAB_INFO]() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // enabled ve cleanDelay SEKMEYE degil GENEL ayarlara ait; erken donuslerde de gonderilmeli.
    const genel = async () => {
      const settings = await getSettings();
      return {
        enabled: settings.enabled !== false,
        cleanDelay: clampCleanDelay(settings.cleanDelay)
      };
    };

    if (tab?.incognito === true) {
      // Gizli pencerede normal profilin verisini gostermek ve uzerinde islem yaptirmak yanlis olur.
      return { success: true, isIncognito: true, url: '', ...await genel() };
    }
    if (!tab?.url || isInternalUrl(tab.url)) {
      return { success: true, isInternal: true, url: tab?.url || '', ...await genel() };
    }

    const host = extractHostname(tab.url);
    const clean = normalizeDomain(host);
    const root = getRootDomain(clean);

    // 3. taraf sayimi KOK kapsamiyla yapilir. Gozlemci ebeveyni tam hostname
    // olarak bildiriyor (`www.site.com`), sayfa ise `site.com`'da da olabilir;
    // kok kapsami ikisini de yakalar. Sekme url'siyle kapsam kurmak alt alan
    // adinda `base`i `www.site.com` yapar ve `site.com` ebeveyni kacardi.
    const parentScope = createDomainScope(root || clean);

    const [status, metrics, settings, hostAccess, thirdPartyCount] = await Promise.all([
      getRules().then(rules => matchDomainRule(tab.url, rules)),
      getTraceMetrics(tab.url),
      getSettings(),
      hasHostAccess(tab.url),
      parentScope ? countThirdPartyUnder(parentScope.matches) : 0
    ]);

    return {
      success: true,
      isInternal: false,
      domain: clean,
      rawHost: host,
      url: tab.url,
      title: tab.title || '',
      isSubdomain: Boolean(clean && root && clean !== root),
      rootDomain: root,
      ruleType: status.type,
      rule: status.rule,
      matchedDomain: status.matchedDomain,
      cookieCount: metrics.cookieCount,
      historyCount: metrics.historyCount,
      downloadCount: metrics.downloadCount,
      // totalTraces'e KATILMAZ: o deger rozeti besliyor ve rozet "ayrilinca
      // silinecek iz" demek. 3. taraf verisi site temizliginde silinmiyor
      // (periyodik supurme aliyor), dolayisiyla oraya sayilmasi yanlis vaat olurdu.
      thirdPartyCount,
      totalTraces: metrics.total,
      enabled: settings.enabled !== false,
      cleanDelay: clampCleanDelay(settings.cleanDelay),
      hasHostAccess: hostAccess
    };
  },

  async [Action.GET_DOMAIN_COOKIES](message) {
    return describeDomainCookies(message.domain);
  },

  async [Action.GET_ALL_STORED_DOMAINS]() {
    const { domains, truncated } = await collectStoredDomains();
    // `domains` SU ANDA veri barindiranlari anlatir.
    const [thirdPartySeen, visitedRoots, statsHistory] = await Promise.all([
      getThirdPartySeen(), getVisitedRoots(), getStatsHistory()
    ]);
    return { success: true, domains, truncated, thirdPartySeen, visitedRoots, statsHistory };
  },

  async [Action.CLEAR_STATS_HISTORY](message) {
    const kind = message?.kind === 'thirdParty' || message?.kind === 'sites' ? message.kind : null;
    await clearStatsHistory(kind);
    return { success: true };
  },

  /**
   * Istatistik sekmesindeki IKI LISTEYI besleyen her seyi siler.
   *
   * Neden ayri bir eylem: "Istatistikleri sifirla" YALNIZCA sayaclari
   * (`stats`) sifirliyor ve listeler ondan beslenmiyor - liste, temizlik
   * OZETI gunluklerinden ve karsilasma haritalarindan turetiliyor
   * (bkz. options/tabs/insights.js). Kullanici bunu bildirdi: sayaclar
   * sifirlaniyor, "En cok temizlenen siteler" duruyordu.
   *
   * Gunluklerin TAMAMI silinmez: yalnizca temizlik ozetleri. Gunlukler ayni
   * zamanda tek teshis aracimiz ("butceye takildi -> devam alarmi" zinciri
   * orada goruluyor) ve listeleri temizlemek onu goturmemeli.
   */
  async [Action.CLEAR_INSIGHT_LISTS]() {
    await Promise.all([
      clearCleanupSummaries(),   // oturum: temizlik ozeti gunlukleri
      clearStatsHistory(),       // disk: kalici 3. taraf + site listeleri
      clearThirdPartySeen(),     // oturum: karsilasma sayimi
      clearVisitedRoots()        // oturum: ziyaret edilen kokler
    ]);
    await logInfo(LogCategory.SYSTEM, 'Istatistik listeleri temizlendi');
    return { success: true };
  },

  async [Action.GET_DIAGNOSTICS]() {
    const [settings, stats, alarms, hardening, thirdParty, tabMap, removalPolicy] = await Promise.all([
      getSettings(), getStats(), chrome.alarms.getAll(), readHardeningState(),
      getThirdPartyMap(), getTabMap(), getRemovalPolicy()
    ]);

    // Oturum bellegi kotasi sinirlidir; sekme haritasi + 3. taraf haritasi + teshis loglari hep orada.
    let sessionBytes = null;
    try {
      if (typeof chrome.storage.session?.getBytesInUse === 'function') {
        sessionBytes = await chrome.storage.session.getBytesInUse(null);
      }
    } catch {
      sessionBytes = null;
    }

    // Kota SABIT GOMULMEZ.
    const rawQuota = chrome.storage.session?.QUOTA_BYTES;
    const sessionQuota = Number.isFinite(rawQuota) && rawQuota > 0 ? rawQuota : null;

    return {
      success: true,
      version: chrome.runtime.getManifest().version,
      settings: { ...settings, rules: undefined, stats: undefined },
      ruleCount: Object.keys(settings.rules).length,
      stats,
      alarms: alarms.map(a => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes })),
      hardening,
      thirdPartyCount: Object.keys(thirdParty).length,
      trackedTabs: Object.keys(tabMap).length,
      storageEstimateCount: Object.keys(await getStorageEstimates()).length,
      sessionBytes,
      sessionQuota,
      // null = okunamadi/API yok. false = politika engelliyor.
      historyRemovalPermitted: removalPolicy ? removalPolicy.history : null,
      downloadsRemovalPermitted: removalPolicy ? removalPolicy.downloads : null
    };
  },

  async [Action.SET_RULE](message) {
    const { domain, type, options = {} } = message;
    const rule = await setDomainRule(domain, type, options);
    if (!rule) return { success: false, error: 'INVALID_DOMAIN' };

    await cancelScheduledPurge(rule.domain);
    scheduleBadgeRefresh();
    await logInfo(LogCategory.RULE, `Kural kaydedildi: ${rule.type}`, { rule }, rule.domain);
    return { success: true, rule };
  },

  async [Action.DELETE_RULE](message) {
    const deleted = await deleteDomainRule(message.domain);
    scheduleBadgeRefresh();
    if (deleted) {
      await logInfo(LogCategory.RULE, 'Kural silindi', null, normalizeDomain(message.domain));
      // Kural kalkti: site artik korumali degil, temizligi planla.
      if (message.purgeAfter !== false) {
        await scheduleDomainPurge(message.domain, { reason: 'rule-removed' });
      }
    }
    return { success: deleted };
  },

  async [Action.SET_RULE_SCOPE](message) {
    const host = normalizeDomain(message.domain);
    const rules = await getRules();
    const existing = rules[host];
    if (!existing) return { success: false, error: 'RULE_NOT_FOUND' };

    const rule = await setDomainRule(host, existing.type, {
      ...existing,
      subdomains: Boolean(message.subdomains)
    });
    scheduleBadgeRefresh();
    return { success: Boolean(rule), rule };
  },

  async [Action.IMPORT_RULES](message) {
    const incoming = Array.isArray(message.rules) ? message.rules : [];
    const normalized = {};
    let imported = 0;
    let rejected = 0;

    for (const candidate of incoming) {
      const rule = normalizeRule(candidate.domain, candidate.type, candidate);
      if (!rule) { rejected++; continue; }
      // Ice aktarimda suresi dolmus gecici izin KALICI beyaz listeye cevrilir: sure bu profilde hic yasamadi, kaydi dusurmek listeyi eksiltmek olur. (runMigrations tersini yapar - orada sure gercekten doldu.) Yon veri SAKLAMA yonunde; service-worker.test.js kilitliyor.
      if (rule.type === RuleType.TEMP && (!rule.expiresAt || rule.expiresAt <= Date.now())) {
        rule.type = RuleType.WHITE;
        rule.expiresAt = null;
      }
      normalized[rule.domain] = rule;
      imported++;
    }

    if (imported === 0) return { success: false, imported: 0, rejected };

    const merged = { ...(await getRules()), ...normalized };
    await saveRules(merged);
    // Ice aktarilan gecici izinlerin alarmlarini kur.
    for (const rule of Object.values(normalized)) {
      if (rule.type === RuleType.TEMP) await setDomainRule(rule.domain, rule.type, rule);
    }

    scheduleBadgeRefresh();
    await logSuccess(LogCategory.RULE, `${imported} kural ice aktarildi`, { imported, rejected });
    return { success: true, imported, rejected };
  },

  async [Action.RESET_RULES]() {
    // Kurallar giderken alarmlarini da toparla.
    const alarms = await chrome.alarms.getAll();
    await Promise.all(
      alarms.filter(a => a.name.startsWith(SNOOZE_ALARM_PREFIX)).map(a => chrome.alarms.clear(a.name))
    );
    await resetOnlyRules();
    scheduleBadgeRefresh();
    return { success: true };
  },

  async [Action.PURGE_DOMAIN](message) {
    const outcome = await purgeSiteNow(message.domain);
    if (!outcome.ok && outcome.reason === 'INVALID_DOMAIN') {
      return { success: false, error: 'INVALID_DOMAIN' };
    }
    if (!outcome.ok && outcome.reason === 'NO_HOST_ACCESS') {
      // Hicbir sey silinmedi; arayuz bunu "temizlendi" diye gostermemeli.
      return { success: false, error: 'NO_HOST_ACCESS', domain: outcome.domain };
    }
    if (!outcome.ok) {
      return {
        success: false,
        protected: true,
        ruleType: outcome.match.type,
        error: 'PROTECTED_BY_RULE',
        matchedDomain: outcome.match.matchedDomain
      };
    }
    return { success: true, ...outcome.result };
  },

  async [Action.PURGE_DOMAIN_HISTORY_ONLY](message) {
    const scope = createDomainScope(message.domain);
    if (!scope) return { success: false, error: 'INVALID_DOMAIN' };

    // Beyaz listedeki bir sitenin gecmisini elle silmek istiyoruz.
    const settings = await getSettings();
    const ctx = await createPurgeContext({ settings: { ...settings, whitelistCleanHistory: true } });
    const result = await cleanHistoryForDomain(scope.base, ctx);

    if (result.count > 0) await incrementStats({ history: result.count, bytes: result.bytes });
    scheduleBadgeRefresh();
    return { success: true, history: result.count, bytes: result.bytes, truncated: result.truncated };
  },

  async [Action.PURGE_SELECTED_DOMAINS](message) {
    const domains = Array.isArray(message.domains) ? message.domains : [];
    if (domains.length === 0) return { success: false, error: 'NO_DOMAINS' };

    const summary = await purgeDomains(domains);
    // Yarim kalan isde budama YAPILMAZ: kayit, o alan adinda hala veri bulunabilecegine dair tek sinyal.
    if (summary.remaining > 0) {
      // DEVAM YALNIZCA SECILEN SITELER ICIN kurulur.
      for (const domain of domains) {
        const scope = createDomainScope(domain);
        if (scope) {
          await chrome.alarms.create(purgeAlarmName(scope.base), { when: Date.now() + CONTINUATION_DELAY_MS });
        }
      }
      await logWarn(
        LogCategory.PURGE,
        `Secili site temizligi yarim kaldi; ${summary.remaining} kayit icin YALNIZCA secili siteler yeniden planlandi`,
        { remaining: summary.remaining, domains }
      );
    } else {
      // ISTENEN degil GERCEKLESEN listeye gore budanir: korumali oldugu icin atlanan bir sitenin kaydi durmali.
      await pruneThirdParty(host => (summary.purgedDomains || []).some(domain => {
        const scope = createDomainScope(domain);
        return scope ? scope.matches(host) : false;
      }));
    }
    scheduleBadgeRefresh();
    return { success: true, ...summary };
  },

  async [Action.PURGE_ALL_NON_WHITELIST]() {
    const result = await purgeAllNonWhitelisted();
    // remaining > 0 ise devam alarmi kurar ve haritayi KORUR (bkz. scheduler).
    await settleBulkPurge(result);
    await resetSweepThrottle();
    scheduleBadgeRefresh();

    const settings = await getSettings();
    if (settings.notifyOnClean && (result.cookies > 0 || result.history > 0)) {
      await notify({
        titleKey: 'serviceWorker.periodicCleanTitle',
        messageKey: 'serviceWorker.periodicCleanMsg',
        params: { cookies: result.cookies, history: result.history },
        tag: 'purge-all'
      });
    }
    return { success: true, ...result };
  },

  async [Action.SET_AUTOMATIC_CLEANING_ENABLED](message) {
    const enabled = message.enabled !== false;
    const written = await updateSettings({ enabled });
    if (!written?.ok) {
      // Yazma basarisizsa ana anahtari degistirdigimizi soylememeliyiz.
      return { success: false, error: written?.error || 'STORAGE_WRITE_FAILED' };
    }
    if (!enabled) {
      await cancelAllScheduledPurges();
      await chrome.alarms.clear(ALARM_PERIODIC_SWEEP);
    } else {
      await ensurePeriodicAlarm();
      // YETISME SUPURMESI: anahtar kapaliyken sekme kapanislari alarm kurmaz, yani anahtar geri acildiginda biriken veriyi bekleyen hicbir sey yok (olculdu: 120 sn sonra hala duruyordu).
      await resetSweepThrottle();
      void sweepOrphanDomains({ force: true });
    }
    await syncContentScriptRegistration();
    scheduleBadgeRefresh();
    return { success: true, enabled };
  },

  async [Action.SETTINGS_CHANGED]() {
    await ensurePeriodicAlarm();
    await syncContentScriptRegistration();
    await syncContextMenus();
    const settings = await getSettings();
    const hardening = await applyHardening(settings.hardening);
    scheduleBadgeRefresh();
    return { success: true, hardening };
  },

  async [Action.GET_LOGS](message) {
    return { success: true, logs: await getLogs(message.limit || 500) };
  },

  async [Action.CLEAR_LOGS]() {
    return { success: await clearLogs() };
  },

  async [Action.EXPORT_LOGS](message) {
    const logs = await getLogs(500);
    if (message.format === 'json') {
      return { success: true, format: 'json', content: formatLogsAsJSON(logs), count: logs.length };
    }
    await initI18n();
    return {
      success: true,
      format: 'text',
      content: formatLogsAsText(logs, { title: t('options.logsExportTitle'), locale: message.locale || 'tr-TR' }),
      count: logs.length
    };
  },

  async [Action.APPLY_HARDENING](message) {
    // OKUMA ile YAZMA ayrilir. `hardening` gelmediyse bu bir DURUM SORGUSUDUR
    // ve tarayici ayarina DOKUNULMAZ. Onceden bu yolda da applyHardening()
    // kosuyordu: Ayarlar sekmesini acmak chrome.privacy uzerinde set()/clear()
    // isletiyordu, yani okuma yolunun yan etkisi vardi. Sertlestirmeyi yeniden
    // dayatan yollar zaten ayrica var (SETTINGS_CHANGED ve onInstalled).
    if (!message.hardening) {
      return { success: true, outcome: null, state: await readHardeningState() };
    }
    await updateSettings({ hardening: { ...DEFAULT_SETTINGS.hardening, ...message.hardening } });
    const settings = await getSettings();
    const outcome = await applyHardening(settings.hardening);
    const state = await readHardeningState();
    return { success: true, outcome, state };
  },


  async [Action.REPORT_STORAGE_ESTIMATE](message, sender) {
    const settings = await getSettings();
    if (!settings.enabled || !settings.trackThirdParty) return { success: false };

    // Guvenilir kaynak: host gonderenin gercek sekme URL'sinden alinir.
    const host = normalizeDomain(sender?.tab?.url || '');
    if (!host) return { success: false };
    if (sender?.tab?.incognito === true) return { success: false };

    await recordStorageEstimate(host, Number(message.usage));
    return { success: true };
  },

  async [Action.REPORT_THIRD_PARTY](message, sender) {
    const settings = await getSettings();
    if (!settings.enabled || !settings.trackThirdParty) return { success: false };

    // GIZLI PENCERE: kayit gizli sekmelerde de calisiyor.
    if (sender?.tab?.incognito === true) return { success: false };

    // Guvenilir kaynak: parent, gonderen sekmenin gercek URL'sinden alinir.
    const parentRoot = getRootDomain(sender?.tab?.url || message.parent || '');
    if (!parentRoot) return { success: false };

    const hosts = Array.isArray(message.hosts) ? message.hosts : [];
    const thirdPartyRoots = [...new Set(
      hosts.map(host => getRootDomain(host)).filter(root => root && root !== parentRoot)
    )];

    if (thirdPartyRoots.length) await recordThirdParty(parentRoot, thirdPartyRoots);
    return { success: true, recorded: thirdPartyRoots.length };
  }
};
