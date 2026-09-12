// GhostTrace - Oturum Durumu.

import { recordStatsHistory } from './storage.js';

const KEY_TAB_MAP = 'gt_tabMap';
const KEY_THIRD_PARTY = 'gt_thirdParty';
// Karsilasma sayimi gt_thirdParty'den AYRI ve budanmaz: "neyi temizlemeliyim" ile "bu oturumda neyle karsilastim" farkli sorular.
const KEY_THIRD_PARTY_SEEN = 'gt_thirdPartySeen';
// Ziyaret edilen ana siteler.
const KEY_VISITED_ROOTS = 'gt_visitedRoots';
const KEY_LAST_SWEEP = 'gt_lastSweep';
const KEY_STORAGE_ESTIMATES = 'gt_storageEstimates';
const KEY_BOOTSTRAPPED = 'gt_bootstrapped';
const KEY_REMOVAL_POLICY = 'gt_removalPolicy';

export const MAX_THIRD_PARTY_HOSTS = 400;
export const MAX_PARENTS_PER_HOST = 5;

/** Oturum deposu. local'e YEDEK YOK ve bu bilincli: yedek, gezinti izini diske yazardi. */
function area() {
  return chrome.storage.session || null;
}

async function read(key, fallback) {
  if (!area()) return fallback;
  try {
    const data = await area().get(key);
    return data[key] === undefined ? fallback : data[key];
  } catch {
    return fallback;
  }
}

/** Birden cok anahtari TEK cagrida okur (her biri icin ayri get atmaz). */
async function readMany(keys) {
  if (!area()) return Object.fromEntries(keys.map(key => [key, {}]));
  try {
    const data = await area().get(keys);
    return Object.fromEntries(keys.map(key => [key, data[key] === undefined ? {} : data[key]]));
  } catch {
    return Object.fromEntries(keys.map(key => [key, {}]));
  }
}

/** Birden cok anahtari TEK cagrida yazar. */
async function writeMany(values) {
  if (!area()) return;
  try {
    await area().set(values);
    return true;
  } catch (err) {
    console.warn('[GhostTrace] Oturum durumu yazilamadi:', err);
    return false;
  }
}

async function write(key, value) {
  if (!area()) return;
  try {
    await area().set({ [key]: value });
    return true;
  } catch (err) {
    console.warn(`[GhostTrace] Oturum durumu yazilamadi (${key}):`, err);
    return false;
  }
}

// Sekme haritasi

let tabQueue = Promise.resolve();

