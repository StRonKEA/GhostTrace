// GhostTrace - Yetim alan adi taramasi (emniyet agi).

import { getRootDomain } from '../domain.js';
import { isRuleProtected } from '../rules.js';
import { createPurgeContext, purgeDomain } from '../purge/index.js';
import { selectPurgeTarget } from '../purge/context.js';
import { getSettings, clampCleanDelay } from '../storage.js';
import { fetchCookies } from '../cookies.js';
import { logInfo, logWarn, logError, LogCategory } from '../logger.js';
import { getThirdPartyMap, claimSweepSlot, pruneThirdParty } from '../session-state.js';
import {
  ALARM_SWEEP_RETRY, CONTINUATION_DELAY_MS, SWEEP_MAX_DOMAINS,
  SWEEP_MIN_INTERVAL_MS, purgeAlarmName
} from './constants.js';
import { isManagedTab } from './tabs.js';
import { scheduleBadgeRefresh } from './badge.js';

/** Kisitlama penceresi dolunca supurmeyi tekrar deneyecek alarmi kurar. */
async function ertelemeKur() {
  try {
    if (await chrome.alarms?.get?.(ALARM_SWEEP_RETRY)) return;
    await chrome.alarms?.create?.(ALARM_SWEEP_RETRY, {
      when: Date.now() + SWEEP_MIN_INTERVAL_MS
    });
  } catch {
    // Alarm kurulamadi: emniyet agi gecikir ama akis bozulmaz.
  }
}

/** Erteleme alarmi tetiklendiginde cagrilir. */
export async function runSweepRetry() {
  return sweepOrphanDomains({});
}

/** Acik sekmesi olmayan, kurali da olmayan alan adlarini temizler. */
export async function sweepOrphanDomains({ excludeTabId = null, force = false } = {}) {
  const settings = await getSettings();
  if (!settings.enabled) return { scanned: 0, purged: 0, scheduled: 0, capped: false };

  if (!force && !await claimSweepSlot(SWEEP_MIN_INTERVAL_MS)) {
    // Kisitlandi: IPTAL degil ERTELE.
    await ertelemeKur();
    return { scanned: 0, purged: 0, scheduled: 0, capped: false, throttled: true };
  }

  try {
    const [cookies, tabs, thirdParty] = await Promise.all([
      fetchCookies(),
      chrome.tabs.query({}),
      getThirdPartyMap()
    ]);

    const openRoots = new Set();
    for (const tab of tabs) {
      if (excludeTabId !== null && tab.id === excludeTabId) continue;
      if (!isManagedTab(tab)) continue;
      const tabUrl = tab.url || tab.pendingUrl;
      const root = getRootDomain(tabUrl);
      if (root) openRoots.add(root);
    }

    const ctx = await createPurgeContext({ settings });

    // Aday secimi lib/purge/context.js'te PAYLASILIYOR: sekme kapanisi yolu da aynisini kullaniyor.
    const adaySec = (host) => selectPurgeTarget(host, ctx);

    const candidates = new Set();
    for (const cookie of cookies) {
      const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const aday = adaySec(host);
      if (aday && !openRoots.has(getRootDomain(aday))) candidates.add(aday);
    }

    // Gorulmus 3. taraflar da adaydir.
    for (const [host, info] of Object.entries(thirdParty)) {
      const root = adaySec(host);
      if (!root || openRoots.has(getRootDomain(root))) continue;

      // Kaynak sayfa hala aciksa dokunmayiz: canli bir sayfanin altindan veri cekmek oturumunu bozabilir.
      const sourceStillOpen = (info.parents || [])
        .some(parent => openRoots.has(getRootDomain(parent)));
      if (sourceStillOpen) continue;

      candidates.add(root);
    }

    const targets = [...candidates].filter(root => !isRuleProtected(ctx.matchFor(root)));

    const capped = targets.length > SWEEP_MAX_DOMAINS;
    const batch = targets.slice(0, SWEEP_MAX_DOMAINS);

    // Tarama, kullanicinin belirledigi bekleme suresini ATLAMAZ. (v1.1.0'da bu tarama her sekme kapanisinda dogrudan silme yaptigi icin cleanDelay ayari fiilen islevsizdi.)
    const delay = clampCleanDelay(settings.cleanDelay);
    let purged = 0;
    let scheduled = 0;

    // Kaydi DUSURULMEYECEK alan adlari: butceye takilanlar (isi yarim kaldi) ve erisim kisitli olanlar (hic dokunulamadi).
    const truncated = [];
    const unreachable = [];

    for (const root of batch) {
      if (delay === 0) {
        const result = await purgeDomain(root, ctx);
        if (result.noHostAccess) {
          unreachable.push(root);
          continue;
        }
        if (!result.protected) purged++;
        if (result.remaining > 0) {
          truncated.push(root);
          await chrome.alarms.create(purgeAlarmName(root), { when: Date.now() + CONTINUATION_DELAY_MS });
        }
      } else {
        const name = purgeAlarmName(root);
        // Zaten planlanmis bir temizligin zamanini ileriye atmayiz.
        if (await chrome.alarms.get(name)) continue;
        await chrome.alarms.create(name, { when: Date.now() + delay * 1000 });
        scheduled++;
      }
    }

    if (unreachable.length > 0) {
      await logError(
        LogCategory.PURGE,
        `${unreachable.length} alan adinda site erisimi kisitli; temizlenemediler`,
        { domains: unreachable }
      );
    }
    if (purged > 0) {
      // Yalnizca TAMAMLANAN alan adlarinin kaydi dusulur.
      const done = batch.filter(root => !truncated.includes(root) && !unreachable.includes(root));
      if (done.length > 0) {
        await pruneThirdParty(host => done.some(root => host === root || host.endsWith(`.${root}`)));
      }
      scheduleBadgeRefresh();
    }
    if (truncated.length > 0) {
      await logWarn(
        LogCategory.PURGE,
        `${truncated.length} alan adi butceye takildi; devam alarmlari kuruldu`,
        { domains: truncated }
      );
    }
    if (scheduled > 0) {
      await logInfo(LogCategory.ALARM, `${scheduled} yetim alan adi icin temizlik planlandi`, { delay });
    }
    if (capped) {
      // Sessiz kirpma yapmiyoruz: kalan is bir sonraki taramada islenir.
      await logWarn(
        LogCategory.PURGE,
        `Tarama ust sinira takildi: ${batch.length}/${targets.length} alan adi islendi, kalan ${targets.length - batch.length} sonraki taramada`
      );
    }

    return { scanned: candidates.size, purged, scheduled, capped };
  } catch (err) {
    await logError(LogCategory.PURGE, `Yetim taramasi hatasi: ${err.message}`, { error: String(err) });
    return { scanned: 0, purged: 0, scheduled: 0, capped: false };
  }
}
