// GhostTrace - Alan Adi Katmani (Domain Layer)

import { pslLiteral, pslWildcard, pslException, PSL_MAX_LABELS, PSL_VERSION } from './psl.js';

export { PSL_VERSION };

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Web disi / tarayici ici semalar: bu adreslerde temizlenecek site verisi yoktur.
const INTERNAL_SCHEMES = [
  'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:',
  'edge:', 'brave:', 'opera:', 'vivaldi:', 'moz-extension:', 'about:',
  'devtools:', 'view-source:', 'data:', 'blob:', 'filesystem:', 'file:',
  'javascript:', 'mailto:', 'tel:', 'ftp:'
];

/** Tarayici ici / web disi bir adres mi? Bos deger de "temizlenemez" sayilir. */
export function isInternalUrl(url) {
  if (!url) return true;
  const value = String(url).trim().toLowerCase();
  return INTERNAL_SCHEMES.some(scheme => value.startsWith(scheme));
}

/** Ham IPv4 adresi mi? */
export function isIpv4Host(host) {
  if (!IPV4_RE.test(host)) return false;
  return host.split('.').every(part => Number(part) <= 255);
}

/** IP (v4/v6) veya baska sekilde kayit edilemeyen bir host mu? */
export function isIpHost(host) {
  return isIpv4Host(host) || host.includes(':');
}

/** URL ya da cıplak alan adi dizesinden normalize edilmis hostname cikarir. */
export function extractHostname(urlOrHost) {
  if (!urlOrHost) return '';
  const raw = String(urlOrHost).trim();
  if (!raw || isInternalUrl(raw)) return '';

  const candidate = raw.replace(/^\*\./, '');
  if (!candidate) return '';

  let host;
  try {
    const withScheme = candidate.includes('://') ? candidate : `http://${candidate}`;
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host) return '';

  // IPv6 koseli parantezli gelir: [::1]
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  if (isIpHost(host)) return host;

  // Sondaki nokta kanonik degildir (example.com. === example.com)
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return '';

  const labels = host.split('.');
  if (!labels.every(label => LABEL_RE.test(label))) return '';
  return host;
}

