// GhostTrace - Depolama Katmani (Settings / Rules / Stats). onChanged ile gecersiz kilinan bellek ici onbellek, seri kuyrukta atomik yazma, sema surumu ve goc.

import { getRootDomain, normalizeDomain } from './domain.js';

export const SCHEMA_VERSION = 2;

/** Temizlik gecikmesi icin izinli en kucuk deger (0 = aninda). */
export const MIN_CLEAN_DELAY_SEC = 30;
export const MAX_CLEAN_DELAY_SEC = 600;

/** Periyodik supurme icin Chrome'un izin verdigi en kucuk aralik. */
export const MIN_PERIODIC_INTERVAL_MIN = 15;

export const LOG_LEVELS = ['off', 'error', 'info'];

/** Arayuz temasi. 'system' isletim sistemini izler (prefers-color-scheme). */
export const THEMES = Object.freeze(['system', 'light', 'dark']);

/** Beyaz listede hangi cerezler korunur: hepsi | yalnizca oturum | kalip. */
export const KEEP_MODES = Object.freeze(['all', 'session', 'custom']);

export const DEFAULT_STATS = Object.freeze({
  cookiesDeleted: 0,
  historyDeleted: 0,
  storageCleaned: 0,
  downloadsDeleted: 0,
  bytesFreed: 0,
  // Tarayicinin bildirdigi depolama kullanimi (TAHMIN, eskimis olabilir). bytesFreed ile KARISTIRILMAZ: o, silme aninda birebir olculen cerez ve gecmis kaydi buyuklugudur.
  storageBytesFreed: 0,
  totalCleans: 0,
  lastCleanedAt: null
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  enabled: true,

  // Sekme kapandiktan sonra beklenecek sure. 0 = aninda.
  cleanDelay: 60,

  cleanHistory: true,
  cleanCookies: true,
  cleanLocalStorage: true,
  cleanIndexedDB: true,
  cleanServiceWorkers: true,
  cleanDownloads: true,

  // DIKKAT: Bu ayar "onbellegi sil" ANLAMINA GELMEZ.
  cleanCacheOnPurgeAll: false,
  // Tarayici baslatildiginda korumasiz tum verileri tam supur.
  cleanOnStartup: false,

  whitelistCleanHistory: false,
  whitelistCleanDownloads: false,

  // URL'lerdeki izleme parametrelerini (utm_*, fbclid vb.) temizler.
  stripTrackingParams: true,

  // Varsayilan ACIK (v2.7.0): yalnizca yerel depolama tutan siteleri sekme kapanisi HIC gormuyor, tek ulasma yolu supurme.
  periodicCleanEnabled: true,
  periodicCleanInterval: 60,

  notifyOnClean: false,
  showBadgeCount: true,
  language: 'auto',

  // 3. taraf izleyici tespiti (icerik script'i uzerinden)
  trackThirdParty: true,

  // iframe'leri de izle.
  trackThirdPartyFrames: true,

  // Sag tik menusu.
  contextMenuEnabled: false,

  // Teshis loglari yalnizca oturum bellegindedir; 'off' tamamen kapatir.
  logLevel: 'info',
  theme: 'system',

  // Opsiyonel "privacy" izni verildiginde uygulanacak sertlestirmeler
  // Istatistik gecmisi: listeleri DISKE yazar. Ikisi de varsayilan KAPALI -
  // ziyaret edilen site listesi gezinti gecmisinin ta kendisidir.
  keepThirdPartyHistory: false,
  keepSiteHistory: false,
  // 'session' | 'daily' | 'weekly' | 'monthly' | 'unlimited'
  statsHistoryRetention: 'monthly',

  hardening: Object.freeze({
    blockThirdPartyCookies: false,
    // Asagidakiler UZAK SUNUCUDA iz olusmasini onler; silinemeyen izler.
    disableNetworkPrediction: false,
    disableRelatedWebsiteSets: false,
    disableSearchSuggest: false,
    disableAlternateErrorPages: false
  }),

  rules: Object.freeze({}),
  stats: DEFAULT_STATS
});

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

// Sadece bu dosyanin bildigi eski/olu anahtarlar - goc sirasinda silinir.
const LEGACY_KEYS = ['gt_logs', 'cleanCache', 'ungroupUnlisted'];

let cache = null;
let cacheReady = null;
let cacheGeneration = 0;

function invalidateCache() {
  cache = null;
  cacheReady = null;
  // Nesil sayaci: ucusta olan bir okuma tamamlandiginda kendi neslinin hala gecerli olup olmadigini bundan anlar.
  cacheGeneration++;
}

