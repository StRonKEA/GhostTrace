// GhostTrace - Temizlik motoru: yonetim ve dis yuzey.

import { buildOrigins, createDomainScope, hostFromCookieDomain, normalizeDomain } from '../domain.js';

import { fetchCookies, removeCookies } from '../cookies.js';
import { searchHistoryPaged, deleteHistoryItems } from '../history.js';
import { incrementStats, recordStatsHistory } from '../storage.js';
import { logInfo, logSuccess, logWarn, logError, LogCategory } from '../logger.js';
import { notify } from '../notify.js';
import { hasAllSitesAccess, hasHostAccess } from '../privacy.js';
import { consumeStorageEstimates, getStorageEstimates, getThirdPartyMap, getRemovalPolicy } from '../session-state.js';
import {
  EMPTY_RESULT, BULK_HISTORY_BUDGET_MS, ERASE_CHUNK_SIZE
} from './constants.js';
import {
  chunked, createPurgeContext, openTabHosts, buildProtectedOrigins,
  needsSubdomainDiscovery, discoverProtectedSubdomains
} from './context.js';
import { cleanCookiesForScope, raporlaGeriKonamayan } from './cookies.js';
import { cleanHistoryForScope, cleanHistoryForDomain, readRemovalPolicy } from './history.js';
import { cleanDownloadsForScope, cleanDownloadsForDomain } from './downloads.js';
import { storageTypesFor, cleanStorageForScope } from './storage.js';

// Alt modullerin dis yuzeyini buradan da veriyoruz: tuketiciler tek bir giris noktasi gorur, ama bir hatayi ararken dogru dosyaya gidebilir.
export {
  createPurgeContext, cleanCookiesForScope, cleanHistoryForScope,
  cleanHistoryForDomain, cleanDownloadsForScope, cleanDownloadsForDomain,
  cleanStorageForScope, readRemovalPolicy
};

/** Bir alan adinin butun izlerini siler. */
export async function purgeDomain(hostOrUrl, options = {}) {
  const scope = createDomainScope(hostOrUrl);
  if (!scope) return { ...EMPTY_RESULT };

  const ctx = options.matchFor ? options : await createPurgeContext(options);
  const match = ctx.matchFor(scope.base);

  // keepMode 'custom'/'session' ise burada durmayiz: her alt temizleyici kendi korumasini uygular (isHistory/Download/Storage/CookieProtected).
  if (ctx.isFullyProtected(scope.base)) {
    await logInfo(LogCategory.PURGE, `Korumali liste (${match.type}); temizlik yapilmadi`, { ruleType: match.type }, scope.base);
    return { ...EMPTY_RESULT, protected: true, ruleType: match.type };
  }

  // Site erisimi kontrolu MOTORUN TEK GIRISINDE: erisim daraltilmissa API'ler sessizce bos doner ve "Temizlendi | cerez: 0" diye yanlis rapor cikar.
  if (!await hasHostAccess(`https://${scope.base}/`)) {
    await logError(
      LogCategory.PURGE,
      'Site erisimi kisitli; temizlik YAPILAMADI. chrome://extensions -> Site erisimi ayarini kontrol edin.',
      { host: scope.base },
      scope.base
    );
    return { ...EMPTY_RESULT, noHostAccess: true };
  }

  await logInfo(LogCategory.PURGE, 'Temizlik basliyor', { reason: options.reason || 'manual' }, scope.base);

  // 1. Gecmis once temizlenir: sildigimiz URL'lerden gercek origin listesi cikar.
  let historyResult = { count: 0, bytes: 0, origins: new Set(), truncated: false };
  if (ctx.settings.cleanHistory !== false) {
    historyResult = await cleanHistoryForScope(scope, ctx);
  }

  // 2. Cerez ve indirme kayitlari paralel
  const [cookieResult, downloadResult] = await Promise.all([
    ctx.settings.cleanCookies !== false ? cleanCookiesForScope(scope, ctx) : Promise.resolve({ count: 0, bytes: 0, hosts: new Set() }),
    ctx.settings.cleanDownloads !== false ? cleanDownloadsForScope(scope, ctx) : Promise.resolve({ count: 0 })
  ]);

  // 3. Depolama: cerezlerden, gecmisten ve acik sekmelerden kesfedilen tum kapsam ici hostlar origin listesine girer.
  const discoveredHosts = new Set(cookieResult.hosts);
  for (const origin of historyResult.origins) {
    const host = normalizeDomain(origin);
    if (host) discoveredHosts.add(host);
  }
  for (const host of await openTabHosts()) {
    if (scope.matches(host)) discoveredHosts.add(host);
  }
  // Depolama olcumu de bir KESIF kaynagidir: yalnizca IndexedDB tutan bir alt alan adi cerez/gecmis listesine girmez, olcum olmadan diskte kalirdi.
  for (const host of Object.keys(await getStorageEstimates())) {
    if (scope.matches(host)) discoveredHosts.add(host);
  }

  const storageResult = await cleanStorageForScope(scope, ctx, discoveredHosts);

  // Tarayicinin bildirdigi depolama kullanimi (sayfa acikken olculmustu).
  const storageBytes = await consumeStorageEstimates(
    host => scope.matches(host) && !ctx.isStorageProtected(host)
  );

  const result = {
    cookies: cookieResult.count,
    history: historyResult.count,
    downloads: downloadResult.count,
    storage: storageResult.count,
    // Yalnizca gercekten olculen buyuklukler toplanir.
    bytes: cookieResult.bytes + historyResult.bytes,
    truncated: historyResult.truncated,
    // > 0 ise temizlik yarim kalmistir; cagiran taraf yeni bir olayda devam ettirmeli (service-worker.js -> runScheduledPurge).
    remaining: historyResult.remaining || 0,
    storageBytes
  };

  await incrementStats({
    cookies: result.cookies, history: result.history, downloads: result.downloads,
    storage: result.storage, bytes: result.bytes, storageBytes: result.storageBytes
  });

  // Kalici site gecmisi (varsayilan kapali): yalnizca GERCEKTEN iz silinmisse.
  if (result.cookies > 0 || result.history > 0 || result.storage > 0 || result.downloads > 0) {
    void recordStatsHistory('sites', scope.base);
  }

  await logSuccess(
    LogCategory.PURGE,
    `Temizlendi | cerez: ${result.cookies}, gecmis: ${result.history}, indirme: ${result.downloads}, origin: ${result.storage}`,
    result,
    scope.base
  );

  if (ctx.settings.notifyOnClean && (result.cookies > 0 || result.history > 0 || result.downloads > 0)) {
    await notify({
      titleKey: 'serviceWorker.siteCleanedTitle',
      messageKey: 'serviceWorker.siteCleanedMsg',
      params: { domain: scope.base, cookies: result.cookies, history: result.history },
      tag: 'clean'
    });
  }

  return result;
}

