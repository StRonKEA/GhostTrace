// GhostTrace - Arka Plan Service Worker (MV3) - GIRIS NOKTASI

import { createDomainScope, extractHostname, isInternalUrl, stripTrackingParams } from './lib/domain.js';
import {
  deleteDomainRule, hostFromSnoozeAlarm, matchDomainRule, pruneExpiredRules, RuleType, setDomainRule, SNOOZE_ALARM_PREFIX
} from './lib/rules.js';
import { purgeAllNonWhitelisted } from './lib/purge/index.js';
import { getRules, getSettings, runMigrations, pruneStatsHistory } from './lib/storage.js';
import { notify } from './lib/notify.js';
import { flushLogs, LogCategory, logError, logInfo, logWarn } from './lib/logger.js';
import { removeTab, setTabUrl } from './lib/session-state.js';
import { applyHardening, watchHardeningChanges } from './lib/privacy.js';
import {
  ALARM_MAINTENANCE,
  ALARM_SWEEP_RETRY, ALARM_PERIODIC_SWEEP, ALARM_PURGE_PREFIX, ALARM_WHITELIST_PREFIX, MENU_PURGE, MENU_WHITELIST, BULK_CONTINUE_ALARM} from './lib/sw/constants.js';
import { isManagedTab } from './lib/sw/tabs.js';
import { handlers } from './lib/sw/handlers.js';
import { lightBootstrap, sessionBootstrap } from './lib/sw/bootstrap.js';
import { runSweepRetry, sweepOrphanDomains } from './lib/sw/sweep.js';
import {
  cancelAllScheduledPurges, cancelScheduledPurge, purgeSiteNow, runScheduledPurge, runWhitelistExceptionCleanup, scheduleDomainPurge, settleBulkPurge
} from './lib/sw/scheduler.js';
import { refreshContextMenuLabels, syncContextMenus } from './lib/sw/context-menu.js';
import { syncContentScriptRegistration } from './lib/sw/observer.js';
import { ensurePeriodicAlarm } from './lib/sw/alarms.js';
import { scheduleBadgeRefresh, updateBadgeForTab } from './lib/sw/badge.js';


// Olay dinleyicileri

/** Kullanici istegiyle tek siteyi temizler ve SONUCU BILDIRIR. */
async function purgeActiveSite(url, tag) {
  const outcome = await purgeSiteNow(url);
  if (!outcome.ok) {
    if (outcome.reason === 'PROTECTED') {
      await notify({
        titleKey: 'serviceWorker.protectedTitle',
        messageKey: 'serviceWorker.protectedMsg',
        params: { domain: outcome.domain },
        tag
      });
    }
    if (outcome.reason === 'NO_HOST_ACCESS') {
      // Sessiz kalmak, kullanicinin temizlendigini SANMASI demek.
      await notify({
        titleKey: 'serviceWorker.noAccessTitle',
        messageKey: 'serviceWorker.noAccessMsg',
        params: { domain: outcome.domain },
        tag
      });
    }
    return;
  }
  await notify({
    titleKey: 'serviceWorker.siteCleanedTitle',
    messageKey: 'serviceWorker.siteCleanedMsg',
    params: {
      domain: outcome.domain,
      cookies: outcome.result.cookies,
      history: outcome.result.history
    },
    tag
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.action];
  if (!handler) {
    sendResponse({ success: false, error: 'UNKNOWN_ACTION' });
    return false;
  }

  handler(message, sender)
    .then(result => sendResponse(result ?? { success: true }))
    .catch(async err => {
      await logError(LogCategory.SYSTEM, `${message.action} basarisiz: ${err.message}`, { error: String(err) });
      console.error(`[GhostTrace] ${message.action} hatasi:`, err);
      sendResponse({ success: false, error: err.message || 'HANDLER_ERROR' });
    });

  return true; // asenkron yanit
});


