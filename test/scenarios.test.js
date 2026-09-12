// GhostTrace - GERCEK KULLANIM SENARYOLARI
//
// NEDEN AYRI BIR DOSYA: Diger test dosyalari birim davranisi olcuyor
// (bu fonksiyon bu girdiyle ne doner?). Burasi UCTAN UCA senaryo olcuyor:
// "kullanici sunu yaparsa, tarayicida ne KALIR, ne GIDER?"
//
// Alan adlari gercek hayat senaryolarindan secildi. Bu onemli, cunku sentetik
// `a.com` / `b.com` ikilileri PSL sinirlarini, `www.` soyulmasini ve
// kardes/ust alan adi iliskilerini HIC zorlamiyor - projedeki gecmis hatalarin
// cogu tam orada yasandi (`forum.mobilism.org`, `mail.google.com`, `user.github.io`).
//
// Her testin adi bir IDDIA. Iddia belgeden geliyor (CONTEXT.md / ARCHITECTURE.md),
// koddan degil; ikisi ayrilirsa test kirilir ve hangisinin yanlis oldugu
// tartisilir.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, makeCookie, makeHistoryItem, sendMessage } from './helpers/chrome-stub.js';

let chromeStub = installChromeStub();

const storage = await import('../lib/storage.js');
const logger = await import('../lib/logger.js');
const { purgeDomain, purgeAllNonWhitelisted } = await import('../lib/purge/index.js');
const { getRootDomain, createDomainScope, normalizeDomain } = await import('../lib/domain.js');
const { matchDomainRule } = await import('../lib/rules.js');

// --------------------------------------------------------------------------
// Kurgu yardimcilari
// --------------------------------------------------------------------------

async function seed({ cookies = [], history = [], downloads = [], tabs = [], rules = {}, settings = {} } = {}) {
  chromeStub = installChromeStub({ cookies, history, downloads, tabs });
  storage.__resetCacheForTests();
  logger.__resetLoggerForTests();
  await chrome.storage.local.set({
    ...storage.DEFAULT_SETTINGS,
    logLevel: 'off',
    cleanDelay: 0,
    rules,
    ...settings
  });
  storage.__resetCacheForTests();
}

const kural = (domain, extra = {}) => ({
  domain, type: 'white', subdomains: true, keepMode: 'all', keepCookies: [],
  addedAt: 1, updatedAt: 1, ...extra
});

/** Diskte kalan cerezler: "host|ad" listesi. */
const kalanCerezler = () => chromeStub._state.cookies
  .map(c => `${c.domain.startsWith('.') ? c.domain.slice(1) : c.domain}|${c.name}`).sort();

/** Diskte kalan gecmis adresleri. */
const kalanGecmis = () => chromeStub._state.history.map(h => h.url).sort();

/** browsingData.remove cagrilarinda gecen tum origin'ler. */
const silinenOriginler = () => chromeStub._state.browsingDataCalls
  .flatMap(call => call.filter?.origins || []);

const haricTutulanOriginler = () => chromeStub._state.browsingDataCalls
  .flatMap(call => call.filter?.excludeOrigins || []);

beforeEach(async () => { await seed(); });

// --------------------------------------------------------------------------
// A. KAPSAM: gercek alan adlari PSL sinirlarinda dogru cozuluyor mu?
// --------------------------------------------------------------------------

describe('A. Kapsam cozumlemesi (gercek alan adlari)', () => {
  test('A1. Yer imlerindeki her alan adi dogru koke indirgeniyor', () => {
    const beklenen = {
      'https://www.instagram.com/': 'instagram.com',
      'https://www.youtube.com/': 'youtube.com',
      'https://mail.google.com/mail/u/0/#inbox': 'google.com',
      'https://web.whatsapp.com/': 'whatsapp.com',
      'https://fitgirl-repacks.site/': 'fitgirl-repacks.site',
      'https://blackmod.net/': 'blackmod.net',
      'https://platinmods.com/forums/x.30/': 'platinmods.com',
      'https://forum.mobilism.org/index.php': 'mobilism.org',
      'https://1337x.to/home/': '1337x.to',
      'https://ddlbase.com/': 'ddlbase.com',
      'https://www.dizibox.com/': 'dizibox.com',
      'https://openani.me/': 'openani.me',
      'https://www.deepl.com/translator': 'deepl.com',
      'https://github.com/Yimikami/CursorForge': 'github.com',
      'https://ecc.tools/': 'ecc.tools'
    };
    for (const [url, kok] of Object.entries(beklenen)) {
      assert.equal(getRootDomain(url), kok, `${url} -> ${kok} olmaliydi`);
    }
  });

  test('A2. www. SOYULUR: www.google.com ile google.com ayni kuraldir', () => {
    assert.equal(normalizeDomain('https://www.google.com/'), 'google.com');
    assert.equal(normalizeDomain('https://www.deepl.com/translator'), 'deepl.com');
    // Ama "www" sadece BASTAN soyulur; ortadaki www bir alt alan adidir.
    assert.equal(normalizeDomain('https://www.forum.mobilism.org/'), 'forum.mobilism.org');
  });

  test('A3. Alt alan adi kapsami KENDI dallaridir; kardes ve ust ASLA', () => {
    const scope = createDomainScope('mail.google.com');
    assert.equal(scope.matches('mail.google.com'), true, 'kendisi');
    assert.equal(scope.matches('x.mail.google.com'), true, 'kendi dali');
    assert.equal(scope.matches('drive.google.com'), false, 'KARDES dahil olmamali');
    assert.equal(scope.matches('google.com'), false, 'UST dahil olmamali');
    assert.equal(scope.matches('www.google.com'), false, 'www ust ile aynidir, dahil olmamali');
  });

  test('A4. Kok kapsami TUM alt alan adlarini icerir', () => {
    const scope = createDomainScope('google.com');
    for (const host of ['google.com', 'www.google.com', 'mail.google.com', 'drive.google.com']) {
      assert.equal(scope.matches(host), true, `${host} kok kapsaminda olmali`);
    }
    assert.equal(scope.matches('notgoogle.com'), false, 'benzer isim kapsamda olmamali');
  });

  test('A5. github.io gibi cok kullanicili ekler: bir kullanici digerini KAPSAMAZ', () => {
    assert.equal(getRootDomain('yimikami.github.io'), 'yimikami.github.io');
    const scope = createDomainScope('yimikami.github.io');
    assert.equal(scope.matches('selogpt.github.io'), false,
      'bir github.io kullanicisini korumak digerlerini korumamali');
  });
});

