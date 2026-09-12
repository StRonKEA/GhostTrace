import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, makeCookie, makeHistoryItem } from './helpers/chrome-stub.js';

let chromeStub = installChromeStub();

const storage = await import('../lib/storage.js');
const cleaner = await import('../lib/purge/index.js');
const logger = await import('../lib/logger.js');

const { purgeDomain, purgeAllNonWhitelisted, purgeDomains, createPurgeContext } = cleaner;

const historyLib = await import('../lib/history.js');
const { deleteHistoryForScope, searchHistoryPaged } = historyLib;
const domainLib = await import('../lib/domain.js');
const { createDomainScope } = domainLib;
const rulesLib = await import('../lib/rules.js');
const { setDomainRule } = rulesLib;

const sessionState = await import('../lib/session-state.js');
const privacyLib = await import('../lib/privacy.js');
const bootstrap = await import('../lib/sw/bootstrap.js');
const { applyHardening, readHardeningState, watchHardeningChanges, hardeningKeys, sunsettingKeys } = privacyLib;

async function seed({ cookies = [], history = [], downloads = [], tabs = [], rules = {}, settings = {} } = {}) {
  chromeStub = installChromeStub({ cookies, history, downloads, tabs });
  storage.__resetCacheForTests();
  logger.__resetLoggerForTests();
  await chrome.storage.local.set({
    ...storage.DEFAULT_SETTINGS,
    logLevel: 'off',
    rules,
    ...settings
  });
  storage.__resetCacheForTests();
}

const whiteRule = (domain, extra = {}) => ({ domain, type: 'white', subdomains: true, keepMode: 'all', keepCookies: [], ...extra });

beforeEach(async () => { await seed(); });

describe('purgeDomain - kapsam kurallari', () => {
  test('kok alan adi temizligi tum alt alan adlarini kapsar', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'a', domain: 'example.com' }),
        makeCookie({ name: 'b', domain: '.example.com' }),
        makeCookie({ name: 'c', domain: 'mail.example.com' }),
        makeCookie({ name: 'd', domain: 'other.com' })
      ]
    });

    const result = await purgeDomain('example.com');
    assert.equal(result.cookies, 3);
    assert.deepEqual(chromeStub._state.cookies.map(c => c.name), ['d']);
  });

  test('alt alan adi temizligi kardes ve ust alan adina DOKUNMAZ', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'parent', domain: 'example.com' }),
        makeCookie({ name: 'sibling', domain: 'ads.example.com' }),
        makeCookie({ name: 'target', domain: 'mail.example.com' }),
        makeCookie({ name: 'child', domain: 'inbox.mail.example.com' })
      ]
    });

    const result = await purgeDomain('mail.example.com');
    assert.equal(result.cookies, 2);
    assert.deepEqual(chromeStub._state.cookies.map(c => c.name).sort(), ['parent', 'sibling']);
  });

  test('B3: kok temizligi BEYAZ LISTEDEKI alt alan adinin cerezlerini korur', async () => {
    // v1.1.0: google.com sekmesi kapatilinca *.google.com tum cerezler
    // siliniyordu; mail.google.com beyaz listede olsa bile.
    await seed({
      cookies: [
        makeCookie({ name: 'root', domain: '.google.com' }),
        makeCookie({ name: 'gmail', domain: 'mail.google.com' }),
        makeCookie({ name: 'ads', domain: 'ads.google.com' })
      ],
      rules: { 'mail.google.com': whiteRule('mail.google.com', { subdomains: false }) }
    });

    const result = await purgeDomain('google.com');
    assert.equal(result.cookies, 2);
    assert.deepEqual(chromeStub._state.cookies.map(c => c.name), ['gmail']);
  });

  test('korumali alan adi hic temizlenmez', async () => {
    await seed({
      cookies: [makeCookie({ name: 'a', domain: 'safe.com' })],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    const result = await purgeDomain('safe.com');
    assert.equal(result.protected, true);
    assert.equal(result.ruleType, 'white');
    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('gri liste ve aktif gecici izin de korumalidir', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'grey.com' }), makeCookie({ domain: 'temp.com' })],
      rules: {
        'grey.com': { domain: 'grey.com', type: 'grey', subdomains: true },
        'temp.com': { domain: 'temp.com', type: 'temp', subdomains: true, expiresAt: Date.now() + 60000 }
      }
    });

    assert.equal((await purgeDomain('grey.com')).protected, true);
    assert.equal((await purgeDomain('temp.com')).protected, true);
    assert.equal(chromeStub._state.cookies.length, 2);
  });

  test('suresi dolmus gecici izin korumali degildir', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'temp.com' })],
      rules: { 'temp.com': { domain: 'temp.com', type: 'temp', subdomains: true, expiresAt: Date.now() - 1000 } }
    });

    const result = await purgeDomain('temp.com');
    assert.notEqual(result.protected, true);
    assert.equal(result.cookies, 1);
  });

  test('beyaz liste keepMode custom yalnizca eslesen cerezleri korur', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'session_id', domain: 'shop.com' }),
        makeCookie({ name: '_ga', domain: 'shop.com' }),
        makeCookie({ name: 'cart', domain: 'shop.com' })
      ],
      rules: {
        // Kural alt alan adi icin; ust alan adi temizlenirken cerez korumasi
        // yine de cerezin kendi kuralindan gelir.
        'shop.com': whiteRule('shop.com', { keepMode: 'custom', keepCookies: ['session*'] })
      }
    });

    // shop.com korumali oldugu icin dogrudan temizlenemez; kok uzerinden
    // baglami zorlayarak cerez korumasini test ediyoruz.
    const ctx = await createPurgeContext();
    assert.equal(ctx.isCookieProtected(makeCookie({ name: 'session_id', domain: 'shop.com' })), true);
    assert.equal(ctx.isCookieProtected(makeCookie({ name: '_ga', domain: 'shop.com' })), false);
    assert.equal(ctx.isCookieProtected(makeCookie({ name: 'cart', domain: 'shop.com' })), false);
  });
});

describe('purgeDomain - gecmis ve indirmeler', () => {
  test('kapsam ici gecmis silinir, disi korunur', async () => {
    await seed({
      history: [
        makeHistoryItem('https://example.com/a'),
        makeHistoryItem('https://mail.example.com/b'),
        makeHistoryItem('https://other.com/c'),
        makeHistoryItem('https://cdn.net/x?ref=example.com')
      ]
    });

    const result = await purgeDomain('example.com');
    assert.equal(result.history, 2);
    assert.deepEqual(chromeStub._state.history.map(h => h.url).sort(),
      ['https://cdn.net/x?ref=example.com', 'https://other.com/c']);
  });

  test('B5: 10.000 kayittan fazla gecmis SAYFALANARAK tamamen silinir', async () => {
    // v1.1.0'da maxResults:10000 sabiti vardi; 10.000'inci kayittan eskisi
    // hicbir zaman bulunamiyor, dolayisiyla silinmiyordu.
    const base = Date.now();
    const history = [];
    for (let i = 0; i < 12000; i++) {
      history.push(makeHistoryItem(`https://example.com/p${i}`, { lastVisitTime: base - i * 1000 }));
    }
    await seed({ history });

    const result = await purgeDomain('example.com');
    assert.equal(result.history, 12000, 'tum kayitlar silinmeli');
    assert.equal(chromeStub._state.history.length, 0);
    assert.ok(chromeStub._state.apiCalls.historySearch > 1, 'sayfalama yapilmali');
  });

  test('beyaz listedeki alan adinin gecmisi varsayilan olarak korunur', async () => {
    await seed({
      history: [makeHistoryItem('https://example.com/a'), makeHistoryItem('https://safe.example.com/b')],
      rules: { 'safe.example.com': whiteRule('safe.example.com', { subdomains: false }) }
    });

    const result = await purgeDomain('example.com');
    assert.equal(result.history, 1);
    assert.deepEqual(chromeStub._state.history.map(h => h.url), ['https://safe.example.com/b']);
  });

  test('whitelistCleanHistory acikken beyaz listenin gecmisi de silinir', async () => {
    await seed({
      history: [makeHistoryItem('https://safe.example.com/b')],
      rules: { 'safe.example.com': whiteRule('safe.example.com', { subdomains: false }) },
      settings: { whitelistCleanHistory: true }
    });

    const ctx = await createPurgeContext();
    assert.equal(ctx.isHistoryProtected('https://safe.example.com/b'), false);
  });

  test('indirme kayitlari kapsama gore silinir', async () => {
    await seed({
      downloads: [
        { id: 1, url: 'https://example.com/f.zip' },
        { id: 2, url: 'https://cdn.example.com/g.zip' },
        { id: 3, url: 'https://other.com/h.zip' }
      ]
    });

    const result = await purgeDomain('example.com');
    assert.equal(result.downloads, 2);
    assert.deepEqual(chromeStub._state.downloads.map(d => d.id), [3]);
  });
});

describe('purgeDomain - depolama (browsingData)', () => {
  test('B4: alt alan adi origin-leri de temizlik listesine girer', async () => {
    // v1.1.0: yalnizca host + www.host origin'i veriliyordu; alt alan adlarinin
    // LocalStorage/IndexedDB verisi diskte kaliyordu.
    await seed({
      cookies: [makeCookie({ domain: 'mail.example.com' }), makeCookie({ domain: 'cdn.example.com' })],
      history: [makeHistoryItem('https://shop.example.com/x')],
      tabs: [{ id: 1, url: 'https://app.example.com/', active: true }]
    });

    await purgeDomain('example.com');
    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.ok(call, 'browsingData.remove cagrilmali');

    for (const host of ['example.com', 'mail.example.com', 'cdn.example.com', 'shop.example.com', 'app.example.com']) {
      assert.ok(call.filter.origins.includes(`https://${host}`), `${host} origin listesinde olmali`);
    }
  });

  test('origin bazli cagriya cookies:true VERILMEZ (Chrome bunu alan adi genelinde uygular)', async () => {
    await seed({ cookies: [makeCookie({ domain: 'example.com' })] });
    await purgeDomain('example.com');

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.equal(call.types.cookies, undefined,
      'cerezler yalnizca tek tek, korumasi denetlenerek silinmeli');
    assert.equal(call.types.localStorage, true);
    assert.equal(call.types.indexedDB, true);
    assert.equal(call.types.serviceWorkers, true);
    assert.equal(call.types.cacheStorage, true);
  });

  test('korumali alt alan adinin origin-i haric tutulur', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'mail.example.com' }), makeCookie({ domain: 'ads.example.com' })],
      rules: { 'mail.example.com': whiteRule('mail.example.com', { subdomains: false }) }
    });

    await purgeDomain('example.com');
    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.ok(!call.filter.origins.includes('https://mail.example.com'));
    assert.ok(call.filter.origins.includes('https://ads.example.com'));
  });

  test('ayar kapaliysa ilgili tur gonderilmez', async () => {
    await seed({ cookies: [makeCookie({ domain: 'example.com' })], settings: { cleanIndexedDB: false, cleanServiceWorkers: false } });
    await purgeDomain('example.com');

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.equal(call.types.indexedDB, undefined);
    assert.equal(call.types.serviceWorkers, undefined);
    assert.equal(call.types.localStorage, true);
  });
});