chrome.tabs.onCreated.addListener(async (tab) => {
  // Gizli sekmeler haritaya HIC girmez.
  if (tab?.id !== undefined && isManagedTab(tab)) {
    await setTabUrl(tab.id, tab.url || tab.pendingUrl);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab?.incognito === true) return;
  const rawUrl = changeInfo.url || tab?.url || tab?.pendingUrl;

  if (changeInfo.url && rawUrl && !isInternalUrl(rawUrl)) {
    const settings = await getSettings();
    let effectiveUrl = rawUrl;

    if (settings.stripTrackingParams !== false) {
      const cleanUrl = stripTrackingParams(rawUrl);
      if (cleanUrl !== rawUrl) {
        effectiveUrl = cleanUrl;
        if (settings.cleanHistory !== false && chrome.history?.deleteUrl) {
          void chrome.history.deleteUrl({ url: rawUrl }).catch(() => {});
        }
      }
    }

    const previousUrl = await setTabUrl(tabId, effectiveUrl);
    const previousHost = extractHostname(previousUrl);
    const newHost = extractHostname(effectiveUrl);

    if (newHost) await cancelScheduledPurge(newHost);

    // Ayni siteye ait olmayan bir adrese gecildiyse eskisini temizligi planla.
    if (previousHost && previousHost !== newHost) {
      const previousScope = createDomainScope(previousHost);
      if (previousScope && !previousScope.matches(newHost)) {
        await scheduleDomainPurge(previousHost, { excludeTabId: tabId, reason: 'navigated-away' });
      }
    }
  }

  if ((changeInfo.url || changeInfo.status === 'complete') && tab?.active) {
    scheduleBadgeRefresh();
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (isManagedTab(tab)) await setTabUrl(tab.id, tab.url || tab.pendingUrl);
    await updateBadgeForTab(tab);
    await refreshContextMenuLabels(tab);
  } catch {
    // Sekme aninda kapanmis olabilir
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const closedUrl = await removeTab(tabId);

  // URL bilinmiyorsa dururuz: ya gizli sekme (devam etmek normal profildeki veriyi silerdi) ya da harita kaybolmus (bunu bootstrap ve supurme toparlar).
  if (!closedUrl || isInternalUrl(closedUrl)) return;

  const host = extractHostname(closedUrl);
  if (!host) return;

  const scope = createDomainScope(host);
  await logInfo(LogCategory.TAB, 'Sekme kapatildi', { tabId }, scope?.base || host);

  // 3. taraf kayitlari BURADA budanmaz: sekmeyi kapatmak o CDN'in verisini silmez.
  await scheduleDomainPurge(host, { excludeTabId: tabId, reason: 'tab-closed' });

  // Emniyet agi; kisitlanmis oldugu icin her kapanista tam tarama yapmaz.
  await sweepOrphanDomains({ excludeTabId: tabId });
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await removeTab(removedTabId);
  try {
    const tab = await chrome.tabs.get(addedTabId);
    // isManagedTab: gizli pencere karari TEK yerde.
    if (isManagedTab(tab)) await setTabUrl(addedTabId, tab.url || tab.pendingUrl);
  } catch {
    // yok sayilir
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name.startsWith(ALARM_PURGE_PREFIX)) {
      const host = alarm.name.slice(ALARM_PURGE_PREFIX.length);
      await logInfo(LogCategory.ALARM, 'Temizlik alarmi tetiklendi', null, host);
      await runScheduledPurge(host);
      return;
    }

    if (alarm.name === ALARM_SWEEP_RETRY) {
      // Kisitlanan yetim supurmesinin ikinci sansi.
      await runSweepRetry();
      return;
    }

    if (alarm.name.startsWith(ALARM_WHITELIST_PREFIX)) {
      const host = alarm.name.slice(ALARM_WHITELIST_PREFIX.length);
      await runWhitelistExceptionCleanup(host);
      return;
    }

    if (alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) {
      const host = hostFromSnoozeAlarm(alarm.name);
      if (!host) return;

      // GUVENLIK KONTROLU: Alarm ateslendiginde kuralin GERCEKTEN suresi dolmus bir gecici izin oldugunu dogrula. v1.1.0'da bu kontrol yoktu; yetim kalmis bir alarm, ayni host icin sonradan eklenen BEYAZ LISTE kuralini silip sitenin tum verisini yok ediyordu.
      const rules = await getRules();
      const rule = rules[host];
      if (!rule) {
        await logInfo(LogCategory.ALARM, 'Yetim snooze alarmi yok sayildi', null, host);
        return;
      }
      if (rule.type !== RuleType.TEMP) {
        await logWarn(LogCategory.ALARM, `Snooze alarmi '${rule.type}' kuraline dokunmadi`, { ruleType: rule.type }, host);
        await chrome.alarms.clear(alarm.name);
        return;
      }
      if (rule.expiresAt && rule.expiresAt > Date.now()) {
        // Sure uzatilmis; alarmi yeni zamana tasi.
        await chrome.alarms.create(alarm.name, { when: rule.expiresAt });
        return;
      }

      await deleteDomainRule(host);
      await logInfo(LogCategory.RULE, 'Gecici izin suresi doldu', null, host);
      await runScheduledPurge(host);
      return;
    }

    if (alarm.name === BULK_CONTINUE_ALARM) {
      // Yarim kalan toplu temizligi surdur (idempotent).
      const settings = await getSettings();
      if (!settings.enabled) return;
      const result = await purgeAllNonWhitelisted({ settings });
      await settleBulkPurge(result);
      scheduleBadgeRefresh();
      return;
    }

    if (alarm.name === ALARM_PERIODIC_SWEEP) {
      const settings = await getSettings();
      if (!settings.enabled || !settings.periodicCleanEnabled) return;

      const result = await purgeAllNonWhitelisted({ settings });

      await settleBulkPurge(result);
      scheduleBadgeRefresh();

      if (settings.notifyOnClean && (result.cookies > 0 || result.history > 0)) {
        await notify({
          titleKey: 'serviceWorker.periodicCleanTitle',
          messageKey: 'serviceWorker.periodicCleanMsg',
          params: { cookies: result.cookies, history: result.history },
          tag: 'periodic'
        });
      }
      return;
    }

    if (alarm.name === ALARM_MAINTENANCE) {
      const expired = await pruneExpiredRules();
      if (expired.length) {
        // runScheduledPurge, purgeDomain DEGIL: purgeDomain acik sekme kontrolu yapmaz ve kullanicinin o an baktigi sayfanin altindan cerezi cekerdi.
        for (const host of expired) await runScheduledPurge(host);
        scheduleBadgeRefresh();
      }
      await pruneStatsHistory();
      await flushLogs();
    }
  } catch (err) {
    await logError(LogCategory.ALARM, `Alarm isleme hatasi (${alarm.name}): ${err.message}`, { error: String(err) });
    console.error('[GhostTrace] Alarm hatasi:', err);
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.rules || changes.showBadgeCount || changes.enabled) {
    scheduleBadgeRefresh();
  }
  if (changes.trackThirdParty || changes.trackThirdPartyFrames || changes.enabled) {
    await syncContentScriptRegistration();
  }
  if (changes.contextMenuEnabled) {
    await syncContextMenus();
  }
  if (changes.periodicCleanEnabled || changes.periodicCleanInterval) {
    await ensurePeriodicAlarm();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await logInfo(LogCategory.SYSTEM, 'Tarayici baslatildi');

  // Baglamsiz alarmlari temizle: gt:purge: / gt:wlclean: yeniden baslatmadan sag cikar ama bagli olduklari sekme haritasi storage.session'da oldugu icin kaybolur.
  await cancelAllScheduledPurges();

  await lightBootstrap();
  await sessionBootstrap({ isBrowserStartup: true });
});

// GUNCELLEME/KURULUM: onStartup'tan farkli olarak bekleyen temizlikleri IPTAL ETMEYIZ - iptal, kapatilmis bir sitenin verisinin hic temizlenmemesi demek olurdu. runScheduledPurge acik sekmeyi canli sorguyla dogrular.
chrome.runtime.onInstalled.addListener(async (details) => {
  const report = await runMigrations();
  await logInfo(LogCategory.SYSTEM, `Kurulum/guncelleme: ${details.reason}`, report);

  await lightBootstrap();
  // Guncelleme/kurulum acik sekmelerdeki gozlemciyi oldurur; geri doldur.
  await syncContentScriptRegistration({ backfillOpenTabs: true });
  await syncContextMenus();

  const settings = await getSettings();
  await applyHardening(settings.hardening);
  await sessionBootstrap({ isBrowserStartup: false });
});

if (!chrome.commands?.onCommand) {
  // Optional chaining sessizce hicbir sey kaydetmez.
  void logWarn(LogCategory.SYSTEM, 'chrome.commands API yok; klavye kisayollari devre disi');
}

chrome.commands?.onCommand?.addListener(async (command) => {
  try {
    if (command === 'quick-purge-all') {
      const result = await purgeAllNonWhitelisted();
      await settleBulkPurge(result);
      scheduleBadgeRefresh();
      await notify({
        titleKey: 'serviceWorker.emergencyCleanTitle',
        messageKey: 'serviceWorker.emergencyCleanMsg',
        params: { cookies: result.cookies, history: result.history },
        tag: 'shortcut'
      });
      return;
    }

    if (command === 'quick-purge-current') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || isInternalUrl(tab.url)) return;
      await purgeActiveSite(tab.url, 'shortcut');
    }
  } catch (err) {
    await logError(LogCategory.SYSTEM, `Kisayol hatasi: ${err.message}`, { error: String(err) });
  }
});