// --------------------------------------------------------------------------
// B. CEREZ KORUMASI: yan hasar ve keepMode
// --------------------------------------------------------------------------

describe('B. Cerez koruması', () => {
  test('B1. forum.mobilism.org temizligi .mobilism.org cerezini de goturur (kok hedeflenir)', async () => {
    // ARCHITECTURE selectPurgeTarget: kural yoksa KOK hedeflenir, boylece
    // ust alan adindaki cerez ortada kalmaz. Gecmiste tam host hedefleniyordu
    // ve `.mobilism.org` cerezi elle "Tumunu Temizle" olmadan gitmiyordu.
    await seed({
      cookies: [
        makeCookie({ name: 'phpbb3_sid', domain: '.mobilism.org' }),
        makeCookie({ name: 'style_cookie', domain: 'forum.mobilism.org' })
      ]
    });
    await purgeDomain('mobilism.org');
    assert.deepEqual(kalanCerezler(), [], 'kok temizligi her ikisini de almaliydi');
  });

  test('B2. KORUMALI ust alan adinin ayni isimli cerezi yan hasar olarak GITMEZ', async () => {
    // google.com beyaz listede (yalnizca kendisi), mail.google.com degil.
    // chrome.cookies.remove(url, name) o URL'de gorunen ayni isimli TUM
    // cerezleri siler; ust alan adininki geri konmali.
    await seed({
      cookies: [
        makeCookie({ name: 'SID', domain: '.google.com' }),
        makeCookie({ name: 'SID', domain: 'mail.google.com' })
      ],
      rules: { 'google.com': kural('google.com', { subdomains: false }) }
    });
    await purgeDomain('mail.google.com');
    assert.deepEqual(kalanCerezler(), ['google.com|SID'],
      'ust alan adinin cerezi korunmali, alt alan adininki gitmeliydi');
  });

  test('B3. keepMode custom: yalnizca desene uyan cerez kalir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'wa_session_id', domain: 'web.whatsapp.com' }),
        makeCookie({ name: '_ga', domain: 'web.whatsapp.com' }),
        makeCookie({ name: 'pref_lang', domain: 'web.whatsapp.com' })
      ],
      rules: {
        'web.whatsapp.com': kural('web.whatsapp.com', {
          subdomains: false, keepMode: 'custom', keepCookies: ['wa_*']
        })
      }
    });
    await purgeDomain('web.whatsapp.com');
    assert.deepEqual(kalanCerezler(), ['web.whatsapp.com|wa_session_id'],
      'yalnizca wa_* deseni korunmaliydi');
  });

  test('B4. keepMode session: oturum cerezi kalir, izleyici gider', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sessionid', domain: 'platinmods.com' }),
        makeCookie({ name: '_ga', domain: 'platinmods.com' }),
        makeCookie({ name: '_fbp', domain: 'platinmods.com' })
      ],
      rules: { 'platinmods.com': kural('platinmods.com', { keepMode: 'session' }) }
    });
    await purgeDomain('platinmods.com');
    assert.deepEqual(kalanCerezler(), ['platinmods.com|sessionid'],
      'oturum cerezi kalmali, izleyiciler gitmeliydi');
  });

  test('B5. keepMode all: hicbir cerez silinmez (kural korumali)', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sessionid', domain: '1337x.to' }),
        makeCookie({ name: '_ga', domain: '1337x.to' })
      ],
      rules: { '1337x.to': kural('1337x.to') }
    });
    const sonuc = await purgeDomain('1337x.to');
    assert.equal(sonuc.protected, true, 'korumali site hic islenmemeli');
    assert.equal(kalanCerezler().length, 2);
  });

  test('B6. ADI BOS cerez de silinir', async () => {
    // document.cookie = "=deger" gecerli bir cerez uretir. Eski kod
    // `!cookie.name` ile bunu atliyordu ve cerez her temizlikte "basarisiz"
    // sayilip diskte kaliyordu.
    await seed({ cookies: [makeCookie({ name: '', domain: 'ddlbase.com' })] });
    const sonuc = await purgeDomain('ddlbase.com');
    assert.equal(sonuc.cookies, 1, 'adsiz cerez de silinmeliydi');
    assert.deepEqual(kalanCerezler(), []);
  });
});

// --------------------------------------------------------------------------
// C. KOK TEMIZLIGINDE BEYAZ LISTEDEKI ALT ALAN ADI
// --------------------------------------------------------------------------

describe('C. Kok temizligi vs korumali alt alan adi', () => {
  test('C1. mail.google.com beyaz listedeyken google.com temizligi onu ATLAR', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'GMAIL_AT', domain: 'mail.google.com' }),
        makeCookie({ name: 'NID', domain: '.google.com' }),
        makeCookie({ name: 'DRIVE_S', domain: 'drive.google.com' })
      ],
      history: [
        makeHistoryItem('https://mail.google.com/mail/u/0/'),
        makeHistoryItem('https://www.google.com/search?q=x'),
        makeHistoryItem('https://drive.google.com/drive/my-drive')
      ],
      rules: { 'mail.google.com': kural('mail.google.com', { subdomains: false }) }
    });

    await purgeDomain('google.com');

    assert.deepEqual(kalanCerezler(), ['mail.google.com|GMAIL_AT'],
      'yalnizca korumali alt alan adinin cerezi kalmaliydi');
    assert.deepEqual(kalanGecmis(), ['https://mail.google.com/mail/u/0/'],
      'korumali alt alan adinin gecmisi kalmaliydi');
  });

  test('C2. Korumali alt alan adinin DEPOLAMASI origin listesine GIRMEZ', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'GMAIL_AT', domain: 'mail.google.com' }),
        makeCookie({ name: 'NID', domain: '.google.com' })
      ],
      rules: { 'mail.google.com': kural('mail.google.com', { subdomains: false }) }
    });

    await purgeDomain('google.com');

    const origins = silinenOriginler();
    assert.ok(origins.length > 0, 'depolama temizligi cagrilmali');
    assert.ok(!origins.some(o => o.includes('mail.google.com')),
      `korumali alt alan adi origin listesine GIRMEMELIYDI: ${origins.join(', ')}`);
    assert.ok(origins.some(o => o.includes('google.com')),
      'kok origin listede olmali');
  });

  test('C3. browsingData cagrisina ASLA cookies:true verilmez', async () => {
    await seed({ cookies: [makeCookie({ domain: 'openani.me' })] });
    await purgeDomain('openani.me');
    for (const call of chromeStub._state.browsingDataCalls) {
      assert.notEqual(call.types?.cookies, true,
        'origin filtresiyle cookies gondermek komsu alan adlarini goturur');
    }
  });

  test('C4. Hedefli cagri protectedWeb ICERIR, toplu cagri ICERMEZ', async () => {
    await seed({ cookies: [makeCookie({ domain: 'dizibox.com' })] });
    await purgeDomain('dizibox.com');
    const hedefli = chromeStub._state.browsingDataCalls.find(c => c.filter?.origins);
    assert.deepEqual(hedefli.filter.originTypes, { unprotectedWeb: true, protectedWeb: true });

    await seed({ cookies: [makeCookie({ domain: 'dizibox.com' })] });
    await purgeAllNonWhitelisted();
    for (const call of chromeStub._state.browsingDataCalls) {
      assert.equal(call.filter?.originTypes, undefined,
        'toplu supurmede protectedWeb kurulu uygulamalarin verisini goturur');
    }
  });

  test('C5. extension:true HICBIR yolda verilmez', async () => {
    await seed({ cookies: [makeCookie({ domain: 'deepl.com' })] });
    await purgeDomain('deepl.com');
    await purgeAllNonWhitelisted();
    for (const call of chromeStub._state.browsingDataCalls) {
      assert.notEqual(call.types?.extension, true,
        'extension:true kendi ayarlarimizi ve diger eklentileri siler');
    }
  });
});