describe('purgeDomain - istatistik ve olcum', () => {
  test('D2: bytes yalnizca OLCULEN cerez/gecmis buyuklugunu toplar', async () => {
    await seed({
      cookies: [makeCookie({ name: 'n', value: 'x'.repeat(100), domain: 'example.com' })],
      history: [makeHistoryItem('https://example.com/a')]
    });

    const result = await purgeDomain('example.com');
    // v1.1.0 burada origin basina 160 KB uyduruyordu.
    assert.ok(result.bytes > 100 && result.bytes < 5000, `beklenmeyen bayt: ${result.bytes}`);

    const stats = await storage.getStats();
    assert.equal(stats.cookiesDeleted, 1);
    assert.equal(stats.historyDeleted, 1);
    assert.equal(stats.bytesFreed, result.bytes);
    assert.equal(stats.totalCleans, 1);
  });

  test('gecersiz alan adinda sifir sonuc doner', async () => {
    const result = await purgeDomain('chrome://settings');
    assert.equal(result.cookies, 0);
    assert.equal(result.history, 0);
  });
});

describe('purgeAllNonWhitelisted (A1 regresyonu)', () => {
  test('THROW ETMEZ ve dolu bir sonuc nesnesi doner', async () => {
    // v1.1.0: `storageCleaned is not defined` -> her cagride ReferenceError.
    await seed({
      cookies: [makeCookie({ domain: 'a.com' }), makeCookie({ domain: 'b.com' })],
      history: [makeHistoryItem('https://a.com/1')],
      downloads: [{ id: 7, url: 'https://b.com/f.zip' }]
    });

    const result = await purgeAllNonWhitelisted();
    assert.equal(typeof result, 'object');
    assert.equal(result.cookies, 2);
    assert.equal(result.history, 1);
    assert.equal(result.downloads, 1);
    assert.equal(result.storage, 1);
    assert.ok(result.bytes > 0);
  });

  test('korumali siteler atlanir ve origin-leri haric tutulur', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'keep', domain: 'safe.com' }),
        makeCookie({ name: 'keepsub', domain: 'cdn.safe.com' }),
        makeCookie({ name: 'go', domain: 'bad.com' })
      ],
      history: [makeHistoryItem('https://safe.com/a'), makeHistoryItem('https://bad.com/b')],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    const result = await purgeAllNonWhitelisted();
    assert.equal(result.cookies, 1);
    assert.deepEqual(chromeStub._state.cookies.map(c => c.name).sort(), ['keep', 'keepsub']);
    assert.deepEqual(chromeStub._state.history.map(h => h.url), ['https://safe.com/a']);

    const storageCall = chromeStub._state.browsingDataCalls.find(c => c.filter.excludeOrigins);
    assert.ok(storageCall, 'excludeOrigins ile cagri yapilmali');
    assert.ok(storageCall.filter.excludeOrigins.includes('https://safe.com'));
    assert.ok(storageCall.filter.excludeOrigins.includes('https://cdn.safe.com'),
      'alt alan adlarini kapsayan kuralda bilinen alt alan adlari da korunmali');
    assert.equal(storageCall.types.cookies, undefined);
  });

  test('onbellek: hedefli temizlik her zaman, FILTRESIZ temizlik yalnizca onayla', async () => {
    // Bu test eskiden "onbellek origin bazinda silinemez" varsayimini
    // kodluyordu. Yanlisti: Chromium'da kFilterableDataTypes cache'i iceriyor.
    // Dogru davranis iki katmanli:
    //   1) Kapsam filtreli cagri HER ZAMAN cache tasir (beyaz liste korunur).
    //   2) FILTRESIZ global cagri yalnizca kullanici onayiyla; cunku origin
    //      filtresine girmeyen izleri (HSTS, QUIC, arama onerisi) hedefleyemez
    //      ve beyaz listedeki sitelerin onbellegini de goturur.
    await seed({
      cookies: [makeCookie({ name: 'keep', domain: 'safe.com' }), makeCookie({ name: 'go', domain: 'bad.com' })],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    let result = await purgeAllNonWhitelisted();
    assert.equal(result.cacheCleared, false, 'ek global temizlik yapilmadi');

    const scoped = chromeStub._state.browsingDataCalls.filter(c => c.filter.excludeOrigins);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].types.cache, true, 'kapsamli cagri onbellegi de kapsar');
    assert.ok(scoped[0].filter.excludeOrigins.includes('https://safe.com'));

    const unfiltered = chromeStub._state.browsingDataCalls
      .filter(c => !c.filter.excludeOrigins && !c.filter.origins);
    assert.equal(unfiltered.length, 0, 'onay olmadan filtresiz cagri yapilmamali');

    // Ayar acikken EK filtresiz cagri yapilir
    await seed({
      cookies: [makeCookie({ domain: 'safe.com' }), makeCookie({ domain: 'bad.com' })],
      rules: { 'safe.com': whiteRule('safe.com') },
      settings: { cleanCacheOnPurgeAll: true }
    });
    result = await purgeAllNonWhitelisted();
    assert.equal(result.cacheCleared, true);

    const globalCall = chromeStub._state.browsingDataCalls
      .find(c => !c.filter.excludeOrigins && !c.filter.origins && c.types.cache);
    assert.ok(globalCall, 'filtresiz onbellek cagrisi olmali');
    assert.deepEqual(globalCall.filter, {});
    assert.deepEqual(Object.keys(globalCall.types), ['cache'],
      'ek cagri yalnizca cache tasimali; diger turler zaten kapsamli cagrida gitti');
  });

  test('hicbir korumali kural yoksa filtresiz cagri yapilir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'a.com' })] });
    await purgeAllNonWhitelisted();
    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.deepEqual(call.filter, {});
  });
});

