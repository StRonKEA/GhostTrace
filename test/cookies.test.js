import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, makeCookie } from './helpers/chrome-stub.js';

let chromeStub = installChromeStub();

const cookies = await import('../lib/cookies.js');
const {
  removeCookie, fetchCookies, cookieRemovalUrl, estimateCookieBytes,
  shouldKeepCookie, matchesKeepPatterns, compileKeepPattern,
  classifyCookie, isLikelySessionCookie, isLikelyTrackingCookie,
  __clearPatternCacheForTests
} = cookies;

beforeEach(() => {
  chromeStub = installChromeStub();
  __clearPatternCacheForTests();
});

describe('cookieRemovalUrl', () => {
  test('domain cerezi icin nokta atilir, sema secure bayragindan gelir', () => {
    assert.equal(cookieRemovalUrl(makeCookie({ domain: '.example.com', secure: true, path: '/app' })),
      'https://example.com/app');
    assert.equal(cookieRemovalUrl(makeCookie({ domain: 'example.com', secure: false })),
      'http://example.com/');
  });

  test('bozuk path guvenli hale getirilir', () => {
    assert.equal(cookieRemovalUrl(makeCookie({ domain: 'a.com', path: 'garbage' })), 'http://a.com/');
  });
});

describe('removeCookie (C6/B7 regresyonu)', () => {
  test('tek cagriyla siler - eski surumde 64 deneme yapiliyordu', async () => {
    chromeStub._state.cookies = [makeCookie({ name: 'sid', domain: '.example.com' })];
    const result = await removeCookie(chromeStub._state.cookies[0]);

    assert.equal(result.removed, true);
    assert.ok(result.bytes > 0);
    assert.equal(chromeStub._state.apiCalls.cookiesRemove, 1, 'yalnizca 1 remove cagrisi olmali');
  });

  test('KOK alan adi varyasyonu denenmez: ust alan adinin ayni isimli cerezi silinmez', async () => {
    // v1.1.0'da mail.example.com cerezi silinirken https://example.com/ da
    // deneniyor, boylece (belki beyaz listedeki) ust alan adinin cerezi ucuyordu.
    const parent = makeCookie({ name: 'sid', domain: 'example.com', value: 'PARENT' });
    const child = makeCookie({ name: 'sid', domain: 'mail.example.com', value: 'CHILD' });
    chromeStub._state.cookies = [parent, child];

    const result = await removeCookie(child);
    assert.equal(result.removed, true);

    const remaining = chromeStub._state.cookies;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].value, 'PARENT', 'ust alan adinin cerezi korunmali');
  });

  test('partitionKey aynen iletilir (CHIPS)', async () => {
    const partitioned = makeCookie({
      name: 'p', domain: 'cdn.example.com',
      partitionKey: { topLevelSite: 'https://site.com' }
    });
    chromeStub._state.cookies = [partitioned];
    assert.equal((await removeCookie(partitioned)).removed, true);
    assert.equal(chromeStub._state.cookies.length, 0);
  });

  test('bulunamayan cerezde en fazla 2 deneme yapilir', async () => {
    chromeStub._state.cookies = [];
    const result = await removeCookie(makeCookie({ name: 'yok', domain: 'a.com' }));
    assert.equal(result.removed, false);
    assert.equal(result.bytes, 0);
    assert.ok(chromeStub._state.apiCalls.cookiesRemove <= 2);
  });

  test('eksik parametrelerde sessizce false doner', async () => {
    // collateral: yan hasar korumasiyla eklendi (bkz. removeCookie).
    assert.deepEqual(await removeCookie(null), { removed: false, bytes: 0, collateral: 0 });
    assert.deepEqual(await removeCookie({ name: 'a' }), { removed: false, bytes: 0, collateral: 0 });
  });
});

