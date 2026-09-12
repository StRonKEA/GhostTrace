// GhostTrace - Temizlik baglami: ayarlar ve kurallar islem boyunca TEK KEZ okunur. buildProtectedOrigins http/https ve www varyantlarini uretir - Chrome origin eslemesini birebir yapar, birini atlamak korumali siteyi silmek demektir.

import {
  createDomainScope, getRootDomain, hostFromCookieDomain, isInternalUrl, normalizeDomain
} from '../domain.js';
import { matchDomainRule, isRuleProtected, isRuleFullyProtected, RuleType } from '../rules.js';
import { shouldKeepCookie } from '../cookies.js';
import { getSettings } from '../storage.js';

/** Bir diziyi sabit boyutlu parcalara boler. */
export function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bir temizlik islemi icin paylasilan baglam. */
export async function createPurgeContext({ settings = null, rules = null } = {}) {
  const resolvedSettings = settings || await getSettings();
  const resolvedRules = rules || resolvedSettings.rules || {};

  const matchFor = (hostOrUrl) => matchDomainRule(hostOrUrl, resolvedRules);

  // Korumali kural TASIYAN hostlar.
  const protectedHosts = new Set(
    Object.keys(resolvedRules).filter(host => isRuleProtected(matchDomainRule(host, resolvedRules)))
  );

  return {
    settings: resolvedSettings,
    rules: resolvedRules,
    matchFor,
    protectedHosts,

    /** Bu host'un GECMISI korunacak mi? */
    isHistoryProtected(hostOrUrl) {
      const match = matchFor(hostOrUrl);
      if (!isRuleProtected(match)) return false;
      if (match.type === RuleType.WHITE) return !resolvedSettings.whitelistCleanHistory;
      return true; // gri liste ve aktif gecici izin her zaman korunur
    },

    /** Bu host'un INDIRME kayitlari korunacak mi? */
    isDownloadProtected(hostOrUrl) {
      const match = matchFor(hostOrUrl);
      if (!isRuleProtected(match)) return false;
      if (match.type === RuleType.WHITE) return !resolvedSettings.whitelistCleanDownloads;
      return true;
    },

    /** Bu host'un DEPOLAMASI korunacak mi? */
    isStorageProtected(hostOrUrl) {
      return isRuleProtected(matchFor(hostOrUrl));
    },

    /** Bu host'a HIC dokunulmayacak mi? */
    isFullyProtected(hostOrUrl) {
      return isRuleFullyProtected(matchFor(hostOrUrl));
    },

    /** Cerez korunacak mi? (kural turu + keepMode birlikte) */
    isCookieProtected(cookie) {
      const host = hostFromCookieDomain(cookie?.domain);
      if (!host) return false;
      const match = matchFor(host);
      if (!isRuleProtected(match)) return false;
      if (match.type === RuleType.WHITE) return shouldKeepCookie(cookie, match.rule);
      return true;
    }
  };
}

/** Acik sekmelerin hostlarini toplar (depolama origin listesini zenginlestirir). */
/** Host icin TEMIZLIK ADAYINI secer: normalde kok, kok korumali ve host korumasizsa host, ikisi de korumaliysa aday yok. */
export function selectPurgeTarget(host, ctx) {
  const root = getRootDomain(host);
  if (!root) return null;
  if (!isRuleProtected(ctx.matchFor(root))) return root;

  const clean = normalizeDomain(host);
  if (clean && clean !== root && !isRuleProtected(ctx.matchFor(clean))) return clean;
  return null;
}

export async function openTabHosts() {
  try {
    const tabs = await chrome.tabs.query({});
    const hosts = new Set();
    for (const tab of tabs) {
      const url = tab?.url || tab?.pendingUrl;
      if (!url || isInternalUrl(url)) continue;
      // Gizli sekmeler haric: service worker normal profilin cerez/depolama baglaminda calisir, gizli pencerenin origin-lerini oraya karistirmak yanlis hedefleme uretir.
      if (tab.incognito === true) continue;
      const host = normalizeDomain(url);
      if (host) hosts.add(host);
    }
    return hosts;
  } catch {
    return new Set();
  }
}

/** Kapsami ALT ALAN ADLARINI da iceren korumali kural var mi? */
export function needsSubdomainDiscovery(ctx) {
  return Object.entries(ctx.rules).some(([host, rule]) =>
    rule?.subdomains !== false && isRuleProtected(matchDomainRule(host, ctx.rules)));
}

/** Korumali kurallarin ALT ALAN ADLARINI gecmisten kesfeder. excludeOrigins "listede olmayan her seyi sil" dedigi icin listeye giremeyen beyaz listeli bir alt alan ucar. */
export async function discoverProtectedSubdomains(ctx) {
  const hosts = new Set();
  if (!chrome.history?.search) return hosts;

  for (const [host, rule] of Object.entries(ctx.rules)) {
    if (rule?.subdomains === false) continue;
    if (!isRuleProtected(matchDomainRule(host, ctx.rules))) continue;
    const scope = createDomainScope(host);
    if (!scope) continue;
    try {
      const batch = await chrome.history.search({
        text: scope.searchText, startTime: 0, maxResults: 1000
      });
      for (const item of batch || []) {
        const aday = normalizeDomain(item?.url);
        // `text` filtresi ALT DIZE eslesmesi yapar; kapsam kontrolu sart, yoksa "notornek.com" da "ornek.com" aramasina takilir.
        if (aday && scope.matches(aday)) hosts.add(aday);
      }
    } catch {
      // Bu alan adi okunamadi; digerleri denenmeye devam eder.
    }
  }
  return hosts;
}

/** Korumali kurallardan browsingData icin haric tutulacak origin listesi uretir. */
export async function buildProtectedOrigins(ctx, knownHosts) {
  const origins = new Set();
  const addHost = (host) => {
    const clean = normalizeDomain(host);
    if (!clean) return;
    origins.add(`https://${clean}`);
    origins.add(`http://${clean}`);
    if (!clean.startsWith('www.')) {
      origins.add(`https://www.${clean}`);
      origins.add(`http://www.${clean}`);
    }
  };

  for (const [host, rule] of Object.entries(ctx.rules)) {
    const match = matchDomainRule(host, ctx.rules);
    if (!isRuleProtected(match)) continue;

    addHost(host);

    // Kural alt alan adlarini kapsiyorsa, bilinen tum alt alan adlarini da koru.
    if (rule.subdomains !== false) {
      const scope = createDomainScope(host);
      if (!scope) continue;
      for (const candidate of knownHosts) {
        if (scope.matches(candidate)) addHost(candidate);
      }
    }
  }

  return [...origins];
}
