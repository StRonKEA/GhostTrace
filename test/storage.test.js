import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';

let chromeStub = installChromeStub();

const storage = await import('../lib/storage.js');
const logger = await import('../lib/logger.js');
const i18n = await import('../lib/i18n.js');

beforeEach(() => {
  chromeStub = installChromeStub();
  storage.__resetCacheForTests();
  logger.__resetLoggerForTests();
});

describe('getSettings', () => {
  test('varsayilanlarla birlestirir', async () => {
    const settings = await storage.getSettings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.cleanDelay, 60);
    assert.deepEqual(settings.rules, {});
    assert.equal(settings.stats.cookiesDeleted, 0);
    assert.equal(settings.schemaVersion, storage.SCHEMA_VERSION);
  });

  test('C2: tekrarli cagrilar diski YENIDEN OKUMAZ', async () => {
    await storage.getSettings();
    const readsAfterFirst = chromeStub._storage.local.readCount;
    await storage.getSettings();
    await storage.getRules();
    await storage.getStats();
    assert.equal(chromeStub._storage.local.readCount, readsAfterFirst,
      'onbellek sayesinde ek disk okumasi olmamali');
  });

  test('yazma onbellegi gecersiz kilar', async () => {
    await storage.getSettings();
    await storage.updateSettings({ cleanDelay: 120 });
    assert.equal((await storage.getSettings()).cleanDelay, 120);
  });

  test('baska baglamdan gelen degisiklik onbellegi gecersiz kilar', async () => {
    assert.equal((await storage.getSettings()).enabled, true);
    // storage.onChanged dinleyicisi uzerinden
    await chrome.storage.local.set({ enabled: false });
    assert.equal((await storage.getSettings()).enabled, false);
  });
});

describe('clamp fonksiyonlari', () => {
  test('C4: cleanDelay 0 veya en az 30 saniyedir (MV3 alarm siniri)', () => {
    assert.equal(storage.clampCleanDelay(0), 0);
    assert.equal(storage.clampCleanDelay(-5), 0);
    assert.equal(storage.clampCleanDelay(1), 30);
    assert.equal(storage.clampCleanDelay(29), 30);
    assert.equal(storage.clampCleanDelay(30), 30);
    assert.equal(storage.clampCleanDelay(60), 60);
    assert.equal(storage.clampCleanDelay(99999), 600);
    assert.equal(storage.clampCleanDelay('abc'), 0);
  });

  test('periyodik aralik en az 15 dakikadir', () => {
    assert.equal(storage.clampPeriodicInterval(5), 15);
    assert.equal(storage.clampPeriodicInterval(60), 60);
    assert.equal(storage.clampPeriodicInterval('x'), 60);
  });

  test('updateSettings degerleri araliga oturtur', async () => {
    await storage.updateSettings({ cleanDelay: 7, periodicCleanInterval: 2, logLevel: 'saçma' });
    const settings = await storage.getSettings();
    assert.equal(settings.cleanDelay, 30);
    assert.equal(settings.periodicCleanInterval, 15);
    assert.equal(settings.logLevel, 'info');
  });
});

describe('incrementStats', () => {
  test('es zamanli artislar kaybolmaz (atomik kuyruk)', async () => {
    await Promise.all(Array.from({ length: 20 }, () => storage.incrementStats({ cookies: 1, bytes: 10 })));
    const stats = await storage.getStats();
    assert.equal(stats.cookiesDeleted, 20);
    assert.equal(stats.bytesFreed, 200);
    assert.equal(stats.totalCleans, 20);
  });

  test('bos artis kayit olusturmaz', async () => {
    await storage.incrementStats({});
    assert.equal((await storage.getStats()).totalCleans, 0);
  });
});

describe('mutateRules', () => {
  test('es zamanli kural yazmalari birbirini ezmez', async () => {
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => storage.mutateRules(rules => {
        rules[`site${i}.com`] = { domain: `site${i}.com`, type: 'white' };
        return rules;
      }))
    );
    const rules = await storage.getRules();
    assert.equal(Object.keys(rules).length, 15);
  });

  test('undefined dondurmek degisiklik yapmaz', async () => {
    await storage.mutateRules(() => ({ 'a.com': { domain: 'a.com', type: 'white' } }));
    const writes = chromeStub._storage.local.writeCount;
    await storage.mutateRules(() => undefined);
    assert.equal(chromeStub._storage.local.writeCount, writes);
    assert.equal(Object.keys(await storage.getRules()).length, 1);
  });
});