describe('purgeDomains (toplu secim)', () => {
  test('korumali olanlari atlar ve toplami dogru dondurur', async () => {
    await seed({
      cookies: [
        makeCookie({ domain: 'a.com' }),
        makeCookie({ domain: 'b.com' }),
        makeCookie({ domain: 'safe.com' })
      ],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    const summary = await purgeDomains(['a.com', 'b.com', 'safe.com', 'chrome://x']);
    assert.equal(summary.count, 2);
    assert.equal(summary.skippedProtected, 1);
    assert.equal(summary.cookies, 2);
    assert.deepEqual(chromeStub._state.cookies.map(c => c.domain), ['safe.com']);
  });
});

describe('A3: browsingData veri turu maskesi', () => {
  test('olu webSQL alani GONDERILMEZ, fileSystems gonderilir', async () => {
    // WebSQL ozelligi Chrome 119'da tarayicidan, browsingData anahtari ise
    // Chrome 152'de API'den kaldirildi. Bayragi gondermek hicbir sey
    // temizlemez, yalnizca konsola uyari yazdirir ve arayuzde sahte bir
    // "temizlendi" gostergesi uretir.
    await seed({ cookies: [makeCookie({ domain: 'example.com' })] });
    await purgeDomain('example.com');

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.ok(call, 'browsingData.remove cagrilmali');
    assert.equal('webSQL' in call.types, false, 'webSQL anahtari hic bulunmamali');
    assert.equal(call.types.fileSystems, true, 'fileSystems (OPFS) kalmali');
    assert.equal(call.types.cacheStorage, true);
  });

  test('origin filtreli cagriya asla filtrelenemeyen tur girmez', async () => {
    // history / downloads / formData origins ile birlikte gonderilirse Chrome
    // cagriyi komple reddeder (kNonFilterableError) ve HICBIR sey silinmez.
    await seed({ cookies: [makeCookie({ domain: 'example.com' })] });
    await purgeDomain('example.com');

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.ok(call.filter.origins, 'origin filtreli cagri olmali');
    for (const forbidden of ['history', 'downloads', 'formData', 'passwords', 'pluginData']) {
      assert.equal(forbidden in call.types, false, `${forbidden} origins ile gonderilemez`);
    }
  });
});

describe('A4: levelOfControl tam enum destegi', () => {
  /** chrome.privacy taklidi kurar. */
  function installPrivacy({ levelOfControl = 'controllable_by_this_extension', value = true, granted = true } = {}) {
    const state = { value, levelOfControl, setCalls: 0 };
    chrome.privacy = {
      websites: {
        thirdPartyCookiesAllowed: {
          async get() { return { value: state.value, levelOfControl: state.levelOfControl }; },
          async set({ value: v }) { state.setCalls++; state.value = v; },
          onChange: { addListener() {} }
        }
      }
    };
    chrome.permissions.contains = async () => granted;
    return state;
  }

  test('not_controllable: set() CAGRILMAZ ve durum bildirilir', async () => {
    // Kurumsal politika ile kilitli ayar. Onceki surum bu durumu hic ele
    // almiyordu: set() sessizce yutulur, arayuz "korumali" gosterirdi.
    await seed();
    const state = installPrivacy({ levelOfControl: 'not_controllable' });

    const outcome = await applyHardening({ blockThirdPartyCookies: true });

    assert.equal(state.setCalls, 0, 'kontrol edilemeyen ayara yazma denenmemeli');
    assert.deepEqual(outcome.notControllable, ['blockThirdPartyCookies']);
    assert.deepEqual(outcome.applied, [], 'uygulandi listesi bos olmali');
    assert.ok(outcome.skipped.some(s => s.includes('not-controllable')));
  });

  test('controlled_by_other_extensions: ayri kumede bildirilir', async () => {
    await seed();
    const state = installPrivacy({ levelOfControl: 'controlled_by_other_extensions' });

    const outcome = await applyHardening({ blockThirdPartyCookies: true });

    assert.equal(state.setCalls, 0);
    assert.deepEqual(outcome.controlledElsewhere, ['blockThirdPartyCookies']);
    assert.deepEqual(outcome.notControllable, []);
  });

  test('kontrol edilebiliyorsa uygulanir ve GERI OKUMA ile teyit edilir', async () => {
    await seed();
    const state = installPrivacy({ levelOfControl: 'controllable_by_this_extension', value: true });

    const outcome = await applyHardening({ blockThirdPartyCookies: true });

    assert.equal(state.setCalls, 1);
    assert.equal(state.value, false, 'invert:true -> thirdPartyCookiesAllowed=false');
    assert.deepEqual(outcome.applied, ['blockThirdPartyCookies=true']);
    assert.deepEqual(outcome.unverified, []);
  });

  test('set() sessizce etkisiz kalirsa UNVERIFIED olarak isaretlenir', async () => {
    // set() hata atmadan hicbir sey yapmazsa: geri okuma bunu yakalar.
    await seed();
    chrome.privacy = {
      websites: {
        thirdPartyCookiesAllowed: {
          async get() { return { value: true, levelOfControl: 'controllable_by_this_extension' }; },
          async set() { /* sessizce hicbir sey yapmaz */ },
          onChange: { addListener() {} }
        }
      }
    };
    chrome.permissions.contains = async () => true;

    const outcome = await applyHardening({ blockThirdPartyCookies: true });

    assert.deepEqual(outcome.applied, [], 'teyit edilemeyen ayar uygulandi sayilmamali');
    assert.deepEqual(outcome.unverified, ['blockThirdPartyCookies']);
  });

  test('readHardeningState levelOfControl degerlerini raporlar', async () => {
    await seed();
    installPrivacy({ levelOfControl: 'not_controllable', value: true });

    const state = await readHardeningState();
    assert.equal(state.available, true);
    assert.equal(state.levels.blockThirdPartyCookies, 'not_controllable');
    assert.deepEqual(state.notControllable, ['blockThirdPartyCookies']);
    assert.equal(state.values.blockThirdPartyCookies, false, 'invert: allowed=true -> block=false');
  });

  test('privacy izni yoksa hicbir sey denenmez', async () => {
    await seed();
    const state = installPrivacy({ granted: false });
    const outcome = await applyHardening({ blockThirdPartyCookies: true });

    assert.equal(outcome.available, false);
    assert.equal(state.setCalls, 0);
    assert.ok(outcome.skipped.includes('permission-missing'));
  });

  test('watchHardeningChanges dinleyici baglar ve degisikligi iletir', async () => {
    await seed();
    const listeners = [];
    chrome.privacy = {
      websites: {
        thirdPartyCookiesAllowed: {
          async get() { return { value: true, levelOfControl: 'controllable_by_this_extension' }; },
          async set() {},
          onChange: { addListener(fn) { listeners.push(fn); } }
        }
      }
    };

    const seen = [];
    const attached = watchHardeningChanges(change => seen.push(change));
    assert.equal(attached, true);
    assert.equal(listeners.length, 1);

    listeners[0]({ value: false, levelOfControl: 'controlled_by_other_extensions' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, 'blockThirdPartyCookies');
    assert.equal(seen[0].controllable, false, 'baska eklenti kontrol ediyorsa controllable=false');
  });

  test('chrome.privacy hic yoksa sessizce vazgecer', async () => {
    await seed();
    delete chrome.privacy;
    chrome.permissions.contains = async () => true;

    const outcome = await applyHardening({ blockThirdPartyCookies: true });
    assert.equal(outcome.available, false);
    assert.ok(outcome.skipped.includes('api-unavailable'));
    assert.equal(watchHardeningChanges(() => {}), false);
  });
});

describe('A1 + 1.1: origin bazli HTTP onbellek temizligi', () => {
  // Chromium browsing_data_api.cc:
  //   kFilterableDataTypes = DATA_TYPE_SITE_DATA | DATA_TYPE_CACHE
  //   network_context->ClearHttpCache(..., filter_builder->BuildNetworkServiceFilter(), ...)
  // Yani `origins` filtresi cache'i de kapsar ve filtre gercekten ag servisine
  // gecer. "Site bazinda silinemez" varsayimi yanlisti; onbellege alinmis
  // JS/CSS/gorseller diskte kaliyordu ve onbellek varligi zamanlama
  // saldirisiyla ziyaret tespitine aciktir.

  test('tek alan adi temizliginde cache:true gonderilir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'example.com' })] });
    await purgeDomain('example.com');

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.ok(call.filter.origins, 'origin filtreli cagri olmali');
    assert.equal(call.types.cache, true, 'HTTP onbellegi origin bazinda temizlenmeli');
  });

  test('korumali alt alan adinin onbellegi TEMIZLENMEZ', async () => {
    // BFCache de bu cagriyla dusuyor; beyaz listedeki bir sitenin geri
    // tusunda tam sayfa yeniden yuklemesine yol acmamaliyiz.
    await seed({
      cookies: [makeCookie({ domain: 'mail.example.com' }), makeCookie({ domain: 'ads.example.com' })],
      rules: { 'mail.example.com': whiteRule('mail.example.com', { subdomains: false }) }
    });

    await purgeDomain('example.com');
    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.equal(call.types.cache, true);
    assert.ok(!call.filter.origins.includes('https://mail.example.com'),
      'korumali origin onbellek temizligine de girmemeli');
    assert.ok(call.filter.origins.includes('https://ads.example.com'));
  });

  test('toplu temizlikte excludeOrigins ile birlikte cache:true gonderilir', async () => {
    // Onceki halinde onbellek yalnizca GLOBAL olarak, kullanici acikca
    // isterse siliniyordu; yani beyaz listedeki sitelerin onbellegi de
    // ucuyordu. excludeOrigins + cache bunu korumali hale getirir.
    await seed({
      cookies: [makeCookie({ name: 'keep', domain: 'safe.com' }), makeCookie({ name: 'go', domain: 'bad.com' })],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    await purgeAllNonWhitelisted();

    const scoped = chromeStub._state.browsingDataCalls.find(c => c.filter.excludeOrigins);
    assert.ok(scoped, 'excludeOrigins ile cagri olmali');
    assert.equal(scoped.types.cache, true, 'toplu temizlikte de onbellek gitmeli');
    assert.ok(scoped.filter.excludeOrigins.includes('https://safe.com'),
      'beyaz listedeki sitenin onbellegi korunmali');
  });

  test('korumali kural yoksa filtresiz cagri da cache icerir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'a.com' })] });
    await purgeAllNonWhitelisted();

    const call = chromeStub._state.browsingDataCalls.find(c => !c.filter.excludeOrigins && !c.filter.origins);
    assert.ok(call, 'filtresiz cagri olmali');
    assert.equal(call.types.cache, true);
  });

  test('cleanCacheOnPurgeAll KAPALI olsa bile origin bazli onbellek temizlenir', async () => {
    // Bu ayar artik yalnizca EK global temizligi (HSTS, QUIC, arama onerisi
    // onbellegi gibi origin filtresine girmeyen izler) kontrol eder.
    await seed({
      cookies: [makeCookie({ domain: 'example.com' })],
      settings: { cleanCacheOnPurgeAll: false }
    });

    await purgeDomain('example.com');
    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.equal(call.types.cache, true, 'hedefli temizlik ayardan bagimsiz onbellegi kapsar');
  });

  test('cleanLocalStorage kapatilsa bile cache ayri karar', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'example.com' })],
      settings: { cleanLocalStorage: false, cleanIndexedDB: false }
    });

    await purgeDomain('example.com');
    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.equal(call.types.localStorage, undefined);
    assert.equal(call.types.indexedDB, undefined);
    assert.equal(call.types.cache, true);
  });
});

describe('1.2: uzun temizlikler parcalanir (MV3 5 dakika siniri)', () => {
  test('silme istekleri SINIRSIZ paralel gonderilmez', async () => {
    // Onceki hali: Promise.all(items.map(deleteUrl)) -> 12.000 es zamanli
    // istek. MV3'te tek bir olay 5 dakikayi gecerse worker oldurulur ve
    // temizlik yarida kalir; kullanici "temizlendi" gorur.
    const base = Date.now();
    const history = [];
    for (let i = 0; i < 1000; i++) {
      history.push(makeHistoryItem(`https://example.com/p${i}`, { lastVisitTime: base - i * 1000 }));
    }
    await seed({ history });

    let peak = 0;
    let inflight = 0;
    const original = chrome.history.deleteUrl;
    chrome.history.deleteUrl = async (arg) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise(r => setTimeout(r, 0));
      const out = await original(arg);
      inflight--;
      return out;
    };

    try {
      const result = await purgeDomain('example.com');
      assert.equal(result.history, 1000, 'tum kayitlar silinmeli');
      assert.ok(peak <= 400, `es zamanli istek tavani asilmamali (tepe: ${peak})`);
      assert.ok(peak > 1, 'parcalar yine de paralel gonderilmeli');
    } finally {
      chrome.history.deleteUrl = original;
    }
  });

  test('zaman butcesi dolarsa kalan bildirilir ve silinenler KORUNUR', async () => {
    const history = [];
    const base = Date.now();
    for (let i = 0; i < 1200; i++) {
      history.push(makeHistoryItem(`https://example.com/p${i}`, { lastVisitTime: base - i * 1000 }));
    }
    await seed({ history });

    const scope = createDomainScope('example.com');
    // Her silmeyi yavaslatarak butceyi kesin doldur
    const original = chrome.history.deleteUrl;
    chrome.history.deleteUrl = async (arg) => {
      await new Promise(r => setTimeout(r, 1));
      return original(arg);
    };

    try {
      const result = await deleteHistoryForScope(scope, { budgetMs: 5, chunkSize: 100 });
      assert.ok(result.remaining > 0, 'butce dolunca kalan bildirilmeli');
      assert.ok(result.count > 0, 'ilk parcalar silinmis olmali');
      assert.equal(result.count + result.remaining, 1200, 'silinen + kalan = toplam');
      // Idempotentlik: silinen kayitlar gercekten gitti
      assert.equal(chromeStub._state.history.length, result.remaining);
    } finally {
      chrome.history.deleteUrl = original;
    }
  });

  test('butce verilmezse tek turda tamamlanir ve remaining 0 doner', async () => {
    await seed({ history: [makeHistoryItem('https://example.com/a'), makeHistoryItem('https://example.com/b')] });
    const scope = createDomainScope('example.com');
    const result = await deleteHistoryForScope(scope, {});
    assert.equal(result.count, 2);
    assert.equal(result.remaining, 0);
  });

  test('purgeDomain remaining alanini yukari tasir', async () => {
    await seed({ history: [makeHistoryItem('https://example.com/a')] });
    const result = await purgeDomain('example.com');
    assert.equal(result.remaining, 0, 'kucuk isde remaining 0 olmali');
    assert.ok('remaining' in result, 'remaining alani her zaman bulunmali');
  });

  test('toplu indirme silme de parcalanir', async () => {
    const downloads = [];
    for (let i = 0; i < 500; i++) downloads.push({ id: i, url: `https://bad.com/f${i}.zip` });
    await seed({ downloads });

    let peak = 0;
    let inflight = 0;
    const original = chrome.downloads.erase;
    chrome.downloads.erase = async (arg) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise(r => setTimeout(r, 0));
      const out = await original(arg);
      inflight--;
      return out;
    };

    try {
      const result = await purgeAllNonWhitelisted();
      assert.equal(result.downloads, 500);
      assert.ok(peak <= 200, `indirme silme tavani asilmamali (tepe: ${peak})`);
    } finally {
      chrome.downloads.erase = original;
    }
  });
});