// --------------------------------------------------------------------------
// D. TOPLU TEMIZLIK
// --------------------------------------------------------------------------

describe('D. Toplu temizlik', () => {
  test('D1. Karisik profil: yalnizca korumasizlar gider', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'ig_did', domain: '.instagram.com' }),
        makeCookie({ name: 'VISITOR_INFO', domain: '.youtube.com' }),
        makeCookie({ name: 'phpbb3_sid', domain: '.mobilism.org' }),
        makeCookie({ name: 'gh_sess', domain: 'github.com' })
      ],
      rules: {
        'github.com': kural('github.com'),
        'youtube.com': kural('youtube.com')
      }
    });

    await purgeAllNonWhitelisted();

    assert.deepEqual(kalanCerezler(), ['github.com|gh_sess', 'youtube.com|VISITOR_INFO'],
      'yalnizca beyaz listedekiler kalmaliydi');
  });

  test('D2. ACIK sekmesi olan site toplu temizlikte ATLANIR ve raporlanir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sid', domain: 'ecc.tools' }),
        makeCookie({ name: 'sid', domain: 'blackmod.net' })
      ],
      tabs: [{ id: 1, url: 'https://ecc.tools/', active: true }]
    });

    const sonuc = await purgeAllNonWhitelisted();

    assert.deepEqual(kalanCerezler(), ['ecc.tools|sid'], 'acik sitenin verisi durmaliydi');
    assert.equal(sonuc.skippedOpen, 1);
    assert.deepEqual(sonuc.skippedOpenDomains, ['ecc.tools']);
  });

  test('D3. GIZLI sekme acik siteyi KORUMAZ (normal profil ayri)', async () => {
    await seed({
      cookies: [makeCookie({ name: 'sid', domain: 'ecc.tools' })],
      tabs: [{ id: 1, url: 'https://ecc.tools/', active: true, incognito: true }]
    });
    await purgeAllNonWhitelisted();
    assert.deepEqual(kalanCerezler(), [],
      'gizli sekme normal profildeki temizligi engellememeli');
  });

  test('D4. Beyaz listeli hostlar excludeOrigins listesine www varyantlariyla girer', async () => {
    await seed({
      cookies: [makeCookie({ name: 'x', domain: 'deepl.com' })],
      rules: { 'deepl.com': kural('deepl.com') }
    });
    await purgeAllNonWhitelisted();
    const haric = haricTutulanOriginler();
    for (const beklenen of ['https://deepl.com', 'http://deepl.com',
      'https://www.deepl.com', 'http://www.deepl.com']) {
      assert.ok(haric.includes(beklenen), `${beklenen} haric tutulmaliydi`);
    }
  });

  test('D5. Global onbellek temizligi VARSAYILAN KAPALI', async () => {
    await seed({ cookies: [makeCookie({ domain: 'openani.me' })] });
    const sonuc = await purgeAllNonWhitelisted();
    assert.equal(sonuc.cacheCleared, false,
      'filtresiz onbellek temizligi beyaz listeyi de vurur; onay gerektirir');
  });
});

// --------------------------------------------------------------------------
// E. KURAL ESLEME HIYERARSISI
// --------------------------------------------------------------------------

describe('E. Kural esleme', () => {
  test('E1. Kok kurali subdomains:true ise alt alan adlarini kapsar', () => {
    const rules = { 'google.com': kural('google.com', { subdomains: true }) };
    assert.equal(matchDomainRule('mail.google.com', rules).type, 'white');
    assert.equal(matchDomainRule('drive.google.com', rules).type, 'white');
  });

  test('E2. Kok kurali subdomains:false ise alt alan adlarini KAPSAMAZ', () => {
    const rules = { 'google.com': kural('google.com', { subdomains: false }) };
    assert.equal(matchDomainRule('google.com', rules).type, 'white');
    assert.equal(matchDomainRule('mail.google.com', rules).type, 'default');
  });

  test('E3. Alt alan adi kurali KARDESI kapsamaz', () => {
    const rules = { 'mail.google.com': kural('mail.google.com', { subdomains: true }) };
    assert.equal(matchDomainRule('mail.google.com', rules).type, 'white');
    assert.equal(matchDomainRule('x.mail.google.com', rules).type, 'white');
    assert.equal(matchDomainRule('drive.google.com', rules).type, 'default',
      'kardes alan adi kapsanmamali');
    assert.equal(matchDomainRule('google.com', rules).type, 'default',
      'ust alan adi kapsanmamali');
  });

  test('E4. Suresi dolmus gecici izin KORUMASIZ raporlanir', () => {
    const rules = {
      'ecc.tools': kural('ecc.tools', { type: 'temp', expiresAt: Date.now() - 1000 })
    };
    const eslesme = matchDomainRule('ecc.tools', rules);
    assert.equal(eslesme.type, 'default');
    assert.equal(eslesme.expired, true);
  });

  test('E5. Public suffix sinirinin ALTINA inilmez', () => {
    // "to" tek basina bir kural olsa bile 1337x.to'yu kapsamamali; aksi halde
    // bir ek (co.uk, com.tr) tum siteleri kapsayan bir kurala donusurdu.
    const rules = { 'to': kural('to', { subdomains: true }) };
    assert.equal(matchDomainRule('1337x.to', rules).type, 'default',
      'public suffix kurali alt alan adi kurali gibi davranmamali');
  });
});