describe('sifirlama', () => {
  test('resetOnlySettings kurallari ve istatistikleri korur', async () => {
    await storage.mutateRules(() => ({ 'a.com': { domain: 'a.com', type: 'white' } }));
    await storage.incrementStats({ cookies: 5 });
    await storage.updateSettings({ cleanDelay: 300, notifyOnClean: true });

    await storage.resetOnlySettings();
    const settings = await storage.getSettings();
    assert.equal(settings.cleanDelay, 60);
    assert.equal(settings.notifyOnClean, false);
    assert.equal(Object.keys(settings.rules).length, 1);
    assert.equal(settings.stats.cookiesDeleted, 5);
  });

  test('resetOnlyRules yalnizca kurallari siler', async () => {
    await storage.mutateRules(() => ({ 'a.com': { domain: 'a.com', type: 'white' } }));
    await storage.updateSettings({ cleanDelay: 300 });
    await storage.resetOnlyRules();
    const settings = await storage.getSettings();
    assert.deepEqual(settings.rules, {});
    assert.equal(settings.cleanDelay, 300);
  });

  test('resetToFactoryDefaults her seyi sifirlar', async () => {
    await storage.mutateRules(() => ({ 'a.com': { domain: 'a.com', type: 'white' } }));
    await storage.incrementStats({ cookies: 5 });
    await storage.resetToFactoryDefaults();
    const settings = await storage.getSettings();
    assert.deepEqual(settings.rules, {});
    assert.equal(settings.stats.cookiesDeleted, 0);
    assert.equal(settings.cleanDelay, 60);
  });
});

describe('runMigrations', () => {
  test('kural anahtarlarini kanoniklestirir, gecersizleri atar', async () => {
    await chrome.storage.local.set({
      rules: {
        'www.example.com': { domain: 'www.example.com', type: 'white', subdomains: true, updatedAt: 2 },
        'example.com': { domain: 'example.com', type: 'grey', updatedAt: 1 },
        'chrome://x': { domain: 'chrome://x', type: 'white' },
        bozuk: null
      }
    });
    storage.__resetCacheForTests();

    await storage.runMigrations();
    const rules = await storage.getRules();

    assert.deepEqual(Object.keys(rules), ['example.com']);
    assert.equal(rules['example.com'].type, 'white', 'daha yeni updatedAt kazanmali');
  });

  test('suresi dolmus gecici izinleri atar', async () => {
    await chrome.storage.local.set({
      rules: {
        'old.com': { domain: 'old.com', type: 'temp', expiresAt: Date.now() - 1000 },
        'new.com': { domain: 'new.com', type: 'temp', expiresAt: Date.now() + 60000 }
      }
    });
    storage.__resetCacheForTests();

    await storage.runMigrations();
    assert.deepEqual(Object.keys(await storage.getRules()), ['new.com']);
  });

  test('D1: diskteki eski log arsivini SILER', async () => {
    await chrome.storage.local.set({ gt_logs: [{ message: 'ziyaret edilen site kaydi' }] });
    storage.__resetCacheForTests();

    const report = await storage.runMigrations();
    const raw = await chrome.storage.local.get(null);
    assert.equal('gt_logs' in raw, false, 'gizlilik: gecmis loglari diskte kalmamali');
    assert.ok(report.changes.some(c => c.includes('gt_logs')));
  });

  test('eski cleanCache ayarini yeni anlamina tasir', async () => {
    await chrome.storage.local.set({ cleanCache: true });
    storage.__resetCacheForTests();
    await storage.runMigrations();
    assert.equal((await storage.getSettings()).cleanCacheOnPurgeAll, true);
    const raw = await chrome.storage.local.get(null);
    assert.equal('cleanCache' in raw, false);
  });

  test('gecersiz cleanDelay degerini araliga oturtur', async () => {
    await chrome.storage.local.set({ cleanDelay: 5 });
    storage.__resetCacheForTests();
    await storage.runMigrations();
    assert.equal((await storage.getSettings()).cleanDelay, 30);
  });

  test('idempotenttir', async () => {
    await storage.runMigrations();
    const first = await chrome.storage.local.get(null);
    await storage.runMigrations();
    const second = await chrome.storage.local.get(null);
    assert.deepEqual(second.rules, first.rules);
    assert.equal(second.schemaVersion, storage.SCHEMA_VERSION);
  });
});