// Gizlilik ayarlarinin DIS degisikliklerini dinle: baskasi degistirdiginde arayuz "korumali" demeye devam etmemeli.

function attachHardeningWatch() {
  return watchHardeningChanges(async (change) => {
    await logInfo(
      LogCategory.SYSTEM,
      `Gizlilik ayari disaridan degisti: ${change.key}`,
      { value: change.value, levelOfControl: change.levelOfControl, controllable: change.controllable }
    );
    scheduleBadgeRefresh();
  });
}

attachHardeningWatch();

// Sag tik menusu tiklamalari

// Izin SONRADAN verilebilir, dinleyici de o zaman baglanmali: chrome.contextMenus izin verildigi anda olusur ama bu dosyanin ust duzeyi coktan calismistir - menu gorunur, tiklama hicbir sey yapmazdi.
let menuTiklamaBagli = false;

function attachContextMenuClicks() {
  if (menuTiklamaBagli || !chrome.contextMenus?.onClicked) return;
  menuTiklamaBagli = true;
  chrome.contextMenus.onClicked.addListener(onContextMenuClicked);
}

async function onContextMenuClicked(info, tab) {
  try {
    if (!isManagedTab(tab)) return;
    const scope = createDomainScope(tab.url);
    if (!scope) return;

    if (info.menuItemId === MENU_PURGE) {
      await purgeActiveSite(tab.url, 'menu');
      return;
    }

    if (info.menuItemId === MENU_WHITELIST) {
      const rules = await getRules();
      const match = matchDomainRule(scope.base, rules);
      if (match.type === RuleType.WHITE) {
        await deleteDomainRule(scope.base);
      } else {
        await setDomainRule(scope.base, RuleType.WHITE, { subdomains: scope.isRoot });
      }
      await cancelScheduledPurge(scope.base);
      scheduleBadgeRefresh();
      await refreshContextMenuLabels(tab);
    }
  } catch (err) {
    await logError(LogCategory.SYSTEM, `Sag tik menusu hatasi: ${err.message}`, { error: String(err) });
  }
}