// --------------------------------------------------------------------------
// F. GECMIS VE INDIRMELER
// --------------------------------------------------------------------------

describe('F. Gecmis ve indirme kayitlari', () => {
  test('F1. Gecmis kapsama gore silinir, komsu site etkilenmez', async () => {
    await seed({
      history: [
        makeHistoryItem('https://1337x.to/home/'),
        makeHistoryItem('https://1337x.to/search/x/1/'),
        makeHistoryItem('https://ddlbase.com/')
      ]
    });
    await purgeDomain('1337x.to');
    assert.deepEqual(kalanGecmis(), ['https://ddlbase.com/']);
  });

  test('F2. Indirme KAYDI silinir (alt alan adi dahil)', async () => {
    await seed({
      downloads: [
        { id: 1, url: 'https://fitgirl-repacks.site/game.zip' },
        { id: 2, url: 'https://cdn.fitgirl-repacks.site/part2.zip' },
        { id: 3, url: 'https://ddlbase.com/other.zip' }
      ]
    });
    const sonuc = await purgeDomain('fitgirl-repacks.site');
    assert.equal(sonuc.downloads, 2, 'alt alan adindaki indirme de sayilmali');
    assert.deepEqual(chromeStub._state.downloads.map(d => d.id), [3]);
  });

  test('F3. Beyaz listedeki sitenin gecmisi VARSAYILAN olarak korunur', async () => {
    await seed({
      history: [makeHistoryItem('https://github.com/Yimikami/CursorForge')],
      rules: { 'github.com': kural('github.com') }
    });
    await purgeDomain('github.com');
    assert.equal(kalanGecmis().length, 1);
  });

  test('F4. whitelistCleanHistory acikken beyaz listenin GECMISI temizlenir, cerezi KALIR', async () => {
    await seed({
      cookies: [makeCookie({ name: 'gh_sess', domain: 'github.com' })],
      history: [makeHistoryItem('https://github.com/Yimikami/CursorForge')],
      rules: { 'github.com': kural('github.com') },
      settings: { whitelistCleanHistory: true }
    });
    // Kural korumali oldugu icin purgeDomain hic islemez; istisna yolu
    // scheduler.runWhitelistExceptionCleanup uzerinden calisir.
    const { runWhitelistExceptionCleanup } = await import('../lib/sw/scheduler.js');
    await runWhitelistExceptionCleanup('github.com');
    assert.deepEqual(kalanGecmis(), [], 'gecmis istisnasi calismaliydi');
    assert.deepEqual(kalanCerezler(), ['github.com|gh_sess'], 'cerez korunmaliydi');
  });
});

// --------------------------------------------------------------------------
// G. 3. TARAF HARITASI
// --------------------------------------------------------------------------

describe('G. 3. taraf tespiti', () => {
  test('G1. Bildirilen hostlar KOK alan adina indirgenir', async () => {
    await seed({});
    const { handlers } = await import('../lib/sw/handlers.js');
    const sonuc = await handlers.REPORT_THIRD_PARTY(
      { hosts: ['i.ytimg.com', 'rr3---sn-x.googlevideo.com', 'www.google.com'] },
      { tab: { url: 'https://www.youtube.com/watch?v=x', incognito: false } }
    );
    const { getThirdPartyMap } = await import('../lib/session-state.js');
    const harita = await getThirdPartyMap();
    assert.deepEqual(Object.keys(harita).sort(), ['google.com', 'googlevideo.com', 'ytimg.com']);
    assert.equal(sonuc.recorded, 3);
  });

  test('G2. Ana sitenin KENDI kokundeki kaynaklar 3. taraf SAYILMAZ', async () => {
    await seed({});
    const { handlers } = await import('../lib/sw/handlers.js');
    await handlers.REPORT_THIRD_PARTY(
      { hosts: ['i.ytimg.com', 'm.youtube.com', 'www.youtube.com'] },
      { tab: { url: 'https://www.youtube.com/', incognito: false } }
    );
    const { getThirdPartyMap } = await import('../lib/session-state.js');
    assert.deepEqual(Object.keys(await getThirdPartyMap()), ['ytimg.com']);
  });

  test('G3. GIZLI sekmeden gelen rapor REDDEDILIR', async () => {
    await seed({});
    const { handlers } = await import('../lib/sw/handlers.js');
    const sonuc = await handlers.REPORT_THIRD_PARTY(
      { hosts: ['tracker.example.com'] },
      { tab: { url: 'https://1337x.to/', incognito: true } }
    );
    assert.equal(sonuc.success, false);
    const { getThirdPartyMap } = await import('../lib/session-state.js');
    assert.deepEqual(Object.keys(await getThirdPartyMap()), [],
      'gizli gezinti normal profil haritasina sizmamali');
  });

  test('G4. parent MESAJDAN degil GONDERENIN sekmesinden alinir', async () => {
    await seed({});
    const { handlers } = await import('../lib/sw/handlers.js');
    await handlers.REPORT_THIRD_PARTY(
      // Ele gecirilmis icerik script'i baska bir siteyi "ana site" gosteremez.
      { parent: 'saldirgan.com', hosts: ['ytimg.com'] },
      { tab: { url: 'https://www.youtube.com/', incognito: false } }
    );
    const { getThirdPartyMap, getVisitedRoots } = await import('../lib/session-state.js');
    const harita = await getThirdPartyMap();
    assert.deepEqual(harita['ytimg.com'].parents, ['youtube.com']);
    assert.deepEqual(Object.keys(await getVisitedRoots()), ['youtube.com']);
  });
});

// --------------------------------------------------------------------------
// H. ISTATISTIK DOGRULUGU
// --------------------------------------------------------------------------

describe('H. Istatistikler ölçülene dayanir', () => {
  test('H1. Korumali site temizligi istatistigi ARTIRMAZ', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'github.com' })],
      rules: { 'github.com': kural('github.com') }
    });
    await purgeDomain('github.com');
    const stats = await storage.getStats();
    assert.equal(stats.totalCleans, 0, 'hicbir sey silinmediyse temizlik sayilmamali');
    assert.equal(stats.cookiesDeleted, 0);
  });

  test('H2. Silinen cerez sayisi GERCEKTEN silinenle esittir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'a', domain: 'blackmod.net' }),
        makeCookie({ name: 'b', domain: 'blackmod.net' }),
        makeCookie({ name: 'c', domain: 'ddlbase.com' })
      ]
    });
    const sonuc = await purgeDomain('blackmod.net');
    assert.equal(sonuc.cookies, 2);
    const stats = await storage.getStats();
    assert.equal(stats.cookiesDeleted, 2);
    assert.deepEqual(kalanCerezler(), ['ddlbase.com|c']);
  });
});