describe('logger (D1 regresyonu)', () => {
  test('loglar OTURUM depolamasina yazilir, diske DEGIL', async () => {
    await logger.logInfo(logger.LogCategory.PURGE, 'test kaydi', null, 'example.com');
    await logger.flushLogs();

    assert.ok(chromeStub._storage.session.data.has('gt_logs'), 'oturum depolamasinda olmali');
    assert.equal(chromeStub._storage.local.data.has('gt_logs'), false, 'diskte OLMAMALI');
  });

  test('yazmalar tamponlanir: 10 kayit tek yazma turuna sigar', async () => {
    const before = chromeStub._storage.session.writeCount;
    for (let i = 0; i < 10; i++) await logger.logInfo(logger.LogCategory.TAB, `kayit ${i}`);
    await logger.flushLogs();
    const writes = chromeStub._storage.session.writeCount - before;
    assert.ok(writes <= 2, `beklenen <=2 yazma, olan ${writes}`);
  });

  test('logLevel off tum kayitlari susturur', async () => {
    await storage.updateSettings({ logLevel: 'off' });
    logger.__resetLoggerForTests();
    await logger.logError(logger.LogCategory.SYSTEM, 'gorulmemeli');
    await logger.flushLogs();
    assert.deepEqual(await logger.getLogs(), []);
  });

  test('logLevel error yalnizca hata/uyari gecirir', async () => {
    await storage.updateSettings({ logLevel: 'error' });
    logger.__resetLoggerForTests();
    await logger.logInfo(logger.LogCategory.SYSTEM, 'bilgi');
    await logger.logError(logger.LogCategory.SYSTEM, 'hata');
    const logs = await logger.getLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'ERROR');
  });

  test('en yeni kayit basta olur ve ust sinir uygulanir', async () => {
    await logger.logInfo(logger.LogCategory.SYSTEM, 'birinci');
    await logger.logInfo(logger.LogCategory.SYSTEM, 'ikinci');
    const logs = await logger.getLogs();
    assert.equal(logs[0].message, 'ikinci');
  });

  test('clearLogs bosaltir', async () => {
    await logger.logInfo(logger.LogCategory.SYSTEM, 'x');
    await logger.clearLogs();
    assert.deepEqual(await logger.getLogs(), []);
  });

  test('metin ciktisi kayitlari icerir', async () => {
    await logger.logSuccess(logger.LogCategory.PURGE, 'temizlendi', { count: 3 }, 'example.com');
    const text = logger.formatLogsAsText(await logger.getLogs(), { title: 'Test' });
    assert.ok(text.includes('temizlendi'));
    assert.ok(text.includes('example.com'));
    assert.ok(text.includes('"count": 3'));
  });
});

describe('i18n (A2 regresyonu)', () => {
  test('service worker ortaminda (document yok) THROW ETMEZ', async () => {
    assert.equal(typeof document, 'undefined', 'test ortami DOM icermemeli');
    const language = await i18n.initI18n();
    assert.ok(['tr', 'en'].includes(language));
    assert.equal(i18n.isI18nReady(), true);
  });

  test('applyTranslationsToDOM DOM yoksa sessizce gecer', () => {
    assert.doesNotThrow(() => i18n.applyTranslationsToDOM());
  });

  test('bildirim anahtarlari gercekten tanimli', () => {
    for (const key of [
      'serviceWorker.siteCleanedTitle', 'serviceWorker.siteCleanedMsg',
      'serviceWorker.emergencyCleanTitle', 'serviceWorker.emergencyCleanMsg',
      'serviceWorker.periodicCleanTitle', 'serviceWorker.periodicCleanMsg'
    ]) {
      assert.equal(i18n.hasTranslation(key), true, `eksik anahtar: ${key}`);
    }
  });

  test('parametreler yerine konur', async () => {
    await i18n.setLanguage('tr');
    const text = i18n.t('serviceWorker.siteCleanedMsg', { domain: 'a.com', cookies: 2, history: 3 });
    assert.ok(text.includes('a.com'));
    assert.ok(!text.includes('{domain}'));
  });

  test('bilinmeyen anahtar kendisini doner', () => {
    assert.equal(i18n.t('yok.boyle.bir.anahtar'), 'yok.boyle.bir.anahtar');
  });

  test('dil degistirme kaydedilir', async () => {
    await i18n.setLanguage('en');
    assert.equal(i18n.getLanguage(), 'en');
    assert.equal((await storage.getSettings()).language, 'en');
    assert.equal(i18n.getLocaleTag(), 'en-US');
  });
});