describe('2.10: kaldirilan Privacy Sandbox API-leri (yetenek tespiti)', () => {
  /** Verilen anahtarlar icin calisan bir chrome.privacy taklidi kurar. */
  function installPrivacyFor(availableKeys) {
    const store = {};
    const make = (key) => {
      store[key] = true;
      return {
        async get() { return { value: store[key], levelOfControl: 'controllable_by_this_extension' }; },
        async set({ value }) { store[key] = value; },
        onChange: { addListener() {} }
      };
    };
    const groups = { websites: {}, network: {}, services: {} };
    const apiOf = {
      blockThirdPartyCookies: ['websites', 'thirdPartyCookiesAllowed'],
      disableRelatedWebsiteSets: ['websites', 'relatedWebsiteSetsEnabled'],
      disableNetworkPrediction: ['network', 'networkPredictionEnabled'],
      disableSearchSuggest: ['services', 'searchSuggestEnabled'],
      disableAlternateErrorPages: ['services', 'alternateErrorPagesEnabled']
    };
    for (const key of availableKeys) {
      const [group, api] = apiOf[key];
      groups[group][api] = make(key);
    }
    chrome.privacy = groups;
    chrome.permissions.contains = async () => true;
  }

  test('API yoksa "kaldirildi" olarak raporlanir, sessizce atlanmaz', async () => {
    // Chrome bir anahtari kaldirdiginda kod SURUM NUMARASINA baglanmaz;
    // API'nin varligina bakar. RWS tasfiye takviminde (M152).
    await seed();
    // Yalnizca kalici olanlar mevcut
    const persistent = ['blockThirdPartyCookies'];
    installPrivacyFor(persistent);

    const outcome = await applyHardening({ disableSearchSuggest: true,
      disableRelatedWebsiteSets: true });
    const expectedMissing = hardeningKeys().filter(k => !persistent.includes(k)).sort();

    assert.deepEqual(outcome.unsupported.sort(), expectedMissing,
      'tarayicida bulunmayan her anahtar unsupported olmali');
    for (const key of persistent) {
      assert.equal(outcome.unsupported.includes(key), false,
        `kalici API unsupported sayilmamali: ${key}`);
    }

    const state = await readHardeningState();
    assert.ok(state.unsupported.includes('disableSearchSuggest'));
    assert.equal(state.unsupported.includes('blockThirdPartyCookies'), false);
  });

  test('ILISKILI SITE KUMELERI kapatilir (3. taraf cerez engelinin kacis kapisi)', async () => {
    // Related Website Sets, Chrome'un TANIDIGI bir alan adi grubunun
    // birbirini 3. TARAF SAYMAMASINI saglar. Yani blockThirdPartyCookies
    // aciktayken bile kume icindeki alan adlari cerez paylasmaya devam
    // edebilir - engeli Chrome'un kendi actigi resmi bir kapi.
    //
    // Eklentinin tum kapsam modeli "kayit edilebilir alan adi" sinirina
    // dayaniyor; RWS tam olarak o siniri gecersiz kilar. Acikta birakmak,
    // 3. taraf cerezini engelledigini soyleyip kapiyi aralik birakmak olurdu.
    await seed();
    installPrivacyFor(hardeningKeys());

    const outcome = await applyHardening({ disableRelatedWebsiteSets: true });

    assert.ok(outcome.applied.includes('disableRelatedWebsiteSets=true'),
      'ayar uygulanmali');
    // invert: ayar ACIKKEN API degeri FALSE olmali (kumeler devre disi).
    const durum = await chrome.privacy.websites.relatedWebsiteSetsEnabled.get({});
    assert.equal(durum.value, false, 'kumeler devre disi birakilmali');
  });

  test('sunsettingKeys yalnizca kaldirilma yolundakileri listeler', () => {
    const sunset = sunsettingKeys();
    // Topics/FLEDGE/Attribution 2026-08-30'da KAPSAM DISI birakildi (silme
    // isine katkilari yoktu); geriye tasfiye yolundaki tek anahtar RWS kaldi.
    assert.deepEqual(sunset.sort(), ['disableRelatedWebsiteSets']);
    // Bunlar Chrome-un "Continue to support" listesinde veya bagimsiz:
    for (const persistent of ['blockThirdPartyCookies',
      'disableNetworkPrediction', 'disableSearchSuggest', 'disableAlternateErrorPages']) {
      assert.equal(sunset.includes(persistent), false, `${persistent} sunsetting olmamali`);
    }
  });

  test('hardeningKeys tum anahtarlari verir ve tekrarsizdir', () => {
    const keys = hardeningKeys();
    assert.equal(new Set(keys).size, keys.length, 'anahtarlar tekrarsiz olmali');
    // Beklenen kume; yeni anahtar eklenirse bu liste bilincli olarak guncellenir.
    // KAPSAM: yalnizca silmeye dokunan anahtarlar. Topics, Protected
    // Audience, Attribution Reporting ve baglanti takibi 2026-08-30'da
    // cikarildi - profilleme/uzak isaret, cerez ya da gecmis uretmiyorlar.
    assert.deepEqual(keys.slice().sort(), [
      'blockThirdPartyCookies',
      'disableAlternateErrorPages',
      'disableNetworkPrediction',
      'disableRelatedWebsiteSets',
      'disableSearchSuggest'
    ]);
  });

  test('her hardening anahtarinin bir varsayilani var (hepsi KAPALI)', () => {
    const defaults = storage.DEFAULT_SETTINGS.hardening;
    for (const key of hardeningKeys()) {
      assert.equal(key in defaults, true, `varsayilani eksik: ${key}`);
      assert.equal(defaults[key], false, `${key} varsayilan kapali olmali`);
    }
  });

  test('API mevcutsa unsupported bos kalir', async () => {
    await seed();
    installPrivacyFor(hardeningKeys());

    const outcome = await applyHardening({ blockThirdPartyCookies: true,
      disableSearchSuggest: true });
    assert.deepEqual(outcome.unsupported, []);
    assert.ok(outcome.applied.includes('blockThirdPartyCookies=true'));
    assert.ok(outcome.applied.includes('disableSearchSuggest=true'));
  });

  test('services grubundaki anahtarlar da uygulanir', async () => {
    // Adres cubugu onerileri ve hata sayfasi onerileri chrome.privacy.services
    // altinda; HARDENING_MAP grup destegi olmadan erisilemezdi.
    await seed();
    installPrivacyFor(['disableSearchSuggest', 'disableAlternateErrorPages']);

    const outcome = await applyHardening({
      disableSearchSuggest: true,
      disableAlternateErrorPages: true
    });
    assert.ok(outcome.applied.includes('disableSearchSuggest=true'));
    assert.ok(outcome.applied.includes('disableAlternateErrorPages=true'));
  });
});

describe('gecmis aramasi hata verirse "tam tarama" DENMEZ', () => {
  // BULGU: searchHistoryPaged icindeki catch yalnizca console.warn yazip
  // dongunden cikiyordu; `truncated` false kaliyordu. Yani ucuncu sayfada
  // gecici bir hata olursa YARIM okunan gecmis "tam tarama" sayiliyor,
  // bulunanlar silinip "temizlendi" deniyordu.
  //
  // Sayfa SINIRINA takilmak dogru sekilde truncated:true uretiyor - hata
  // ayni sonucu uretmiyordu. Ustelik console.warn teshis loglarina dusmuyor,
  // yani kullanici hicbir yerde goremiyordu.

  test('ortada hata olursa truncated TRUE doner', async () => {
    await seed({ history: [] });
    const history = [];
    for (let i = 0; i < 1200; i++) {
      history.push(makeHistoryItem(`https://ornek.com/p${i}`, { lastVisitTime: Date.now() - i * 1000 }));
    }
    chromeStub._state.history = history;

    let calls = 0;
    const original = chrome.history.search;
    chrome.history.search = async (query) => {
      calls++;
      if (calls === 2) throw new Error('gecici arama hatasi');
      return original(query);
    };

    try {
      const res = await searchHistoryPaged({ text: '', pageSize: 500 });
      assert.ok(res.items.length > 0, 'ilk sayfa toplanmis olmali');
      assert.equal(res.truncated, true,
        'hata yuzunden yarim kalan tarama TAM sayilmamali');
    } finally {
      chrome.history.search = original;
    }
  });

  test('hata teshis loglarina yazilir', async () => {
    await seed({ history: [] });
    const history = [];
    for (let i = 0; i < 1200; i++) {
      history.push(makeHistoryItem(`https://ornek.com/p${i}`, { lastVisitTime: Date.now() - i * 1000 }));
    }
    chromeStub._state.history = history;
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    let calls = 0;
    const original = chrome.history.search;
    chrome.history.search = async (query) => {
      calls++;
      if (calls === 2) throw new Error('gecici arama hatasi');
      return original(query);
    };
    try {
      await searchHistoryPaged({ text: '', pageSize: 500 });
    } finally {
      chrome.history.search = original;
    }

    const logs = await logger.getLogs();
    assert.ok(logs.some(l => (l.level === 'WARN' || l.level === 'ERROR')
      && /arama/i.test(l.message)),
      'console.warn yeterli degil; kullanici teshis ekraninda gormeli');
  });

  test('ilk sayfada hata olursa da truncated TRUE', async () => {
    await seed({ history: [makeHistoryItem('https://ornek.com/a')] });
    const original = chrome.history.search;
    chrome.history.search = async () => { throw new Error('hemen patla'); };
    try {
      const res = await searchHistoryPaged({ text: '' });
      assert.equal(res.items.length, 0);
      assert.equal(res.truncated, true,
        'hic okuyamadiysak kesinlikle tam tarama degil');
    } finally {
      chrome.history.search = original;
    }
  });

  test('hata yoksa truncated FALSE kalir', async () => {
    await seed({ history: [makeHistoryItem('https://ornek.com/a')] });
    const res = await searchHistoryPaged({ text: '' });
    assert.equal(res.truncated, false, 'saglikli taramada bayrak kalkmamali');
  });
});

describe('toplu temizlik: beyaz listedeki alt alan adi depolamasi KORUNUR', () => {
  // BULGU: buildProtectedOrigins yalnizca knownHosts icinde olan alt alan
  // adlarini koruyabiliyor. knownHosts uc kaynaktan besleniyor: cerez
  // host'lari, gecmis host'lari, acik sekmeler. Bosluklar:
  //
  //   * cleanHistory KAPALIYSA gecmis host'lari hic eklenmiyor.
  //   * Yalnizca depolamasi olan alt alan adi (cerez yok, gecmis yok, sekme
  //     kapali) listeye hic girmiyor.
  //
  // excludeOrigins ile yapilan cagri "bunlar HARIC her seyi sil" demek, yani
  // listeye girmeyen beyaz listeli alt alan adinin localStorage'i UCAR.
  // Bu VERI KAYBI yonunde bir hata.
  //
  // Elimizde tam bu is icin iki kaynak var ama kullanilmiyordu: depolama
  // olcum haritasi ve 3. taraf haritasi.

  function excludeCall() {
    return chromeStub._state.browsingDataCalls.find(c => c.filter?.excludeOrigins);
  }

  test('depolama olcumu olan alt alan adi excludeOrigins e girer', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      rules: { 'ornek.com': { domain: 'ornek.com', type: 'white', subdomains: true } },
      settings: { cleanHistory: false }
    });

    // app.ornek.com'un YALNIZCA depolamasi var: cerez yok, gecmis yok, sekme yok.
    await sessionState.recordStorageEstimate('app.ornek.com', 512 * 1024);

    await purgeAllNonWhitelisted();

    const call = excludeCall();
    assert.ok(call, 'excludeOrigins li cagri yapilmali');
    const origins = call.filter.excludeOrigins;
    assert.ok(origins.includes('https://app.ornek.com'),
      `beyaz listedeki alt alan adi korunmali; liste: ${origins.join(', ')}`);
  });

  test('3. taraf haritasindaki alt alan adi da korunur', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      rules: { 'ornek.com': { domain: 'ornek.com', type: 'white', subdomains: true } },
      settings: { cleanHistory: false }
    });
    await sessionState.recordThirdParty('haber.com', ['cdn.ornek.com']);

    await purgeAllNonWhitelisted();

    const origins = excludeCall()?.filter?.excludeOrigins || [];
    assert.ok(origins.includes('https://cdn.ornek.com'),
      `beyaz listeli kok altindaki 3. taraf host korunmali; liste: ${origins.join(', ')}`);
  });

  test('kural alt alan adlarini KAPSAMIYORSA alt alan adi korunmaz', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      rules: { 'ornek.com': { domain: 'ornek.com', type: 'white', subdomains: false } }
    });
    await sessionState.recordStorageEstimate('app.ornek.com', 1024);

    await purgeAllNonWhitelisted();

    const origins = excludeCall()?.filter?.excludeOrigins || [];
    assert.ok(origins.includes('https://ornek.com'), 'kok korunmali');
    assert.ok(!origins.includes('https://app.ornek.com'),
      'kapsam kapaliyken alt alan adi korunmamali - kullanicinin secimi bu');
  });

  test('beyaz listede olmayan host excludeOrigins e girmez', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      rules: { 'ornek.com': { domain: 'ornek.com', type: 'white', subdomains: true } }
    });
    await sessionState.recordStorageEstimate('izleyici.com', 4096);

    await purgeAllNonWhitelisted();

    const origins = excludeCall()?.filter?.excludeOrigins || [];
    assert.ok(!origins.includes('https://izleyici.com'),
      'korumasiz host listeye girmemeli, yoksa hic temizlenmez');
  });
});