/** Beyaz/gri/gecici listede olmayan TUM sitelerin izlerini siler. */
export async function purgeAllNonWhitelisted(options = {}) {
  const ctx = options.matchFor ? options : await createPurgeContext(options);

  const result = {
    cookies: 0,
    history: 0,
    downloads: 0,
    storage: 0,
    bytes: 0,
    truncated: false,
    remaining: 0,
    cacheCleared: false,
    // Sessiz atlama YOK: acik oldugu icin dokunulmayan siteler raporlanir.
    skippedOpen: 0,
    skippedOpenDomains: [],
    // Site erisimi daraltilmissa toplu temizlik EKSIK kalir ama bunu goremez.
    limitedAccess: false
  };

  // Kullanici chrome://extensions'ta site erisimini daralttiysa chrome.cookies erisilemeyen hostlari HIC dondurmez: toplu temizlik onlarin var oldugunu bile bilmez ve "N cerez silindi" diye tam basari raporlar.
  if (!await hasAllSitesAccess()) {
    result.limitedAccess = true;
    await logError(
      LogCategory.PURGE,
      'Site erisimi daraltilmis: toplu temizlik erisilemeyen siteleri GOREMEZ, sonuc eksik olabilir'
    );
  }

  const knownHosts = new Set();

  // Acik sekmesi olan siteye dokunulmaz - sekme kapanisi yolundaki kuralin aynisi.
  const openHosts = await openTabHosts();
  const atlananlar = new Set();
  const acikSekmeVar = (hostOrUrl) => {
    if (openHosts.size === 0) return false;
    const scope = createDomainScope(hostOrUrl);
    if (!scope) return false;
    for (const openHost of openHosts) {
      if (scope.matches(openHost)) { atlananlar.add(scope.base); return true; }
    }
    return false;
  };

  // Kesif silme ayarlarindan BAGIMSIZ: knownHosts yalnizca koruma listesini besler.
  const kesifGerekli = needsSubdomainDiscovery(ctx);

  try {
    // Cerez listesi silme ayarindan BAGIMSIZ cekilir.
    const cookies = (ctx.settings.cleanCookies !== false || kesifGerekli)
      ? await fetchCookies()
      : [];
    for (const cookie of cookies) {
      const host = hostFromCookieDomain(cookie.domain);
      if (host) knownHosts.add(host);
    }

    // 1. Cerezler
    if (ctx.settings.cleanCookies !== false) {
      const targets = [];
      for (const cookie of cookies) {
        const host = hostFromCookieDomain(cookie.domain);
        if (ctx.isCookieProtected(cookie)) continue;
        if (host && acikSekmeVar(host)) continue;
        targets.push(cookie);
      }
      // Tek site yoluyla AYNI dongu (lib/cookies.js removeCookies): parcali calisir, sayaclari ve geri koyma raporunu ayni sekilde uretir.
      const outcome = await removeCookies(targets, {
        shouldPreserve: (candidate) => ctx.isCookieProtected(candidate),
        protectedHosts: ctx.protectedHosts
      });
      result.cookies += outcome.count;
      result.bytes += outcome.bytes;
      await raporlaGeriKonamayan(outcome.failedRestores);
    }

    // 2. Gecmis.
    //
    // TAM SILME YOLU: "beyaz listenin gecmisini de temizle" acikSA gecmis
    // filtresiz silinir. Sebep olculdu - chrome.history.search() veritabanindaki
    // bazi satirlari HIC dondurmuyor (arama motoru URL'leri ve yonlendirme
    // artiklari), yani secici silme onlara ulasamiyor: "google.com/search?q=..."
    // ve ona bagli arama terimi diskte kaliyor ve adres cubugunu besliyor.
    // Filtresiz cagri hepsini goturur; cerezlere ve oturumlara DOKUNMAZ
    // (olculdu: cerez 11->11, github 6->6, gecmis 3->0).
    // Ayar kapaliyken bu yol kullanilmaz - kullanici beyaz listenin gecmisini
    // saklamak istiyordur ve filtresiz silme onu da goturur.
    const tamSilme = ctx.settings.cleanHistory !== false
      && ctx.settings.whitelistCleanHistory === true;

    if (tamSilme) {
      // Politika oturum basi okunup session'a yazilir (bootstrap.js);
      // ctx uzerinde boyle bir alan YOK - dogrudan kaynagindan okunur.
      const politika = await getRemovalPolicy();
      if (politika && politika.history === false) {
        await logWarn(LogCategory.PURGE,
          'Kurumsal politika gecmis silmeyi engelliyor; tam silme atlandi');
      } else {
        const oncekiSayim = (await searchHistoryPaged({ text: '' })).items.length;
        try {
          await chrome.browsingData.remove({}, { history: true });
          result.history += oncekiSayim;
          await logSuccess(LogCategory.PURGE,
            `Gecmis TAMAMEN silindi (${oncekiSayim} kayit) - secici silmenin ulasamadigi ` +
            'arama motoru izleri dahil');
        } catch (err) {
          await logWarn(LogCategory.PURGE,
            `Tam gecmis silme basarisiz: ${err.message}`, { error: String(err) });
        }
      }
    }

    if (!tamSilme && ctx.settings.cleanHistory !== false) {
      const { items, truncated } = await searchHistoryPaged({
        text: '',
        filter: (item) => {
          const host = normalizeDomain(item.url);
          if (host) knownHosts.add(host);
          if (ctx.isHistoryProtected(item.url)) return false;
          return !(host && acikSekmeVar(host));
        }
      });
      result.truncated = truncated;

      // Parcali + butceli silme lib/history.js deleteHistoryItems icinde: ayni dongu burada ikinci kez yaziliydi (parcalama, butce kontrolu, politika reddini sayma - hepsi kopya).
      const deletion = await deleteHistoryItems(items, { budgetMs: BULK_HISTORY_BUDGET_MS });
      result.history += deletion.count;
      result.bytes += deletion.bytes;
      result.remaining = deletion.remaining;

      if (deletion.remaining > 0) {
        await logWarn(
          LogCategory.PURGE,
          `Toplu gecmis temizligi butceye takildi; ${deletion.remaining} kayit kaldi`,
          { remaining: deletion.remaining }
        );
      }
      if (deletion.failed > 0) {
        await logWarn(
          LogCategory.PURGE,
          `${deletion.failed} gecmis kaydi silinemedi (kurumsal politika gecmis silmeyi engelliyor olabilir)`,
          { failed: deletion.failed, deleted: deletion.count }
        );
      }
    } else if (kesifGerekli) {
      // Gecmis TEMIZLIGI kapali ama koruma listesi yine de beslenmeli.
      for (const host of await discoverProtectedSubdomains(ctx)) knownHosts.add(host);
    }

    // 3. Indirme kayitlari
    if (ctx.settings.cleanDownloads !== false && chrome.downloads?.search) {
      const items = await chrome.downloads.search({});
      const targets = items.filter(item =>
        item?.url && !ctx.isDownloadProtected(item.url) && !acikSekmeVar(item.url));
      for (const chunk of chunked(targets, ERASE_CHUNK_SIZE)) {
        const erased = await Promise.all(
          chunk.map(item => chrome.downloads.erase({ id: item.id }).then(() => true, () => false))
        );
        result.downloads += erased.filter(Boolean).length;
      }
    }

    // 4. Depolama: korumali origin'ler haric. excludeOrigins "bunlar HARIC her seyi sil" demek.
    for (const host of await openTabHosts()) knownHosts.add(host);
    for (const host of Object.keys(await getStorageEstimates())) knownHosts.add(host);
    for (const host of Object.keys(await getThirdPartyMap())) knownHosts.add(host);
    // Depolama tarafinda da ayni koruma: acik sekmelerin origin'leri excludeOrigins listesine eklenir.
    const protectedOrigins = [
      ...new Set([
        ...await buildProtectedOrigins(ctx, knownHosts),
        ...buildOrigins([...openHosts])
      ])
    ];
    const types = storageTypesFor(ctx.settings);

    // originTypes bilerek verilmez: bu bir SUPURME, protectedWeb eklemek kurulu uygulamalarin verisini de silerdi.
    try {
      if (protectedOrigins.length > 0) {
        await chrome.browsingData.remove({ excludeOrigins: protectedOrigins }, types);
      } else {
        await chrome.browsingData.remove({}, types);
      }
      result.storage = 1;
    } catch (err) {
      await logWarn(LogCategory.STORAGE, `Toplu depolama temizleme uyarisi: ${err.message}`, { error: String(err) });
    }

    // 5. Global onbellek: yalnizca origin filtresine GIRMEYEN agsal izler (HSTS, QUIC/alt-svc, zero-suggest).
    if (ctx.settings.cleanCacheOnPurgeAll) {
      try {
        await chrome.browsingData.remove({}, { cache: true });
        result.cacheCleared = true;
        await logInfo(LogCategory.STORAGE, 'Global onbellek temizligi: origin filtresine girmeyen ag izleri (HSTS, QUIC, arama onerisi) de silindi');
      } catch (err) {
        await logWarn(LogCategory.STORAGE, `Onbellek temizleme uyarisi: ${err.message}`, { error: String(err) });
      }
    }

    // Olcum burada tuketilir; yoksa ayni baytlar sonraki temizlikte bir kez daha sayilir.
    const storageBytes = await consumeStorageEstimates(host => !ctx.isStorageProtected(host));

    await incrementStats({
      cookies: result.cookies,
      history: result.history,
      downloads: result.downloads,
      storage: result.storage,
      bytes: result.bytes,
      storageBytes
    });
    result.storageBytes = storageBytes;

    result.skippedOpen = atlananlar.size;
    result.skippedOpenDomains = [...atlananlar];
    if (atlananlar.size > 0) {
      await logInfo(
        LogCategory.PURGE,
        `${atlananlar.size} site ACIK oldugu icin atlandi; sekmeleri kapaninca temizlenecekler`,
        { domains: [...atlananlar] }
      );
    }

    await logSuccess(
      LogCategory.PURGE,
      `Toplu temizlik tamam | cerez: ${result.cookies}, gecmis: ${result.history}, indirme: ${result.downloads}`,
      result
    );
  } catch (err) {
    await logError(LogCategory.PURGE, `Toplu temizlik hatasi: ${err.message}`, { error: String(err) });
    console.error('[GhostTrace] Toplu temizlik hatasi:', err);
  }

  return result;
}