// --------------------------------------------------------------------------
// I. keepMode: "koru ama izleyicileri sil" HER YOLDA calisir
// --------------------------------------------------------------------------

describe('I. keepMode tum temizlik yollarinda uygulanir', () => {
  // GERCEK HATA. Bu ayar YALNIZCA toplu/periyodik supurmede calisiyordu:
  // purgeDomain, runScheduledPurge, scheduleDomainPurge, purgeSiteNow ve
  // PURGE_SELECTED_DOMAINS alan adi duzeyinde "korumali -> atla" deyip
  // cikiyordu, cerez duzeyine hic inmiyordu. Yani kullanici "web.whatsapp.com'u
  // koru ama izleyicilerini sil" dedikten sonra sekmeyi kapatiyor, hicbir sey
  // olmuyor ve izleyiciler ancak bir sonraki saatlik supurmede gidiyordu.
  //
  // Bu bir politika degisikligi DEGIL tutarlilik duzeltmesi: toplu yol zaten
  // (varsayilan acik, saatlik) tam bu cerezleri siliyordu.

  const secici = (domain, extra = {}) => kural(domain, {
    subdomains: false, keepMode: 'custom', keepCookies: ['wa_*'], ...extra
  });

  async function whatsappKur(settings = {}) {
    await seed({
      cookies: [
        makeCookie({ name: 'wa_session_id', domain: 'web.whatsapp.com' }),
        makeCookie({ name: '_ga', domain: 'web.whatsapp.com' }),
        makeCookie({ name: '_fbp', domain: 'web.whatsapp.com' })
      ],
      history: [makeHistoryItem('https://web.whatsapp.com/')],
      rules: { 'web.whatsapp.com': secici('web.whatsapp.com') },
      settings
    });
  }

  const kalanAdlar = () => chromeStub._state.cookies.map(c => c.name).sort();

  test('I1. purgeDomain (dogrudan motor) keepMode uygular', async () => {
    await whatsappKur();
    await purgeDomain('web.whatsapp.com');
    assert.deepEqual(kalanAdlar(), ['wa_session_id']);
  });

  test('I2. Sekme kapanisi (gecikme 0) keepMode uygular', async () => {
    await whatsappKur();
    const { scheduleDomainPurge } = await import('../lib/sw/scheduler.js');
    await scheduleDomainPurge('web.whatsapp.com');
    assert.deepEqual(kalanAdlar(), ['wa_session_id']);
  });

  test('I3. Alarm yolu (gecikme 60 sn) keepMode uygular', async () => {
    await whatsappKur({ cleanDelay: 60 });
    const { runScheduledPurge } = await import('../lib/sw/scheduler.js');
    await runScheduledPurge('web.whatsapp.com');
    assert.deepEqual(kalanAdlar(), ['wa_session_id']);
  });

  test('I4. Popup "Simdi Temizle" keepMode uygular ve BASARILI doner', async () => {
    await whatsappKur();
    const { purgeSiteNow } = await import('../lib/sw/scheduler.js');
    const sonuc = await purgeSiteNow('web.whatsapp.com');
    assert.equal(sonuc.ok, true, 'secici korumada islem yapilabilmeli');
    assert.deepEqual(kalanAdlar(), ['wa_session_id']);
  });

  test('I5. Secili siteleri derin temizle keepMode uygular', async () => {
    await whatsappKur();
    const { handlers } = await import('../lib/sw/handlers.js');
    await handlers.PURGE_SELECTED_DOMAINS({ domains: ['web.whatsapp.com'] });
    assert.deepEqual(kalanAdlar(), ['wa_session_id']);
  });

  test('I6. Secici koruma GECMISI ve DEPOLAMAYI korur (yalnizca cerez secilir)', async () => {
    await whatsappKur();
    await purgeDomain('web.whatsapp.com');
    assert.equal(kalanGecmis().length, 1,
      'whitelistCleanHistory kapaliyken beyaz listenin gecmisi durmali');
    assert.equal(silinenOriginler().length, 0,
      'korumali sitenin depolamasi icin browsingData CAGRILMAMALI');
  });

  test('I7. keepMode "all" hala HER yolda TAM korumadir', async () => {
    const yollar = [];
    const tamKur = async () => seed({
      cookies: [makeCookie({ name: 'x', domain: 'web.whatsapp.com' })],
      history: [makeHistoryItem('https://web.whatsapp.com/')],
      rules: { 'web.whatsapp.com': kural('web.whatsapp.com', { subdomains: false }) }
    });

    await tamKur();
    const dogrudan = await purgeDomain('web.whatsapp.com');
    yollar.push(['purgeDomain', dogrudan.protected === true, kalanAdlar()]);

    await tamKur();
    const { purgeSiteNow, scheduleDomainPurge } = await import('../lib/sw/scheduler.js');
    const simdi = await purgeSiteNow('web.whatsapp.com');
    yollar.push(['purgeSiteNow', simdi.reason === 'PROTECTED', kalanAdlar()]);

    await tamKur();
    await scheduleDomainPurge('web.whatsapp.com');
    yollar.push(['sekme kapanisi', true, kalanAdlar()]);

    for (const [ad, korumaBildirildi, kalan] of yollar) {
      assert.equal(korumaBildirildi, true, `${ad}: koruma bildirilmeliydi`);
      assert.deepEqual(kalan, ['x'], `${ad}: keepMode all'da hicbir cerez silinmemeli`);
    }
  });

  test('I8. Gri liste ve aktif gecici izin keepMode"dan BAGIMSIZ tam korumadir', async () => {
    for (const tip of ['grey', 'temp']) {
      await seed({
        cookies: [
          makeCookie({ name: '_ga', domain: 'openani.me' }),
          makeCookie({ name: 'sid', domain: 'openani.me' })
        ],
        rules: {
          'openani.me': kural('openani.me', {
            type: tip,
            // keepMode secici olsa BILE gri/gecici tam koruma olmali
            keepMode: 'custom', keepCookies: ['sid'],
            expiresAt: tip === 'temp' ? Date.now() + 3600_000 : null
          })
        }
      });
      const sonuc = await purgeDomain('openani.me');
      assert.equal(sonuc.protected, true, `${tip}: tam koruma olmaliydi`);
      assert.equal(chromeStub._state.cookies.length, 2, `${tip}: hicbir cerez silinmemeli`);
    }
  });
});