/** Sekme haritasi uzerinde atomik okuma/yazma yapar. */
export function withTabMap(mutator) {
  const run = tabQueue.then(async () => {
    const tabMap = await read(KEY_TAB_MAP, {});
    const result = await mutator(tabMap);
    if (result && result.map) await write(KEY_TAB_MAP, result.map);
    return result?.value;
  });
  tabQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function getTabMap() {
  return read(KEY_TAB_MAP, {});
}

/** Sekmenin URL'sini kaydeder; onceki URL'yi dondurur. */
export async function setTabUrl(tabId, url) {
  return withTabMap(map => {
    const previous = map[tabId] || '';
    if (previous === url) return { value: previous };
    map[tabId] = url;
    return { map, value: previous };
  });
}

/** Sekme kaydini siler; silinen URL'yi dondurur. */
export async function removeTab(tabId) {
  return withTabMap(map => {
    const previous = map[tabId] || '';
    if (!(tabId in map)) return { value: '' };
    delete map[tabId];
    return { map, value: previous };
  });
}

/** Gercek sekme listesinden haritayi yeniden kurar. */
export async function reconcileTabMap(isInternalUrl) {
  try {
    const tabs = await chrome.tabs.query({});
    const map = {};
    for (const tab of tabs) {
      if (tab?.incognito === true) continue;
      if (tab?.id !== undefined && tab.url && !isInternalUrl(tab.url)) {
        map[tab.id] = tab.url;
      }
    }
    await withTabMap(() => ({ map, value: map }));
    return map;
  } catch (err) {
    console.warn('[GhostTrace] Sekme haritasi eslenemedi:', err);
    return {};
  }
}

/** Bu tarayici oturumunda bir kez calismasi gereken agir isler icin bayrak. */
export async function claimBootstrap() {
  const done = await read(KEY_BOOTSTRAPPED, false);
  if (done) return false;
  await write(KEY_BOOTSTRAPPED, true);
  return true;
}

// 3. taraf izleyici haritasi

/** Icerik script'inden gelen 3. taraf host raporlarini birikitirir. hosts: kok alan adina indirgenmis host listesi. */
/** Oturum haritalari icin SERI yazma kuyrugu: birden cok sekmeden gelen raporlar oku-degistir-yaz yarisinda birbirini eziyordu. */
let sessionQueue = Promise.resolve();
function enqueueSession(task) {
  const run = sessionQueue.then(task, task);
  sessionQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function recordThirdParty(parentHost, hosts) {
  if (!parentHost || !Array.isArray(hosts) || hosts.length === 0) return;
  // Kalici gecmis ayari acikSA diske de yazilir (varsayilan kapali).
  void recordStatsHistory('thirdParty', hosts.filter(h => h && h !== parentHost));
  return enqueueSession(() => recordThirdPartyUnsafe(parentHost, hosts));
}

async function recordThirdPartyUnsafe(parentHost, hosts) {
  // UC harita TEK get / TEK set ile.
  const { [KEY_THIRD_PARTY]: map, [KEY_THIRD_PARTY_SEEN]: seen, [KEY_VISITED_ROOTS]: ziyaret } =
    await readMany([KEY_THIRD_PARTY, KEY_THIRD_PARTY_SEEN, KEY_VISITED_ROOTS]);
  const now = Date.now();

  // Bildirimi GONDEREN sayfa, kullanicinin actigi sitedir.
  ziyaret[parentHost] = now;

  for (const host of hosts) {
    if (!host || host === parentHost) continue;
    const entry = map[host] || { count: 0, parents: [], lastSeen: 0 };
    entry.count++;
    entry.lastSeen = now;

    // KAYAN PENCERE: sabit ilk-N olsaydi populer bir CDN icin liste erken dolar, sonraki ana siteler hic girmez ve acik sayfanin altindan veri cekilirdi.
    if (!entry.parents.includes(parentHost)) {
      entry.parents.push(parentHost);
      if (entry.parents.length > MAX_PARENTS_PER_HOST) {
        entry.parents = entry.parents.slice(-MAX_PARENTS_PER_HOST);
      }
    }
    map[host] = entry;

    // Karsilasma sayimi: kac FARKLI ana sitede gorulduyse o anlamli buyukluk.
    const kayit = seen[host] || { count: 0, sites: [], lastSeen: 0 };
    kayit.count++;
    kayit.lastSeen = now;
    if (!kayit.sites.includes(parentHost)) kayit.sites.push(parentHost);
    seen[host] = kayit;
  }

  // Kapasite asilirsa en eski gorulenleri at (LRU).
  const seenKeys = Object.keys(seen);
  if (seenKeys.length > MAX_THIRD_PARTY_HOSTS) {
    seenKeys
      .sort((a, b) => (seen[a].lastSeen || 0) - (seen[b].lastSeen || 0))
      .slice(0, seenKeys.length - MAX_THIRD_PARTY_HOSTS)
      .forEach(key => delete seen[key]);
  }

  // Ziyaret kaydi da TAVANLI: en eski girilen siteler dusulur.
  const ziyaretKeys = Object.keys(ziyaret);
  if (ziyaretKeys.length > MAX_THIRD_PARTY_HOSTS) {
    ziyaretKeys
      .sort((a, b) => ziyaret[a] - ziyaret[b])
      .slice(0, ziyaretKeys.length - MAX_THIRD_PARTY_HOSTS)
      .forEach(key => delete ziyaret[key]);
  }

  const keys = Object.keys(map);
  if (keys.length > MAX_THIRD_PARTY_HOSTS) {
    keys
      .sort((a, b) => (map[a].lastSeen || 0) - (map[b].lastSeen || 0))
      .slice(0, keys.length - MAX_THIRD_PARTY_HOSTS)
      .forEach(key => delete map[key]);
  }

  await writeMany({
    [KEY_THIRD_PARTY]: map,
    [KEY_THIRD_PARTY_SEEN]: seen,
    [KEY_VISITED_ROOTS]: ziyaret
  });
}

export async function getThirdPartyMap() {
  return read(KEY_THIRD_PARTY, {});
}

/**
 * Bir ana sitenin ALTINDA gorulen 3. taraf alan adi sayisi.
 *
 * KAYNAK `gt_thirdPartySeen`, `gt_thirdParty` DEGIL. Ikisinin isi ayri ve bu
 * ayrim OLCULEREK ogrenildi (`test/e2e/sonda-ucuncuTarafSifir.mjs`):
 *
 *   gt_thirdParty     "neyi temizleyecegim" - temizlik onu BUDUYOR
 *                     (pruneThirdParty; scheduler, sweep ve toplu temizlik).
 *   gt_thirdPartySeen "bu oturumda neyle karsilastim" - hic budanmiyor,
 *                     `sites` listesinin kapagi yok (`parents` 5'te kapakli).
 *
 * Ilk surum `gt_thirdParty`'yi okuyordu ve sayi periyodik supurmeden sonra
 * SIFIRA dusuyordu: supurme yetim 3. taraflari temizleyip kayitlarini
 * dusuruyor, gozlemci de bir host'u sayfa ornegi basina YALNIZCA BIR KEZ
 * bildirdigi icin sayi sayfa yenilenene kadar 0 kaliyordu. Supurme varsayilan
 * acik ve saatlik; yani hatanin normal hali "genelde sifir"di.
 *
 * SINIR: sayim OTURUM boyunca o sitenin altinda gorulenleri kapsar, "su anda
 * yuklu olanlari" degil. Ayni siteyi oturumda ikinci kez gezmek sayiyi
 * biriktirebilir. Bu sayi bir iddia degil, bir isaret.
 *
 * @param {(host: string) => boolean} matchesParent Kapsam esleyici (createDomainScope().matches)
 */
export async function countThirdPartyUnder(matchesParent) {
  if (typeof matchesParent !== 'function') return 0;
  const seen = await read(KEY_THIRD_PARTY_SEEN, {});
  let count = 0;
  for (const info of Object.values(seen)) {
    if ((info?.sites || []).some(site => matchesParent(site))) count++;
  }
  return count;
}

/** Temizlenen host'un 3. taraf kaydini siler. `parents` listesine dokunmaz: haber.com'u temizlemek gstatic.com'un verisini temizlemez ve o kayit, orada veri bulundugunun tek sinyali. */
/** Bu oturumda karsilasilan 3. taraflarin sayimi. */
/** Bu oturumda ANA SITE olarak gorulen root alan adlari (host -> zaman). 3. taraf listesinden bunlari elemek icin kullanilir. */
export async function getVisitedRoots() {
  return read(KEY_VISITED_ROOTS, {});
}

export async function getThirdPartySeen() {
  return read(KEY_THIRD_PARTY_SEEN, {});
}

export async function pruneThirdParty(matches) {
  // KUYRUGA GIRER.
  return enqueueSession(async () => {
    const map = await read(KEY_THIRD_PARTY, {});
    let changed = false;

    for (const host of Object.keys(map)) {
      if (matches(host)) {
        delete map[host];
        changed = true;
      }
    }

    if (changed) await write(KEY_THIRD_PARTY, map);
  });
}

/** Ziyaret edilen kok kaydini siler. Onceden silme yolu HIC YOKTU. */
export async function clearVisitedRoots() {
  return enqueueSession(() => write(KEY_VISITED_ROOTS, {}));
}

export async function clearThirdPartySeen() {
  return enqueueSession(() => write(KEY_THIRD_PARTY_SEEN, {}));
}

export async function clearThirdParty() {
  return enqueueSession(() => write(KEY_THIRD_PARTY, {}));
}

// Depolama olcumleri (yalnizca RAPORLAMA).

export const MAX_STORAGE_ESTIMATES = 300;

/** Bir origin icin tarayicinin bildirdigi kullanim degerini saklar. */
export async function recordStorageEstimate(host, usage) {
  if (!host || !Number.isFinite(usage) || usage <= 0) return;
  return enqueueSession(() => recordStorageEstimateUnsafe(host, usage));
}

async function recordStorageEstimateUnsafe(host, usage) {
  const map = await read(KEY_STORAGE_ESTIMATES, {});
  map[host] = { usage: Math.round(usage), at: Date.now() };

  const keys = Object.keys(map);
  if (keys.length > MAX_STORAGE_ESTIMATES) {
    keys
      .sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
      .slice(0, keys.length - MAX_STORAGE_ESTIMATES)
      .forEach(key => delete map[key]);
  }

  await write(KEY_STORAGE_ESTIMATES, map);
}

export async function getStorageEstimates() {
  return read(KEY_STORAGE_ESTIMATES, {});
}

/** Eslesen origin'lerin olcumlerini toplar ve kayitlari SILER. */
export async function consumeStorageEstimates(matches) {
  // recordStorageEstimate ile AYNI kuyrukta: tuketme sirasinda gelen yeni bir olcum eskiden kaybolabiliyordu (oku-degistir-yaz yarisi).
  return enqueueSession(async () => {
    const map = await read(KEY_STORAGE_ESTIMATES, {});
    let total = 0;
    let changed = false;

    for (const [host, entry] of Object.entries(map)) {
      if (!matches(host)) continue;
      total += entry.usage || 0;
      delete map[host];
      changed = true;
    }

    if (changed) await write(KEY_STORAGE_ESTIMATES, map);
    return total;
  });
}

// Supurme kisitlamasi

/** Yetim domain taramasi pahalidir. */
/** Kurumsal politika durumu: oturum basi bir kez okunur, oturumla gider - kalici depoda eskimis politika kalmaz. */
export async function setRemovalPolicy(policy) {
  try {
    await chrome.storage.session.set({ [KEY_REMOVAL_POLICY]: policy });
  } catch {
    // Oturum deposu yoksa politika bilgisi yalnizca loglarda kalir.
  }
}

/** Doner: { history: boolean, downloads: boolean } | null (bilinmiyor) */
export async function getRemovalPolicy() {
  try {
    const data = await chrome.storage.session.get(KEY_REMOVAL_POLICY);
    return data?.[KEY_REMOVAL_POLICY] || null;
  } catch {
    return null;
  }
}

export async function claimSweepSlot(minIntervalMs) {
  const last = Number(await read(KEY_LAST_SWEEP, 0)) || 0;
  const now = Date.now();
  if (now - last < minIntervalMs) return false;
  await write(KEY_LAST_SWEEP, now);
  return true;
}

/** Kisitlamayi sifirlar (kullanici elle tetikledi). */
export async function resetSweepThrottle() {
  await write(KEY_LAST_SWEEP, 0);
}