describe('onbellek yarisi: ucusta olan okuma ESKI degeri canlandirmaz', () => {
  // BULGU: getSettings() okuma baslatir; okuma tamamlandiginda cache'e yazar.
  // Arada invalidateCache() cagrilirsa (baska bir yazma) tamamlanan okuma
  // ESKIMIS degeri onbellege koyar ve bir sonraki karar o degerle verilir.
  //
  // Somut risk: yeni beyaz listeye alinmis bir site eskimis kural setiyle
  // temizlenir; ya da kaldirilan bir kural hala koruyor gorunur.

  test('okuma sirasinda gecersiz kilinirsa eski deger onbellege yazilmaz', async () => {
    await chrome.storage.local.set({ cleanDelay: 30 });
    storage.__resetCacheForTests();

    // Okumayi elle kontrol et: ESKI anlik goruntuyu dondurecek.
    const stale = { cleanDelay: 30 };
    let release;
    const original = chrome.storage.local.get;
    chrome.storage.local.get = () => new Promise(resolve => {
      release = () => resolve(stale);
    });

    try {
      const pending = storage.getSettings();          // okuma basladi
      await new Promise(r => setTimeout(r, 10));

      // Okuma UCUSTAYKEN disk degisti; gercek get'i geri verip yaziyoruz.
      chrome.storage.local.get = original;
      await chrome.storage.local.set({ cleanDelay: 300 });

      // Simdi eski okuma tamamlaniyor ve cache'e yazmak istiyor.
      release();
      await pending;
    } finally {
      chrome.storage.local.get = original;
    }

    const after = await storage.getSettings();
    assert.equal(after.cleanDelay, 300,
      'ucusta olan okuma eskimis degeri onbellege koymamali');
  });

  test('yarisma yoksa onbellek normal calisir', async () => {
    await chrome.storage.local.set({ cleanDelay: 45 });
    storage.__resetCacheForTests();
    const first = await storage.getSettings();
    const second = await storage.getSettings();
    assert.equal(first.cleanDelay, 45);
    assert.equal(second, first, 'ikinci cagri onbellekten donmeli');
  });
});

describe('periyodik supurme VARSAYILAN ACIK (v2.7.0)', () => {
  // Kapaliyken vaadin disinda kalan bir kategori vardi: cerezi ve gecmisi
  // OLMAYAN, yalnizca yerel depolama tutan siteler. Sekme kapanisi temizligi
  // onlari hic gormuyor, cunku Chrome bu adresleri listeleyecek bir API
  // vermiyor - tek ulasma yolu bu supurme.
  //
  // Yani kapali varsayilan, "izin verilmeyen sitenin tum verisi silinir"
  // vaadini varsayilan ayarlarda EKSIK birakiyordu.

  test('periodicCleanEnabled varsayilani true', () => {
    assert.equal(storage.DEFAULT_SETTINGS.periodicCleanEnabled, true,
      'supurme varsayilan olarak acik gelmeli');
  });

  test('varsayilan araligi makul (15 dk - 24 saat arasi)', () => {
    const dk = storage.DEFAULT_SETTINGS.periodicCleanInterval;
    assert.ok(dk >= 15 && dk <= 1440, `aralik disi: ${dk}`);
  });
});

const sessionStateLib = await import('../lib/session-state.js');