// Baska bir baglam (SW / popup / options) veri degistirdiginde onbellegi at.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (SETTINGS_KEYS.some(key => key in changes)) invalidateCache();
  });
}

function mergeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  merged.rules = { ...(raw?.rules || {}) };
  merged.stats = { ...DEFAULT_STATS, ...(raw?.stats || {}) };
  merged.hardening = { ...DEFAULT_SETTINGS.hardening, ...(raw?.hardening || {}) };
  return merged;
}

async function readFromDisk() {
  try {
    const raw = await chrome.storage.local.get(SETTINGS_KEYS);
    return mergeSettings(raw);
  } catch (err) {
    console.error('[GhostTrace] Ayarlar okunamadi:', err);
    return mergeSettings(null);
  }
}

/** Tum ayarlari (kurallar + istatistikler dahil) onbellekten getirir. */
export async function getSettings() {
  if (cache) return cache;
  if (!cacheReady) {
    const generation = cacheGeneration;
    cacheReady = readFromDisk().then(value => {
      // Okuma sirasinda gecersiz kilindiysa ONBELLEGE YAZMA.
      if (generation === cacheGeneration) cache = value;
      return value;
    });
  }
  return cacheReady;
}

/** Yalnizca kural nesnesini getirir. */
export async function getRules() {
  const settings = await getSettings();
  return settings.rules;
}

/** Yalnizca istatistikleri getirir. */
export async function getStats() {
  const settings = await getSettings();
  return settings.stats;
}

/** Ayar parcasini diske yazar. */
export async function updateSettings(partial) {
  const payload = { ...partial };
  if ('cleanDelay' in payload) payload.cleanDelay = clampCleanDelay(payload.cleanDelay);
  if ('periodicCleanInterval' in payload) payload.periodicCleanInterval = clampPeriodicInterval(payload.periodicCleanInterval);
  if ('logLevel' in payload && !LOG_LEVELS.includes(payload.logLevel)) payload.logLevel = DEFAULT_SETTINGS.logLevel;
  if ('theme' in payload && !THEMES.includes(payload.theme)) payload.theme = DEFAULT_SETTINGS.theme;

  try {
    invalidateCache();
    await chrome.storage.local.set(payload);
    return { ok: true };
  } catch (err) {
    const message = err?.message || String(err);
    console.error('[GhostTrace] Ayar yazma hatasi:', err);
    // Onbellegi tekrar gecersiz kil: yazma basarisizsa bellekteki iyimser durum diskle uyusmuyor olabilir.
    invalidateCache();
    return { ok: false, error: message };
  }
}

/** Gecikme degerini gecerli araliga oturtur: 0 veya [30, 600]. */
export function clampCleanDelay(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  if (parsed < MIN_CLEAN_DELAY_SEC) return MIN_CLEAN_DELAY_SEC;
  return Math.min(parsed, MAX_CLEAN_DELAY_SEC);
}

/** Periyodik aralik degerini gecerli araliga oturtur. */
export function clampPeriodicInterval(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.periodicCleanInterval;
  return Math.max(MIN_PERIODIC_INTERVAL_MIN, parsed);
}

// Seri yazma kuyrugu: kural ve istatistik guncellemelerinde read-modify-write yarisini engeller.
let writeQueue = Promise.resolve();