describe('TEK SITE temizligi depolama olcumunu KESIF kaynagi sayar', () => {
  // Toplu yol depolama olcum haritasini okuyup KORUMA listesini besliyordu;
  // tek site yolu ayni haritayi hic okumuyordu. Sonuc iki katli bir hataydi:
  //
  //   ornek.com kok temizligi -> cerezi ve gecmisi olmayan, yalnizca
  //   IndexedDB tutan app.ornek.com origins listesine girmiyor, depolamasi
  //   DISKTE KALIYOR. Ama consumeStorageEstimates kapsamdaki olcumu yine de
  //   tuketiyor: baytlar "bosaltildi" diye sayiliyor ve o host'ta veri
  //   bulundugunun TEK sinyali (Chrome origin listeleme API'si vermiyor)
  //   siliniyor. Yani veri kaliyor, kullaniciya silindi deniyor.

  const targetedCall = () =>
    chromeStub._state.browsingDataCalls.find(c => c.filter?.origins);

  test('olcumu olan alt alan adi origins listesine girer', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'ornek.com' })],
      settings: { cleanHistory: false }
    });
    // app.ornek.com'un YALNIZCA depolamasi var: cerez yok, gecmis yok, sekme yok.
    await sessionState.recordStorageEstimate('app.ornek.com', 512 * 1024);

    const result = await purgeDomain('ornek.com');

    const origins = targetedCall()?.filter?.origins || [];
    assert.ok(origins.includes('https://app.ornek.com'),
      `olculen alt alan adi silinmeli; liste: ${origins.join(', ')}`);
    // Bayt raporu ancak veri gercekten silindiyse dogru.
    assert.equal(result.storageBytes, 512 * 1024);
  });

  test('KORUMALI alt alan adinin olcumu origins listesine GIRMEZ', async () => {
    // Kesif kaynagini genisletmek korumayi gevsetmemeli.
    await seed({
      cookies: [makeCookie({ domain: 'ornek.com' })],
      rules: { 'app.ornek.com': whiteRule('app.ornek.com') },
      settings: { cleanHistory: false }
    });
    await sessionState.recordStorageEstimate('app.ornek.com', 512 * 1024);

    await purgeDomain('ornek.com');

    const origins = targetedCall()?.filter?.origins || [];
    assert.ok(!origins.includes('https://app.ornek.com'),
      'beyaz listedeki alt alan adinin depolamasi silinmemeli');
    const kalan = await sessionState.getStorageEstimates();
    assert.ok(kalan['app.ornek.com'], 'silinmeyen depolamanin olcumu tuketilmemeli');
  });
});

describe('site erisimi kisitliysa temizlik BASARILI raporlanmaz', () => {
  // Kullanici chrome://extensions'ta site erisimini daraltirsa chrome.cookies
  // ve browsingData o alan adi icin SESSIZCE bos doner - hata yok, veri de
  // gitmiyor. Kontrol yalnizca runScheduledPurge'de vardi; klavye kisayolu,
  // sag tik menusu, popup'taki "Simdi Temizle" ve yetim taramasi ayni motoru
  // DOGRUDAN cagirdigi icin bu yollar "Temizlendi | cerez: 0" diyordu.
  //
  // Kontrol motorun TEK girisinde (purgeDomain) durmali; her cagri yerine
  // ayri ayri eklemek, bir sonraki cagri yerinin yine atlanmasi demek.

  test('erisim yoksa noHostAccess bildirilir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });
    chromeStub._state.revokedOrigins = ['https://ornek.com/'];

    const result = await purgeDomain('ornek.com');

    assert.equal(result.noHostAccess, true, 'erisim yoklugu sonuca yansimali');
    assert.equal(chromeStub._state.cookies.length, 1, 'hicbir sey silinmemis olmali');
  });

  test('erisim yoksa istatistik SISIRILMEZ', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });
    chromeStub._state.revokedOrigins = ['https://ornek.com/'];

    await purgeDomain('ornek.com');

    const stats = await storage.getStats();
    assert.equal(stats.totalCleans, 0, 'yapilmamis temizlik sayilmamali');
  });

  test('erisim yoksa ERROR loglanir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })], settings: { logLevel: 'info' } });
    chromeStub._state.revokedOrigins = ['https://ornek.com/'];

    await purgeDomain('ornek.com');

    const logs = await logger.getLogs(50);
    assert.ok(logs.some(entry => entry.level === 'ERROR' && /erisim/i.test(entry.message)),
      `erisim hatasi loglanmali; loglar: ${logs.map(l => `${l.level}:${l.message}`).join(' | ')}`);
  });

  test('erisim VARSA davranis degismez', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });

    const result = await purgeDomain('ornek.com');

    assert.notEqual(result.noHostAccess, true);
    assert.equal(result.cookies, 1);
  });

  test('baska bir alan adinin kisitlanmasi bu temizligi etkilemez', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });
    chromeStub._state.revokedOrigins = ['https://baska.com/'];

    const result = await purgeDomain('ornek.com');

    assert.notEqual(result.noHostAccess, true);
    assert.equal(result.cookies, 1);
  });
});

describe('originTypes: hedefli ile toplu arasindaki SAPMA bilinclidir', () => {
  // Bu blok bir "tutarsizligi duzeltmeye" karsi bekci. Iki cagri kasten
  // farkli: hedefli temizlikte kullanici siteyi ADIYLA sectigi icin
  // protectedWeb (barindirilan uygulama) dahil edilir; toplu supurmede
  // edilmez, cunku orada kullanicinin KURDUGU uygulamalarin verisi
  // silinirdi - gizlilik kazanci olmadan veri kaybi.

  test('hedefli cagri protectedWeb ICERIR', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });
    await purgeDomain('ornek.com');

    const call = chromeStub._state.browsingDataCalls.find(c => c.filter?.origins);
    assert.ok(call, 'origins filtreli cagri yapilmali');
    assert.equal(call.filter.originTypes.protectedWeb, true);
    assert.equal(call.filter.originTypes.unprotectedWeb, true);
  });

  test('toplu cagri originTypes ICERMEZ', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      rules: { 'ornek.com': whiteRule('ornek.com') }
    });
    await purgeAllNonWhitelisted();

    const call = chromeStub._state.browsingDataCalls.find(c => c.filter?.excludeOrigins);
    assert.ok(call, 'excludeOrigins li cagri yapilmali');
    assert.equal(call.filter.originTypes, undefined,
      'toplu supurmede protectedWeb kurulu uygulamalarin verisini goturur');
  });

  test('extension: true HICBIR cagrida verilmez', async () => {
    await seed({ cookies: [makeCookie({ domain: 'a.com' })] });
    await purgeDomain('a.com');
    await purgeAllNonWhitelisted();
    for (const call of chromeStub._state.browsingDataCalls) {
      assert.notEqual(call.filter?.originTypes?.extension, true,
        'kendi verimizi ve diger eklentileri silmek asla');
    }
  });
});

describe('alt alan adi kurali + kapsa: temizlik motoru uygular (v2.7.0)', () => {
  // Kurallar BILEREK setDomainRule ile yaziliyor, ham nesne olarak degil:
  // arayuzun kullandigi gercek yol bu ve kapsam karari (normalizeRule) tam
  // orada veriliyor. Ham nesne seed etmek normalizeRule'u atlar; o zaman bu
  // testler kural katmanini degil yalnizca matchDomainRule'u olcerdi ve
  // kapsam kilidi geri gelse bile yesil kalirlardi.

  test('kapsa ACIK: kok temizliginde alt dalin cerezi KORUNUR', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'kok', domain: 'google.com' }),
        makeCookie({ name: 'kardes', domain: 'drive.google.com' }),
        makeCookie({ name: 'kural', domain: 'mail.google.com' }),
        makeCookie({ name: 'dal', domain: 'x.mail.google.com' })
      ]
    });
    await setDomainRule('mail.google.com', 'white', { subdomains: true });

    await purgeDomain('google.com');

    const kalan = chromeStub._state.cookies.map(c => c.name).sort();
    assert.deepEqual(kalan, ['dal', 'kural'],
      'kural ve KENDI dali kalmali; kok ve kardes silinmeli');
  });

  test('kapsa KAPALI: kok temizliginde alt dalin cerezi SILINIR', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'kural', domain: 'mail.google.com' }),
        makeCookie({ name: 'dal', domain: 'x.mail.google.com' })
      ]
    });
    await setDomainRule('mail.google.com', 'white', { subdomains: false });

    await purgeDomain('google.com');

    assert.deepEqual(chromeStub._state.cookies.map(c => c.name), ['kural'],
      'yalnizca kuralin kendisi kalmali');
  });

  test('kapsa BELIRTILMEZSE alt alan adinda varsayilan KAPALI kalir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'kural', domain: 'mail.google.com' }),
        makeCookie({ name: 'dal', domain: 'x.mail.google.com' })
      ]
    });
    await setDomainRule('mail.google.com', 'white', {});

    await purgeDomain('google.com');

    assert.deepEqual(chromeStub._state.cookies.map(c => c.name), ['kural'],
      'alt alan adinda kapsam opt-in olmali');
  });

  test('kapsa ACIK: alt dalin depolamasi origin listesinden dislanir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'kok', domain: 'google.com' }),
        makeCookie({ name: 'dal', domain: 'x.mail.google.com' })
      ]
    });
    await setDomainRule('mail.google.com', 'white', { subdomains: true });

    await purgeDomain('google.com');

    const origins = chromeStub._state.browsingDataCalls
      .flatMap(c => c.filter?.origins || []);
    assert.ok(!origins.includes('https://x.mail.google.com'),
      `korunan dalin depolamasi silinmemeli; liste: ${origins.join(', ')}`);
    assert.ok(origins.includes('https://google.com'), 'kok temizlenmeli');
  });

  test('kapsa ACIK: toplu temizlikte alt dal excludeOrigins e girer', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      settings: { cleanHistory: false }
    });
    await setDomainRule('mail.google.com', 'white', { subdomains: true });
    await sessionState.recordStorageEstimate('x.mail.google.com', 2048);

    await purgeAllNonWhitelisted();

    const origins = chromeStub._state.browsingDataCalls
      .find(c => c.filter?.excludeOrigins)?.filter?.excludeOrigins || [];
    assert.ok(origins.includes('https://x.mail.google.com'),
      `korunan dal excludeOrigins e girmeli; liste: ${origins.join(', ')}`);
    assert.ok(!origins.includes('https://drive.google.com'), 'kardes korunmamali');
    assert.ok(!origins.includes('https://google.com'), 'ust korunmamali');
  });
});