attachContextMenuClicks();

// Kullanici chrome://extensions'ta site erisimini daralttiginda eklenti sessizce calisamaz hale gelir; bunu loglayip rozeti guncelliyoruz.
chrome.permissions?.onRemoved?.addListener(async (permissions) => {
  const origins = permissions?.origins || [];
  if (origins.length > 0) {
    await logWarn(
      LogCategory.SYSTEM,
      `Site erisimi kaldirildi (${origins.length} adres); bu sitelerde temizlik yapilamaz`,
      { origins }
    );
  }
  scheduleBadgeRefresh();
});

if (!chrome.permissions?.onAdded) {
  void logWarn(LogCategory.SYSTEM, 'chrome.permissions.onAdded yok; opsiyonel izin sonradan verilirse dinleyici yeniden baglanmayacak');
}

chrome.permissions?.onAdded?.addListener((permissions) => {
  if (permissions?.permissions?.includes('privacy')) {
    attachHardeningWatch();
  }
  if (permissions?.permissions?.includes('contextMenus')) {
    // API yeni olustu: once tiklama dinleyicisini bagla, sonra menuyu kur.
    attachContextMenuClicks();
    void syncContextMenus();
  }
  if (permissions?.origins?.length) scheduleBadgeRefresh();
});

// SW her uyandiginda yalnizca hafif hazirlik calisir.
void lightBootstrap();