describe('ADSIZ cerez silinebilmeli (gercek log bulgusu)', () => {
  // GERCEK KULLANIM VERISI: obilet.com'un tek bir cerezi bes temizlikte de
  // silinemedi (attempted 1, failed 1, removed 0 - her seferinde).
  //
  // Sebep gercek Chrome'da olculdu: bir site `document.cookie = "=deger"`
  // yazarak ADSIZ cerez olusturabiliyor. Chrome bunu kuruyor, getAll doner
  // VE remove({name: ''}) ile silinebiliyor.
  //
  // Ama removeCookie'nin girisindeki koruma soyleydi:
  //     if (!cookie?.name || !cookie?.domain) return { removed: false };
  // Bos dize falsy oldugu icin remove HIC CAGRILMIYORDU. Cerez her temizlikte
  // "denendi, basarisiz" sayiliyor, Chrome'dan hata gelmedigi icin sebep de
  // bildirilemiyordu: teshis edilemez, sonsuza kadar tekrarlanan bir ariza.
  //
  // `domain` kontrolu YERINDE kalir - alan adi olmadan silme URL'si kurulamaz.

  test('adi bos olan cerez icin remove GERCEKTEN cagrilir', async () => {
    chromeStub._state.cookies = [
      { name: '', value: 'adsiz', domain: 'ornek.com', path: '/', secure: true, storeId: '0' }
    ];

    const sonuc = await removeCookie({
      name: '', domain: 'ornek.com', path: '/', secure: true, storeId: '0'
    });

    assert.equal(sonuc.removed, true, 'adsiz cerez silinebilmeli');
    assert.equal(chromeStub._state.cookies.length, 0, 'cerez gitmis olmali');
  });

  test('alan adi YOKSA denenmez (bu koruma yerinde kalir)', async () => {
    const sonuc = await removeCookie({ name: 'x', domain: '' });
    assert.equal(sonuc.removed, false, 'alan adi olmadan silme URL i kurulamaz');
    assert.equal(chromeStub._state.apiCalls.cookiesRemove, 0,
      'bosuna API cagrisi yapilmamali');
  });
});

describe('fetchCookies', () => {
  test('standart ve partitioned cerezleri birlestirip tekilleştirir', async () => {
    chromeStub._state.cookies = [
      makeCookie({ name: 'a', domain: 'example.com' }),
      makeCookie({ name: 'b', domain: '.example.com' }),
      makeCookie({ name: 'c', domain: 'cdn.example.com', partitionKey: { topLevelSite: 'https://x.com' } }),
      makeCookie({ name: 'd', domain: 'other.com' })
    ];

    const all = await fetchCookies();
    assert.equal(all.length, 4);

    const scoped = await fetchCookies({ domain: 'example.com' });
    assert.deepEqual(scoped.map(c => c.name).sort(), ['a', 'b', 'c']);
    assert.equal(chromeStub._state.apiCalls.cookiesGetAll, 4, 'domain basina 2 sorgu (standart + partitioned)');
  });
});

describe('estimateCookieBytes', () => {
  test('gercek dize uzunlugunu olcer (uydurma sabit degil)', () => {
    const small = estimateCookieBytes(makeCookie({ name: 'a', value: 'b' }));
    const large = estimateCookieBytes(makeCookie({ name: 'a', value: 'x'.repeat(1000) }));
    assert.ok(large - small >= 999, `fark: ${large - small}`);
  });

  test('UTF-8 cok baytli karakterleri dogru sayar', () => {
    const ascii = estimateCookieBytes(makeCookie({ name: 'n', value: 'aaa', domain: 'a.com', path: '/', sameSite: '' }));
    const turkish = estimateCookieBytes(makeCookie({ name: 'n', value: 'ğğğ', domain: 'a.com', path: '/', sameSite: '' }));
    assert.equal(turkish - ascii, 3);
  });
});

describe('koruma kaliplari (B8 regresyonu)', () => {
  test('joker kalip calisir', () => {
    assert.equal(matchesKeepPatterns('session_id', ['sess*']), true);
    assert.equal(matchesKeepPatterns('my_session', ['*session']), true);
    assert.equal(matchesKeepPatterns('other', ['sess*']), false);
  });

  test('regex ozel karakteri iceren kalip THROW ETMEZ', () => {
    // v1.1.0: new RegExp('^sess($') -> SyntaxError -> o site icin tum cerez
    // temizligi sessizce iptal oluyordu.
    assert.doesNotThrow(() => compileKeepPattern('sess('));
    assert.doesNotThrow(() => compileKeepPattern('a[b'));
    assert.doesNotThrow(() => compileKeepPattern('+++'));
    assert.equal(matchesKeepPatterns('sess(', ['sess(']), true);
    assert.equal(matchesKeepPatterns('sessX', ['sess(']), false);
  });

  test('nokta joker gibi davranmaz', () => {
    assert.equal(matchesKeepPatterns('axb', ['a.b']), false);
    assert.equal(matchesKeepPatterns('a.b', ['a.b']), true);
  });

  test('buyuk/kucuk harf duyarsiz', () => {
    assert.equal(matchesKeepPatterns('SessionID', ['sessionid']), true);
  });
});