/** Birden fazla alan adini sirayla temizler; korumali olanlari atlar. */
export async function purgeDomains(domains, options = {}) {
  const ctx = options.matchFor ? options : await createPurgeContext(options);
  const summary = {
    count: 0, skippedProtected: 0,
    cookies: 0, history: 0, downloads: 0, storage: 0, bytes: 0,
    truncated: false, remaining: 0,
    // GERCEKTEN temizlenenler.
    purgedDomains: []
  };

  for (const domain of domains) {
    const scope = createDomainScope(domain);
    if (!scope) continue;
    // TAM korumali olanlar atlanir; keepMode ile secici olanlar islenir (bkz. purgeDomain).
    if (ctx.isFullyProtected(scope.base)) {
      summary.skippedProtected++;
      continue;
    }
    const result = await purgeDomain(scope.base, ctx);
    if (result.protected) {
      summary.skippedProtected++;
      continue;
    }
    summary.count++;
    summary.purgedDomains.push(scope.base);
    summary.cookies += result.cookies;
    summary.history += result.history;
    summary.downloads += result.downloads;
    summary.storage += result.storage;
    summary.bytes += result.bytes;
    summary.truncated = summary.truncated || Boolean(result.truncated);
    summary.remaining += result.remaining || 0;
  }

  return summary;
}