function enqueue(task) {
  const run = writeQueue.then(task, task);
  // Kuyrugu hatalarda kirmadan devam ettir
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Kurallari atomik olarak degistirir. mutator(rulesKopyasi) -> yeni kural nesnesi veya undefined (degisiklik yok). */
export async function mutateRules(mutator) {
  return enqueue(async () => {
    const current = await getSettings();
    const draft = structuredClone(current.rules);
    const next = await mutator(draft);
    if (next === undefined) return current.rules;
    invalidateCache();
    await chrome.storage.local.set({ rules: next });
    return next;
  });
}

/** Kurallari dogrudan kaydeder (ice aktarma / sifirlama gibi toplu islemler). */
export async function saveRules(rules) {
  return mutateRules(() => rules).then(() => true).catch(() => false);
}

/** Istatistikleri atomik olarak artirir. */
export async function incrementStats({ cookies = 0, history = 0, storage = 0, downloads = 0, bytes = 0, storageBytes = 0 } = {}) {
  const touched = cookies > 0 || history > 0 || storage > 0 || downloads > 0 || bytes > 0 || storageBytes > 0;
  if (!touched) return getStats();

  return enqueue(async () => {
    const current = await getSettings();
    const stats = {
      cookiesDeleted: (current.stats.cookiesDeleted || 0) + cookies,
      historyDeleted: (current.stats.historyDeleted || 0) + history,
      storageCleaned: (current.stats.storageCleaned || 0) + storage,
      downloadsDeleted: (current.stats.downloadsDeleted || 0) + downloads,
      bytesFreed: (current.stats.bytesFreed || 0) + bytes,
      storageBytesFreed: (current.stats.storageBytesFreed || 0) + storageBytes,
      totalCleans: (current.stats.totalCleans || 0) + 1,
      lastCleanedAt: Date.now()
    };
    invalidateCache();
    await chrome.storage.local.set({ stats });
    return stats;
  });
}

// --------------------------------------------------------------------------
// Istatistik gecmisi (opsiyonel, varsayilan KAPALI)
// --------------------------------------------------------------------------

/** Saklama suresi -> milisaniye. 'unlimited' icin null. */
export const RETENTION_MS = Object.freeze({
  // 'session': oturum icinde budanmaz, tarayici kapaninca TAMAMEN silinir
  // (silme sessionBootstrap'ta yapilir).
  session: null,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  unlimited: null
});

/** Bir alan adi kaydinin ust siniri; kota tasmasina karsi emniyet. */
export const HISTORY_MAX_ENTRIES = 20000;

const EMPTY_HISTORY = Object.freeze({ thirdParty: {}, sites: {} });

/** Kalici istatistik gecmisini okur: { thirdParty: {host:{n,t}}, sites: {...} }. */
export async function getStatsHistory() {
  try {
    const raw = (await chrome.storage.local.get('statsHistory'))?.statsHistory;
    return {
      thirdParty: raw?.thirdParty && typeof raw.thirdParty === 'object' ? raw.thirdParty : {},
      sites: raw?.sites && typeof raw.sites === 'object' ? raw.sites : {}
    };
  } catch {
    return { ...EMPTY_HISTORY };
  }
}

/** Saklama penceresi disinda kalan kayitlari ve tasan fazlaligi atar. */
export function pruneHistoryMap(map, retention, now = Date.now()) {
  // ?? KULLANILMAZ: 'unlimited' degeri null ve null ?? X -> X, yani sinirsiz
  // sessizce aylik olurdu (birim test yakaladi).
  const ms = Object.hasOwn(RETENTION_MS, retention) ? RETENTION_MS[retention] : RETENTION_MS.monthly;
  let entries = Object.entries(map || {});
  if (ms !== null) entries = entries.filter(([, v]) => (v?.t || 0) >= now - ms);
  // Kota emniyeti: en eskiden basla.
  if (entries.length > HISTORY_MAX_ENTRIES) {
    entries.sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0));
    entries = entries.slice(0, HISTORY_MAX_ENTRIES);
  }
  return Object.fromEntries(entries);
}

// YAZMA TOPLANIR, her raporda diske gidilmez.
//
// OLCULDU: her cagride tum blogu okuyup yazmak 20.000 kayitta rapor basina
// 84 ms suruyordu ve icerik script'i 3 saniyede bir, HER sekmeden rapor
// gonderiyor. Bekleyenler bellekte toplanir, FLUSH_MS sonra tek yazma yapilir.
// Bedeli: service worker olurse en fazla FLUSH_MS'lik kayit kaybolur -
// istatistik icin kabul edilebilir, temizligi etkilemez.
const FLUSH_MS = 5000;
const bekleyen = { thirdParty: new Map(), sites: new Map() };
let flushTimer = null;

function bekleyenVar() {
  return bekleyen.thirdParty.size > 0 || bekleyen.sites.size > 0;
}

/** Bekleyen sayimlari diske yazar. */
export async function flushStatsHistory() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!bekleyenVar()) return;

  const parti = {
    thirdParty: new Map(bekleyen.thirdParty),
    sites: new Map(bekleyen.sites)
  };
  bekleyen.thirdParty.clear();
  bekleyen.sites.clear();

  return enqueue(async () => {
    const gecmis = await getStatsHistory();
    const ayar = await getSettings();
    const now = Date.now();
    for (const kind of ['thirdParty', 'sites']) {
      if (parti[kind].size === 0) continue;
      // Ayar bu arada KAPATILMIS olabilir: "kapali = hicbir sey yazilmaz"
      // sozu, kayit alindiktan sonra kapatilan durumda da gecerli olmali.
      const acik = kind === 'thirdParty' ? ayar.keepThirdPartyHistory : ayar.keepSiteHistory;
      if (!acik) continue;
      const map = { ...gecmis[kind] };
      for (const [host, adet] of parti[kind]) {
        const kayit = map[host] || { n: 0, t: 0 };
        map[host] = { n: kayit.n + adet, t: now };
      }
      // Saklama suresi budamasi BAKIM ALARMINDA yapilir; burada yalnizca
      // kota tavani uygulanir, yoksa her yazmada tum harita taranirdi.
      gecmis[kind] = Object.keys(map).length > HISTORY_MAX_ENTRIES
        ? pruneHistoryMap(map, 'unlimited', now)
        : map;
    }
    try {
      await chrome.storage.local.set({ statsHistory: gecmis });
    } catch {
      // Kota dolu olabilir: gecmis kaybi temizligi etkilemez, sessiz gecilir.
    }
  });
}