describe('shouldKeepCookie', () => {
  const cookie = makeCookie({ name: 'auth_token' });

  test('keepMode all her cerezi korur', () => {
    assert.equal(shouldKeepCookie(cookie, { keepMode: 'all' }), true);
    assert.equal(shouldKeepCookie(makeCookie({ name: '_ga' }), { keepMode: 'all' }), true);
  });

  test('keepMode session yalnizca oturum cerezlerini korur', () => {
    assert.equal(shouldKeepCookie(cookie, { keepMode: 'session' }), true);
    assert.equal(shouldKeepCookie(makeCookie({ name: '_ga' }), { keepMode: 'session' }), false);
  });

  test('keepMode custom kalip listesine bakar', () => {
    assert.equal(shouldKeepCookie(cookie, { keepMode: 'custom', keepCookies: ['auth*'] }), true);
    assert.equal(shouldKeepCookie(cookie, { keepMode: 'custom', keepCookies: ['sess*'] }), false);
  });

  test('custom modda bos liste hicbir seyi korumaz', () => {
    assert.equal(shouldKeepCookie(cookie, { keepMode: 'custom', keepCookies: [] }), false);
  });

  test('kural yoksa korunmaz', () => {
    assert.equal(shouldKeepCookie(cookie, null), false);
  });
});

describe('siniflandirma', () => {
  test('izleyiciler tespit edilir', () => {
    for (const name of ['_ga', '_gid', '_fbp', '__utma', 'datr', 'test_cookie', '_hjSession']) {
      assert.equal(isLikelyTrackingCookie(makeCookie({ name })), true, name);
    }
  });

  test('oturum cerezleri tespit edilir', () => {
    for (const name of ['PHPSESSID', 'auth_token', '__Secure-1PSID', 'jwt', 'connect.sid']) {
      assert.equal(isLikelySessionCookie(makeCookie({ name })), true, name);
    }
  });

  test('izleyici + oturum cakismasinda izleyici kazanir', () => {
    assert.equal(classifyCookie(makeCookie({ name: '_ga' })), 'tracker');
  });

  test('cok genis anahtarlar artik oturum saymaz (eski yanlis pozitifler)', () => {
    // v1.1.0'da 'user', 'profile', 'admin', 'security' ve "httpOnly ise oturumdur"
    // kurallari neredeyse her cerezi korumaya aliyordu.
    for (const name of ['username_display', 'profile_theme', 'admin_ui_prefs', 'security_banner']) {
      assert.equal(isLikelySessionCookie(makeCookie({ name })), false, name);
    }
    assert.equal(isLikelySessionCookie(makeCookie({ name: 'layout_pref', httpOnly: true })), false);
  });

  test('siniflandirilamayan cerez other olur', () => {
    assert.equal(classifyCookie(makeCookie({ name: 'theme' })), 'other');
  });
});

describe('partitionKey semantigi (A2 - stub gercek Chrome davranisini taklit etmeli)', () => {
  // Chromium cookies_helpers.cc -> CookiePartitionKeyCollectionFromApiPartitionKey():
  // topLevelSite yoksa ContainsAll() uretilir. Kaynak yorumu birebir:
  // "There is an edge case where a getAll call that contains a partition key
  //  parameter but no top_level_site parameter results in a return of
  //  partitioned and non-partitioned cookies."
  const seed = () => {
    chromeStub._state.cookies = [
      makeCookie({ name: 'plain1', domain: 'example.com' }),
      makeCookie({ name: 'plain2', domain: '.example.com' }),
      makeCookie({ name: 'part1', domain: 'example.com', partitionKey: { topLevelSite: 'https://haber.com' } }),
      makeCookie({ name: 'part2', domain: 'example.com', partitionKey: { topLevelSite: 'https://blog.net' } })
    ];
  };

  test('partitionKey HIC verilmezse yalnizca bolumlenmemis cerezler doner', async () => {
    seed();
    const result = await chrome.cookies.getAll({});
    assert.deepEqual(result.map(c => c.name).sort(), ['plain1', 'plain2']);
  });

  test('partitionKey:{} verilirse HEM bolumlenmis HEM bolumlenmemis doner', async () => {
    seed();
    const result = await chrome.cookies.getAll({ partitionKey: {} });
    assert.deepEqual(result.map(c => c.name).sort(), ['part1', 'part2', 'plain1', 'plain2'],
      'topLevelSite yoksa ContainsAll() uretilir');
  });

  test('topLevelSite:"" TUZAGI: yalnizca bolumlenmemis cerezleri secer', async () => {
    seed();
    const result = await chrome.cookies.getAll({ partitionKey: { topLevelSite: '' } });
    assert.deepEqual(result.map(c => c.name).sort(), ['plain1', 'plain2'],
      'bos dize "tum bolumler" DEGIL, bolumlenmemis anlamina gelir');
  });

  test('belirli bir topLevelSite yalnizca o bolumu secer', async () => {
    seed();
    const result = await chrome.cookies.getAll({ partitionKey: { topLevelSite: 'https://haber.com' } });
    assert.deepEqual(result.map(c => c.name), ['part1']);
  });

  test('domain filtresi partitionKey ile birlikte calisir', async () => {
    seed();
    chromeStub._state.cookies.push(
      makeCookie({ name: 'other', domain: 'baska.com', partitionKey: { topLevelSite: 'https://haber.com' } })
    );
    const result = await chrome.cookies.getAll({ domain: 'example.com', partitionKey: {} });
    assert.equal(result.some(c => c.name === 'other'), false);
    assert.equal(result.length, 4);
  });

  test('fetchCookies tekilleştirme A2 sonrasi da dogru sonuc verir', async () => {
    // fetchCookies iki sorgu yapiyor; partitionKey:{} artik ustkume dondurdugu
    // icin tekilleştirme sonrasi sayi degismemeli (D1 kuyrugundaki tek-sorguya
    // gecis kararindan BAGIMSIZ olarak dogru kalmali).
    seed();
    const all = await fetchCookies();
    assert.deepEqual(all.map(c => c.name).sort(), ['part1', 'part2', 'plain1', 'plain2']);

    const scoped = await fetchCookies({ domain: 'example.com' });
    assert.equal(scoped.length, 4);
  });
});