describe('ZIYARET EDILEN site 3. taraf listesine girmez (v2.7.0)', () => {
  // KULLANICI BULGUSU: "3. taraflar" sekmesinde google.com ve google.com.tr
  // gorunuyordu. Bunlar kullanicinin KENDI actigi siteler; 3. taraf listesi
  // baskalarinin gomdugu harici siteleri gostermeli.
  //
  // Neden oldu: eski `site-data.js` bu ayrimi `historyCount === 0` ile
  // yapiyordu. Karsilasma sayimina gecerken o filtre tasinmadi, sayim her
  // bildirileni 3. taraf saymaya basladi. youtube.com'dayken google.com'un
  // kaynak yuklemesi teknik olarak 3. taraf istegidir - ama kullanici o
  // siteyi ZATEN aciyor, listede "harici izleyici" gibi durmasi yaniltici.
  //
  // Dogru sinyal: bir host hic ANA SITE (parent) olarak gorulduyse, onu
  // kullanici acmistir. Bu sinyal oturumluktur ve temizlikten sag cikar,
  // yani gecmis silinse bile dogru kalir.

  test('ana site olarak gorulen host ziyaret edilmis sayilir', async () => {
    chromeStub = installChromeStub();
    await sessionStateLib.recordThirdParty('google.com', ['doubleclick.net']);
    await sessionStateLib.recordThirdParty('youtube.com', ['google.com']);

    const ziyaret = await sessionStateLib.getVisitedRoots();
    assert.ok(ziyaret['google.com'], 'google.com ana site olarak gorulmus olmali');
    assert.ok(ziyaret['youtube.com'], 'youtube.com ana site olarak gorulmus olmali');
    assert.equal(ziyaret['doubleclick.net'], undefined,
      'yalnizca 3. taraf olarak gorulen host ziyaret sayilmamali');
  });

  test('ziyaret kaydi da TAVANLI', async () => {
    chromeStub = installChromeStub();
    for (let i = 0; i < sessionStateLib.MAX_THIRD_PARTY_HOSTS + 20; i++) {
      await sessionStateLib.recordThirdParty(`s${i}.example`, ['izleyici.net']);
    }
    const ziyaret = await sessionStateLib.getVisitedRoots();
    assert.ok(Object.keys(ziyaret).length <= sessionStateLib.MAX_THIRD_PARTY_HOSTS,
      `tavan asilmamali: ${Object.keys(ziyaret).length}`);
  });
});

describe('3. taraf KARSILASMA sayimi temizlikten SAG CIKAR (v2.7.0)', () => {
  // KULLANICI BULGUSU: "En cok karsilasilan 3. taraflar" sekmesi bostu.
  //
  // Sebep: canli kesif haritasi her temizlikte BUDANIYOR (pruneThirdParty) -
  // dogru davranis, cunku o harita "neyi temizlemeliyim" sorusunu yanitliyor.
  // Ama istatistigin basligi "en cok KARSILASILAN" diyor; karsilastiginiz bir
  // izleyici, verisi silindi diye karsilasilmamis olmuyor. Her seyi
  // temizledikten sonra liste hep bos kaliyordu.
  //
  // Cozum: AYRI bir oturumluk sayim. Budanmaz, yalnizca tarayici kapaninca
  // gider. Gizlilik acisindan canli haritayla ayni sinifta: diske YAZILMAZ.

  const sessionState = sessionStateLib;

  test('budama sayimi SILMEZ', async () => {
    chromeStub = installChromeStub();
    await sessionState.recordThirdParty('haber.com', ['izleyici.net']);
    await sessionState.recordThirdParty('blog.org', ['izleyici.net']);

    // Canli harita budanir (site temizlendi)
    await sessionState.pruneThirdParty(host => host === 'izleyici.net');
    const canli = await sessionState.getThirdPartyMap();
    assert.equal(canli['izleyici.net'], undefined, 'canli harita budanmali');

    // Karsilasma sayimi DURMALI
    const sayim = await sessionState.getThirdPartySeen();
    assert.ok(sayim['izleyici.net'], 'karsilasma kaydi budamadan sag cikmali');
    assert.equal(sayim['izleyici.net'].sites.length, 2,
      'iki farkli ana sitede gorulmus olmali');
  });

  test('ayni ana site tekrar sayilmaz, istek sayaci artar', async () => {
    chromeStub = installChromeStub();
    await sessionState.recordThirdParty('haber.com', ['izleyici.net']);
    await sessionState.recordThirdParty('haber.com', ['izleyici.net']);

    const sayim = await sessionState.getThirdPartySeen();
    assert.equal(sayim['izleyici.net'].sites.length, 1, 'ayni site bir kez sayilir');
    assert.equal(sayim['izleyici.net'].count, 2, 'istek sayaci artmali');
  });

  test('sayim da TAVANLI - sinirsiz buyumez', async () => {
    chromeStub = installChromeStub();
    const cok = Array.from({ length: sessionState.MAX_THIRD_PARTY_HOSTS + 25 },
      (_, i) => `t${i}.example`);
    await sessionState.recordThirdParty('haber.com', cok);

    const sayim = await sessionState.getThirdPartySeen();
    assert.ok(Object.keys(sayim).length <= sessionState.MAX_THIRD_PARTY_HOSTS,
      `tavan asilmamali: ${Object.keys(sayim).length}`);
  });
});