describe('sertlestirme TEK YONLU: kapaliyken tarayici ayarina dokunmaz', () => {
  // BULGU: Tum sertlestirme anahtarlari invert:true. Anahtar KAPALIYKEN
  // wanted=false -> value=true -> set({value:true}).
  //
  // Somut sonuc: "3. taraf cerezleri engelle" kapaliysa eklenti
  // thirdPartyCookiesAllowed = TRUE yaziyordu. Yani kullanici Chrome'un kendi
  // ayarlarindan 3. taraf cerezleri engellemis olsa bile bir GIZLILIK
  // eklentisi onu aktif olarak geri aciyordu. Ustelik bu, ayarlar sekmesini
  // her acista tekrarliyordu (loadHardeningState -> APPLY_HARDENING).
  //
  // Dogru davranis: acikken sertlestir, kapaliyken kendi gecersiz kilmamizi
  // BIRAK (clear) - karar kullanicinin tarayici ayarina kalsin. Chrome
  // dokumani da Privacy Sandbox anahtarlari icin "eklentiler bunu yalnizca
  // false yazarak devre disi birakabilir" diyor.

  function installPrivacy() {
    const calls = { set: [], clear: [] };
    const mk = (name) => ({
      async get() { return { value: true, levelOfControl: 'controllable_by_this_extension' }; },
      async set({ value }) { calls.set.push({ name, value }); },
      async clear() { calls.clear.push(name); },
      onChange: { addListener() {} }
    });
    chrome.privacy = {
      websites: {
        thirdPartyCookiesAllowed: mk('thirdPartyCookiesAllowed'),
        hyperlinkAuditingEnabled: mk('hyperlinkAuditingEnabled')
      },
      network: { networkPredictionEnabled: mk('networkPredictionEnabled') },
      services: {
        searchSuggestEnabled: mk('searchSuggestEnabled'),
        alternateErrorPagesEnabled: mk('alternateErrorPagesEnabled')
      }
    };
    chrome.permissions.contains = async () => true;
    return calls;
  }

  test('anahtar KAPALIYKEN set cagrilmaz, clear cagrilir', async () => {
    await seed({});
    const calls = installPrivacy();

    await applyHardening({ blockThirdPartyCookies: false, disableSearchSuggest: false });

    const wrote = calls.set.filter(c => c.name === 'thirdPartyCookiesAllowed');
    assert.deepEqual(wrote, [],
      'kapali anahtar icin set() cagrilmamali - kullanicinin Chrome ayarini eziyor');
    assert.ok(calls.clear.includes('thirdPartyCookiesAllowed'),
      'kendi gecersiz kilmamiz birakilmali (clear) ki Chrome ayari gecerli olsun');
  });

  test('anahtar ACIKKEN sertlestirici deger yazilir', async () => {
    await seed({});
    const calls = installPrivacy();

    await applyHardening({ blockThirdPartyCookies: true });

    const wrote = calls.set.filter(c => c.name === 'thirdPartyCookiesAllowed');
    assert.equal(wrote.length, 1, 'acik anahtar icin set() cagrilmali');
    assert.equal(wrote[0].value, false,
      '3. taraf cerezleri ENGELLEMEK icin thirdPartyCookiesAllowed=false yazilmali');
    assert.ok(!calls.clear.includes('thirdPartyCookiesAllowed'),
      'acikken clear cagrilmamali');
  });

  test('HICBIR durumda izin verici deger yazilmaz', async () => {
    await seed({});
    const calls = installPrivacy();

    await applyHardening({});                       // hepsi kapali
    await applyHardening({ disableSearchSuggest: true });   // biri acik

    const permissive = calls.set.filter(c => c.value === true);
    assert.deepEqual(permissive, [],
      `bir gizlilik eklentisi izin verici deger YAZMAMALI; yazilanlar: ${JSON.stringify(permissive)}`);
  });

  test('kapali anahtar "applied" olarak raporlanmaz', async () => {
    await seed({});
    installPrivacy();
    const outcome = await applyHardening({ blockThirdPartyCookies: false });
    assert.ok(!outcome.applied.some(a => a.startsWith('blockThirdPartyCookies')),
      'dokunulmayan ayar uygulanmis gibi raporlanmamali');
  });
});

describe('AYNI ISIMLI cerez: alt alan adini silmek USTU goturmemeli', () => {
  // GERCEK TARAYICIDA BULUNDU. chrome.cookies.remove(url, name) o URL'de
  // GORUNEN, o isimdeki TUM cerezleri siler (Chromium: "Deletes all cookies
  // with the specified name that match the given URL"). Alt alan adinin
  // URL'sinde ust alan adinin ayni isimli cerezi de gorunur.
  //
  // Sonuc: korumasiz gist.github.com temizlenirken BEYAZ LISTEDEKI
  // github.com'un ayni isimli oturum cerezi de ucuyor - kullanici oturumdan
  // atiliyor. Eklentinin cekirdek vaadi tam olarak bu.
  //
  // Birim testler yakalayamamisti cunku stub tek cerez siliyordu; stub
  // gercege uyduruldu (bkz. helpers/chrome-stub.js remove).

  const isimler = () => chromeStub._state.cookies
    .map(c => `${c.domain}|${c.name}`).sort();

  test('beyaz listedeki UST alan adinin ayni isimli cerezi KORUNUR', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sessionid', domain: '.github.com' }),
        makeCookie({ name: 'sessionid', domain: 'gist.github.com' })
      ],
      rules: { 'github.com': whiteRule('github.com', { subdomains: false }) }
    });

    await purgeAllNonWhitelisted();

    assertHasCookie('.github.com', 'sessionid');
  });

  test('tek site temizliginde de UST alan adi korunur', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'auth_token', domain: '.ornek.com' }),
        makeCookie({ name: 'auth_token', domain: 'alt.ornek.com' })
      ],
      rules: { 'ornek.com': whiteRule('ornek.com', { subdomains: false }) }
    });

    await purgeDomain('alt.ornek.com');

    assertHasCookie('.ornek.com', 'auth_token');
  });

  test('hedeflenen cerez GERCEKTEN silinir (koruma silmeyi engellemez)', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sessionid', domain: '.github.com' }),
        makeCookie({ name: 'sessionid', domain: 'gist.github.com' })
      ],
      rules: { 'github.com': whiteRule('github.com', { subdomains: false }) }
    });

    await purgeAllNonWhitelisted();

    const kalan = isimler();
    assert.ok(!kalan.includes('gist.github.com|sessionid'),
      `korumasiz alt alan adi cerezi silinmeliydi; kalanlar: ${kalan.join(', ')}`);
  });

  function assertHasCookie(domain, name) {
    const kalan = isimler();
    assert.ok(kalan.includes(`${domain}|${name}`),
      `${domain} uzerindeki '${name}' cerezi KORUNMALIYDI; kalanlar: ${kalan.join(', ') || '(hicbiri)'}`);
  }
});

describe('yan hasar KORUMASI hedefleri diriltmemeli (kod incelemesi bulgusu)', () => {
  // Onceki turda eklenen "sil ve yan hasari geri koy" mekanizmasi KORUMASIZ
  // cerezleri de geri koyuyordu. Silmeler Promise.all ile PARALEL kostugu
  // icin, ayni isimli iki hedeften her biri digerinin sildigini yeniden
  // yaratabiliyor: sayac "silindi" diyor, cerez diskte kaliyor.
  //
  // Dogru kural: yalnizca KORUMALI cerezler geri konur. Korumasiz bir cerez
  // zaten kendi sirasinda silinecektir.

  const kalanlar = () => chromeStub._state.cookies.map(c => `${c.domain}|${c.name}`).sort();

  test('ayni isimli IKI KORUMASIZ cerez birlikte silinir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sessionid', domain: '.ornek.com' }),
        makeCookie({ name: 'sessionid', domain: 'alt.ornek.com' })
      ]
    });

    await purgeAllNonWhitelisted();

    assert.deepEqual(kalanlar(), [],
      `korumasiz cerezlerin ikisi de silinmeliydi; kalan: ${kalanlar().join(', ')}`);
  });

  test('tek site temizliginde de ikisi birden gider', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'token', domain: '.ornek.com' }),
        makeCookie({ name: 'token', domain: 'alt.ornek.com' })
      ]
    });

    await purgeDomain('ornek.com');

    assert.deepEqual(kalanlar(), [],
      `kok temizligi ikisini de goturmeliydi; kalan: ${kalanlar().join(', ')}`);
  });

  test('KORUMALI olan hala geri konur (onceki duzeltme bozulmadi)', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sessionid', domain: '.github.com' }),
        makeCookie({ name: 'sessionid', domain: 'gist.github.com' })
      ],
      rules: { 'github.com': whiteRule('github.com', { subdomains: false }) }
    });

    await purgeAllNonWhitelisted();

    assert.deepEqual(kalanlar(), ['.github.com|sessionid'],
      `beyaz listedeki korunmali, digeri gitmeli; kalan: ${kalanlar().join(', ')}`);
  });
});