/** Saklama suresini uygular; bakim alarmindan cagrilir. */
export async function pruneStatsHistory() {
  const settings = await getSettings();
  if (settings.statsHistoryRetention === 'session'
    || settings.statsHistoryRetention === 'unlimited') return;
  return enqueue(async () => {
    const gecmis = await getStatsHistory();
    const now = Date.now();
    gecmis.thirdParty = pruneHistoryMap(gecmis.thirdParty, settings.statsHistoryRetention, now);
    gecmis.sites = pruneHistoryMap(gecmis.sites, settings.statsHistoryRetention, now);
    try { await chrome.storage.local.set({ statsHistory: gecmis }); } catch { /* kota */ }
  });
}

/**
 * Alan adlarini kalici gecmise yazar. Ayar kapaliysa HICBIR SEY yazmaz.
 * Kayit basina yalnizca sayac ve son gorulme; hangi sitede gorulduyu SAKLANMAZ.
 */
export async function recordStatsHistory(kind, hosts) {
  if (kind !== 'thirdParty' && kind !== 'sites') return;
  const liste = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean);
  if (liste.length === 0) return;

  const settings = await getSettings();
  const acik = kind === 'thirdParty' ? settings.keepThirdPartyHistory : settings.keepSiteHistory;
  if (!acik) return;

  for (const host of liste) {
    bekleyen[kind].set(host, (bekleyen[kind].get(host) || 0) + 1);
  }
  if (!flushTimer) flushTimer = setTimeout(() => void flushStatsHistory(), FLUSH_MS);
}

/** Bekleyen tamponu atar; yoksa silinen gecmis bir sonraki flush'ta geri gelir. */
function bekleyeniAt(kind = null) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (kind) bekleyen[kind]?.clear();
  else { bekleyen.thirdParty.clear(); bekleyen.sites.clear(); }
}

/** Gecmisi siler. kind verilmezse ikisini de. */
export async function clearStatsHistory(kind = null) {
  bekleyeniAt(kind);
  return enqueue(async () => {
    const gecmis = kind ? await getStatsHistory() : { thirdParty: {}, sites: {} };
    if (kind) gecmis[kind] = {};
    await chrome.storage.local.set({ statsHistory: gecmis });
    return gecmis;
  });
}

/** Istatistikleri sifirlar. */
export async function resetStats() {
  invalidateCache();
  await chrome.storage.local.set({ stats: { ...DEFAULT_STATS } });
  return { ...DEFAULT_STATS };
}

/** Yalnizca temizlik ayarlarini sifirlar; kurallar ve istatistikler korunur. */
export async function resetOnlySettings() {
  const current = await getSettings();
  const payload = { ...DEFAULT_SETTINGS, rules: current.rules, stats: current.stats };
  invalidateCache();
  await chrome.storage.local.set(payload);
  return payload;
}

/** Yalnizca site kurallarini sifirlar. */
export async function resetOnlyRules() {
  await mutateRules(() => ({}));
  return true;
}

/** Fabrika ayarlarina tam donus. */
export async function resetToFactoryDefaults() {
  invalidateCache();
  // Bekleyen gecmis de atilir; yoksa sifirlamadan sonraki flush geri yazardi.
  bekleyeniAt();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS });
  invalidateCache();
  return { ...DEFAULT_SETTINGS };
}

// Goc (migration)