// --------------------------------------------------------------------------
// J. KESIF, SILME AYARLARINDAN BAGIMSIZDIR
// --------------------------------------------------------------------------

describe('J. Koruma listesi silme ayarlarina bagli olmamali', () => {
  // Toplu temizlik `excludeOrigins` ile calisir: "bu listede olmayan HER SEYI
  // sil". Liste bes kaynaktan beslenir ve ikisi (cerez, gecmis) SILME
  // ayarlarinin icine gomuluydu. Sonuc, yonu ters bir hata: "gecmisi
  // temizleme" veya "cerezleri temizleme" diyen - yani DAHA ihtiyatli
  // davranan - kullanici, koruma listesi eksildigi icin DAHA cok veri
  // kaybediyordu. Kodun kendi yorumu bunu zaten yaziyordu ama duzeltilmemisti.

  const kapsamli = (domain) => kural(domain, { subdomains: true });

  async function toplu({ settings = {}, cookies = [], history = [], rules }) {
    await seed({ cookies, history, rules, settings });
    await purgeAllNonWhitelisted();
    return haricTutulanOriginler();
  }

  test('J1. cleanHistory KAPALIYKEN de beyaz listeli alt alan adi korunur', async () => {
    const haric = await toplu({
      settings: { cleanHistory: false },
      history: [makeHistoryItem('https://mail.google.com/mail/u/0/')],
      rules: { 'google.com': kapsamli('google.com') }
    });
    assert.ok(haric.includes('https://mail.google.com'),
      `alt alan adi korunmaliydi; haric tutulanlar: ${haric.join(', ')}`);
  });

  test('J2. cleanCookies KAPALIYKEN de beyaz listeli alt alan adi korunur', async () => {
    const haric = await toplu({
      settings: { cleanCookies: false },
      cookies: [makeCookie({ name: 'GMAIL_AT', domain: 'mail.google.com' })],
      rules: { 'google.com': kapsamli('google.com') }
    });
    assert.ok(haric.includes('https://mail.google.com'),
      `alt alan adi korunmaliydi; haric tutulanlar: ${haric.join(', ')}`);
  });

  test('J3. Ikisi de kapaliyken bile korunur', async () => {
    const haric = await toplu({
      settings: { cleanHistory: false, cleanCookies: false },
      history: [makeHistoryItem('https://forum.mobilism.org/index.php')],
      rules: { 'mobilism.org': kapsamli('mobilism.org') }
    });
    assert.ok(haric.includes('https://forum.mobilism.org'),
      `alt alan adi korunmaliydi; haric tutulanlar: ${haric.join(', ')}`);
  });

  test('J4. Hedefli arama ALT DIZE eslesmesiyle YABANCI alan adi sizdirmaz', async () => {
    // chrome.history.search({text}) alt dize eslesmesi yapar: "ornek.com"
    // aramasi "notornek.com" kaydini da dondurur. Kapsam kontrolu olmadan o
    // yabanci alan adi koruma listesine girer ve TEMIZLENMEZ.
    const haric = await toplu({
      settings: { cleanHistory: false },
      history: [
        makeHistoryItem('https://alt.ornek.com/'),
        makeHistoryItem('https://notornek.com/'),
        makeHistoryItem('https://ornek.com.evil.net/')
      ],
      rules: { 'ornek.com': kapsamli('ornek.com') }
    });
    assert.ok(haric.includes('https://alt.ornek.com'), 'gercek alt alan adi korunmali');
    assert.ok(!haric.some(o => o.includes('notornek.com')),
      `yabanci alan adi koruma listesine SIZMAMALI: ${haric.join(', ')}`);
    assert.ok(!haric.some(o => o.includes('evil.net')),
      `sahte alt alan adi koruma listesine SIZMAMALI: ${haric.join(', ')}`);
  });

  test('J5. Kapsam KAPALI kuralda hedefli arama HIC yapilmaz', async () => {
    // "yalnizca bu adres" diyen kuralda alt alan adi korunmuyor zaten;
    // gecmisi okumanin bir karsiligi yok, okunmamali.
    await seed({
      history: [makeHistoryItem('https://alt.ornek.com/')],
      rules: { 'ornek.com': kural('ornek.com', { subdomains: false }) },
      settings: { cleanHistory: false }
    });
    await purgeAllNonWhitelisted();
    assert.equal(chromeStub._state.apiCalls.historySearch, 0,
      'gerekmedigi halde gecmis okundu');
  });

  test('J6. Korumali kural YOKKEN kesif maliyeti odenmez', async () => {
    await seed({
      cookies: [makeCookie({ domain: '1337x.to' })],
      history: [makeHistoryItem('https://1337x.to/')],
      settings: { cleanHistory: false, cleanCookies: false }
    });
    await purgeAllNonWhitelisted();
    assert.equal(chromeStub._state.apiCalls.historySearch, 0);
    assert.equal(chromeStub._state.apiCalls.cookiesGetAll, 0,
      'korunacak kural yokken cerez listesi cekilmemeli');
  });
});

// --------------------------------------------------------------------------
// K. HER AYAR hatasiz acilip kapanabilmeli
// --------------------------------------------------------------------------