describe('2.4: partitionKey asla kirpilmaz (regresyon kilidi)', () => {
  test('removeCookie partitionKey nesnesini BIREBIR gecirir', async () => {
    // Alan dusurmek sessiz basarisizlik uretir: eksik partitionKey ile
    // bolumlenmis cerez silinmez ve remove() bunu bildirmez.
    const partitionKey = { topLevelSite: 'https://haber.com', hasCrossSiteAncestor: true };
    const cookie = makeCookie({ name: 'p', domain: 'cdn.example.com', partitionKey });
    chromeStub._state.cookies = [cookie];

    const seen = [];
    const original = chrome.cookies.remove;
    chrome.cookies.remove = async (details) => { seen.push(details); return original(details); };

    try {
      await removeCookie(cookie);
    } finally {
      chrome.cookies.remove = original;
    }

    assert.equal(seen.length >= 1, true);
    assert.deepEqual(seen[0].partitionKey, partitionKey,
      'partitionKey birebir gecmeli - alan dusurulmemeli');
    assert.ok('hasCrossSiteAncestor' in seen[0].partitionKey,
      'hasCrossSiteAncestor atlanirsa Chrome true varsayar ve same-site bolum cerezi silinmez');
  });

  test('bolumlenmemis cerezde partitionKey HIC gonderilmez', async () => {
    const cookie = makeCookie({ name: 'plain', domain: 'example.com' });
    chromeStub._state.cookies = [cookie];

    const seen = [];
    const original = chrome.cookies.remove;
    chrome.cookies.remove = async (details) => { seen.push(details); return original(details); };

    try {
      await removeCookie(cookie);
    } finally {
      chrome.cookies.remove = original;
    }

    assert.equal('partitionKey' in seen[0], false,
      'bos partitionKey gondermek bolumlenmemis cerezi hedeflemeyi bozar');
  });

  test('bos topLevelSite ASLA uretilmez', () => {
    // topLevelSite:"" "tum bolumler" DEGIL "bolumlenmemis" anlamina gelir.
    // Kod bu degeri hicbir yerde uretmemeli.
    const cookie = makeCookie({ domain: 'a.com', partitionKey: { topLevelSite: 'https://x.com' } });
    const url = cookieRemovalUrl(cookie);
    assert.ok(url.length > 0);
    assert.equal(cookie.partitionKey.topLevelSite, 'https://x.com', 'girdi degistirilmemeli');
  });
});

describe('2.4: cerez filtresi en dar kapsamla sorgular', () => {
  test('kapsamli temizlik domain filtresi VERIR (tum kavanozu cekmez)', async () => {
    // Performans notu: url/domain verilmezse Chrome once GetAllCookies ile
    // tum kavanozu ceker. Sekme basi temizlikte bu kabul edilemez.
    chromeStub._state.cookies = [
      makeCookie({ name: 'a', domain: 'example.com' }),
      makeCookie({ name: 'b', domain: 'other.com' })
    ];

    const filters = [];
    const original = chrome.cookies.getAll;
    chrome.cookies.getAll = async (filter) => { filters.push(filter); return original(filter); };

    try {
      await fetchCookies({ domain: 'example.com' });
    } finally {
      chrome.cookies.getAll = original;
    }

    assert.ok(filters.length > 0);
    assert.ok(filters.every(f => f.domain === 'example.com'),
      'her sorgu domain ile daraltilmali');
  });
});