describe('3. taraf haritasi: parents listesi KAYAN pencere (v2.7.0)', () => {
  // sweepOrphanDomains "kaynak sayfa hala acik mi?" sorusunu bu listeye
  // bakarak yanitliyor. Liste ilk 5 ana sitede DONUYORDU: populer bir CDN
  // (fonts.gstatic.com gibi) 5 farkli sitede gorulduyse, 6. site acikken bile
  // "kaynak kapali" sanilip o CDN'in verisi canli sayfanin altindan cekiliyordu.
  //
  // Kayan pencere dogru davranis: liste EN SON goruleni tutar, cunku acik olma
  // ihtimali en yuksek olan odur.

  test('kapasite asilinca EN ESKI ana site dusulur', async () => {
    installChromeStub();
    const cap = sessionStateLib.MAX_PARENTS_PER_HOST;

    for (let i = 0; i < cap; i++) {
      await sessionStateLib.recordThirdParty(`site${i}.com`, ['cdn.com']);
    }
    await sessionStateLib.recordThirdParty('yeni.com', ['cdn.com']);

    const parents = (await sessionStateLib.getThirdPartyMap())['cdn.com'].parents;
    assert.equal(parents.length, cap, 'kapasite korunmali');
    assert.ok(parents.includes('yeni.com'),
      `en son gorulen ana site listede olmali; liste: ${parents.join(', ')}`);
    assert.ok(!parents.includes('site0.com'),
      'en eski ana site dusmeli');
  });

  test('zaten listedeki ana site tekrar eklenmez', async () => {
    installChromeStub();
    await sessionStateLib.recordThirdParty('haber.com', ['cdn.com']);
    await sessionStateLib.recordThirdParty('haber.com', ['cdn.com']);

    const parents = (await sessionStateLib.getThirdPartyMap())['cdn.com'].parents;
    assert.deepEqual(parents, ['haber.com']);
  });

  test('kapasite altinda sira KORUNUR', async () => {
    installChromeStub();
    await sessionStateLib.recordThirdParty('a.com', ['cdn.com']);
    await sessionStateLib.recordThirdParty('b.com', ['cdn.com']);

    const parents = (await sessionStateLib.getThirdPartyMap())['cdn.com'].parents;
    assert.deepEqual(parents, ['a.com', 'b.com']);
  });
});