describe('K. Ayar ac/kapat taramasi', () => {
  // Genis ve ucuz bir emniyet agi: her ayari acip kapatir ve GUNLUGE ERROR
  // veya WARN dusup dusmedigine bakar. Tek tek davranis testi degil - "bir
  // ayara dokunmak hicbir seyi patlatmiyor" garantisi. Gecmiste tam bu yolda
  // iki hata cikti: sag tik menusu yarisi (Cannot find menu item) ve icerik
  // script'i durdurmada senkron TypeError.
  const AYARLAR = [
    'cleanHistory', 'cleanCookies', 'cleanLocalStorage', 'cleanIndexedDB',
    'cleanServiceWorkers', 'cleanDownloads', 'cleanCacheOnPurgeAll',
    'cleanOnStartup', 'periodicCleanEnabled', 'whitelistCleanHistory',
    'whitelistCleanDownloads', 'stripTrackingParams', 'notifyOnClean', 'showBadgeCount',
    'trackThirdParty', 'trackThirdPartyFrames', 'contextMenuEnabled'
  ];

  test('K1. Her anahtar ac/kapat: ERROR veya WARN uretmez', async () => {
    await seed({
      cookies: [makeCookie({ domain: 'openani.me' })],
      history: [makeHistoryItem('https://openani.me/')],
      tabs: [{ id: 1, url: 'https://openani.me/', active: true, windowId: 1, incognito: false }],
      settings: { logLevel: 'info' }
    });
    await import('../service-worker.js');
    await new Promise(r => setTimeout(r, 60));

    const sorunlar = [];
    for (const anahtar of AYARLAR) {
      const varsayilan = storage.DEFAULT_SETTINGS[anahtar];
      for (const deger of [!varsayilan, varsayilan]) {
        logger.__resetLoggerForTests();
        await chrome.storage.session.set({ gt_logs: [] });

        const yazma = await storage.updateSettings({ [anahtar]: deger });
        const yanit = await sendMessage({ action: 'SETTINGS_CHANGED' });
        await new Promise(r => setTimeout(r, 40));

        if (!yazma?.ok) sorunlar.push(`${anahtar}=${deger}: yazilamadi`);
        if (!yanit?.success) sorunlar.push(`${anahtar}=${deger}: SETTINGS_CHANGED basarisiz`);
        for (const l of await logger.getLogs(30)) {
          if (l.level === 'ERROR' || l.level === 'WARN') {
            sorunlar.push(`${anahtar}=${deger}: [${l.level}] ${l.message}`);
          }
        }
      }
    }
    assert.deepEqual(sorunlar, [], `ayar degisikligi sorun uretti:\n  ${sorunlar.join('\n  ')}`);
  });

  test('K2. Gecersiz degerler guvenli araliga oturur', async () => {
    await seed({});
    for (const [anahtar, giren, beklenen] of [
      ['cleanDelay', 17, 30], ['cleanDelay', 9999, 600], ['cleanDelay', -5, 0],
      ['periodicCleanInterval', 5, 15],
      ['logLevel', 'gecersiz', 'info'],
      ['theme', 'gecersiz', 'system']
    ]) {
      await storage.updateSettings({ [anahtar]: giren });
      const s = await storage.getSettings();
      assert.equal(s[anahtar], beklenen,
        `${anahtar}=${JSON.stringify(giren)} -> ${JSON.stringify(s[anahtar])}, beklenen ${JSON.stringify(beklenen)}`);
    }
  });

  test('K3. Korumali sitede elle temizlik GUNLUGE yazilir', async () => {
    // Kullanici bir eylem baslatti ve hicbir sey olmadi; teshis gunlugunun
    // yanitlamasi gereken soru tam olarak bu. Eskiden bu yol sessizdi.
    await seed({
      cookies: [makeCookie({ name: 'gh_sess', domain: 'github.com' })],
      rules: { 'github.com': kural('github.com') },
      settings: { logLevel: 'info' }
    });
    const { purgeSiteNow } = await import('../lib/sw/scheduler.js');
    const sonuc = await purgeSiteNow('github.com');
    assert.equal(sonuc.reason, 'PROTECTED');

    const logs = await logger.getLogs(20);
    assert.ok(logs.some(l => /Korumali liste/.test(l.message)),
      `reddedilen temizlik gunluge dusmeli; loglar: ${logs.map(l => l.message).join(' | ') || '(bos)'}`);
  });
});

// --------------------------------------------------------------------------
// L. ANA ANAHTAR: kapaliyken biriken veri, acilinca YETISILIR
// --------------------------------------------------------------------------

describe('L. Ana anahtar acilinca yetisme supurmesi', () => {
  // GERCEK TARAYICI OLCUMUNDE BULUNDU. Anahtar kapaliyken sekme kapanislari
  // HIC alarm kurmuyor (scheduleDomainPurge `enabled` ile erken donuyor).
  // Kullanici korumayi geri actiginda o donemde biriken veriyi bekleyen
  // hicbir sey kalmiyordu: bir sonraki periyodik supurmeye (varsayilan 60 dk)
  // ya da rastgele bir sekme kapanisina kadar duruyordu. 120 saniye sonra
  // hala durdugu olculdu.
  //
  // Supurme SILMEZ, PLANLAR: cleanDelay'e uyar ve acik sekmelere dokunmaz.

  test('L1. Anahtar acilinca yetim veri icin temizlik PLANLANIR', async () => {
    await seed({
      cookies: [makeCookie({ name: 'a', domain: '1337x.to' })],
      settings: { enabled: false, cleanDelay: 0 }
    });
    const { handlers } = await import('../lib/sw/handlers.js');

    await handlers.SET_AUTOMATIC_CLEANING_ENABLED({ enabled: true });
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), [],
      'anahtar acilinca yetim veri temizlenmeliydi');
  });

  test('L2. Anahtar KAPATILINCA supurme tetiklenmez', async () => {
    await seed({
      cookies: [makeCookie({ name: 'a', domain: '1337x.to' })],
      settings: { enabled: true, cleanDelay: 0 }
    });
    const { handlers } = await import('../lib/sw/handlers.js');

    await handlers.SET_AUTOMATIC_CLEANING_ENABLED({ enabled: false });
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), ['1337x.to|a'],
      'anahtar kapatilirken silme yapilmamali');
  });

  test('L3. Yetisme supurmesi ACIK sekmeye dokunmaz', async () => {
    await seed({
      cookies: [makeCookie({ name: 'a', domain: 'ecc.tools' })],
      tabs: [{ id: 1, url: 'https://ecc.tools/', active: true }],
      settings: { enabled: false, cleanDelay: 0 }
    });
    const { handlers } = await import('../lib/sw/handlers.js');

    await handlers.SET_AUTOMATIC_CLEANING_ENABLED({ enabled: true });
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), ['ecc.tools|a'],
      'acik sekmenin verisi yetisme supurmesinde silinmemeli');
  });
});

// --------------------------------------------------------------------------
// M. POPUP'TAN VERILEN SURELI IZIN GERCEKTEN DOLAR
// --------------------------------------------------------------------------