/** Hostname'i kanonik forma indirir (bastaki www. atilir). */
export function normalizeDomain(urlOrHost) {
  const host = extractHostname(urlOrHost);
  if (!host) return '';
  if (isIpHost(host)) return host;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Cerezin domain alanindan ("...example.com") host cikarir. */
export function hostFromCookieDomain(cookieDomain) {
  if (!cookieDomain) return '';
  const raw = String(cookieDomain).startsWith('.') ? String(cookieDomain).slice(1) : String(cookieDomain);
  return extractHostname(raw);
}

/** Public Suffix List algoritmasi: verilen etiket dizisinin kac etiketi "public suffix"tir? (co.uk -> 2, github.io -> 2, com -> 1) */
function publicSuffixLabelCount(labels) {
  const n = labels.length;
  const maxLen = Math.min(n, PSL_MAX_LABELS);

  // 1. Istisna kurallari en yuksek onceliklidir (!city.kawasaki.jp)
  for (let len = maxLen; len >= 2; len--) {
    if (pslException().has(labels.slice(n - len).join('.'))) return len - 1;
  }

  // 2. En uzun eslesen birebir veya joker kural kazanir
  for (let len = maxLen; len >= 2; len--) {
    const candidate = labels.slice(n - len).join('.');
    if (pslLiteral().has(candidate)) return len;
    // *.bd kurali: "bd" joker anahtaridir, onunden gelen tek etiket suffixe dahildir
    if (pslWildcard().has(labels.slice(n - len + 1).join('.'))) return len;
  }

  // 3. Bilinmeyen TLD: tek etiketli public suffix varsayilir
  return 1;
}

/** Hostname'in public suffix kismini doner (kayit edilemeyen ust bolum). */
export function getPublicSuffix(urlOrHost) {
  const host = extractHostname(urlOrHost);
  if (!host || isIpHost(host) || !host.includes('.')) return '';
  const labels = host.split('.');
  return labels.slice(labels.length - publicSuffixLabelCount(labels)).join('.');
}

/** Kayit edilebilir kok alan adi (registrable domain / eTLD+1). */
export function getRootDomain(urlOrHost) {
  const host = extractHostname(urlOrHost);
  if (!host) return '';
  if (isIpHost(host)) return host;

  const clean = host.startsWith('www.') ? host.slice(4) : host;
  const labels = clean.split('.');
  if (labels.length === 1) return clean;

  const suffixLen = publicSuffixLabelCount(labels);
  // Host'un kendisi public suffix ise (ornek: "github.io") daha fazla indirgeyemeyiz.
  if (labels.length <= suffixLen) return clean;
  return labels.slice(labels.length - suffixLen - 1).join('.');
}

/** Verilen hostlar icin http/https origin varyasyonlarini uretir. */
export function buildOrigins(hosts) {
  const origins = new Set();
  for (const raw of hosts) {
    const host = extractHostname(raw);
    if (!host) continue;
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
    if (!isIpHost(host) && !host.startsWith('www.')) {
      origins.add(`https://www.${host}`);
      origins.add(`http://www.${host}`);
    }
  }
  return [...origins];
}

/** Bir temizlik isleminin kapsamini tanimlar. */
export function createDomainScope(urlOrHost) {
  const host = extractHostname(urlOrHost);
  if (!host) return null;

  const clean = normalizeDomain(host);
  const root = getRootDomain(clean);
  const isRoot = clean === root;
  const base = isRoot ? root : clean;
  const ip = isIpHost(base);

  const matches = (candidateUrlOrHost) => {
    const candidate = normalizeDomain(candidateUrlOrHost);
    if (!candidate) return false;
    if (candidate === base) return true;
    if (ip) return false;
    return candidate.endsWith(`.${base}`);
  };

  return {
    /** Kapsamin cipa aldigi alan adi (kok kural icin kok, alt kural icin alt) */
    base,
    /** Girdinin www.'suz hali */
    host: clean,
    /** Girdinin kayit edilebilir kok alan adi */
    root,
    /** Girdi kok alan adinin kendisi mi? */
    isRoot,
    isIp: ip,
    matches,
    /** Bir cerezin bu kapsama girip girmedigini soyler */
    matchesCookie: (cookie) => matches(hostFromCookieDomain(cookie?.domain)),
    /** chrome.cookies.getAll icin en dar filtre (alt alan adlari dahil doner) */
    cookieFilterDomain: base,
    /** chrome.history.search icin metin filtresi */
    searchText: base,
    /** Kapsamdaki bilinen hostlardan browsingData origin listesi uretir */
    originsFor(extraHosts = []) {
      return buildOrigins([base, ...extraHosts].filter(h => !h || matches(h) || h === base));
    }
  };
}

export const TRACKING_PARAM_PATTERNS = Object.freeze([
  /^utm_/i,
  /^ga_/i,
  /^(?:fbclid|gclid|gbraid|wbraid|gad_source|mc_eid|igshid|yclid|_hsenc|_hsmi|mkt_tok|si|msclkid|dclid)$/i
]);

/**
 * URL'den bilinen pazarlama ve takip parametrelerini temizler.
 * Takip parametresi yoksa veya gecersiz URL ise girdiyi degistirmeden doner.
 */
export function stripTrackingParams(rawUrl) {
  if (!rawUrl || isInternalUrl(rawUrl)) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!url.search) return rawUrl;

    const toRemove = [];
    for (const key of url.searchParams.keys()) {
      if (TRACKING_PARAM_PATTERNS.some(re => re.test(key))) {
        toRemove.push(key);
      }
    }

    if (toRemove.length === 0) return rawUrl;

    for (const key of toRemove) {
      url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}