/** Depolamayi guncel semaya tasir. */
export async function runMigrations() {
  const raw = await chrome.storage.local.get(null);
  const from = Number.parseInt(raw.schemaVersion, 10) || 1;
  const patch = {};
  const report = { from, to: SCHEMA_VERSION, changes: [] };

  // 1. Kural anahtarlarini kanoniklestir, gecersiz/suresi dolmus olanlari at.
  if (raw.rules && typeof raw.rules === 'object') {
    const cleaned = {};
    let mutated = false;
    const now = Date.now();

    for (const [key, rule] of Object.entries(raw.rules)) {
      if (!rule || typeof rule !== 'object') { mutated = true; continue; }

      const host = normalizeDomain(rule.domain || key);
      if (!host) { mutated = true; continue; }
      if (host !== key) mutated = true;

      // Suresi dolmus gecici izinler kural listesinde kalmamali.
      if (rule.type === 'temp' && rule.expiresAt && rule.expiresAt <= now) {
        mutated = true;
        continue;
      }

      const candidate = {
        domain: host,
        type: ['white', 'grey', 'temp'].includes(rule.type) ? rule.type : 'white',
        // Kapsam varsayilani normalizeRule ile ayni: kok -> ACIK, alt alan -> KAPALI.
        subdomains: host !== getRootDomain(host) ? rule.subdomains === true : rule.subdomains !== false,
        expiresAt: rule.type === 'temp' ? (Number(rule.expiresAt) || null) : null,
        durationMinutes: rule.type === 'temp' ? (Number(rule.durationMinutes) || null) : null,
        keepMode: KEEP_MODES.includes(rule.keepMode) ? rule.keepMode : 'all',
        keepCookies: Array.isArray(rule.keepCookies) ? rule.keepCookies.filter(x => typeof x === 'string') : [],
        addedAt: Number(rule.addedAt) || now,
        updatedAt: Number(rule.updatedAt) || now
      };

      // Alan duzeyinde de kanoniklestiriyoruz, yalnizca anahtar duzeyinde degil. `mutated` eskiden SADECE anahtar degisimini/dusurmeyi izliyordu; eksik alan tasiyan eski bir kural (ornegin `subdomains` hic yazilmamis) hicbir zaman yeniden yazilmiyor ve kanonik olmayan haliyle diskte kaliyordu - goc adiminin adi "kanoniklestir" olmasina ragmen.
      if (!mutated && JSON.stringify(candidate) !== JSON.stringify(rule)) mutated = true;

      // Ayni kanonik host icin cakisma varsa (x.com + www.x.com) en yeniyi tut.
      const existing = cleaned[host];
      if (!existing || (candidate.updatedAt || 0) >= (existing.updatedAt || 0)) {
        cleaned[host] = candidate;
      }
      if (existing) mutated = true;
    }

    if (mutated) {
      patch.rules = cleaned;
      report.changes.push(`kurallar kanoniklestirildi (${Object.keys(raw.rules).length} -> ${Object.keys(cleaned).length})`);
    }
  }

  // 2. Gecikme degeri MV3 alarm sinirina uydurulur.
  const clampedDelay = clampCleanDelay(raw.cleanDelay ?? DEFAULT_SETTINGS.cleanDelay);
  if (clampedDelay !== raw.cleanDelay) {
    patch.cleanDelay = clampedDelay;
    report.changes.push(`cleanDelay ${raw.cleanDelay} -> ${clampedDelay} sn`);
  }

  const clampedInterval = clampPeriodicInterval(raw.periodicCleanInterval ?? DEFAULT_SETTINGS.periodicCleanInterval);
  if (clampedInterval !== raw.periodicCleanInterval) {
    patch.periodicCleanInterval = clampedInterval;
  }

  // 3. Eski global "cleanCache" ayari yeni anlamina tasinir.
  if (typeof raw.cleanCache === 'boolean' && raw.cleanCacheOnPurgeAll === undefined) {
    patch.cleanCacheOnPurgeAll = raw.cleanCache;
    report.changes.push('cleanCache -> cleanCacheOnPurgeAll');
  }

  // 4. Eksik yeni ayarlar varsayilanla doldurulur.
  for (const key of SETTINGS_KEYS) {
    if (raw[key] === undefined && patch[key] === undefined && key !== 'rules' && key !== 'stats') {
      patch[key] = DEFAULT_SETTINGS[key];
    }
  }

  patch.schemaVersion = SCHEMA_VERSION;

  // 5. Diskteki teshis loglari gizlilik gerekcesiyle silinir.
  const legacyToRemove = LEGACY_KEYS.filter(key => key in raw);
  if (legacyToRemove.length) {
    report.changes.push(`eski anahtarlar silindi: ${legacyToRemove.join(', ')}`);
  }

  invalidateCache();
  if (legacyToRemove.length) await chrome.storage.local.remove(legacyToRemove);
  await chrome.storage.local.set(patch);
  invalidateCache();

  return report;
}

/** Testler icin: bellek ici onbellegi zorla temizler. */
export function __resetCacheForTests() {
  invalidateCache();
}