describe('istatistik: bosaltilan depolama IKI KEZ sayilmamali', () => {
  // purgeAllNonWhitelisted depolamayi siliyor ama olcum kayitlarini
  // TUKETMIYORDU. Kayit duruyor; ayni alan adi daha sonra tek tek
  // temizlenince o baytlar bir kez daha ekleniyor - oysa depolama ilk
  // temizlikte zaten gitmisti. Bu projede uydurma sayi uretmemek acik bir
  // kural, bu da uydurma sayinin ta kendisi.

  test('toplu temizlik olcumu tuketir, sonraki temizlik tekrar saymaz', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });
    await sessionState.recordStorageEstimate('ornek.com', 5_000_000);

    await purgeAllNonWhitelisted();
    const sonrasi = await storage.getStats();

    // Ayni alan adi tekrar temizlenirse EK bayt eklenmemeli.
    await purgeDomain('ornek.com');
    const ikinci = await storage.getStats();

    assert.equal(ikinci.storageBytesFreed, sonrasi.storageBytesFreed,
      'ayni depolama iki kez sayilmamali');
  });

  test('toplu temizlik bosaltilan depolamayi RAPOR eder', async () => {
    await seed({ cookies: [makeCookie({ domain: 'ornek.com' })] });
    await sessionState.recordStorageEstimate('ornek.com', 3_000_000);

    await purgeAllNonWhitelisted();
    const stats = await storage.getStats();
    assert.ok(stats.storageBytesFreed >= 3_000_000,
      `toplu temizlik olculen depolamayi bildirmeli; gelen: ${stats.storageBytesFreed}`);
  });

  test('KORUMALI alan adinin olcumu tuketilmez', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'baska.com' })],
      rules: { 'safe.com': whiteRule('safe.com') }
    });
    await sessionState.recordStorageEstimate('safe.com', 9_000_000);

    await purgeAllNonWhitelisted();
    const kalan = await sessionState.getStorageEstimates();
    assert.ok(kalan['safe.com'], 'korumali alan adinin olcumu durmali - verisi silinmedi');
  });
});

describe('TOPLU temizlik ACIK sekmeleri atlamali (sekme kapanisi yoluyla ayni saygi)', () => {
  // Eklentinin tum modeli "sekme kapaninca temizle" uzerine kurulu:
  // scheduleDomainPurge ve runScheduledPurge acik sekme varsa DURUYOR.
  // Toplu yol bu kurali cigneyen TEK yerdi - kullanicinin o an kullandigi
  // siteden onu atiyordu. Periyodik supurmenin varsayilan KAPALI olmasinin
  // sebebi de buydu; duzeltilince guvenle acilabilir.
  //
  // Beyaz liste davranisi DEGISMIYOR: o zaten her yolda korumali.

  const kalanCerezler = () => new Set(chromeStub._state.cookies.map(c => c.domain.replace(/^\./, '')));

  test('acik sekmesi olan site TEMIZLENMEZ', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'a', domain: 'acik.com' }),
        makeCookie({ name: 'b', domain: 'kapali.com' })
      ],
      tabs: [{ id: 1, url: 'https://acik.com/', active: true, incognito: false }]
    });

    await purgeAllNonWhitelisted();

    const kalan = kalanCerezler();
    assert.ok(kalan.has('acik.com'), 'acik sekmenin verisi durmali');
    assert.ok(!kalan.has('kapali.com'), 'kapali sitenin verisi gitmeli');
  });

  test('acik sekmenin GECMISI de korunur', async () => {
    await seed({
      history: [makeHistoryItem('https://acik.com/x'), makeHistoryItem('https://kapali.com/y')],
      tabs: [{ id: 1, url: 'https://acik.com/', active: true, incognito: false }]
    });

    await purgeAllNonWhitelisted();

    const urller = chromeStub._state.history.map(h => h.url);
    assert.ok(urller.some(u => u.includes('acik.com')), 'acik sekmenin gecmisi durmali');
    assert.ok(!urller.some(u => u.includes('kapali.com')), 'kapali sitenin gecmisi gitmeli');
  });

  test('acik sekme ALT ALAN ADI ile eslesirse de korunur', async () => {
    // scope(acik.com).matches(mail.acik.com) === true - sekme kapanisi
    // yolundaki kuralin AYNISI.
    await seed({
      cookies: [makeCookie({ name: 'a', domain: 'acik.com' })],
      tabs: [{ id: 1, url: 'https://mail.acik.com/', active: true, incognito: false }]
    });

    await purgeAllNonWhitelisted();
    assert.ok(kalanCerezler().has('acik.com'), 'alt alan adi acikken kok korunmali');
  });

  test('GIZLI sekme acik sekme SAYILMAZ', async () => {
    await seed({
      cookies: [makeCookie({ name: 'a', domain: 'gizli.com' })],
      tabs: [{ id: 1, url: 'https://gizli.com/', active: true, incognito: true }]
    });

    await purgeAllNonWhitelisted();
    assert.ok(!kalanCerezler().has('gizli.com'),
      'gizli sekme normal profildeki temizligi engellememeli');
  });

  test('atlanan site sayisi RAPOR edilir (sessiz atlama yok)', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'acik.com' }), makeCookie({ domain: 'kapali.com' })],
      tabs: [{ id: 1, url: 'https://acik.com/', active: true, incognito: false }]
    });

    const sonuc = await purgeAllNonWhitelisted();
    assert.ok(sonuc.skippedOpen >= 1,
      `acik sekme yuzunden atlananlar raporlanmali; sonuc: ${JSON.stringify(sonuc)}`);
  });

  test('BEYAZ LISTE davranisi degismedi', async () => {
    await seed({
      cookies: [
        makeCookie({ domain: 'beyaz.com' }),
        makeCookie({ domain: 'kapali.com' })
      ],
      tabs: [],
      rules: { 'beyaz.com': whiteRule('beyaz.com') }
    });

    await purgeAllNonWhitelisted();
    const kalan = kalanCerezler();
    assert.ok(kalan.has('beyaz.com'), 'beyaz liste her zaman korunur');
    assert.ok(!kalan.has('kapali.com'), 'digeri gider');
  });
});

describe('TOPLU temizlik kisitli site erisimini BILDIRMELI', () => {
  // Kullanici chrome://extensions'ta site erisimini daraltirsa chrome.cookies
  // o hostlari HIC DONDURMEZ - toplu temizlik onlari goremez ve "N cerez
  // silindi" diye basari raporlar. Tek site yolu bu durumu ERROR olarak
  // logluyor; toplu yol tamamen sessizdi.

  test('erisim daraltilmissa sonuc bunu bildirir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'gorunen.com' })] });
    chromeStub._state.revokedOrigins = ['https://gizlenen.com/'];

    const sonuc = await purgeAllNonWhitelisted();
    assert.equal(sonuc.limitedAccess, true,
      `kisitli erisim sonuca yansimali: ${JSON.stringify(sonuc)}`);
  });

  test('erisim daraltilmissa ERROR loglanir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'gorunen.com' })], settings: { logLevel: 'info' } });
    chromeStub._state.revokedOrigins = ['https://gizlenen.com/'];

    await purgeAllNonWhitelisted();
    const logs = await logger.getLogs(50);
    // Kategori de dogrulanir: LogCategory.<YOKOLAN> yazim hatasi undefined
    // gecer, lint yakalamaz ve kayit kategorisiz kalir.
    assert.ok(logs.some(l => l.level === 'ERROR' && /erisim/i.test(l.message)
      && l.category === 'PURGE'),
      `kisit ERROR olarak loglanmali; loglar: ${logs.map(l => `${l.level}:${l.message}`).join(' | ')}`);
  });

  test('TAM erisim varken sessiz kalir', async () => {
    await seed({ cookies: [makeCookie({ domain: 'gorunen.com' })] });
    const sonuc = await purgeAllNonWhitelisted();
    assert.notEqual(sonuc.limitedAccess, true, 'tam erisimde uyari olmamali');
  });
});

describe('VERI TURU ANAHTARLARI: ACIK ve KAPALI durum ayri ayri (v2.7.0)', () => {
  // KAPSAM OLCUMU BULGUSU: cleanDownloads hicbir testte gecmiyordu,
  // cleanServiceWorkers yalnizca KAPALI durumda olculmustu. "Ayar
  // kaydediliyor" testi yetmez; olculmesi gereken sey DAVRANISIN degismesi.

  test('cleanDownloads ACIK: indirme kaydi SILINIR', async () => {
    await seed({
      downloads: [{ id: 11, url: 'https://example.com/dosya.zip' }],
      settings: { cleanDownloads: true }
    });
    await purgeDomain('example.com');

    assert.deepEqual(chromeStub._state.downloads, [],
      'indirme kaydi silinmeliydi');
    assert.equal(chromeStub._state.erasedDownloads.length, 1);
  });

  test('cleanDownloads KAPALI: indirme kaydi KORUNUR', async () => {
    await seed({
      downloads: [{ id: 12, url: 'https://example.com/dosya.zip' }],
      settings: { cleanDownloads: false }
    });
    await purgeDomain('example.com');

    assert.equal(chromeStub._state.downloads.length, 1,
      'ayar kapaliyken indirme kaydina dokunulmamali');
    assert.equal(chromeStub._state.erasedDownloads.length, 0);
  });

  test('cleanDownloads KAPALIYKEN kapsam disi kayit da etkilenmez', async () => {
    await seed({
      downloads: [
        { id: 13, url: 'https://example.com/a.zip' },
        { id: 14, url: 'https://baska.com/b.zip' }
      ],
      settings: { cleanDownloads: false }
    });
    await purgeDomain('example.com');
    assert.equal(chromeStub._state.downloads.length, 2);
  });

  test('cleanServiceWorkers ACIK: tur browsingData cagrisina GIRER', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'example.com' })],
      settings: { cleanServiceWorkers: true }
    });
    await purgeDomain('example.com');

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.equal(call.types.serviceWorkers, true,
      `serviceWorkers turu gonderilmeliydi; gonderilen: ${JSON.stringify(call.types)}`);
  });

  test('cleanIndexedDB ACIK: tur GIRER (karsit durum dogrulamasi)', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'example.com' })],
      settings: { cleanIndexedDB: true }
    });
    await purgeDomain('example.com');
    assert.equal(chromeStub._state.browsingDataCalls.at(-1).types.indexedDB, true);
  });
});

