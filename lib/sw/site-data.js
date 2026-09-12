// GhostTrace - "Site verileri" listesi (yalnizca OKUMA)

import { createDomainScope, normalizeDomain } from '../domain.js';
import { matchDomainRule, RuleType } from '../rules.js';
import { getRules } from '../storage.js';
import {
  fetchCookies, classifyCookie, isLikelySessionCookie, isLikelyTrackingCookie
} from '../cookies.js';
import { searchHistoryPaged } from '../history.js';
import { getThirdPartyMap } from '../session-state.js';

/** "Site Verileri" sekmesi icin butun izleri toplar. */
export async function collectStoredDomains() {
  const [cookies, downloads, rules, thirdParty] = await Promise.all([
    fetchCookies(),
    chrome.downloads?.search ? chrome.downloads.search({}).catch(() => []) : Promise.resolve([]),
    getRules(),
    getThirdPartyMap()
  ]);

  const historyScan = await searchHistoryPaged({ text: '', pageSize: 5000, maxPages: 4 });

  // Not: acik sekme listesi artik gerekmiyor. 3. taraf kayitlari ana sitenin sekmesi acik olmasa da listelendigi icin chrome.tabs.query cagrisi dustu.
  const entries = new Map();
  const entryFor = (rawHost) => {
    const host = normalizeDomain(rawHost);
    if (!host) return null;
    if (!entries.has(host)) {
      entries.set(host, {
        domain: host,
        cookieCount: 0,
        historyCount: 0,
        downloadCount: 0,
        requestCount: 0,
        // Kullanici bu sitede GIRIS YAPMIS gorunuyor mu?
        hasSessionCookie: false,
        parentSites: [],
        ruleType: matchDomainRule(host, rules).type
      });
    }
    return entries.get(host);
  };

  for (const cookie of cookies) {
    const entry = entryFor(cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain);
    if (!entry) continue;
    entry.cookieCount++;
    if (isLikelySessionCookie(cookie)) entry.hasSessionCookie = true;
  }
  for (const item of historyScan.items) {
    const entry = entryFor(item.url);
    if (entry) entry.historyCount++;
  }
  for (const item of downloads) {
    if (!item?.url) continue;
    const entry = entryFor(item.url);
    if (entry) entry.downloadCount++;
  }
  for (const [host, rule] of Object.entries(rules)) {
    const entry = entryFor(host);
    if (entry) entry.ruleType = matchDomainRule(host, rules).type || rule.type;
  }
  for (const [host, info] of Object.entries(thirdParty)) {
    const entry = entryFor(host);
    if (!entry) continue;
    entry.requestCount += info.count || 0;
    entry.parentSites = info.parents || [];
  }

  const list = [...entries.values()]
    .filter(entry => {
      // Kurali olanlar ve gercekten veri barindiranlar her zaman listelenir.
      if (entry.ruleType !== RuleType.DEFAULT) return true;
      if (entry.cookieCount || entry.historyCount || entry.downloadCount) return true;
      // Gorulmus 3. taraflar da listelenir.
      return entry.requestCount > 0;
    })
    .map(entry => {
      // 3. taraf: kendi basina gezilmemis, yalnizca baska bir sitenin yukledigi kaynak olarak gorulmus alan adi.
      const isThirdParty = entry.ruleType === RuleType.DEFAULT
        && entry.historyCount === 0
        && (entry.requestCount > 0 || entry.parentSites.length > 0);

      return {
        ...entry,
        isThirdParty,
        category: isThirdParty ? 'third_party' : 'direct',
        totalTraces: entry.cookieCount + entry.historyCount + entry.downloadCount + entry.requestCount
      };
    })
    .sort((a, b) => b.totalTraces - a.totalTraces);

  return { domains: list, truncated: historyScan.truncated };
}

/** Bir alan adinin cerezlerini arayuz icin ozetler. */
export async function describeDomainCookies(domain) {
  const scope = createDomainScope(domain);
  if (!scope) return { success: false, cookies: [] };

  const cookies = (await fetchCookies({ domain: scope.cookieFilterDomain }))
    .filter(cookie => scope.matchesCookie(cookie))
    .map(cookie => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      // Deger arayuzde gosterilmez; yalnizca uzunlugu bilgi olarak gecer.
      valueLength: cookie.value ? cookie.value.length : 0,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || 'unspecified',
      session: Boolean(cookie.session),
      expirationDate: cookie.expirationDate || null,
      partitioned: Boolean(cookie.partitionKey),
      // Silme icin GEREKLI kimlik alanlari.
      partitionKey: cookie.partitionKey,
      storeId: cookie.storeId,
      hostOnly: Boolean(cookie.hostOnly),
      classification: classifyCookie(cookie),
      isSession: isLikelySessionCookie(cookie),
      isTracker: isLikelyTrackingCookie(cookie)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    cookies,
    sessionCount: cookies.filter(c => c.isSession).length,
    trackerCount: cookies.filter(c => c.isTracker).length
  };
}