describe('M. Sureli izin bitisi sureden turetilir', () => {
  // GERCEK ARAYUZ OLCUMUNDE BULUNDU. Popup'un sure seridi yalnizca
  // `durationMinutes` gonderiyor, ayarlar sayfasi ise `expiresAt`i kendisi
  // hesaplayip ikisini birden gonderiyordu. normalizeRule sadece `expiresAt`
  // okudugu icin popup'tan verilen izin `expiresAt: null` kaliyordu:
  //
  //   POPUP  : {tip:temp, dk:60, bitis:null,  snooze:[]}          <- alarm YOK
  //   AYARLAR: {tip:temp, dk:60, bitis:<zaman>, snooze:[gt:snooze:...]}
  //
  // Yani popup'tan "1 saat koru" demek SONSUZA KADAR koru demekti.

  test('M1. Yalnizca durationMinutes verilince bitis HESAPLANIR', async () => {
    const { normalizeRule } = await import('../lib/rules.js');
    const once = Date.now();
    const kural = normalizeRule('ecc.tools', 'temp', { durationMinutes: 60 });
    assert.ok(kural.expiresAt, 'bitis zamani turetilmedi - popup izni hic dolmaz');
    const kalanDk = (kural.expiresAt - once) / 60000;
    assert.ok(kalanDk > 59 && kalanDk <= 61, `60 dk yerine ${kalanDk.toFixed(1)} dk`);
  });

  test('M2. Acikca verilen expiresAt KORUNUR (sureden turetilmez)', async () => {
    const { normalizeRule } = await import('../lib/rules.js');
    const acik = Date.now() + 7 * 60_000;
    const kural = normalizeRule('ecc.tools', 'temp', { durationMinutes: 60, expiresAt: acik });
    assert.equal(kural.expiresAt, acik, 'acik bitis zamani ezildi');
  });

  test('M3. Kalici (white) kuralda sure bitisi OLUSTURULMAZ', async () => {
    const { normalizeRule } = await import('../lib/rules.js');
    const kural = normalizeRule('ecc.tools', 'white', { durationMinutes: 60 });
    assert.equal(kural.expiresAt, null, 'kalici kurala bitis zamani konmus');
  });

  test('M4. Popup yolu (sadece dk) ALARM kurdurur', async () => {
    await seed({ settings: { enabled: true } });
    const { handlers } = await import('../lib/sw/handlers.js');
    await handlers.SET_RULE({ domain: 'ecc.tools', type: 'temp',
      options: { durationMinutes: 60 } });
    const adlar = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(adlar.some(n => n.includes('ecc.tools')),
      `sureli izin alarmi kurulmadi: ${JSON.stringify(adlar)}`);
  });
});

// --------------------------------------------------------------------------
// N. SON SEKME ALT ALAN ADINDAYSA SITENIN CEREZLERI YINE DE GIDER
// --------------------------------------------------------------------------

describe('N. Alt alan adindan cikista kok temizligi', () => {
  // GERCEK SITEDE OLCULEN VERI KAYBI. Kullanici instagram.com'u geziyor, son
  // olarak bir ic baglantiya tikliyor, o baglanti privacycenter.instagram.com
  // alt alan adina yonlendiriyor, sekme oradan kapaniyor. Kapsam alt alan
  // adina cipalaniyordu ve sitenin GERCEK cerezleri (hepsi `.instagram.com`
  // uzerinde) hic gorulmuyordu:
  //
  //   getAll({domain:'privacycenter.instagram.com'}) -> []
  //   getAll({domain:'instagram.com'})               -> 5 cerez
  //   scope.matchesCookie({domain:'.instagram.com'}) -> false
  //
  // Temizlik "cerez: 0" diyerek BASARIYLA bitiyordu: ne uyari ne hata.

  test('N1. Alt alan adindan cikista UST alan adinin cerezleri silinir', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sid', domain: '.instagram.com' }),
        makeCookie({ name: 'datr', domain: '.instagram.com' })
      ],
      settings: { enabled: true, cleanDelay: 0 }
    });
    const { scheduleDomainPurge } = await import('../lib/sw/scheduler.js');

    await scheduleDomainPurge('privacycenter.instagram.com');
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), [],
      'alt alan adindan cikilinca sitenin cerezleri KALDI');
  });

  test('N2. Kok KORUMALIYSA kapsam genisletilmez (koruma cignenmez)', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'sid', domain: 'openani.me' }),
        makeCookie({ name: 'sid', domain: 'alt.openani.me' })
      ],
      rules: { 'openani.me': { domain: 'openani.me', type: 'white', subdomains: false } },
      settings: { enabled: true, cleanDelay: 0 }
    });
    const { scheduleDomainPurge } = await import('../lib/sw/scheduler.js');

    await scheduleDomainPurge('alt.openani.me');
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), ['openani.me|sid'],
      'korumali kokun cerezi silinmis ya da alt alan adi temizlenmemis');
  });

  test('N3. ALT ALAN ADININ KENDI kurali varsa kapsam genisletilmez', async () => {
    // Kullanici yalnizca mail.google.com'u korumus olabilir; o sekme kapaninca
    // kokü temizlemek korumali alt alan adini da silme riskine sokar.
    await seed({
      cookies: [
        makeCookie({ name: 'sid', domain: 'mail.google.com' }),
        makeCookie({ name: 'ads', domain: 'google.com' })
      ],
      rules: { 'mail.google.com': { domain: 'mail.google.com', type: 'white' } },
      settings: { enabled: true, cleanDelay: 0 }
    });
    const { scheduleDomainPurge } = await import('../lib/sw/scheduler.js');

    await scheduleDomainPurge('mail.google.com');
    await new Promise(r => setTimeout(r, 60));

    assert.ok(kalanCerezler().includes('mail.google.com|sid'),
      'korumali alt alan adinin cerezi silinmis');
  });

  test('N4. Kok alan adindan cikista davranis DEGISMEZ', async () => {
    await seed({
      cookies: [
        makeCookie({ name: 'a', domain: 'dizibox.com' }),
        makeCookie({ name: 'b', domain: 'video.dizibox.com' })
      ],
      settings: { enabled: true, cleanDelay: 0 }
    });
    const { scheduleDomainPurge } = await import('../lib/sw/scheduler.js');

    await scheduleDomainPurge('dizibox.com');
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), [], 'kok temizligi tum aileyi almaliydi');
  });

  test('N5. Kapsam genisleyince ACIK KALAN kardes sekme temizligi durdurur', async () => {
    // Genisletme, "acik sekme var mi" kontrolunden ONCE yapilmali: instagram.com
    // temizlenecekse baska bir instagram sekmesi acikken yapilmamali.
    await seed({
      cookies: [makeCookie({ name: 'sid', domain: '.instagram.com' })],
      tabs: [{ id: 7, url: 'https://www.instagram.com/', active: true }],
      settings: { enabled: true, cleanDelay: 0 }
    });
    const { scheduleDomainPurge } = await import('../lib/sw/scheduler.js');

    await scheduleDomainPurge('privacycenter.instagram.com');
    await new Promise(r => setTimeout(r, 60));

    assert.deepEqual(kalanCerezler(), ['instagram.com|sid'],
      'kardes sekme acikken temizlik yapilmamaliydi');
  });
});