describe('istatistik gecmisi: kalici liste (varsayilan KAPALI)', () => {
  const oku = () => chrome.storage.local.get('statsHistory')
    .then(r => r.statsHistory || { thirdParty: {}, sites: {} });

  test('VARSAYILAN KAPALI: hicbir sey diske yazilmaz', async () => {
    await seed();
    await storage.recordStatsHistory('thirdParty', ['doubleclick.net']);
    await storage.recordStatsHistory('sites', 'ornek.com');
    await storage.flushStatsHistory();
    const g = await oku();
    assert.deepEqual(g.thirdParty, {}, '3. taraf kapaliyken yazilmamali');
    assert.deepEqual(g.sites, {}, 'site kapaliyken yazilmamali');
  });

  test('Iki ayar BAGIMSIZ: biri acikken oteki yazmaz', async () => {
    await seed({ settings: { keepThirdPartyHistory: true, keepSiteHistory: false } });
    await storage.recordStatsHistory('thirdParty', ['gstatic.com']);
    await storage.recordStatsHistory('sites', 'ornek.com');
    await storage.flushStatsHistory();
    const g = await oku();
    assert.equal(g.thirdParty['gstatic.com']?.n, 1);
    assert.deepEqual(g.sites, {}, 'site ayari kapaliyken yazilmamali');
  });

  test('Sayac artar, HANGI SITEDE gorulduyu SAKLAMAZ', async () => {
    await seed({ settings: { keepThirdPartyHistory: true } });
    await storage.recordStatsHistory('thirdParty', ['criteo.com']);
    await storage.recordStatsHistory('thirdParty', ['criteo.com']);
    await storage.flushStatsHistory();
    const kayit = (await oku()).thirdParty['criteo.com'];
    assert.equal(kayit.n, 2, 'sayac artmali');
    assert.ok(typeof kayit.t === 'number', 'son gorulme damgasi olmali');
    // GIZLILIK: kaydin icinde site listesi OLMAMALI - hangi siteyi gezdigini
    // ele veren tek alan budur.
    assert.deepEqual(Object.keys(kayit).sort(), ['n', 't']);
  });

  test('Saklama suresi ESKI kayitlari duser', async () => {
    const now = Date.parse('2026-08-31T00:00:00Z');
    const map = {
      eski: { n: 5, t: now - 40 * 24 * 60 * 60 * 1000 },   // 40 gun once
      yeni: { n: 2, t: now - 2 * 24 * 60 * 60 * 1000 }     // 2 gun once
    };
    const aylik = storage.pruneHistoryMap(map, 'monthly', now);
    assert.deepEqual(Object.keys(aylik), ['yeni'], '30 gunden eski dusmeli');

    const sinirsiz = storage.pruneHistoryMap(map, 'unlimited', now);
    assert.deepEqual(Object.keys(sinirsiz).sort(), ['eski', 'yeni'], 'sinirsizda hicbiri dusmez');

    const gunluk = storage.pruneHistoryMap(map, 'daily', now);
    assert.deepEqual(Object.keys(gunluk), [], '1 gunden eski hepsi dusmeli');
  });

  test('KOTA EMNIYETI: ust siniri asan kayit sayisi kirpilir', async () => {
    const now = Date.now();
    const map = {};
    for (let i = 0; i < storage.HISTORY_MAX_ENTRIES + 50; i++) {
      map[`d${i}.com`] = { n: 1, t: now - i };   // buyuk i = daha eski
    }
    const kirpik = storage.pruneHistoryMap(map, 'unlimited', now);
    assert.equal(Object.keys(kirpik).length, storage.HISTORY_MAX_ENTRIES);
    assert.ok(kirpik['d0.com'], 'en yeni kayit kalmali');
    assert.ok(!kirpik[`d${storage.HISTORY_MAX_ENTRIES + 49}.com`], 'en eski dusmeli');
  });

  test('Gecmis silinir; SAYACLAR etkilenmez', async () => {
    await seed({ settings: { keepThirdPartyHistory: true, keepSiteHistory: true } });
    await storage.recordStatsHistory('thirdParty', ['adform.net']);
    await storage.recordStatsHistory('sites', 'ornek.com');
    await storage.flushStatsHistory();
    await storage.incrementStats({ cookies: 7 });

    await storage.clearStatsHistory();
    const g = await oku();
    assert.deepEqual(g.thirdParty, {});
    assert.deepEqual(g.sites, {});
    const stats = await storage.getStats();
    assert.equal(stats.cookiesDeleted, 7, 'sayaclar gecmis silinince sifirlanmamali');
  });

  test('Tek tur silinebilir; oteki durur', async () => {
    await seed({ settings: { keepThirdPartyHistory: true, keepSiteHistory: true } });
    await storage.recordStatsHistory('thirdParty', ['lijit.com']);
    await storage.recordStatsHistory('sites', 'ornek.com');
    await storage.flushStatsHistory();

    await storage.clearStatsHistory('sites');
    const g = await oku();
    assert.equal(g.thirdParty['lijit.com']?.n, 1, '3. taraf durmali');
    assert.deepEqual(g.sites, {}, 'yalnizca site listesi silinmeli');
  });
});

describe('istatistik gecmisi: OTURUM saklamasi', () => {
  test("'session' oturum ICINDE budamaz", () => {
    const now = Date.parse('2026-08-31T00:00:00Z');
    const map = { eski: { n: 3, t: now - 90 * 24 * 60 * 60 * 1000 } };   // 90 gun once
    const sonuc = storage.pruneHistoryMap(map, 'session', now);
    assert.deepEqual(Object.keys(sonuc), ['eski'],
      'oturum icinde yas onemsiz - silme tarayici kapanisinda olur');
  });

  test("'session' bilinen bir secenek, sessizce ayliga DUSMEZ", () => {
    assert.ok(Object.hasOwn(storage.RETENTION_MS, 'session'));
    assert.equal(storage.RETENTION_MS.session, null);
  });
});

describe('istatistik gecmisi: tarayici kapanisinda silme', () => {
  const oku = () => chrome.storage.local.get('statsHistory')
    .then(r => r.statsHistory || { thirdParty: {}, sites: {} });

  test("'session' secildiyse YENI oturumda gecmis silinir", async () => {
    await seed({ settings: {
      keepThirdPartyHistory: true, keepSiteHistory: true, statsHistoryRetention: 'session'
    } });
    await storage.recordStatsHistory('thirdParty', ['doubleclick.net']);
    await storage.recordStatsHistory('sites', 'ornek.com');
    await storage.flushStatsHistory();
    assert.equal((await oku()).thirdParty['doubleclick.net']?.n, 1, 'on kosul: kayit olusmali');

    // Tarayici kapanisi = storage.session bosalir; bootstrap isareti de gider.
    await chrome.storage.session.clear();
    await bootstrap.sessionBootstrap();

    const g = await oku();
    assert.deepEqual(g.thirdParty, {}, 'yeni oturumda 3. taraf gecmisi silinmeli');
    assert.deepEqual(g.sites, {}, 'yeni oturumda site gecmisi silinmeli');
  });

  test("'monthly' secildiyse yeni oturumda gecmis DURUR", async () => {
    await seed({ settings: {
      keepThirdPartyHistory: true, statsHistoryRetention: 'monthly'
    } });
    await storage.recordStatsHistory('thirdParty', ['gstatic.com']);
    await storage.flushStatsHistory();

    await chrome.storage.session.clear();
    await bootstrap.sessionBootstrap();

    assert.equal((await oku()).thirdParty['gstatic.com']?.n, 1,
      'kalici saklamada tarayici kapanisi gecmisi silmemeli');
  });
});

describe('istatistik gecmisi: sifirlama bekleyen kaydi geri getirmez', () => {
  test('Fabrika ayarlarindan sonra BEKLEYEN kayit diske yazilmaz', async () => {
    await seed({ settings: { keepThirdPartyHistory: true } });
    // Kayit alindi ama HENUZ yazilmadi (toplu yazma).
    await storage.recordStatsHistory('thirdParty', ['doubleclick.net']);

    await storage.resetToFactoryDefaults();
    await storage.flushStatsHistory();   // bekleyen varsa burada yazilirdi

    const g = (await chrome.storage.local.get('statsHistory')).statsHistory;
    assert.ok(!g?.thirdParty?.['doubleclick.net'],
      'sifirlamadan sonra bekleyen kayit geri gelmemeli');
  });

  test('Gecmis silindikten sonra BEKLEYEN kayit geri gelmez', async () => {
    await seed({ settings: { keepThirdPartyHistory: true } });
    await storage.recordStatsHistory('thirdParty', ['criteo.com']);

    await storage.clearStatsHistory();
    await storage.flushStatsHistory();

    const g = (await chrome.storage.local.get('statsHistory')).statsHistory;
    assert.deepEqual(g?.thirdParty || {}, {});
  });
});

describe('istatistik gecmisi: ayar KAPATILINCA bekleyen yazilmaz', () => {
  test('Kayit alindiktan sonra ayar kapatilirsa diske gitmez', async () => {
    await seed({ settings: { keepThirdPartyHistory: true } });
    await storage.recordStatsHistory('thirdParty', ['doubleclick.net']);

    // Kullanici ayari kapatti; bekleyen kayit HENUZ yazilmadi.
    await storage.updateSettings({ keepThirdPartyHistory: false });
    await storage.flushStatsHistory();

    const g = (await chrome.storage.local.get('statsHistory')).statsHistory;
    assert.ok(!g?.thirdParty?.['doubleclick.net'],
      'ayar kapatildiktan sonra bekleyen kayit yazilmamali');
  });

  test('Oteki ayar ACIK kaldiysa onun bekleyeni yazilir', async () => {
    await seed({ settings: { keepThirdPartyHistory: true, keepSiteHistory: true } });
    await storage.recordStatsHistory('thirdParty', ['criteo.com']);
    await storage.recordStatsHistory('sites', 'ornek.com');

    await storage.updateSettings({ keepThirdPartyHistory: false });
    await storage.flushStatsHistory();

    const g = (await chrome.storage.local.get('statsHistory')).statsHistory;
    assert.ok(!g?.thirdParty?.['criteo.com'], 'kapatilan tur yazilmamali');
    assert.equal(g?.sites?.['ornek.com']?.n, 1, 'acik kalan tur yazilmali');
  });
});

describe('gecmis: TAM SILME yolu (whitelistCleanHistory)', () => {
  test('Ayar KAPALIYKEN secici silme kullanilir, filtresiz cagri YAPILMAZ', async () => {
    await seed({
      history: [makeHistoryItem('https://ornek.com/a'), makeHistoryItem('https://korumali.com/b')],
      rules: { 'korumali.com': { domain: 'korumali.com', type: 'white', subdomains: true } },
      settings: { whitelistCleanHistory: false, cleanHistory: true }
    });
    const cagrilar = [];
    const orj = chrome.browsingData.remove;
    chrome.browsingData.remove = async (o, t) => { cagrilar.push({ o, t }); return orj?.(o, t); };

    await cleaner.purgeAllNonWhitelisted();

    chrome.browsingData.remove = orj;
    const filtresizGecmis = cagrilar.some(c => c.t?.history === true && !c.o?.origins);
    assert.equal(filtresizGecmis, false,
      'ayar kapaliyken filtresiz gecmis silme CAGRILMAMALI - beyaz listeyi goturur');
  });

  test('Ayar ACIKKEN filtresiz gecmis silme cagrilir', async () => {
    await seed({
      history: [makeHistoryItem('https://ornek.com/a')],
      settings: { whitelistCleanHistory: true, cleanHistory: true }
    });
    const cagrilar = [];
    const orj = chrome.browsingData.remove;
    chrome.browsingData.remove = async (o, t) => { cagrilar.push({ o, t }); return orj?.(o, t); };

    await cleaner.purgeAllNonWhitelisted();

    chrome.browsingData.remove = orj;
    const filtresizGecmis = cagrilar.some(c => c.t?.history === true && !c.o?.origins);
    assert.equal(filtresizGecmis, true,
      'ayar acikken filtresiz silme yapilmali - secici yol arama izlerine ulasamiyor');
  });

  test('cleanHistory KAPALIYKEN ayar acik olsa da gecmise dokunulmaz', async () => {
    await seed({
      history: [makeHistoryItem('https://ornek.com/a')],
      settings: { whitelistCleanHistory: true, cleanHistory: false }
    });
    const cagrilar = [];
    const orj = chrome.browsingData.remove;
    chrome.browsingData.remove = async (o, t) => { cagrilar.push({ o, t }); return orj?.(o, t); };

    await cleaner.purgeAllNonWhitelisted();

    chrome.browsingData.remove = orj;
    assert.equal(cagrilar.some(c => c.t?.history === true), false,
      'gecmis temizligi kapaliyken hicbir gecmis silme yapilmamali');
  });
});