describe('oturum haritalarina ES ZAMANLI yazma kaybolmamali', () => {
  // recordThirdParty ve recordStorageEstimate seri kuyruk KULLANMIYORDU
  // (sekme haritasinda withTabMap var, bunlarda yok). Icerik script'leri
  // 3 saniyelik gruplarla ve BIRDEN COK SEKMEDEN ayni anda rapor gonderiyor;
  // oku-degistir-yaz yarisinda raporlar birbirini eziyor.
  //
  // Bu harita, cerezi olmayan CDN'lere ulasmanin TEK yolu - kaybolan kayit
  // hic temizlenmeyen iz demek.

  test('es zamanli 3. taraf raporlarinin HEPSI kaydedilir', async () => {
    installChromeStub();
    await Promise.all([
      sessionStateLib.recordThirdParty('a.com', ['cdn1.com']),
      sessionStateLib.recordThirdParty('b.com', ['cdn2.com']),
      sessionStateLib.recordThirdParty('c.com', ['cdn3.com']),
      sessionStateLib.recordThirdParty('d.com', ['cdn4.com']),
      sessionStateLib.recordThirdParty('e.com', ['cdn5.com'])
    ]);

    const harita = await sessionStateLib.getThirdPartyMap();
    assert.deepEqual(Object.keys(harita).sort(),
      ['cdn1.com', 'cdn2.com', 'cdn3.com', 'cdn4.com', 'cdn5.com'],
      `es zamanli raporlarin hepsi kalmali; kalan: ${Object.keys(harita).join(', ')}`);
  });

  test('es zamanli depolama olcumlerinin HEPSI kaydedilir', async () => {
    installChromeStub();
    await Promise.all([
      sessionStateLib.recordStorageEstimate('s1.com', 1000),
      sessionStateLib.recordStorageEstimate('s2.com', 2000),
      sessionStateLib.recordStorageEstimate('s3.com', 3000),
      sessionStateLib.recordStorageEstimate('s4.com', 4000)
    ]);

    const olcumler = await sessionStateLib.getStorageEstimates();
    assert.deepEqual(Object.keys(olcumler).sort(), ['s1.com', 's2.com', 's3.com', 's4.com'],
      `es zamanli olcumlerin hepsi kalmali; kalan: ${Object.keys(olcumler).join(', ')}`);
  });
});

describe('tema secimi', () => {
  // Arayuz acik ve koyu temayi destekliyor. Varsayilan 'system': isletim
  // sistemini izler. Kullanici isterse sabitler.

  test('varsayilan tema sistemi izler', async () => {
    const settings = await storage.getSettings();
    assert.equal(settings.theme, 'system');
  });

  test('gecerli tema kaydedilir', async () => {
    await storage.updateSettings({ theme: 'dark' });
    assert.equal((await storage.getSettings()).theme, 'dark');
    await storage.updateSettings({ theme: 'light' });
    assert.equal((await storage.getSettings()).theme, 'light');
  });

  test('gecersiz tema varsayilana duser', async () => {
    // Dogrulanmazsa data-theme'e cop deger yazilir ve HICBIR tema blogu
    // eslesmez: sayfa yari acik yari koyu kalir.
    await storage.updateSettings({ theme: 'neon' });
    assert.equal((await storage.getSettings()).theme, 'system',
      'bilinmeyen tema varsayilana dusmeli');
  });
});


describe('iframe izleme varsayilan ACIK (v2.7.0)', () => {
  // KAPSAM BOSLUGU. Resource Timing tamponu YALNIZCA kendi cercevesinin
  // kaynaklarini tasir. Ust cerceveden bakildiginda bir reklam iframe'inin
  // yukledigi izleyiciler GORUNMEZ - gorunmeyen de temizlenmez.
  //
  // iframe tam olarak ucuncu tarafin saklandigi yer. Kapali varsayilan,
  // "izin verilmeyen sitenin ILISKILI ucuncu taraflarini da temizle"
  // vaadini reklam yogun sitelerde sessizce eksik birakiyordu.
  //
  // Periyodik supurmede ayni sey yasandi: kapali varsayilan sessiz bir
  // kapsam boslugu uretiyordu.
  //
  // Maliyeti gercek (daha cok betik ornegi ve mesaj trafigi) ama kapsam
  // hizin onunde: eksik temizlik kullanicinin FARK EDEMEYECEGI bir kusur,
  // yavaslik ise fark edilir ve kapatilabilir.

  test('trackThirdPartyFrames varsayilani true', () => {
    assert.equal(storage.DEFAULT_SETTINGS.trackThirdPartyFrames, true,
      'iframe izleme varsayilan olarak acik gelmeli');
  });

  test('ust ayar da acik - alt ayar tek basina ise yaramaz', () => {
    // trackThirdPartyFrames, trackThirdParty'ye BAGLI bir alt ayar.
    // Ust kapaliyken alt acik olsa hicbir sey izlenmez.
    assert.equal(storage.DEFAULT_SETTINGS.trackThirdParty, true,
      'alt ayar acikken ust ayar da acik olmali');
  });
});
