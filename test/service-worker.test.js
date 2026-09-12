import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, makeCookie, makeHistoryItem, sendMessage } from './helpers/chrome-stub.js';

let chromeStub = installChromeStub();

const storage = await import('../lib/storage.js');
const logger = await import('../lib/logger.js');
const { Action } = await import('../lib/messaging.js');
const { snoozeAlarmName, RuleType } = await import('../lib/rules.js');
const observer = await import('../lib/sw/observer.js');
const sweep = await import('../lib/sw/sweep.js');

// Service worker'i yukle: modul yuklenirken olay dinleyicilerini baglar.
await import('../service-worker.js');

const ALARM_PURGE = 'gt:purge:';
const ALARM_PERIODIC = 'gt:periodicSweep';
const ALARM_MAINTENANCE = 'gt:maintenance';

/** Bekleyen mikro/makro gorevlerin bitmesini bekler. */
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

async function reset({ cookies = [], history = [], downloads = [], tabs = [], rules = {}, settings = {}, revokedOrigins = [], historyRemovalPermitted = true } = {}) {
  chromeStub = installChromeStub({ cookies, history, downloads, tabs, revokedOrigins, historyRemovalPermitted });
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

const whiteRule = (domain, extra = {}) => ({
  domain, type: 'white', subdomains: true, keepMode: 'all', keepCookies: [], addedAt: 1, updatedAt: 1, ...extra
});

beforeEach(async () => { await reset(); });

describe('Istatistik listeleri: SECICI temizlik', () => {
  // Kullanici bildirdi: "Istatistikleri sifirla dedigimde En cok temizlenen
  // siteler temizlenmiyor". Sebep olculdu: o liste `stats`'tan DEGIL temizlik
  // OZETI gunluklerinden turetiliyor (options/tabs/insights.js). Ayri bir
  // eylem eklendi; bu test onun SINIRINI tutuyor.
  const ozet = (domain, cookies) => ({
    id: domain + cookies, timestamp: 1, level: 'SUCCESS', category: 'PURGE',
    domain, message: 'Temizlendi', details: { cookies, history: 0, downloads: 0 }
  });
  const teshis = (message) => ({
    id: message, timestamp: 1, level: 'WARN', category: 'PURGE',
    domain: null, message, details: null
  });

  async function tohum() {
    await chrome.storage.session.set({
      gt_logs: [ozet('haber.com', 12), ozet('forum.net', 5), teshis('Tarama ust sinira takildi')],
      gt_thirdPartySeen: { 'doubleclick.net': { count: 9, sites: ['a.com'], lastSeen: 1 } },
      gt_visitedRoots: { 'a.com': 1 }
    });
    await chrome.storage.local.set({
      statsHistory: { sites: { 'eski.com': { n: 4 } }, thirdParty: { 'ads.com': { n: 2 } } },
      stats: { ...storage.DEFAULT_STATS, totalCookies: 900, totalCleans: 25 }
    });
  }

  test('temizlik OZETLERI silinir, TESHIS kayitlari KALIR', async () => {
    await reset({ tabs: [] });
    await tohum();

    const res = await sendMessage({ action: Action.CLEAR_INSIGHT_LISTS });
    assert.equal(res.success, true);

    const { gt_logs: loglar } = await chrome.storage.session.get('gt_logs');
    const ozetler = loglar.filter(x => x.level === 'SUCCESS' && x.domain);
    const teshisler = loglar.filter(x => x.level === 'WARN');
    assert.equal(ozetler.length, 0, 'temizlik ozetleri silinmeliydi');
    assert.ok(teshisler.length >= 1,
      'teshis kayitlari KORUNMALI: gunlukler tek teshis aracimiz');
  });

  test('SAYACLAR etkilenmez - onlarin kendi dugmesi var', async () => {
    await reset({ tabs: [] });
    await tohum();
    await sendMessage({ action: Action.CLEAR_INSIGHT_LISTS });

    const { stats } = await chrome.storage.local.get('stats');
    assert.equal(stats.totalCookies, 900, 'sayac sifirlanmamaliydi');
    assert.equal(stats.totalCleans, 25);
  });

  test('kalici listeler ve karsilasma haritalari da bosalir', async () => {
    await reset({ tabs: [] });
    await tohum();
    await sendMessage({ action: Action.CLEAR_INSIGHT_LISTS });

    const { statsHistory } = await chrome.storage.local.get('statsHistory');
    assert.deepEqual(Object.keys(statsHistory.sites || {}), []);
    assert.deepEqual(Object.keys(statsHistory.thirdParty || {}), []);

    const oturum = await chrome.storage.session.get(['gt_thirdPartySeen', 'gt_visitedRoots']);
    assert.deepEqual(Object.keys(oturum.gt_thirdPartySeen || {}), [],
      'karsilasma sayimi da listeyi besliyor');
    assert.deepEqual(Object.keys(oturum.gt_visitedRoots || {}), []);
  });
});

describe('popup 3. TARAF sayisi', () => {
  // Gozlemci ebeveyni TAM HOSTNAME olarak bildiriyor. Sayim kok kapsamiyla
  // yapilmali: www.site.com'da acilan popup, site.com altinda kaydedilmis
  // 3. taraflari da gormeli - ve kardes alan adinin altindakileri GORMEMELI.
  //
  // Kaynak gt_thirdPartySeen (`sites`), gt_thirdParty (`parents`) DEGIL:
  // ikincisi temizlikte budaniyor ve sayi supurmeden sonra sifira dusuyordu.
  const gorulen = {
    'doubleclick.net': { count: 3, sites: ['www.haber.com'], lastSeen: 1 },
    'gstatic.com':     { count: 2, sites: ['haber.com'],     lastSeen: 1 },
    'cdn.baska.com':   { count: 1, sites: ['baska.com'],     lastSeen: 1 },
    'ortak.net':       { count: 9, sites: ['baska.com', 'www.haber.com'], lastSeen: 1 }
  };

  test('sayim ALT ALAN ADI varyantlarini da kapsar', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://www.haber.com/x', active: true, incognito: false }] });
    await chrome.storage.session.set({ gt_thirdPartySeen: gorulen });

    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    // doubleclick (www.haber.com) + gstatic (haber.com) + ortak (iki ebeveynden biri)
    assert.equal(info.thirdPartyCount, 3);
  });

  test('KARDES sitenin 3. taraflari sayilmaz', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://baska.com/', active: true, incognito: false }] });
    await chrome.storage.session.set({ gt_thirdPartySeen: gorulen });

    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    // cdn.baska.com + ortak.net; haber.com'un ikisi HARIC
    assert.equal(info.thirdPartyCount, 2);
  });

  test('kayit yoksa sifir doner, patlamaz', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://tek.com/', active: true, incognito: false }] });
    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(info.thirdPartyCount, 0);
  });

  // ASIL REGRESYON KORUMASI: temizlik gt_thirdParty'yi buduyor. Sayi ondan
  // okunursa periyodik supurmeden sonra 0'a duser ve sayfa yenilenene kadar
  // 0 kalir (gozlemci host'u sayfa ornegi basina bir kez bildiriyor).
  // Kullanici bunu "genelde sifir" diye bildirdi; olculdu ve kaynak degisti.
  test('temizlik haritasi BUDANSA BILE sayi durur', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://www.haber.com/', active: true, incognito: false }] });
    await chrome.storage.session.set({
      gt_thirdPartySeen: gorulen,
      // Supurmenin biraktigi hal: temizlik haritasi BOS.
      gt_thirdParty: {}
    });

    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(info.thirdPartyCount, 3, 'sayi budanan haritadan okunuyor');
  });

  // ASIL KORUMA: bu sayi ROZETE ve "silinecekler" toplamina KATILMAMALI.
  // 3. taraf verisi site temizliginde silinmiyor; totalTraces'e sayilsa
  // rozet silmedigimiz veriyi silinecekmis gibi gosterirdi.
  test('totalTraces 3. taraf sayisini ICERMEZ', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://www.haber.com/', active: true, incognito: false }],
      cookies: [{ name: 'a', domain: 'haber.com', path: '/', secure: true }]
    });
    await chrome.storage.session.set({ gt_thirdPartySeen: gorulen });

    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.ok(info.thirdPartyCount > 0, 'on kosul: 3. taraf gorulmus olmali');
    assert.equal(
      info.totalTraces,
      info.cookieCount + info.historyCount + info.downloadCount,
      'totalTraces yalnizca SILINECEK izleri saymali'
    );
  });
});

describe('A3: periyodik alarm SW uyanislarinda sifirlanmaz', () => {
  test('ayni aralikta ikinci kurulum alarmi yeniden yaratmaz', async () => {
    await reset({ settings: { periodicCleanEnabled: true, periodicCleanInterval: 60 } });

    // Ilk kurulum
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(40);
    const first = await chrome.alarms.get(ALARM_PERIODIC);
    assert.ok(first, 'periyodik alarm kurulmali');
    assert.equal(first.periodInMinutes, 60);

    // SW yeniden uyandi: storage degisikligi tetikleyicisi uzerinden
    await chrome.storage.local.set({ periodicCleanInterval: 60 });
    await settle(20);
    const second = await chrome.alarms.get(ALARM_PERIODIC);
    assert.equal(second.periodInMinutes, 60);
    assert.equal(second.delayInMinutes, first.delayInMinutes,
      'alarm yeniden yaratilmamali (v1.1.0 her uyanista sifirliyordu)');
  });

  test('aralik degisince alarm yenilenir', async () => {
    await reset({ settings: { periodicCleanEnabled: true, periodicCleanInterval: 60 } });
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(40);

    await chrome.storage.local.set({ periodicCleanInterval: 120 });
    await settle(20);
    assert.equal((await chrome.alarms.get(ALARM_PERIODIC)).periodInMinutes, 120);
  });

  test('periyodik temizlik kapaliysa alarm kalmaz', async () => {
    await reset({ settings: { periodicCleanEnabled: true, periodicCleanInterval: 60 } });
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(40);
    assert.ok(await chrome.alarms.get(ALARM_PERIODIC));

    await chrome.storage.local.set({ periodicCleanEnabled: false });
    await settle(20);
    assert.equal(await chrome.alarms.get(ALARM_PERIODIC), undefined);
  });

  test('kurulumda bakim alarmi da kurulur', async () => {
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(40);
    assert.ok(await chrome.alarms.get(ALARM_MAINTENANCE));
  });
});

describe('C4: temizlik yalnizca alarmla planlanir', () => {
  test('sekme kapaninca gecikmeli alarm kurulur, veri HEMEN silinmez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true }],
      settings: { cleanDelay: 60 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://example.com/' });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(40);

    const alarm = await chrome.alarms.get(ALARM_PURGE + 'example.com');
    assert.ok(alarm, 'temizlik alarmi kurulmali');
    assert.ok(alarm.when > Date.now() + 50_000);
    assert.equal(chromeStub._state.cookies.length, 1, 'gecikme dolmadan silinmemeli');
  });

  test('alarm tetiklendiginde temizlik gerceklesir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      history: [makeHistoryItem('https://example.com/a')],
      tabs: []
    });

    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
    await settle(40);

    assert.equal(chromeStub._state.cookies.length, 0);
    assert.equal(chromeStub._state.history.length, 0);
  });

  test('gecikme 0 ise sekme kapaninda hemen temizlenir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true }],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://example.com/' });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(60);

    assert.equal(chromeStub._state.cookies.length, 0);
  });

  test('B3: ayni siteden baska sekme acikken temizlik planlanmaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [
        { id: 1, url: 'https://example.com/a', active: false },
        { id: 2, url: 'https://mail.example.com/b', active: true }
      ]
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://example.com/a' });
    chromeStub._state.tabs = chromeStub._state.tabs.filter(t => t.id !== 1);
    await chrome.tabs.onRemoved._fire(1);
    await settle(60);

    assert.equal(await chrome.alarms.get(ALARM_PURGE + 'example.com'), undefined,
      'kapsamda hala acik sekme var (mail.example.com), temizlik planlanmamali');
    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('alarm tetiklense bile sekme aciksa temizlik yapilmaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 5, url: 'https://mail.example.com/', active: true }]
    });

    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
    await settle(40);
    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('otomatik temizlik kapatilinca bekleyen alarmlar iptal edilir', async () => {
    await reset({ tabs: [] });
    await chrome.alarms.create(ALARM_PURGE + 'a.com', { when: Date.now() + 60000 });
    await chrome.alarms.create('gt:wlclean:b.com', { when: Date.now() + 60000 });

    const response = await sendMessage({ action: Action.SET_AUTOMATIC_CLEANING_ENABLED, enabled: false });
    assert.equal(response.success, true);
    await settle(20);

    assert.equal(await chrome.alarms.get(ALARM_PURGE + 'a.com'), undefined);
    assert.equal(await chrome.alarms.get('gt:wlclean:b.com'), undefined);
  });
});

describe('B1: snooze alarmi guvenlik kontrolu', () => {
  test('kural artik beyaz listeyse alarm ONA DOKUNMAZ', async () => {
    // v1.1.0'daki en yikici hata: yetim snooze alarmi beyaz liste kuralini
    // silip sitenin tum verisini yok ediyordu.
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      rules: { 'example.com': whiteRule('example.com') },
      tabs: []
    });
    await chrome.alarms.create(snoozeAlarmName('example.com'), { when: Date.now() - 1000 });

    await chrome.alarms.onAlarm._fire({ name: snoozeAlarmName('example.com') });
    await settle(40);

    const rules = await storage.getRules();
    assert.equal(rules['example.com']?.type, 'white', 'beyaz liste kurali korunmali');
    assert.equal(chromeStub._state.cookies.length, 1, 'site verisi silinmemeli');
    assert.equal(await chrome.alarms.get(snoozeAlarmName('example.com')), undefined,
      'yetim alarm temizlenmeli');
  });

  test('kural hic yoksa alarm sessizce yok sayilir', async () => {
    await reset({ cookies: [makeCookie({ domain: 'example.com' })], tabs: [] });
    await chrome.alarms.onAlarm._fire({ name: snoozeAlarmName('example.com') });
    await settle(30);
    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('sure uzatilmissa alarm yeni zamana tasinir', async () => {
    const future = Date.now() + 30 * 60 * 1000;
    await reset({
      rules: { 'example.com': { domain: 'example.com', type: 'temp', subdomains: true, expiresAt: future } },
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: []
    });

    await chrome.alarms.onAlarm._fire({ name: snoozeAlarmName('example.com') });
    await settle(30);

    assert.equal((await chrome.alarms.get(snoozeAlarmName('example.com'))).when, future);
    assert.equal(chromeStub._state.cookies.length, 1);
    assert.equal((await storage.getRules())['example.com'].type, 'temp');
  });

  test('gercekten suresi dolmussa kural silinir ve site temizlenir', async () => {
    await reset({
      rules: { 'example.com': { domain: 'example.com', type: 'temp', subdomains: true, expiresAt: Date.now() - 1000 } },
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: []
    });

    await chrome.alarms.onAlarm._fire({ name: snoozeAlarmName('example.com') });
    await settle(40);

    assert.equal((await storage.getRules())['example.com'], undefined);
    assert.equal(chromeStub._state.cookies.length, 0);
  });
});

describe('gecici izin suresi dolarken sekme ACIKSA veri silinmez', () => {
  // ISTENEN DAVRANIS: "15 dakika koru" denen bir site, sure dolunca kuraldan
  // dusurulur ama o an sekmede ACIKSA verisi SILINMEZ - listeye hic
  // eklenmemis sradan bir site gibi devam eder ve ancak sekme kapaninca
  // (cleanDelay kadar sonra) temizlenir.
  //
  // Iki yol suresi dolmus gecici izni isliyor ve IKISI DE ayni kurala
  // uymalidir: gt:snooze: alarmi (birincil) ve gt:maintenance alarmi
  // (yedek - snooze kacirilmissa devreye girer).

  const expiredTemp = (domain) => ({
    domain, type: 'temp', subdomains: true, keepMode: 'all', keepCookies: [],
    expiresAt: Date.now() - 1000, durationMinutes: 15, addedAt: 1, updatedAt: 1
  });

  test('snooze alarmi: sekme acikken kural duser ama cerez KALIR', async () => {
    await reset({
      rules: { 'example.com': expiredTemp('example.com') },
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true }]
    });

    await chrome.alarms.onAlarm._fire({ name: snoozeAlarmName('example.com') });
    await settle(40);

    assert.equal((await storage.getRules())['example.com'], undefined,
      'sure dolunca kural her listeden dusmeli');
    assert.equal(chromeStub._state.cookies.length, 1,
      'sekme ACIK oldugu icin veri silinmemeliydi');
  });

  test('bakim alarmi: sekme acikken kural duser ama cerez KALIR', async () => {
    await reset({
      rules: { 'example.com': expiredTemp('example.com') },
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true }]
    });

    await chrome.alarms.onAlarm._fire({ name: ALARM_MAINTENANCE });
    await settle(40);

    assert.equal((await storage.getRules())['example.com'], undefined,
      'sure dolunca kural her listeden dusmeli');
    assert.equal(chromeStub._state.cookies.length, 1,
      'sekme ACIK oldugu icin veri silinmemeliydi');
  });

  test('sekme kapaninca normal akis temizler', async () => {
    await reset({
      rules: { 'example.com': expiredTemp('example.com') },
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true }],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://example.com/' });
    await chrome.alarms.onAlarm._fire({ name: snoozeAlarmName('example.com') });
    await settle(40);
    assert.equal(chromeStub._state.cookies.length, 1, 'acikken durmali');

    // Sekme kapandi: artik kuralsiz sradan bir site.
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(60);

    assert.equal(chromeStub._state.cookies.length, 0,
      'sekme kapandiktan sonra veri tamamen silinmeliydi');
  });
});

describe('C1: yetim taramasi kisitlanir', () => {
  test('kisa aralikta ikinci tarama atlanir', async () => {
    // Gecikme 0: tarama bulduklarini hemen temizler, boylece kisitlamayi
    // dogrudan gozlemleyebiliriz.
    await reset({
      cookies: [makeCookie({ domain: 'orphan.com' })],
      tabs: [{ id: 1, url: 'https://tracked.com/', active: true }],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://tracked.com/' });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(60);

    // Ilk tarama yetim orphan.com'u temizledi
    assert.equal(chromeStub._state.cookies.length, 0);

    // Yeni yetim ekle, hemen ardindan baska bir sekme kapat
    chromeStub._state.cookies = [makeCookie({ domain: 'orphan2.com' })];
    chromeStub._state.tabs = [{ id: 2, url: 'https://x.com/', active: true }];
    await chrome.tabs.onCreated._fire({ id: 2, url: 'https://x.com/' });
    chromeStub._state.tabs = [];
    const before = chromeStub._state.apiCalls.cookiesGetAll;
    await chrome.tabs.onRemoved._fire(2);
    await settle(60);

    // orphan2.com kisitlama nedeniyle bu turda taranmamali
    assert.ok(chromeStub._state.cookies.some(c => c.domain === 'orphan2.com'),
      'kisitlama devrede oldugu icin ikinci tarama atlanmali');
    assert.ok(chromeStub._state.apiCalls.cookiesGetAll - before < 4,
      'ikinci turda agir tarama yapilmamali');
  });

  test('tarama kullanicinin bekleme suresini ATLAMAZ', async () => {
    // v1.1.0'da bu tarama dogrudan silme yaptigi icin cleanDelay ayari
    // fiilen islevsizdi.
    await reset({
      cookies: [makeCookie({ domain: 'orphan.com' })],
      tabs: [{ id: 1, url: 'https://tracked.com/', active: true }],
      settings: { cleanDelay: 60 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://tracked.com/' });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 1, 'gecikme dolmadan silinmemeli');
    assert.ok(await chrome.alarms.get(ALARM_PURGE + 'orphan.com'), 'yerine alarm kurulmali');
  });

  test('ACIK sekmenin kendi sitesi supurmede ATLANIR', async () => {
    // Supurme artik VARSAYILAN ACIK. Yani her kullanicida, acik sekmelerden
    // bagimsiz olarak arka planda calisiyor. O yuzden su ozellik artik bir
    // rahatlik degil GUVENLIK sarti: o an KULLANDIGINIZ ama beyaz listeye
    // almadiginiz bir siteden sizi atmamali.
    //
    // Ucuncu tarafin ana sayfasi acikken korunmasi ayrica test ediliyor
    // ("kaynak sayfasi HALA ACIK olan CDN e dokunulmaz"); burada olculen
    // sitenin KENDISI acikken korunmasi.
    await reset({
      cookies: [
        makeCookie({ domain: 'acik.com' }),      // sekmesi acik -> DURMALI
        makeCookie({ domain: 'kapali.com' })     // sekmesi yok  -> GITMELI
      ],
      tabs: [{ id: 1, url: 'https://acik.com/sayfa', active: true }],
      settings: { cleanDelay: 0, periodicCleanEnabled: true }
    });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://acik.com/sayfa' });

    const { sweepOrphanDomains } = await import('../lib/sw/sweep.js');
    await sweepOrphanDomains({ force: true });
    await settle(80);

    const kalan = chromeStub._state.cookies.map(c => c.domain).sort();
    assert.ok(kalan.includes('acik.com'),
      `acik sekmenin cerezi silinmemeli; kalan: ${JSON.stringify(kalan)}`);
    assert.equal(kalan.includes('kapali.com'), false,
      'sekmesi olmayan site supurulmeli');
  });

  test('korumali yetimler taramada atlanir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' }), makeCookie({ domain: 'bad.com' })],
      rules: { 'safe.com': whiteRule('safe.com') },
      tabs: [{ id: 1, url: 'https://x.com/', active: true }],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://x.com/' });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(80);

    assert.deepEqual(chromeStub._state.cookies.map(c => c.domain), ['safe.com']);
  });
});

describe('mesaj isleyicileri', () => {
  test('bilinmeyen eylem hata doner, patlamaz', async () => {
    const response = await sendMessage({ action: 'HIC_BOYLE_BIR_SEY_YOK' });
    assert.equal(response.success, false);
    assert.equal(response.error, 'UNKNOWN_ACTION');
  });

  test('SET_RULE kural yazar ve bekleyen temizligi iptal eder', async () => {
    await reset({ tabs: [] });
    await chrome.alarms.create(ALARM_PURGE + 'example.com', { when: Date.now() + 60000 });

    const response = await sendMessage({
      action: Action.SET_RULE, domain: 'www.example.com', type: RuleType.WHITE,
      options: { subdomains: true }
    });

    assert.equal(response.success, true);
    assert.equal(response.rule.domain, 'example.com');
    assert.equal(await chrome.alarms.get(ALARM_PURGE + 'example.com'), undefined,
      'kural eklenince bekleyen temizlik iptal edilmeli');
  });

  test('DELETE_RULE kurali siler ve temizligi planlar', async () => {
    await reset({ rules: { 'example.com': whiteRule('example.com') }, tabs: [] });

    const response = await sendMessage({ action: Action.DELETE_RULE, domain: 'example.com' });
    assert.equal(response.success, true);
    await settle(40);

    assert.equal((await storage.getRules())['example.com'], undefined);
    assert.ok(await chrome.alarms.get(ALARM_PURGE + 'example.com'),
      'kural kalkinca temizlik planlanmali');
  });

  test('PURGE_DOMAIN korumali siteyi reddeder', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    const response = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'safe.com' });
    assert.equal(response.success, false);
    assert.equal(response.protected, true);
    assert.equal(response.ruleType, 'white');
    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('PURGE_ALL_NON_WHITELIST calisir ve sayilar doner', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'a.com' }), makeCookie({ domain: 'b.com' })],
      history: [makeHistoryItem('https://a.com/1')]
    });

    const response = await sendMessage({ action: Action.PURGE_ALL_NON_WHITELIST });
    assert.equal(response.success, true);
    assert.equal(response.cookies, 2);
    assert.equal(response.history, 1);
  });

  test('GET_ACTIVE_TAB_INFO aktif sekmeyi ozetler', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' }), makeCookie({ name: 'x', domain: 'mail.example.com' })],
      history: [makeHistoryItem('https://example.com/a')],
      tabs: [{ id: 1, url: 'https://mail.example.com/inbox', active: true, title: 'Mail' }],
      rules: { 'example.com': whiteRule('example.com') }
    });

    const response = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(response.isInternal, false);
    assert.equal(response.domain, 'mail.example.com');
    assert.equal(response.isSubdomain, true);
    assert.equal(response.rootDomain, 'example.com');
    assert.equal(response.ruleType, 'white', 'ust alan adi kurali alt alan adini kapsiyor');
    assert.equal(response.cookieCount, 1);
  });

  test('GET_ACTIVE_TAB_INFO tarayici ici sayfayi isaretler', async () => {
    await reset({ tabs: [{ id: 1, url: 'chrome://settings', active: true }] });
    const response = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(response.isInternal, true);
  });

  test('GET_DOMAIN_COOKIES cerez DEGERINI sizdirmaz', async () => {
    await reset({
      cookies: [makeCookie({ name: 'sid', value: 'COK-GIZLI-TOKEN', domain: 'example.com' })]
    });

    const response = await sendMessage({ action: Action.GET_DOMAIN_COOKIES, domain: 'example.com' });
    assert.equal(response.success, true);
    assert.equal(response.cookies.length, 1);
    assert.equal(response.cookies[0].value, undefined, 'deger arayuze gonderilmemeli');
    assert.equal(response.cookies[0].valueLength, 15);
    assert.equal(JSON.stringify(response).includes('COK-GIZLI-TOKEN'), false);
  });

  test('GET_ALL_STORED_DOMAINS izleri gruplar', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'a.com' }), makeCookie({ domain: 'b.com' })],
      history: [makeHistoryItem('https://a.com/1'), makeHistoryItem('https://a.com/2')],
      downloads: [{ id: 1, url: 'https://b.com/f.zip' }],
      rules: { 'c.com': whiteRule('c.com') }
    });

    const response = await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS });
    assert.equal(response.success, true);

    const byDomain = Object.fromEntries(response.domains.map(d => [d.domain, d]));
    assert.equal(byDomain['a.com'].cookieCount, 1);
    assert.equal(byDomain['a.com'].historyCount, 2);
    assert.equal(byDomain['b.com'].downloadCount, 1);
    assert.ok(byDomain['c.com'], 'kurali olan site veri barindirmasa da listelenmeli');
    assert.equal(byDomain['c.com'].ruleType, 'white');
  });

  test('IMPORT_RULES gecerli kayitlari alir, gecersizleri sayar', async () => {
    await reset();
    const response = await sendMessage({
      action: Action.IMPORT_RULES,
      rules: [
        { domain: 'good.com', type: 'white', subdomains: true },
        { domain: 'www.other.com', type: 'grey' },
        { domain: 'chrome://x', type: 'white' },
        { domain: '', type: 'white' },
        { domain: 'stale.com', type: 'temp', expiresAt: Date.now() - 5000 }
      ]
    });

    assert.equal(response.success, true);
    assert.equal(response.imported, 3);
    assert.equal(response.rejected, 2);

    const rules = await storage.getRules();
    assert.deepEqual(Object.keys(rules).sort(), ['good.com', 'other.com', 'stale.com']);
    assert.equal(rules['stale.com'].type, 'white', 'suresi dolmus temp beyaz listeye cevrilmeli');
  });

  test('REPORT_THIRD_PARTY parent bilgisini GONDERENIN sekmesinden alir', async () => {
    // Icerik script'i ele gecirilmis olabilir; mesajdaki `parent` alanina
    // guvenilmez, gerceklik kaynagi sender.tab.url'dir.
    await reset({ settings: { trackThirdParty: true } });

    const response = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, parent: 'yalan-site.com', hosts: ['cdn.other.com', 'fonts.gstatic.com'] },
      { tab: { id: 1, url: 'https://gercek-site.com/sayfa' } }
    );

    assert.equal(response.success, true);
    assert.equal(response.recorded, 2);

    const gstatic = (await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS }))
      .domains.find(d => d.domain === 'gstatic.com');
    assert.ok(gstatic, 'kayit listelenmeli');
    assert.deepEqual(gstatic.parentSites, ['gercek-site.com'],
      'mesajdaki uydurma parent yerine gercek sekme host u kullanilmali');
  });

  test('REPORT_THIRD_PARTY ayar kapaliysa kayit tutmaz', async () => {
    await reset({ settings: { trackThirdParty: false } });
    const response = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['cdn.x.com'] },
      { tab: { id: 1, url: 'https://site.com/' } }
    );
    assert.equal(response.success, false);
  });

  test('GET_DIAGNOSTICS sistem durumunu doner', async () => {
    await reset({ rules: { 'a.com': whiteRule('a.com') } });
    const response = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(response.success, true);
    assert.equal(response.ruleCount, 1);
    assert.ok(Array.isArray(response.alarms));
    assert.equal(response.hardening.available, false, 'privacy izni yokken kapali olmali');
  });

  test('isleyici icinde hata olusursa mesaj katmani patlamaz', async () => {
    await reset();
    const original = chrome.alarms.getAll;
    chrome.alarms.getAll = async () => { throw new Error('patlama testi'); };
    try {
      const response = await sendMessage({ action: Action.GET_DIAGNOSTICS });
      assert.equal(response.success, false);
      assert.ok(response.error.includes('patlama'));
    } finally {
      chrome.alarms.getAll = original;
    }
  });

  test('okuma isleyicileri tek tek API hatalarina karsi dayanikli', async () => {
    // Site listesi cagrisi, alt API'lerden biri patlasa bile sonuc dondurur.
    await reset({ cookies: [makeCookie({ domain: 'a.com' })] });
    const original = chrome.downloads.search;
    chrome.downloads.search = async () => { throw new Error('indirme API hatasi'); };
    try {
      const response = await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS });
      assert.equal(response.success, true);
      assert.ok(response.domains.some(d => d.domain === 'a.com'));
    } finally {
      chrome.downloads.search = original;
    }
  });
});

describe('C5: icerik script i dinamik kaydi', () => {
  test('ayar acikken kaydedilir, kapatilinca kaldirilir', async () => {
    // trackThirdPartyFrames ACIKCA yaziliyor: bu test cerceve KAPSAMINI
    // degil, kaydin varligini olcuyor. Varsayilana yaslanirsa varsayilan
    // degisince sebepsiz kirilir (v2.7.0'da tam bunu yasadik).
    await reset({ settings: { trackThirdParty: true, trackThirdPartyFrames: false } });
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(50);

    let registered = await chrome.scripting.getRegisteredContentScripts();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].js[0], 'content/trace-observer.js');
    assert.equal(registered[0].allFrames, false);

    await chrome.storage.local.set({ trackThirdParty: false });
    await settle(30);
    registered = await chrome.scripting.getRegisteredContentScripts();
    assert.equal(registered.length, 0, 'kapatilinca sayfalarda hicbir kod calismamali');
  });

  test('otomatik temizlik kapaliysa gozlemci de kaydedilmez', async () => {
    await reset({ settings: { trackThirdParty: true, enabled: false } });
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(50);
    assert.equal((await chrome.scripting.getRegisteredContentScripts()).length, 0);
  });
});

describe('sekme gezinme takibi', () => {
  test('baska siteye gecince eskisi icin temizlik planlanir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'first.com' })],
      tabs: [{ id: 1, url: 'https://first.com/', active: true }]
    });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://first.com/' });

    chromeStub._state.tabs = [{ id: 1, url: 'https://second.com/', active: true }];
    await chrome.tabs.onUpdated._fire(1, { url: 'https://second.com/' }, { id: 1, url: 'https://second.com/', active: true });
    await settle(50);

    assert.ok(await chrome.alarms.get(ALARM_PURGE + 'first.com'));
  });

  test('ayni site icinde gezinmede temizlik planlanmaz', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://example.com/a', active: true }] });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://example.com/a' });

    chromeStub._state.tabs = [{ id: 1, url: 'https://mail.example.com/b', active: true }];
    await chrome.tabs.onUpdated._fire(1, { url: 'https://mail.example.com/b' }, { id: 1, url: 'https://mail.example.com/b', active: true });
    await settle(50);

    assert.equal(await chrome.alarms.get(ALARM_PURGE + 'example.com'), undefined);
  });

  test('bir siteye geri donunce bekleyen temizlik iptal edilir', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://other.com/', active: true }] });
    await chrome.alarms.create(ALARM_PURGE + 'example.com', { when: Date.now() + 60000 });

    chromeStub._state.tabs = [{ id: 1, url: 'https://example.com/', active: true }];
    await chrome.tabs.onUpdated._fire(1, { url: 'https://example.com/' }, { id: 1, url: 'https://example.com/', active: true });
    await settle(40);

    assert.equal(await chrome.alarms.get(ALARM_PURGE + 'example.com'), undefined);
  });
});

describe('rozet', () => {
  test('kural turune gore renk ve toplam sayi yazilir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' }), makeCookie({ name: 'y', domain: 'example.com' })],
      history: [makeHistoryItem('https://example.com/a')],
      tabs: [{ id: 3, url: 'https://example.com/', active: true }],
      rules: { 'example.com': whiteRule('example.com') }
    });

    await chrome.tabs.onActivated._fire({ tabId: 3 });
    await settle(60);

    const badge = chromeStub._state.badge.get(3);
    assert.equal(badge.text, '3');
    assert.equal(badge.color, '#10b981', 'beyaz liste yesil olmali');
  });

  test('rozet kapaliysa metin yazilmaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 3, url: 'https://example.com/', active: true }],
      settings: { showBadgeCount: false }
    });

    await chrome.tabs.onActivated._fire({ tabId: 3 });
    await settle(50);
    assert.equal(chromeStub._state.badge.get(3).text, '');
  });

  test('tarayici ici sayfada rozet temizlenir', async () => {
    await reset({ tabs: [{ id: 4, url: 'chrome://settings', active: true }] });
    await chrome.tabs.onActivated._fire({ tabId: 4 });
    await settle(40);
    assert.equal(chromeStub._state.badge.get(4).text, '');
  });
});

describe('oturum basi temizlik', () => {
  test('gri liste kurallari ve verileri tarayici acilisinda silinir', async () => {
    await reset({
      cookies: [
        makeCookie({ domain: 'session-site.com' }),
        makeCookie({ domain: 'permanent.com' })
      ],
      rules: {
        'session-site.com': { domain: 'session-site.com', type: 'grey', subdomains: true },
        'permanent.com': whiteRule('permanent.com')
      },
      tabs: []
    });

    await chrome.runtime.onStartup._fire();
    await settle(120);

    const rules = await storage.getRules();
    assert.equal(rules['session-site.com'], undefined, 'gri liste kurali kalkmali');
    assert.ok(rules['permanent.com'], 'beyaz liste kalmali');
    assert.deepEqual(chromeStub._state.cookies.map(c => c.domain), ['permanent.com']);
  });

  test('suresi dolmus gecici izinler acilista temizlenir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'expired.com' })],
      rules: { 'expired.com': { domain: 'expired.com', type: 'temp', subdomains: true, expiresAt: Date.now() - 1000 } },
      tabs: []
    });

    await chrome.runtime.onStartup._fire();
    await settle(120);

    assert.equal((await storage.getRules())['expired.com'], undefined);
    assert.equal(chromeStub._state.cookies.length, 0);
  });
});

describe('klavye kisayollari (A2 regresyonu)', () => {
  test('hizli tam temizlik BILDIRIM gosterir', async () => {
    // v1.1.0: initI18n() service worker'da ReferenceError atiyor, bildirim
    // asla olusmuyordu.
    await reset({
      cookies: [makeCookie({ domain: 'a.com' })],
      history: [makeHistoryItem('https://a.com/1')]
    });

    await chrome.commands.onCommand._fire('quick-purge-all');
    await settle(80);

    assert.equal(chromeStub._state.notifications.length, 1);
    const notification = chromeStub._state.notifications[0];
    assert.ok(notification.title.includes('GhostTrace'));
    assert.ok(!notification.message.includes('{cookies}'), 'parametreler yerine konmali');
    assert.equal(chromeStub._state.cookies.length, 0);
  });

  test('aktif sekmeyi temizleme kisayolu calisir', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true }]
    });

    await chrome.commands.onCommand._fire('quick-purge-current');
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 0);
    assert.equal(chromeStub._state.notifications.length, 1);
  });

  test('korumali sitede kisayol uyari verir, silmez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      tabs: [{ id: 1, url: 'https://safe.com/', active: true }],
      rules: { 'safe.com': whiteRule('safe.com') }
    });

    await chrome.commands.onCommand._fire('quick-purge-current');
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 1);
    assert.equal(chromeStub._state.notifications.length, 1);
    assert.ok(chromeStub._state.notifications[0].message.includes('safe.com'));
  });
});

describe('kurulum ve goc', () => {
  test('kurulumda goc calisir ve eski disk loglari silinir', async () => {
    chromeStub = installChromeStub();
    storage.__resetCacheForTests();
    await chrome.storage.local.set({
      cleanDelay: 5,
      cleanCache: true,
      gt_logs: [{ message: 'eski kayit' }],
      rules: { 'www.example.com': { domain: 'www.example.com', type: 'white' } }
    });
    storage.__resetCacheForTests();

    await chrome.runtime.onInstalled._fire({ reason: 'update' });
    await settle(80);

    const raw = await chrome.storage.local.get(null);
    assert.equal('gt_logs' in raw, false);
    assert.equal(raw.cleanDelay, 30);
    assert.equal(raw.cleanCacheOnPurgeAll, true);
    assert.deepEqual(Object.keys(raw.rules), ['example.com']);
    assert.equal(raw.schemaVersion, storage.SCHEMA_VERSION);
  });
});

describe('3. taraf (CDN / izleyici) kayitlarinin gorunurlugu', () => {
  /** haber.com sekmesi acik; sayfa iki harici kaynak yukluyor. */
  async function seedThirdParty() {
    await reset({ tabs: [{ id: 1, url: 'https://haber.com/', active: true }] });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://haber.com/' });
    const report = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com', 'cdn.jsdelivr.net'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );
    assert.equal(report.recorded, 2, 'iki kok alan adi kaydedilmeli');
  }

  const listDomains = async () => {
    const response = await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS });
    assert.equal(response.success, true);
    return response.domains;
  };

  test('kok alan adina indirgenip 3. taraf olarak listelenir', async () => {
    await seedThirdParty();
    const domains = await listDomains();

    const gstatic = domains.find(d => d.domain === 'gstatic.com');
    assert.ok(gstatic, 'fonts.gstatic.com -> gstatic.com olarak listelenmeli');
    assert.equal(gstatic.category, 'third_party');
    assert.equal(gstatic.requestCount, 1);
    assert.deepEqual(gstatic.parentSites, ['haber.com']);
    assert.ok(domains.some(d => d.domain === 'jsdelivr.net'));
  });

  test('ana sitenin sekmesi KAPANDIKTAN sonra kayit listede kalir', async () => {
    // Sekmeyi kapatmak bir 3. taraf izini yok etmez: gstatic.com'un kendi
    // verisi hala tarayicida. Kaydi silmek, temizlenmemis veriyi kullanicidan
    // gizlemek olur.
    await seedThirdParty();
    assert.ok((await listDomains()).some(d => d.domain === 'gstatic.com'));

    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(80);

    const domains = await listDomains();
    assert.ok(domains.some(d => d.domain === 'gstatic.com'),
      'sekme kapandi diye CDN kaydi silinmemeli');
  });

  test('ana site TEMIZLENSE bile 3. taraf kaydi listede kalir', async () => {
    // haber.com temizligi gstatic.com verisini temizlemez; ayri alan adidir.
    await seedThirdParty();
    chromeStub._state.tabs = [];

    const purge = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'haber.com' });
    assert.equal(purge.success, true);
    await settle(40);

    const domains = await listDomains();
    assert.ok(domains.some(d => d.domain === 'gstatic.com'),
      'ana site temizlendi diye CDN kaydi silinmemeli');
  });

  test('3. tarafin KENDISI temizlenince kaydi listeden duser', async () => {
    await seedThirdParty();
    chromeStub._state.tabs = [];

    const purge = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'gstatic.com' });
    assert.equal(purge.success, true);
    await settle(40);

    const domains = await listDomains();
    assert.equal(domains.some(d => d.domain === 'gstatic.com'), false,
      'temizlenen 3. taraf artik iz barindirmadigi icin listeden dusmeli');
    assert.ok(domains.some(d => d.domain === 'jsdelivr.net'),
      'diger 3. taraf kayitlari etkilenmemeli');
  });

  test('3. taraf temizlenebilir: korumali degilse PURGE_DOMAIN kabul eder', async () => {
    await reset({
      cookies: [makeCookie({ domain: '.doubleclick.net' })],
      tabs: [{ id: 1, url: 'https://haber.com/', active: true }]
    });
    await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['ads.doubleclick.net'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );

    const response = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'doubleclick.net' });
    assert.equal(response.success, true);
    assert.equal(response.cookies, 1);
    assert.equal(chromeStub._state.cookies.length, 0);
  });

  test('cerezi olan 3. taraf, istek kaydi olmasa da listelenir', async () => {
    await reset({ cookies: [makeCookie({ domain: '.doubleclick.net' })], tabs: [] });
    const domains = await listDomains();
    const entry = domains.find(d => d.domain === 'doubleclick.net');
    assert.ok(entry, 'cerez barindiran alan adi her zaman listelenmeli');
    assert.equal(entry.cookieCount, 1);
  });

  test('ayni CDN birden fazla siteden gorulurse parent listesi birikir', async () => {
    await reset({
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true },
        { id: 2, url: 'https://blog.net/', active: false }
      ]
    });
    await sendMessage({ action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com'] },
      { tab: { id: 1, url: 'https://haber.com/' } });
    await sendMessage({ action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com'] },
      { tab: { id: 2, url: 'https://blog.net/' } });

    const gstatic = (await listDomains()).find(d => d.domain === 'gstatic.com');
    assert.equal(gstatic.requestCount, 2);
    assert.deepEqual(gstatic.parentSites.sort(), ['blog.net', 'haber.com']);
  });

  test('sitenin kendi alt alan adi 3. taraf sayilmaz', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://haber.com/', active: true }] });
    const report = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['cdn.haber.com', 'img.haber.com'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );
    assert.equal(report.recorded, 0, 'ayni kok alan adi 3. taraf degildir');
  });
});

describe('3. taraf otomatik temizligi (yetim taramasi)', () => {
  const listDomains = async () => {
    const response = await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS });
    assert.equal(response.success, true);
    return response.domains;
  };

  test('CEREZI OLMAYAN bir CDN de otomatik temizlige girer', async () => {
    // Kritik bosluk: tarama adaylarini yalnizca cerezlerden topluyordu.
    // Cerezi olmayan ama LocalStorage/IndexedDB tutabilen bir CDN hicbir zaman
    // temizlenmiyor, listede sonsuza kadar kaliyordu. Chrome'da "hangi
    // origin'de depolama var" diye sorabilecegimiz bir API olmadigi icin bu
    // istek kaydi elimizdeki tek sinyaldir.
    await reset({
      tabs: [{ id: 1, url: 'https://haber.com/', active: true }],
      settings: { cleanDelay: 0 }
    });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://haber.com/' });
    await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );
    assert.ok((await listDomains()).some(d => d.domain === 'gstatic.com'));

    // Sekme kapaninca tarama devreye girer
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(120);

    const cleaned = chromeStub._state.browsingDataCalls
      .some(call => (call.filter.origins || []).includes('https://gstatic.com'));
    assert.ok(cleaned, 'gstatic.com icin depolama temizligi cagrilmali');

    assert.equal((await listDomains()).some(d => d.domain === 'gstatic.com'), false,
      'temizlendikten sonra kayit listeden dusmeli');
  });

  test('kaynak sayfasi HALA ACIK olan CDN e dokunulmaz', async () => {
    // Canli bir sayfanin altindan veri cekmek oturumu bozabilir.
    await reset({
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true },
        { id: 2, url: 'https://blog.net/', active: false }
      ],
      settings: { cleanDelay: 0 }
    });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://haber.com/' });
    await chrome.tabs.onCreated._fire({ id: 2, url: 'https://blog.net/' });
    await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );

    // haber.com acik kalirken blog.net kapatilir -> tarama tetiklenir
    chromeStub._state.tabs = [{ id: 1, url: 'https://haber.com/', active: true }];
    await chrome.tabs.onRemoved._fire(2);
    await settle(120);

    const touched = chromeStub._state.browsingDataCalls
      .some(call => (call.filter.origins || []).includes('https://gstatic.com'));
    assert.equal(touched, false, 'kaynak sayfa acikken CDN temizlenmemeli');
    assert.ok((await listDomains()).some(d => d.domain === 'gstatic.com'),
      'kayit listede kalmali');
  });

  test('korumali (beyaz listedeki) 3. taraf taramada atlanir', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://haber.com/', active: true }],
      rules: { 'gstatic.com': whiteRule('gstatic.com') },
      settings: { cleanDelay: 0 }
    });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://haber.com/' });
    await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );

    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(120);

    const touched = chromeStub._state.browsingDataCalls
      .some(call => (call.filter.origins || []).includes('https://gstatic.com'));
    assert.equal(touched, false, 'beyaz listedeki 3. taraf temizlenmemeli');
    const entry = (await listDomains()).find(d => d.domain === 'gstatic.com');
    assert.equal(entry?.ruleType, 'white');
  });

  test('gecikme varsa CDN icin de alarm kurulur, hemen silinmez', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://haber.com/', active: true }],
      settings: { cleanDelay: 60 }
    });
    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://haber.com/' });
    await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['fonts.gstatic.com'] },
      { tab: { id: 1, url: 'https://haber.com/' } }
    );

    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(120);

    assert.ok(await chrome.alarms.get(ALARM_PURGE + 'gstatic.com'),
      'gstatic.com icin temizlik alarmi kurulmali');
    const touched = chromeStub._state.browsingDataCalls
      .some(call => (call.filter.origins || []).includes('https://gstatic.com'));
    assert.equal(touched, false, 'gecikme dolmadan silinmemeli');
  });
});

describe('1.5 / 1.6: gozlemcinin ACIK sekmelerdeki yasam dongusu', () => {
  test('1.5 ayar acilinca zaten acik sekmelere geri doldurulur', async () => {
    // registerContentScripts yalnizca kayittan SONRAKI yuklemelere uygular.
    // Ayari actiginiz anda acik olan sekmelerde tespit calismaz; o sekmeler
    // kapatilirken 3. taraf haritasi bos oldugu icin izler temizlenmez.
    await reset({
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true },
        { id: 2, url: 'https://blog.net/', active: false },
        { id: 3, url: 'http://eski.site/', active: false },
        { id: 4, url: 'chrome://settings', active: false }
      ],
      // Cerceve kapsamini ACIKCA kapatiyoruz: bu test GERI DOLDURMANIN
      // olup olmadigini olcuyor, kapsami degil (onun ayri testi var).
      settings: { trackThirdParty: false, trackThirdPartyFrames: false }
    });

    const injected = [];
    chrome.scripting.executeScript = async ({ target, files }) => {
      if (target.tabId === 4) throw new Error('Cannot access chrome:// URL');
      injected.push({ tabId: target.tabId, allFrames: target.allFrames, files });
      return [];
    };

    await chrome.storage.local.set({ trackThirdParty: true });
    await settle(80);

    assert.equal(injected.length, 3, 'yalnizca http/https sekmelerine enjekte edilmeli');
    assert.deepEqual(injected.map(i => i.tabId).sort(), [1, 2, 3]);
    assert.ok(injected.every(i => i.allFrames === false),
      'allFrames:false zorunlu - gozlemci yalnizca ust cercevede calisir');
    assert.ok(injected.every(i => i.files[0] === 'content/trace-observer.js'));
  });

  test('1.5 tek sekmenin hatasi akisi kirmaz', async () => {
    await reset({
      tabs: [
        { id: 1, url: 'https://a.com/', active: true },
        { id: 2, url: 'https://b.com/', active: false }
      ],
      settings: { trackThirdParty: false }
    });

    let calls = 0;
    chrome.scripting.executeScript = async ({ target }) => {
      calls++;
      if (target.tabId === 1) throw new Error('erisim yok');
      return [];
    };

    await chrome.storage.local.set({ trackThirdParty: true });
    await settle(80);

    assert.equal(calls, 2, 'ilk sekme hata verse de ikinciye devam edilmeli');
    assert.equal((await chrome.scripting.getRegisteredContentScripts()).length, 1,
      'kayit yine tamamlanmis olmali');
  });

  test('1.6 ayar kapatilinca acik sekmelere DUR mesaji gider', async () => {
    // Doküman: "Unregistering content scripts will not remove scripts or
    // styles that have already been injected."
    await reset({
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true },
        { id: 2, url: 'https://blog.net/', active: false }
      ],
      settings: { trackThirdParty: true }
    });
    chrome.scripting.executeScript = async () => [];
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(80);
    assert.equal((await chrome.scripting.getRegisteredContentScripts()).length, 1);

    const messages = [];
    chrome.tabs.sendMessage = async (tabId, message) => { messages.push({ tabId, message }); };

    await chrome.storage.local.set({ trackThirdParty: false });
    await settle(80);

    assert.equal((await chrome.scripting.getRegisteredContentScripts()).length, 0, 'kayit silinmeli');
    assert.equal(messages.length, 2, 'her acik sekmeye dur mesaji gitmeli');
    assert.ok(messages.every(m => m.message.action === 'STOP_THIRD_PARTY_OBSERVER'));
  });

  test('1.6 mesaj ulasmayan sekme akisi kirmaz', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://a.com/', active: true }],
      settings: { trackThirdParty: true }
    });
    chrome.scripting.executeScript = async () => [];
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(60);

    chrome.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
    await chrome.storage.local.set({ trackThirdParty: false });
    await settle(80);

    assert.equal((await chrome.scripting.getRegisteredContentScripts()).length, 0,
      'mesaj basarisiz olsa da kayit silinmeli');
  });

  test('gozlemci document_start ile kaydedilir', async () => {
    // Resource Timing tamponu 250 girdide tasabilir; document_idle'a kadar
    // beklemek ilk kaynaklari kacirmaya yol acar.
    await reset({ settings: { trackThirdParty: true, trackThirdPartyFrames: false } });
    chrome.scripting.executeScript = async () => [];
    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(60);

    const [registered] = await chrome.scripting.getRegisteredContentScripts();
    assert.equal(registered.runAt, 'document_start');
    assert.equal(registered.allFrames, false);
    assert.equal(registered.persistAcrossSessions, true);
  });
});

describe('1.4: ag ongorusu sertlestirmesi', () => {
  test('chrome.privacy.network altindaki ayar da uygulanir', async () => {
    // HARDENING_MAP onceden yalnizca chrome.privacy.websites yolunu biliyordu.
    await reset();
    // Stub GERCEK davranisi taklit etmeli: set() sonrasi get() yeni degeri
    // dondurmeli. Aksi halde A4'un geri-okuma teyidi (dogru sekilde)
    // "unverified" der.
    const calls = [];
    let current = true;
    chrome.privacy = {
      websites: {},
      network: {
        networkPredictionEnabled: {
          async get() { return { value: current, levelOfControl: 'controllable_by_this_extension' }; },
          async set({ value }) { calls.push(value); current = value; },
          onChange: { addListener() {} }
        }
      }
    };
    chrome.permissions.contains = async () => true;

    const response = await sendMessage({
      action: Action.APPLY_HARDENING,
      hardening: { disableNetworkPrediction: true }
    });

    assert.equal(response.success, true);
    assert.deepEqual(calls, [false], 'invert:true -> networkPredictionEnabled=false');
    assert.ok(response.outcome.applied.some(a => a.startsWith('disableNetworkPrediction=')));
  });

  test('varsayilan KAPALI: yeni kullanicida ag ongorusu kapatilmaz', async () => {
    await reset();
    assert.equal(storage.DEFAULT_SETTINGS.hardening.disableNetworkPrediction, false,
      'performans bedeli oldugu icin varsayilan kapali olmali');
  });
});

describe('3.1: gizli pencere normal profile KARISMAZ', () => {
  test('gizli sekme kapaninca NORMAL profil verisi silinmez', async () => {
    // Service worker normal profilin baglaminda calisir; gizli sekmenin
    // kapanmasini temizlik tetikleyicisi saymak, kullanicinin normal
    // profildeki verisini yok eder.
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: true }],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire({ id: 1, url: 'https://example.com/', incognito: true });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(1);
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 1,
      'gizli sekme kapanisi normal profildeki cerezi silmemeli');
    assert.equal(await chrome.alarms.get(ALARM_PURGE + 'example.com'), undefined,
      'temizlik bile planlanmamali');
  });

  test('gizli sekme, normal profildeki temizligi ENGELLEMEZ', async () => {
    // Ters yon: gizli pencerede acik bir sekme "site hala kullanimda" sayilip
    // normal profildeki temizligi bloke etmemeli.
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 9, url: 'https://example.com/', active: true, incognito: true }]
    });

    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
    await settle(60);

    assert.equal(chromeStub._state.cookies.length, 0,
      'gizli sekme normal profil temizligini engellememeli');
  });

  test('normal sekme temizligi engellemeye DEVAM eder', async () => {
    // Regresyon: gizli filtresi normal sekme korumasini bozmamali.
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 9, url: 'https://example.com/', active: true, incognito: false }]
    });

    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
    await settle(60);

    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('gizli sekme yetim taramasinda "acik" sayilmaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'orphan.com' })],
      tabs: [
        { id: 1, url: 'https://orphan.com/', active: true, incognito: true },
        { id: 2, url: 'https://tracked.com/', active: false, incognito: false }
      ],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire({ id: 2, url: 'https://tracked.com/', incognito: false });
    chromeStub._state.tabs = [{ id: 1, url: 'https://orphan.com/', active: true, incognito: true }];
    await chrome.tabs.onRemoved._fire(2);
    await settle(100);

    assert.equal(chromeStub._state.cookies.length, 0,
      'yalnizca gizli sekmesi olan alan adi yetim sayilmali');
  });

  test('gizli sekmeye gozlemci enjekte edilmez', async () => {
    // Gizli gezintide gorulen 3. taraflar oturum haritasina yazilirsa, sonra
    // NORMAL profilde temizlik tetikler - gizli gezintinin sizmasi olur.
    await reset({
      tabs: [
        { id: 1, url: 'https://normal.com/', active: true, incognito: false },
        { id: 2, url: 'https://gizli.com/', active: false, incognito: true }
      ],
      settings: { trackThirdParty: false }
    });

    const injected = [];
    chrome.scripting.executeScript = async ({ target }) => { injected.push(target.tabId); return []; };

    await chrome.storage.local.set({ trackThirdParty: true });
    await settle(80);

    assert.deepEqual(injected, [1], 'yalnizca normal sekmeye enjekte edilmeli');
  });

  test('gizli sekmede rozet TEMIZLENIR (normal profil sayilari gosterilmez)', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' }), makeCookie({ name: 'b', domain: 'example.com' })],
      tabs: [{ id: 7, url: 'https://example.com/', active: true, incognito: true }]
    });

    await chrome.tabs.onActivated._fire({ tabId: 7 });
    await settle(60);

    assert.equal(chromeStub._state.badge.get(7)?.text, '',
      'gizli sekmede normal profilin iz sayisi gosterilmemeli');
  });

  test('GET_ACTIVE_TAB_INFO gizli pencereyi isaretler', async () => {
    await reset({ tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: true }] });
    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(info.isIncognito, true);
    assert.equal(info.domain, undefined, 'gizli pencerede alan adi bilgisi verilmemeli');
  });

  test('gizli sekme depolama origin listesine girmez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://gizli.example.com/', active: true, incognito: true }]
    });

    await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    await settle(40);

    const call = chromeStub._state.browsingDataCalls.at(-1);
    assert.ok(!call.filter.origins.includes('https://gizli.example.com'),
      'gizli sekmenin origin-i temizlik listesine girmemeli');
  });
});

describe('3.3: sag tik menusu (varsayilan KAPALI)', () => {
  const menuItems = () => chrome.contextMenus._items;

  test('varsayilan olarak menuye HIC kayit yapilmaz', async () => {
    await reset();
    assert.equal(storage.DEFAULT_SETTINGS.contextMenuEnabled, false,
      'kullanicinin baglam menusu varsayilan olarak kirletilmez');

    await chrome.runtime.onInstalled._fire({ reason: 'install' });
    await settle(80);
    assert.equal(menuItems().size, 0);
  });

  test('ayar acilinca TEK ust oge altinda iki secenek olusur', async () => {
    await reset({ settings: { contextMenuEnabled: true } });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);

    const items = [...menuItems().values()];
    const roots = items.filter(i => !i.parentId);
    assert.equal(roots.length, 1, 'menude tek satir gorunmeli');
    assert.equal(items.filter(i => i.parentId === roots[0].id).length, 2);
    assert.ok(items.every(i => i.contexts.includes('page')));
  });

  test('ayar kapatilinca tum kayitlar kaldirilir', async () => {
    await reset({ settings: { contextMenuEnabled: true } });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);
    assert.ok(menuItems().size > 0);

    await chrome.storage.local.set({ contextMenuEnabled: false });
    await settle(80);
    assert.equal(menuItems().size, 0);
  });

  test('temizle secenegi siteyi temizler', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: false }],
      settings: { contextMenuEnabled: true }
    });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);

    await chrome.contextMenus.onClicked._fire(
      { menuItemId: 'gt:menu:purge' },
      { id: 1, url: 'https://example.com/', incognito: false }
    );
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 0);
    assert.ok(chromeStub._state.notifications.length > 0, 'sonuc bildirilmeli');
  });

  test('korumali sitede temizle secenegi veriyi SILMEZ', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      tabs: [{ id: 1, url: 'https://safe.com/', active: true, incognito: false }],
      rules: { 'safe.com': whiteRule('safe.com') },
      settings: { contextMenuEnabled: true }
    });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);

    await chrome.contextMenus.onClicked._fire(
      { menuItemId: 'gt:menu:purge' },
      { id: 1, url: 'https://safe.com/', incognito: false }
    );
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('beyaz liste secenegi ekler ve tekrar tiklamada cikarir', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: false }],
      settings: { contextMenuEnabled: true }
    });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);

    const tab = { id: 1, url: 'https://example.com/', incognito: false };

    await chrome.contextMenus.onClicked._fire({ menuItemId: 'gt:menu:whitelist' }, tab);
    await settle(80);
    assert.equal((await storage.getRules())['example.com']?.type, 'white');

    await chrome.contextMenus.onClicked._fire({ menuItemId: 'gt:menu:whitelist' }, tab);
    await settle(80);
    assert.equal((await storage.getRules())['example.com'], undefined);
  });

  test('gizli sekmede menu islemi calismaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      settings: { contextMenuEnabled: true }
    });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);

    await chrome.contextMenus.onClicked._fire(
      { menuItemId: 'gt:menu:purge' },
      { id: 1, url: 'https://example.com/', incognito: true }
    );
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 1,
      'gizli sekmeden normal profil verisi silinmemeli');
  });

  test('menu etiketi beyaz liste durumuna gore guncellenir', async () => {
    await reset({
      tabs: [{ id: 5, url: 'https://example.com/', active: true, incognito: false }],
      rules: { 'example.com': whiteRule('example.com') },
      settings: { contextMenuEnabled: true }
    });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    await settle(80);

    await chrome.tabs.onActivated._fire({ tabId: 5 });
    await settle(80);

    const item = menuItems().get('gt:menu:whitelist');
    assert.ok(item, 'beyaz liste ogesi olmali');
    // Beyaz listedeki site icin "cikar" etiketi bekleniyor
    assert.ok(item.title.length > 0);
    const purgeItem = menuItems().get('gt:menu:purge');
    assert.equal(purgeItem.enabled, false, 'korumali sitede temizle devre disi olmali');
  });
});

describe('3.4: gercek depolama olcumu (yalnizca raporlama)', () => {
  test('olcum kaydedilir ve temizlikte AYRI alanda toplanir', async () => {
    await reset({
      cookies: [makeCookie({ name: 'c', value: 'v', domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: false }]
    });

    const report = await sendMessage(
      { action: Action.REPORT_STORAGE_ESTIMATE, usage: 5_242_880 },
      { tab: { id: 1, url: 'https://example.com/', incognito: false } }
    );
    assert.equal(report.success, true);

    chromeStub._state.tabs = [];
    const result = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    assert.equal(result.success, true);
    assert.equal(result.storageBytes, 5_242_880);

    const stats = await storage.getStats();
    assert.equal(stats.storageBytesFreed, 5_242_880);
    // KRITIK: birebir olculen bytes ile KARISMAMALI
    assert.ok(stats.bytesFreed > 0 && stats.bytesFreed < 10_000,
      `bytesFreed yalnizca cerez/gecmis baytini tasimali (olan: ${stats.bytesFreed})`);
  });

  test('olcum bir kez tuketilir, ikinci temizlikte tekrar sayilmaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: false }]
    });
    await sendMessage(
      { action: Action.REPORT_STORAGE_ESTIMATE, usage: 1_000_000 },
      { tab: { id: 1, url: 'https://example.com/', incognito: false } }
    );
    chromeStub._state.tabs = [];

    const first = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    assert.equal(first.storageBytes, 1_000_000);

    const second = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    assert.equal(second.storageBytes, 0, 'ayni olcum ikinci kez sayilmamali');
  });

  test('kapsam disi olcum tuketilmez', async () => {
    await reset({
      tabs: [
        { id: 1, url: 'https://example.com/', active: true, incognito: false },
        { id: 2, url: 'https://other.com/', active: false, incognito: false }
      ]
    });
    await sendMessage({ action: Action.REPORT_STORAGE_ESTIMATE, usage: 111 },
      { tab: { id: 1, url: 'https://example.com/', incognito: false } });
    await sendMessage({ action: Action.REPORT_STORAGE_ESTIMATE, usage: 222 },
      { tab: { id: 2, url: 'https://other.com/', incognito: false } });

    chromeStub._state.tabs = [];
    const result = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    assert.equal(result.storageBytes, 111, 'yalnizca kapsam ici olcum toplanmali');

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.storageEstimateCount, 1, 'other.com olcumu durmaya devam etmeli');
  });

  test('alt alan adi olcumleri kok temizliginde toplanir', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://mail.example.com/', active: true, incognito: false }]
    });
    await sendMessage({ action: Action.REPORT_STORAGE_ESTIMATE, usage: 700 },
      { tab: { id: 1, url: 'https://mail.example.com/', incognito: false } });
    await sendMessage({ action: Action.REPORT_STORAGE_ESTIMATE, usage: 300 },
      { tab: { id: 1, url: 'https://cdn.example.com/', incognito: false } });

    chromeStub._state.tabs = [];
    const result = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    assert.equal(result.storageBytes, 1000);
  });

  test('gizli sekmeden gelen olcum kabul edilmez', async () => {
    await reset({ tabs: [] });
    const report = await sendMessage(
      { action: Action.REPORT_STORAGE_ESTIMATE, usage: 999 },
      { tab: { id: 1, url: 'https://example.com/', incognito: true } }
    );
    assert.equal(report.success, false);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.storageEstimateCount, 0);
  });

  test('3. taraf takibi kapaliysa olcum alinmaz', async () => {
    await reset({ settings: { trackThirdParty: false } });
    const report = await sendMessage(
      { action: Action.REPORT_STORAGE_ESTIMATE, usage: 999 },
      { tab: { id: 1, url: 'https://example.com/', incognito: false } }
    );
    assert.equal(report.success, false);
  });

  test('gecersiz olcum degerleri yok sayilir', async () => {
    await reset({ tabs: [] });
    for (const usage of [0, -5, NaN, 'abc', null, undefined]) {
      await sendMessage({ action: Action.REPORT_STORAGE_ESTIMATE, usage },
        { tab: { id: 1, url: 'https://example.com/', incognito: false } });
    }
    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.storageEstimateCount, 0);
  });

  test('olcum silme kararlarina KARISMAZ', async () => {
    // Korumali bir site icin olcum kaydedilse bile temizlik yapilmamali.
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      rules: { 'safe.com': whiteRule('safe.com') },
      tabs: [{ id: 1, url: 'https://safe.com/', active: true, incognito: false }]
    });
    await sendMessage({ action: Action.REPORT_STORAGE_ESTIMATE, usage: 9_000_000 },
      { tab: { id: 1, url: 'https://safe.com/', incognito: false } });

    const result = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'safe.com' });
    assert.equal(result.success, false);
    assert.equal(result.protected, true);
    assert.equal(chromeStub._state.cookies.length, 1);

    const stats = await storage.getStats();
    assert.equal(stats.storageBytesFreed, 0, 'temizlik olmadigi icin olcum sayilmamali');
  });
});

describe('D5: site erisimi kisitlandiginda SESSIZ kalinmaz', () => {
  test('erisim yoksa temizlik yapilmaz ve HATA olarak kaydedilir', async () => {
    // Kullanici chrome://extensions'ta site erisimini daraltirsa
    // chrome.cookies o alan adi icin bos doner. Onceki halinde eklenti
    // "0 cerez silindi" diye BASARILI rapor ederdi; kullanici korundugunu
    // sanardi ama veri yerinde kalirdi.
    await reset({
      cookies: [makeCookie({ domain: 'example.com' })],
      tabs: [],
      revokedOrigins: ['https://example.com/']
    });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
    await settle(80);

    assert.equal(chromeStub._state.cookies.length, 1, 'veri yerinde kalmali');

    const logs = await logger.getLogs();
    const errors = logs.filter(l => l.level === 'ERROR');
    assert.ok(errors.length > 0, 'sessiz kalmamali, hata kaydi olmali');
    assert.ok(errors.some(l => l.message.includes('erisimi kisitli')),
      'log mesaji sebebi soylemeli');
  });

  test('erisim varsa temizlik normal calisir', async () => {
    await reset({ cookies: [makeCookie({ domain: 'example.com' })], tabs: [] });
    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
    await settle(80);
    assert.equal(chromeStub._state.cookies.length, 0);
  });

  test('rozet erisim yokken UYARI isareti gosterir, sayi gostermez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'example.com' }), makeCookie({ name: 'b', domain: 'example.com' })],
      tabs: [{ id: 4, url: 'https://example.com/', active: true, incognito: false }],
      revokedOrigins: ['https://example.com/']
    });

    await chrome.tabs.onActivated._fire({ tabId: 4 });
    await settle(80);

    const badge = chromeStub._state.badge.get(4);
    assert.equal(badge.text, '!', 'guvenilmez sayi yerine uyari isareti');
    assert.equal(badge.color, '#64748b');
  });

  test('GET_ACTIVE_TAB_INFO erisim durumunu bildirir', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://example.com/', active: true, incognito: false }],
      revokedOrigins: ['https://example.com/']
    });
    const info = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(info.hasHostAccess, false);

    await reset({ tabs: [{ id: 1, url: 'https://ok.com/', active: true, incognito: false }] });
    const info2 = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });
    assert.equal(info2.hasHostAccess, true);
  });

  test('erisim kaldirilinca uyari loglanir', async () => {
    await reset({ tabs: [] });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    await chrome.permissions.onRemoved._fire({ origins: ['https://example.com/*'] });
    await settle(60);

    const logs = await logger.getLogs();
    assert.ok(logs.some(l => l.level === 'WARN' && l.message.includes('Site erisimi kaldirildi')));
  });

  test('erisim kontrolu belirsizse temizlik ENGELLENMEZ', async () => {
    // API hata verirse yanlis alarm vermek yerine erisim varsayilir; aksi
    // halde tek bir API arizasi tum temizligi durdurur.
    await reset({ cookies: [makeCookie({ domain: 'example.com' })], tabs: [] });
    const original = chrome.permissions.contains;
    chrome.permissions.contains = async () => { throw new Error('API arizasi'); };

    try {
      await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'example.com' });
      await settle(80);
      assert.equal(chromeStub._state.cookies.length, 0,
        'belirsizlikte temizlik devam etmeli');
    } finally {
      chrome.permissions.contains = original;
    }
  });

  test('tarayici ici adresler erisim kontrolunden gecer', async () => {
    const { hasHostAccess } = await import('../lib/privacy.js');
    assert.equal(await hasHostAccess('chrome://settings'), true);
    assert.equal(await hasHostAccess(''), true);
    assert.equal(await hasHostAccess('gecersiz-url'), true);
  });
});

describe('D10: basarisiz cerez silmeleri gorunur', () => {
  test('silinemeyen cerezler uyari olarak kaydedilir', async () => {
    await reset({
      cookies: [
        makeCookie({ name: 'a', domain: 'example.com' }),
        makeCookie({ name: 'b', domain: 'example.com' }),
        makeCookie({ name: 'c', domain: 'example.com' })
      ],
      tabs: []
    });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    // Bir cerezin silinmesini engelle (Chrome remove() null dondururse boyle olur)
    const original = chrome.cookies.remove;
    chrome.cookies.remove = async (details) => {
      if (details.name === 'b') return null;
      return original(details);
    };

    try {
      const result = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
      assert.equal(result.cookies, 2, 'yalnizca gercekten silinenler sayilmali');
    } finally {
      chrome.cookies.remove = original;
    }

    const logs = await logger.getLogs();
    assert.ok(logs.some(l => l.level === 'WARN' && l.message.includes('silinemedi')),
      'basarisiz silme sessiz kalmamali');
  });
});

describe('SILINEMEYEN CEREZ teshis edilebilir olmali (gercek log bulgusu)', () => {
  // GERCEK KULLANIM VERISI (2026-08-25 log disa aktarimi):
  //
  //   attempted 15, failed 1, removed 14   <- ilk temizlik
  //   attempted  1, failed 1, removed  0   <- 4 kez daha, ayni cerez
  //
  // Yani obilet.com'un TEK bir cerezi hicbir temizlikte silinemedi ve her
  // seferinde yeniden denendi. Uc ayri kusur ayni anda gorunuyor:
  //
  //   1. Uyari "site erisimi kisitli olabilir" diyordu - ayni yiginda 14
  //      cerez silinmisken bu SEBEP OLAMAZ. Kod dogrulamadigi bir nedeni
  //      iddia edip kullaniciyi bosuna chrome://extensions'a yolluyordu.
  //   2. chrome.runtime.lastError HIC OKUNMUYORDU. Chrome basarisizligin
  //      sebebini soyluyor, biz atiyorduk.
  //   3. HANGI cerez oldugu kaydedilmiyordu; ne kullanici ne de biz teshis
  //      edebiliyorduk. Sonsuza kadar tekrar denenen gorunmez bir ariza.

  test('basarisiz cerezin KIMLIGI loglanir, DEGERI loglanmaz', async () => {
    await reset({
      cookies: [
        makeCookie({ domain: 'example.com', name: 'a', value: 'GIZLI_DEGER_1' }),
        makeCookie({ domain: 'example.com', name: 'inatci', value: 'GIZLI_DEGER_2' })
      ]
    });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    const original = chrome.cookies.remove;
    chrome.cookies.remove = async (details) => {
      if (details.name === 'inatci') {
        chrome.runtime.lastError = { message: 'Cannot remove cookie: test sebebi' };
        return null;
      }
      return original(details);
    };

    try {
      await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    } finally {
      chrome.cookies.remove = original;
      delete chrome.runtime.lastError;
    }

    const logs = await logger.getLogs();
    const uyari = logs.find(l => l.level === 'WARN' && l.message.includes('silinemedi'));
    assert.ok(uyari, 'uyari kaydedilmeli');

    const metin = JSON.stringify(uyari.details || {});
    assert.ok(metin.includes('inatci'),
      `hangi cerezin silinemedigi yazmali; details: ${metin}`);
    assert.equal(metin.includes('GIZLI_DEGER'), false,
      'cerez DEGERI asla loga yazilmamali');
  });

  test('Chrome un verdigi SEBEP loga gecer, uydurulmaz', async () => {
    await reset({ cookies: [makeCookie({ domain: 'example.com', name: 'inatci' })] });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    const original = chrome.cookies.remove;
    chrome.cookies.remove = async () => {
      chrome.runtime.lastError = { message: 'Cannot remove cookie: test sebebi' };
      return null;
    };

    try {
      await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    } finally {
      chrome.cookies.remove = original;
      delete chrome.runtime.lastError;
    }

    const logs = await logger.getLogs();
    const uyari = logs.find(l => l.level === 'WARN' && l.message.includes('silinemedi'));
    assert.ok(uyari, 'uyari kaydedilmeli');
    assert.ok(JSON.stringify(uyari.details || {}).includes('test sebebi'),
      'Chrome un bildirdigi sebep details icinde olmali');
  });

  test('uyari DOGRULANMAMIS bir sebep IDDIA ETMEZ', async () => {
    // "site erisimi kisitli olabilir" cumlesi kodun bilmedigi bir teshis.
    // Yanlis oldugunda kullaniciyi var olmayan bir ayari duzeltmeye yolluyor.
    await reset({ cookies: [makeCookie({ domain: 'example.com', name: 'inatci' })] });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    const original = chrome.cookies.remove;
    chrome.cookies.remove = async () => null;
    try {
      await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
    } finally {
      chrome.cookies.remove = original;
    }

    const logs = await logger.getLogs();
    const uyari = logs.find(l => l.level === 'WARN' && l.message.includes('silinemedi'));
    assert.ok(uyari, 'uyari kaydedilmeli');
    assert.equal(/erisimi kisitli olabilir/.test(uyari.message), false,
      `mesaj dogrulanmamis sebep iddia etmemeli: "${uyari.message}"`);
  });
});

describe('3.2: kurumsal politika gecmis silmeyi engellerse sessiz kalinmaz', () => {
  test('engelli politikada gecmis silinemeyince UYARI kaydedilir', async () => {
    // Gercek Chrome: kAllowDeletingBrowserHistory=false ise
    // chrome.history.deleteUrl kDeleteProhibitedError atar. Eski kod bu reddi
    // `.then(() => bytes, () => 0)` ile sessizce yutuyor, "0 gecmis silindi"
    // diye BASARILI rapor ediyordu.
    await reset({
      history: [
        { url: 'https://example.com/a', title: 'a', lastVisitTime: 1 },
        { url: 'https://example.com/b', title: 'b', lastVisitTime: 2 }
      ],
      tabs: [],
      historyRemovalPermitted: false
    });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });

    assert.equal(chromeStub._state.history.length, 2, 'veri yerinde kalmali');
    const logs = await logger.getLogs();
    assert.ok(
      logs.some(l => (l.level === 'WARN' || l.level === 'ERROR') && l.message.includes('gecmis kaydi silinemedi')),
      'basarisiz gecmis silme sessiz kalmamali'
    );
  });

  test('politika durumu teshise yazilir', async () => {
    await reset({ tabs: [], historyRemovalPermitted: false });
    await chrome.runtime.onStartup._fire();
    await settle(80);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.historyRemovalPermitted, false,
      'teshis ekrani politika engelini gostermeli');
  });

  test('politika serbestse teshis true bildirir ve uyari yok', async () => {
    await reset({ tabs: [] });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();
    await chrome.runtime.onStartup._fire();
    await settle(80);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.historyRemovalPermitted, true);

    const logs = await logger.getLogs();
    assert.ok(!logs.some(l => l.message.includes('gecmis silme politika')),
      'engel yokken uyari uretilmemeli');
  });

  test('settings() API yoksa temizlik engellenmez', async () => {
    await reset({
      history: [{ url: 'https://example.com/a', title: 'a', lastVisitTime: 1 }],
      tabs: []
    });
    const original = chrome.browsingData.settings;
    chrome.browsingData.settings = undefined;
    try {
      await chrome.runtime.onStartup._fire();
      await settle(60);
      const result = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'example.com' });
      assert.equal(result.history, 1, 'API eksikliginde temizlik normal calismali');
    } finally {
      chrome.browsingData.settings = original;
    }
  });

  test('toplu temizlikte de politika reddi gorunur', async () => {
    await reset({
      history: [{ url: 'https://blocked.com/a', title: 'a', lastVisitTime: 1 }],
      tabs: [],
      historyRemovalPermitted: false
    });
    await chrome.storage.local.set({ logLevel: 'info' });
    logger.__resetLoggerForTests();

    await sendMessage({ action: Action.PURGE_ALL_NON_WHITELIST });
    await settle(80);

    const logs = await logger.getLogs();
    assert.ok(
      logs.some(l => (l.level === 'WARN' || l.level === 'ERROR') && l.message.includes('gecmis kaydi silinemedi')),
      'toplu temizlikte de sessiz kalmamali'
    );
  });
});

describe('rozet durumu yalnizca renkle anlatilmaz (erisilebilirlik)', () => {
  test('beyaz listede baslik korumayi soyler', async () => {
    await reset({
      tabs: [{ id: 7, url: 'https://safe.com/', active: true, incognito: false }],
      rules: { 'safe.com': { type: 'white', domain: 'safe.com' } }
    });

    await chrome.tabs.onActivated._fire({ tabId: 7 });
    await settle(80);

    const title = chromeStub._state.actionTitles.get(7);
    assert.ok(title, 'baslik yazilmali');
    assert.ok(/koru|listede/i.test(title), `baslik durumu soylemeli: ${title}`);
  });

  test('varsayilan sitede baslik temizlenecegini soyler', async () => {
    await reset({
      tabs: [{ id: 8, url: 'https://other.com/', active: true, incognito: false }]
    });

    await chrome.tabs.onActivated._fire({ tabId: 8 });
    await settle(80);

    const title = chromeStub._state.actionTitles.get(8);
    assert.ok(title, 'baslik yazilmali');
    assert.ok(/temizlen/i.test(title), `baslik durumu soylemeli: ${title}`);
  });

  test('erisim yokken baslik sebebi soyler', async () => {
    await reset({
      tabs: [{ id: 9, url: 'https://blocked.com/', active: true, incognito: false }],
      revokedOrigins: ['https://blocked.com/']
    });

    await chrome.tabs.onActivated._fire({ tabId: 9 });
    await settle(80);

    const title = chromeStub._state.actionTitles.get(9);
    assert.ok(title, 'baslik yazilmali');
    assert.ok(/erisim|erişim/i.test(title), `baslik sebebi soylemeli: ${title}`);
  });
});

describe('URL takip parametrelerini temizleme (stripTrackingParams)', () => {
  test('varsayilan ACIK: izleme parametresi iceren URL history-den silinir', async () => {
    await reset({
      tabs: [{ id: 20, url: 'https://other.com/page?utm_source=twitter&fbclid=123', active: true, incognito: false }],
      history: [{ url: 'https://other.com/page?utm_source=twitter&fbclid=123', lastVisitTime: 1000 }]
    });

    await chrome.tabs.onUpdated._fire(20,
      { url: 'https://other.com/page?utm_source=twitter&fbclid=123' },
      { id: 20, url: 'https://other.com/page?utm_source=twitter&fbclid=123', active: true, incognito: false });
    await settle(60);

    // Gecmisten kirli adresin silindigini dogrula
    assert.ok(chromeStub._state.deletedHistory.some(h => h.url.includes('utm_source')),
      'kirli URL gecmisten silinmeli');
  });

  test('ayar KAPALI iken URL history-den silinmez', async () => {
    await reset({
      tabs: [{ id: 21, url: 'https://other.com/page?utm_source=twitter', active: true, incognito: false }],
      settings: { stripTrackingParams: false },
      history: [{ url: 'https://other.com/page?utm_source=twitter', lastVisitTime: 1000 }]
    });

    await chrome.tabs.onUpdated._fire(21,
      { url: 'https://other.com/page?utm_source=twitter' },
      { id: 21, url: 'https://other.com/page?utm_source=twitter', active: true, incognito: false });
    await settle(60);

    assert.equal(chromeStub._state.deletedHistory.some(h => h.url.includes('utm_source')), false,
      'ayar kapaliyken URL silinmemeli');
    const history = await chrome.history.search({ text: '' });
    assert.ok(history.some(h => h.url.includes('utm_source')),
      'ayar kapaliyken URL gecmiste kalir');
  });
});

describe('cleanOnStartup: acilista tam supurme', () => {
  test('cleanOnStartup ACIK: baslangicta korumasiz tum veriler supurulur', async () => {
    await reset({
      settings: { cleanOnStartup: true, enabled: true },
      cookies: [
        { domain: 'unlisted.com', name: 'trace', value: '1' },
        { domain: 'safe.com', name: 'auth', value: '1' }
      ],
      rules: { 'safe.com': { type: 'white', domain: 'safe.com' } }
    });

    await chrome.runtime.onStartup._fire();
    await settle(80);

    const remainingCookies = await chrome.cookies.getAll({});
    assert.ok(remainingCookies.some(c => c.domain === 'safe.com'), 'beyaz liste korunmali');
    assert.ok(!remainingCookies.some(c => c.domain === 'unlisted.com'), 'korumasiz cerezler supurulmeli');
  });
});

describe('1.5 ikinci yari: eklenti GUNCELLEMESINDEN sonra acik sekmeler', () => {
  test('guncelleme sonrasi zaten acik sekmelere gozlemci geri doldurulur', async () => {
    // Kayit persistAcrossSessions:true ile yapiliyor, yani guncellemeden SONRA
    // da kayitli gorunur. Ama guncelleme, acik sekmelere ENJEKTE EDILMIS
    // script'i olduruyor (eklenti baglami gecersizlesir). Eski kodda geri
    // doldurma yalnizca `wanted && !isRegistered` dalindan cagriliyordu; kayit
    // sag kaldigi icin o dal hic girilmiyordu. Sonuc: guncellemeden sonra acik
    // kalan sekmelerde 3. taraf tespiti YOK -> o CDN'ler haritaya girmiyor ->
    // sekme kapaninca temizlenmiyor. Sessiz iz kacagi.
    await reset({
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true, incognito: false },
        { id: 2, url: 'https://blog.net/', active: false, incognito: false },
        { id: 3, url: 'chrome://settings', active: false, incognito: false }
      ],
      settings: { trackThirdParty: true }
    });

    // Guncelleme oncesi durum: kayit ZATEN var.
    await chrome.scripting.registerContentScripts([{
      id: 'gt-trace-observer',
      js: ['content/trace-observer.js'],
      matches: ['http://*/*', 'https://*/*'],
      persistAcrossSessions: true
    }]).catch(() => {});

    const injected = [];
    chrome.scripting.executeScript = async ({ target }) => {
      if (target.tabId === 3) throw new Error('Cannot access chrome:// URL');
      injected.push(target.tabId);
      return [];
    };

    await chrome.runtime.onInstalled._fire({ reason: 'update' });
    await settle(120);

    assert.deepEqual(injected.sort(), [1, 2],
      'guncelleme sonrasi acik http/https sekmelerine enjekte edilmeli');
  });

  test('gozlemci KAPALIYKEN guncelleme enjeksiyon yapmaz', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://haber.com/', active: true, incognito: false }],
      settings: { trackThirdParty: false }
    });

    const injected = [];
    chrome.scripting.executeScript = async ({ target }) => { injected.push(target.tabId); return []; };

    await chrome.runtime.onInstalled._fire({ reason: 'update' });
    await settle(120);

    assert.deepEqual(injected, [], 'ayar kapaliyken enjeksiyon olmamali');
  });

  test('gizli sekmeye guncelleme sonrasi da enjekte edilmez', async () => {
    await reset({
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true, incognito: false },
        { id: 2, url: 'https://gizli.com/', active: false, incognito: true }
      ],
      settings: { trackThirdParty: true }
    });
    await chrome.scripting.registerContentScripts([{
      id: 'gt-trace-observer', js: ['content/trace-observer.js'],
      matches: ['http://*/*', 'https://*/*'], persistAcrossSessions: true
    }]).catch(() => {});

    const injected = [];
    chrome.scripting.executeScript = async ({ target }) => { injected.push(target.tabId); return []; };

    await chrome.runtime.onInstalled._fire({ reason: 'update' });
    await settle(120);

    assert.deepEqual(injected, [1], 'gizli sekme kapsam disi kalmali');
  });
});

describe('2.9: kural yazma hatasi ile GECERSIZ ALAN ADI ayirt edilir', () => {
  test('gecersiz alan adi INVALID_DOMAIN kodu doner', async () => {
    await reset({ tabs: [] });
    const res = await sendMessage({ action: Action.SET_RULE, domain: '???', type: 'white' });
    assert.equal(res.success, false);
    assert.equal(res.error, 'INVALID_DOMAIN');
  });

  test('depolama reddi INVALID_DOMAIN DEGIL baska bir kod doner', async () => {
    // Eski davranis: arayuz her basarisizlikta "gecerli bir alan adi girin"
    // diyordu. Kullanici zaten gecerli olan alan adini tekrar yaziyor, yine
    // olmuyor; asil sebep (kota/yazma kisiti) hicbir yerde gorunmuyordu.
    await reset({ tabs: [] });
    const originalSet = chrome.storage.local.set;
    chrome.storage.local.set = async (items) => {
      if (items && Object.prototype.hasOwnProperty.call(items, 'rules')) {
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      return originalSet(items);
    };
    try {
      const res = await sendMessage({ action: Action.SET_RULE, domain: 'example.com', type: 'white' });
      assert.equal(res.success, false, 'basarisiz olmali');
      assert.notEqual(res.error, 'INVALID_DOMAIN',
        'kota reddi gecersiz alan adi gibi raporlanmamali');
      assert.match(String(res.error), /quota/i, 'gercek sebep kodda gorunmeli');
    } finally {
      chrome.storage.local.set = originalSet;
    }
  });
});


describe('beyaz liste istisnasi: oturum korunur, gecmis/indirme temizlenir', () => {
  // Bu ozellik ayarlarda VAR, arayuzde VAR, alarm zinciri VAR - ama olculen
  // kapsam raporunda lib/sw/scheduler.js:63-94 HIC calismamis cikti. Yani
  // "kod var" diye calistigi varsayilamaz. Bu oturumda ayni sinifta iki hata
  // bulundu (izin dugmesi hicbir sey yapmiyordu, menu sessizce kuruluyordu).

  const WHITE = { 'safe.com': { type: 'white', domain: 'safe.com' } };

  test('gecmis istisnasi ACIK: gecmis silinir, CEREZ KORUNUR', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      history: [
        makeHistoryItem('https://safe.com/a'),
        makeHistoryItem('https://safe.com/b')
      ],
      tabs: [],
      rules: WHITE,
      settings: { whitelistCleanHistory: true, cleanDelay: 0 }
    });

    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(120);

    assert.equal(chromeStub._state.history.length, 0, 'gecmis silinmeli');
    assert.equal(chromeStub._state.cookies.length, 1,
      'CEREZ KORUNMALI - beyaz listenin anlami bu');
  });

  test('indirme istisnasi ACIK: indirme kaydi silinir, cerez korunur', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      downloads: [{ id: 1, url: 'https://safe.com/dosya.zip' }],
      tabs: [],
      rules: WHITE,
      settings: { whitelistCleanDownloads: true, cleanDelay: 0 }
    });

    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(120);

    assert.equal(chromeStub._state.downloads.length, 0, 'indirme kaydi silinmeli');
    assert.equal(chromeStub._state.cookies.length, 1, 'cerez korunmali');
  });

  test('iki ayar da KAPALI: hicbir sey silinmez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'safe.com' })],
      history: [makeHistoryItem('https://safe.com/a')],
      downloads: [{ id: 1, url: 'https://safe.com/d.zip' }],
      tabs: [],
      rules: WHITE,
      settings: { whitelistCleanHistory: false, whitelistCleanDownloads: false, cleanDelay: 0 }
    });

    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(120);

    assert.equal(chromeStub._state.history.length, 1, 'ayar kapaliyken gecmis kalmali');
    assert.equal(chromeStub._state.downloads.length, 1, 'indirme kaydi kalmali');
    assert.equal(chromeStub._state.cookies.length, 1, 'cerez kalmali');
  });

  test('site HALA ACIKSA istisna uygulanmaz', async () => {
    await reset({
      history: [makeHistoryItem('https://safe.com/a')],
      tabs: [{ id: 5, url: 'https://safe.com/', active: true, incognito: false }],
      rules: WHITE,
      settings: { whitelistCleanHistory: true, cleanDelay: 0 }
    });

    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(120);

    assert.equal(chromeStub._state.history.length, 1,
      'kullanici sitede gezerken gecmisi silinmemeli');
  });

  test('eklenti KAPALIYSA istisna uygulanmaz', async () => {
    await reset({
      history: [makeHistoryItem('https://safe.com/a')],
      tabs: [],
      rules: WHITE,
      settings: { enabled: false, whitelistCleanHistory: true, cleanDelay: 0 }
    });

    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(120);

    assert.equal(chromeStub._state.history.length, 1, 'eklenti kapaliyken dokunulmamali');
  });

  test('sekme kapaninca gecikmeli istisna ALARMI kurulur', async () => {
    await reset({
      tabs: [{ id: 6, url: 'https://safe.com/', active: true, incognito: false }],
      rules: WHITE,
      settings: { whitelistCleanHistory: true, cleanDelay: 60 }
    });
    await chrome.tabs.onCreated._fire({ id: 6, url: 'https://safe.com/', incognito: false });
    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(6);
    await settle(120);

    const alarms = await chrome.alarms.getAll();
    assert.ok(alarms.some(a => a.name === 'gt:wlclean:safe.com'),
      `beyaz liste istisna alarmi kurulmali; kurulanlar: ${alarms.map(a => a.name).join(', ')}`);
    assert.ok(!alarms.some(a => a.name === 'gt:purge:safe.com'),
      'beyaz listede TAM temizlik alarmi kurulmamali');
  });

  test('istatistikler yalnizca gercekten silinenle artar', async () => {
    await reset({
      history: [makeHistoryItem('https://safe.com/a')],
      tabs: [],
      rules: WHITE,
      settings: { whitelistCleanHistory: true, cleanDelay: 0 }
    });

    const before = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(120);
    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });

    assert.equal(after.stats.historyDeleted - before.stats.historyDeleted, 1,
      'silinen 1 kayit istatistige 1 olarak yansimali');
  });
});

describe('MV3 devam zinciri: yarim kalan temizlik alarmla surdurulur', () => {
  // NEDEN ONEMLI: MV3'te service worker'i oldurten kurallardan biri "tek bir
  // istek 5 dakikadan uzun surerse"dir. Buyuk bir profilde gecmis silme bu
  // sinira yaklasabilir. Zaman butcesi dolunca is YARIDA kesilir ve kalan
  // kisim yeni bir alarmla surdurulur. Bu zincir kopuksa kullanici
  // "temizlendi" gorur ama veri kalir - bu projede en kotu hata sinifi.
  //
  // lib/purge seviyesinde butce davranisi test ediliyordu; ZAMANLAYICI
  // seviyesindeki devam alarmi olculen kapsamda HIC calismamis cikti.

  /** Butceyi deterministik doldurur: her cagride saat 15 sn ilerler. */
  function installJumpyClock(stepMs = 15_000) {
    const real = Date.now;
    let calls = 0;
    const base = real();
    Date.now = () => base + (calls++ * stepMs);
    return () => { Date.now = real; };
  }

  function manyHistory(host, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(makeHistoryItem(`https://${host}/p${i}`));
    return out;
  }

  test('butce dolunca DEVAM alarmi kurulur', async () => {
    await reset({
      history: manyHistory('big.com', 900),
      tabs: [],
      settings: { cleanDelay: 0 }
    });

    const restore = installJumpyClock();
    try {
      await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'big.com' });
      await settle(200);
    } finally {
      restore();
    }

    const alarms = await chrome.alarms.getAll();
    assert.ok(alarms.some(a => a.name === ALARM_PURGE + 'big.com'),
      `devam alarmi kurulmali; kurulanlar: ${alarms.map(a => a.name).join(', ') || '(yok)'}`);
  });

  test('yarim kalan temizlikte 3. taraf haritasi SILINMEZ', async () => {
    // Harita silinirse o CDN'ler bir daha hic temizlenmez: devam turunda
    // aday listesinde olmazlar. Bu yuzden budama YALNIZCA is bitince yapilir.
    await reset({
      history: manyHistory('big.com', 900),
      tabs: [],
      settings: { cleanDelay: 0 }
    });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://big.com/',
      hosts: ['cdn.baska.com']
    });

    const before = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(before.thirdPartyCount > 0, 'on kosul: haritada kayit olmali');

    const restore = installJumpyClock();
    try {
      await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'big.com' });
      await settle(200);
    } finally {
      restore();
    }

    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(after.thirdPartyCount, before.thirdPartyCount,
      'is yarida kaldiysa 3. taraf haritasi korunmali');
  });

  test('is TAMAMLANDIYSA devam alarmi kurulmaz ve harita budanir', async () => {
    await reset({
      history: [makeHistoryItem('https://small.com/a')],
      tabs: [],
      settings: { cleanDelay: 0 }
    });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://small.com/',
      hosts: ['cdn.baska.com']
    });

    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'small.com' });
    await settle(150);

    const alarms = await chrome.alarms.getAll();
    assert.ok(!alarms.some(a => a.name === ALARM_PURGE + 'small.com'),
      'is bittiyse devam alarmi kalmamali');
    assert.equal(chromeStub._state.history.length, 0, 'gecmis tamamen silinmeli');
  });

  test('devam turu idempotent: ikinci tur kalani bitirir', async () => {
    await reset({
      history: manyHistory('big.com', 900),
      tabs: [],
      settings: { cleanDelay: 0 }
    });

    const restore = installJumpyClock();
    try {
      await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'big.com' });
      await settle(200);
    } finally {
      restore();
    }
    const afterFirst = chromeStub._state.history.length;
    assert.ok(afterFirst > 0, 'ilk tur yarida kalmali');
    assert.ok(afterFirst < 900, 'ilk turda bir kismi silinmis olmali');

    // Gercek saatle ikinci tur: kalan bitmeli
    await chrome.alarms.onAlarm._fire({ name: ALARM_PURGE + 'big.com' });
    await settle(300);

    assert.equal(chromeStub._state.history.length, 0,
      'devam turu kalani bitirmeli (islem idempotent)');
  });
});

describe('mesaj isleyicileri: arayuzden basilan her dugme', () => {
  // Olculen kapsam raporunda lib/sw/handlers.js fonksiyon kapsami %64 cikti:
  // 23 isleyicinin 13'unde hic kosmayan kod vardi. Bunlar kullanicinin
  // bastigi dugmeler - biri bozuksa panel sessizce ise yaramaz.

  describe('ANA ANAHTAR: otomatik temizligi ac/kapat', () => {
    test('kapatinca bekleyen TUM temizlik alarmlari iptal edilir', async () => {
      await reset({
        tabs: [],
        settings: { periodicCleanEnabled: true, periodicCleanInterval: 60 }
      });
      // Once bekleyen bir temizlik kur
      await chrome.alarms.create('gt:purge:kalinti.com', { when: Date.now() + 60_000 });
      await chrome.alarms.create('gt:wlclean:baska.com', { when: Date.now() + 60_000 });

      const res = await sendMessage({
        action: Action.SET_AUTOMATIC_CLEANING_ENABLED, enabled: false
      });
      await settle(80);

      assert.equal(res.success, true);
      assert.equal(res.enabled, false);
      const names = (await chrome.alarms.getAll()).map(a => a.name);
      assert.ok(!names.some(n => n.startsWith('gt:purge:')),
        `temizlik alarmlari kalmamali: ${names.join(', ')}`);
      assert.ok(!names.some(n => n.startsWith('gt:wlclean:')),
        'beyaz liste alarmlari da iptal edilmeli');
      assert.ok(!names.includes('gt:periodicSweep'),
        'periyodik supurme de durmali');
    });

    test('acinca periyodik alarm geri kurulur', async () => {
      await reset({
        tabs: [],
        settings: { enabled: false, periodicCleanEnabled: true, periodicCleanInterval: 60 }
      });
      const res = await sendMessage({
        action: Action.SET_AUTOMATIC_CLEANING_ENABLED, enabled: true
      });
      await settle(80);

      assert.equal(res.enabled, true);
      const names = (await chrome.alarms.getAll()).map(a => a.name);
      assert.ok(names.includes('gt:periodicSweep'), 'periyodik alarm geri gelmeli');
    });

    test('AYAR YAZILAMAZSA ana anahtar degistirildi DENMEZ', async () => {
      // Kritik: yazma basarisizsa "kapatildi" demek kullaniciyi korundugu
      // sanisiyla birakir. Bu, projede tekrar tekrar duzeltilen hata sinifi.
      await reset({ tabs: [] });
      const original = chrome.storage.local.set;
      chrome.storage.local.set = async (items) => {
        if (items && 'enabled' in items) throw new Error('QUOTA_BYTES quota exceeded');
        return original(items);
      };
      try {
        const res = await sendMessage({
          action: Action.SET_AUTOMATIC_CLEANING_ENABLED, enabled: false
        });
        assert.equal(res.success, false, 'yazma basarisizsa success:false donmeli');
        assert.ok(res.error, 'sebep bildirilmeli');
      } finally {
        chrome.storage.local.set = original;
      }
    });
  });

  describe('kural kapsami (alt alan adlari dahil mi)', () => {
    test('var olan kuralin kapsami degistirilir', async () => {
      await reset({
        tabs: [],
        rules: { 'ornek.com': { type: 'white', domain: 'ornek.com', subdomains: false } }
      });
      const res = await sendMessage({
        action: Action.SET_RULE_SCOPE, domain: 'ornek.com', subdomains: true
      });
      assert.equal(res.success, true);
      assert.equal(res.rule.subdomains, true, 'kapsam guncellenmeli');
      assert.equal(res.rule.type, 'white', 'kural TURU korunmali');
    });

    test('olmayan kural icin RULE_NOT_FOUND doner', async () => {
      await reset({ tabs: [] });
      const res = await sendMessage({
        action: Action.SET_RULE_SCOPE, domain: 'yok.com', subdomains: true
      });
      assert.equal(res.success, false);
      assert.equal(res.error, 'RULE_NOT_FOUND');
    });
  });

  describe('yalnizca GECMISI temizle (beyaz listede bile)', () => {
    test('beyaz listedeki sitenin gecmisi silinir, cerezi KALIR', async () => {
      await reset({
        cookies: [makeCookie({ domain: 'safe.com' })],
        history: [makeHistoryItem('https://safe.com/a'), makeHistoryItem('https://safe.com/b')],
        tabs: [],
        rules: { 'safe.com': { type: 'white', domain: 'safe.com' } }
      });

      const res = await sendMessage({ action: Action.PURGE_DOMAIN_HISTORY_ONLY, domain: 'safe.com' });

      assert.equal(res.success, true);
      assert.equal(res.history, 2, 'iki gecmis kaydi silinmeli');
      assert.equal(chromeStub._state.history.length, 0);
      assert.equal(chromeStub._state.cookies.length, 1,
        'elle gecmis temizligi cereze DOKUNMAMALI');
    });

    test('gecersiz alan adi INVALID_DOMAIN doner', async () => {
      await reset({ tabs: [] });
      const res = await sendMessage({ action: Action.PURGE_DOMAIN_HISTORY_ONLY, domain: '???' });
      assert.equal(res.success, false);
      assert.equal(res.error, 'INVALID_DOMAIN');
    });
  });

  describe('secili siteleri topluca temizle', () => {
    test('yalnizca secilenler silinir, digerleri KALIR', async () => {
      await reset({
        cookies: [
          makeCookie({ domain: 'a.com' }),
          makeCookie({ domain: 'b.com' }),
          makeCookie({ domain: 'c.com' })
        ],
        tabs: []
      });

      const res = await sendMessage({
        action: Action.PURGE_SELECTED_DOMAINS, domains: ['a.com', 'c.com']
      });

      assert.equal(res.success, true);
      const kalan = chromeStub._state.cookies.map(c => c.domain);
      assert.deepEqual(kalan, ['b.com'], `secilmeyen kalmali; kalan: ${kalan.join(', ')}`);
    });

    test('bos liste NO_DOMAINS doner', async () => {
      await reset({ tabs: [] });
      const res = await sendMessage({ action: Action.PURGE_SELECTED_DOMAINS, domains: [] });
      assert.equal(res.success, false);
      assert.equal(res.error, 'NO_DOMAINS');
    });
  });

  describe('kurallari sifirla', () => {
    test('tum kurallar silinir ama AYARLAR korunur', async () => {
      await reset({
        tabs: [],
        rules: {
          'a.com': { type: 'white', domain: 'a.com' },
          'b.com': { type: 'grey', domain: 'b.com' }
        },
        settings: { cleanDelay: 90 }
      });

      const res = await sendMessage({ action: Action.RESET_RULES });
      assert.equal(res.success, true);

      const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
      assert.equal(diag.ruleCount, 0, 'kural kalmamali');
      assert.equal(diag.settings.cleanDelay, 90, 'ayarlar korunmali');
    });
  });

  describe('loglar', () => {
    test('log kaydi alinir, temizlenir ve metin olarak disa aktarilir', async () => {
      await reset({ tabs: [] });
      await chrome.storage.local.set({ logLevel: 'info' });
      logger.__resetLoggerForTests();
      await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'ornek.com' });
      await settle(60);

      const got = await sendMessage({ action: Action.GET_LOGS });
      assert.ok(Array.isArray(got.logs), 'loglar dizi olarak donmeli');

      const exported = await sendMessage({ action: Action.EXPORT_LOGS, format: 'text' });
      assert.equal(exported.success, true);
      assert.ok(typeof exported.content === 'string' && exported.content.length > 0,
        'metin cikti uretilmeli');

      const cleared = await sendMessage({ action: Action.CLEAR_LOGS });
      assert.equal(cleared.success, true);
      const after = await sendMessage({ action: Action.GET_LOGS });
      assert.equal(after.logs.length, 0, 'temizlikten sonra log kalmamali');
    });

    test('JSON bicimi de uretilir ve gecerli JSON olur', async () => {
      await reset({ tabs: [] });
      await chrome.storage.local.set({ logLevel: 'info' });
      logger.__resetLoggerForTests();
      await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'ornek.com' });
      await settle(60);

      const exported = await sendMessage({ action: Action.EXPORT_LOGS, format: 'json' });
      assert.equal(exported.success, true);
      assert.doesNotThrow(() => JSON.parse(exported.content), 'gecerli JSON olmali');
    });
  });

  describe('ayar degisikligi bildirimi', () => {
    test('SETTINGS_CHANGED alarmlari ve kaydi yeniden esitler', async () => {
      await reset({ tabs: [], settings: { periodicCleanEnabled: true, periodicCleanInterval: 45 } });
      const res = await sendMessage({ action: Action.SETTINGS_CHANGED });
      await settle(80);

      assert.equal(res.success, true);
      const names = (await chrome.alarms.getAll()).map(a => a.name);
      assert.ok(names.includes('gt:periodicSweep'), 'periyodik alarm esitlenmeli');
    });
  });
});

describe('periyodik supurme, devami ve bakim alarmi', () => {
  // Olculen kapsamda service-worker.js 211-265 hic calismamisti: periyodik
  // temizlik (kullanici ayari), onun devam zinciri ve bakim alarmi.

  const PERIODIC = 'gt:periodicSweep';
  const CONTINUE = 'gt:periodicSweep:continue';
  const MAINTENANCE = 'gt:maintenance';

  test('periyodik supurme izin verilmeyen siteleri temizler, beyaz listeyi BIRAKIR', async () => {
    await reset({
      cookies: [
        makeCookie({ domain: 'safe.com' }),
        makeCookie({ domain: 'bad.com' })
      ],
      tabs: [],
      rules: { 'safe.com': { type: 'white', domain: 'safe.com' } },
      settings: { periodicCleanEnabled: true, periodicCleanInterval: 60 }
    });

    await chrome.alarms.onAlarm._fire({ name: PERIODIC });
    await settle(150);

    const kalan = chromeStub._state.cookies.map(c => c.domain);
    assert.deepEqual(kalan, ['safe.com'],
      `beyaz liste kalmali, digeri gitmeli; kalan: ${kalan.join(', ')}`);
  });

  test('ayar KAPALIYSA periyodik supurme hicbir sey silmez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'bad.com' })],
      tabs: [],
      settings: { periodicCleanEnabled: false }
    });

    await chrome.alarms.onAlarm._fire({ name: PERIODIC });
    await settle(120);

    assert.equal(chromeStub._state.cookies.length, 1,
      'ayar kapaliyken kullanicinin verisine dokunulmamali');
  });

  test('eklenti KAPALIYSA periyodik supurme calismaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'bad.com' })],
      tabs: [],
      settings: { enabled: false, periodicCleanEnabled: true }
    });

    await chrome.alarms.onAlarm._fire({ name: PERIODIC });
    await settle(120);

    assert.equal(chromeStub._state.cookies.length, 1);
  });

  test('is tamamlaninca 3. taraf haritasi TEMIZLENIR', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'bad.com' })],
      tabs: [],
      settings: { periodicCleanEnabled: true }
    });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://bad.com/',
      hosts: ['cdn.izleyici.com']
    });
    const before = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(before.thirdPartyCount > 0, 'on kosul: haritada kayit olmali');

    await chrome.alarms.onAlarm._fire({ name: PERIODIC });
    await settle(150);

    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(after.thirdPartyCount, 0,
      'is bittiyse harita bosaltilmali (bir sonraki tura eskimis veri tasinmaz)');
  });

  test('toplu temizlik yarim kalirsa DEVAM alarmi kurulur ve harita KORUNUR', async () => {
    const history = [];
    for (let i = 0; i < 900; i++) history.push(makeHistoryItem(`https://bad.com/p${i}`));
    await reset({ history, tabs: [], settings: { periodicCleanEnabled: true } });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://bad.com/',
      hosts: ['cdn.izleyici.com']
    });

    // Toplu butce 60 sn (BULK_HISTORY_BUDGET_MS). Adim buyuk olmali ki
    // butce IS BITMEDEN dolsun; kucuk adimda 900 kayit 3 parcada bitiyor.
    const real = Date.now;
    let calls = 0;
    const base = real();
    Date.now = () => base + (calls++ * 100_000);
    try {
      await chrome.alarms.onAlarm._fire({ name: PERIODIC });
      await settle(250);
    } finally {
      Date.now = real;
    }

    const names = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(names.includes(CONTINUE),
      `devam alarmi kurulmali; kurulanlar: ${names.join(', ') || '(yok)'}`);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(diag.thirdPartyCount > 0,
      'is yarida kaldiysa harita korunmali - yoksa o CDN bir daha temizlenmez');
  });

  test('devam alarmi kalani bitirir ve haritayi temizler', async () => {
    await reset({
      history: [makeHistoryItem('https://bad.com/a')],
      tabs: [],
      settings: { periodicCleanEnabled: true }
    });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://bad.com/',
      hosts: ['cdn.izleyici.com']
    });

    await chrome.alarms.onAlarm._fire({ name: CONTINUE });
    await settle(150);

    assert.equal(chromeStub._state.history.length, 0, 'kalan is bitmeli');
    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.thirdPartyCount, 0, 'is bitince harita bosalmali');
  });

  test('devam alarmi eklenti kapaliyken calismaz', async () => {
    await reset({
      history: [makeHistoryItem('https://bad.com/a')],
      tabs: [],
      settings: { enabled: false }
    });
    await chrome.alarms.onAlarm._fire({ name: CONTINUE });
    await settle(120);
    assert.equal(chromeStub._state.history.length, 1);
  });

  test('BAKIM alarmi suresi dolmus gecici izinleri temizler', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'gecici.com' })],
      tabs: [],
      rules: {
        'gecici.com': {
          type: 'temp', domain: 'gecici.com',
          durationMinutes: 15, expiresAt: Date.now() - 60_000
        }
      }
    });

    await chrome.alarms.onAlarm._fire({ name: MAINTENANCE });
    await settle(150);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.ruleCount, 0, 'suresi dolmus kural kaldirilmali');
    assert.equal(chromeStub._state.cookies.length, 0,
      'suresi dolan sitenin verisi de temizlenmeli');
  });

  test('BAKIM alarmi suresi DOLMAYAN gecici izne dokunmaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'gecici.com' })],
      tabs: [],
      rules: {
        'gecici.com': {
          type: 'temp', domain: 'gecici.com',
          durationMinutes: 60, expiresAt: Date.now() + 30 * 60_000
        }
      }
    });

    await chrome.alarms.onAlarm._fire({ name: MAINTENANCE });
    await settle(150);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.ruleCount, 1, 'suresi dolmayan kural kalmali');
    assert.equal(chromeStub._state.cookies.length, 1, 'verisi korunmali');
  });

  test('bilinmeyen alarm adi sessizce yok sayilir, hata firlatmaz', async () => {
    await reset({ tabs: [] });
    await assert.doesNotReject(async () => {
      await chrome.alarms.onAlarm._fire({ name: 'gt:bilinmeyen:xyz' });
      await settle(60);
    });
  });
});

describe('keepMode "session": izleyiciler silinir, oturum cerezi kalir', () => {
  // BULGU: Arayuzde "Yalnizca Giris / Oturum Cerezlerini Koru" dugmesi var ve
  // aciklamasi "izleyiciler silinir" diyor. shouldKeepCookie bunu DOGRU
  // uyguluyor. Ama normalizeRule (lib/rules.js) 'session' degerini sessizce
  // 'all'a ceviriyordu; 'all' ise HER cerezi koruyor - izleyiciler dahil.
  //
  // Kullanici "izleyicileri sil" diyor, eklenti hepsini tutuyor ve
  // "korundu" gosteriyor. Bu projenin en kotu hata sinifi: sessiz ve
  // GUVENSIZ yonde.

  test('kural session modunu KORUYARAK kaydedilir', async () => {
    await reset({ tabs: [] });
    const res = await sendMessage({
      action: Action.SET_RULE,
      domain: 'ornek.com',
      type: 'white',
      options: { keepMode: 'session' }
    });
    assert.equal(res.success, true);
    assert.equal(res.rule.keepMode, 'session',
      'session modu all a cevrilmemeli - aksi halde izleyiciler korunur');
  });

  test('session modunda izleyici cerezi SILINIR, oturum cerezi kalir', async () => {
    await reset({
      cookies: [
        makeCookie({ name: 'sessionid', domain: 'ornek.com' }),
        makeCookie({ name: '_ga', domain: 'ornek.com' }),
        makeCookie({ name: '_fbp', domain: 'ornek.com' })
      ],
      tabs: [],
      rules: {
        'ornek.com': {
          domain: 'ornek.com', type: 'white', keepMode: 'session',
          keepCookies: [], subdomains: false
        }
      }
    });

    // keepMode TOPLU temizlikte devreye girer: PURGE_DOMAIN beyaz listedeki
    // siteyi bilincli olarak tamamen reddediyor (ayri testi var). Toplu akista
    // ise tum alan adlarinin cerezleri taranir ve isCookieProtected karar verir.
    await sendMessage({ action: Action.PURGE_ALL_NON_WHITELIST });
    await settle(150);

    const kalan = chromeStub._state.cookies.map(c => c.name).sort();
    assert.deepEqual(kalan, ['sessionid'],
      `oturum cerezi kalmali, izleyiciler gitmeli; kalan: ${kalan.join(', ')}`);
  });

  test('all modunda HER cerez korunur (mevcut davranis)', async () => {
    await reset({
      cookies: [
        makeCookie({ name: 'sessionid', domain: 'ornek.com' }),
        makeCookie({ name: '_ga', domain: 'ornek.com' })
      ],
      tabs: [],
      rules: {
        'ornek.com': {
          domain: 'ornek.com', type: 'white', keepMode: 'all',
          keepCookies: [], subdomains: false
        }
      }
    });

    await sendMessage({ action: Action.PURGE_ALL_NON_WHITELIST });
    await settle(150);
    assert.equal(chromeStub._state.cookies.length, 2, 'all modunda hepsi kalmali');
  });

  test('taninmayan keepMode en KORUYUCU degere degil, all a duser', async () => {
    // 'all' varsayilani bilincli: beyaz listedeki bir siteyi kullanici
    // korumak icin ekledi; belirsizlikte veri silmemek dogru taraf.
    await reset({ tabs: [] });
    const res = await sendMessage({
      action: Action.SET_RULE,
      domain: 'ornek.com',
      type: 'white',
      options: { keepMode: 'bilinmeyen-mod' }
    });
    assert.equal(res.rule.keepMode, 'all');
  });

  test('ice aktarma da session modunu korur', async () => {
    await reset({ tabs: [] });
    const res = await sendMessage({
      action: Action.IMPORT_RULES,
      rules: [{ domain: 'ornek.com', type: 'white', keepMode: 'session', keepCookies: [] }]
    });
    assert.equal(res.success, true);

    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.ruleCount, 1);
    const stored = await chrome.storage.local.get('rules');
    assert.equal(stored.rules['ornek.com'].keepMode, 'session',
      'ice aktarilan session modu korunmali');
  });
});

describe('toplu temizlik yarim kalirsa: HER cagri yerinde devam kurulur', () => {
  // BULGU: purgeAllNonWhitelisted `remaining` dondururuyor ve PERIYODIK yol
  // bunu dogru isliyor (devam alarmi + 3. taraf haritasini koru). Ama "Tumunu
  // Temizle" dugmesi ve klavye kisayolu remaining'i COPE atip clearThirdParty()
  // cagiriyordu: kullaniciya "temizlendi" deniyor, butceye takilan gecmis
  // diskte kaliyor ve o CDN'leri bir daha bulmanin yolu olan harita siliniyor.
  //
  // Ayni is uc yerde farkli davraniyordu - hata sinifi da, tekrar da bu.

  function jumpyClock(stepMs = 100_000) {
    const real = Date.now;
    let calls = 0;
    const base = real();
    Date.now = () => base + (calls++ * stepMs);
    return () => { Date.now = real; };
  }

  function manyHistory(host, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(makeHistoryItem(`https://${host}/p${i}`));
    return out;
  }

  async function seedBig() {
    await reset({ history: manyHistory('bad.com', 900), tabs: [] });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://bad.com/',
      hosts: ['cdn.izleyici.com']
    });
    const before = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(before.thirdPartyCount > 0, 'on kosul: haritada kayit olmali');
  }

  test('"Tumunu Temizle" DUGMESI: devam alarmi kurar, haritayi korur', async () => {
    await seedBig();
    const restore = jumpyClock();
    let res;
    try {
      res = await sendMessage({ action: Action.PURGE_ALL_NON_WHITELIST });
      await settle(250);
    } finally {
      restore();
    }

    assert.ok(res.remaining > 0, 'yanit kalan is oldugunu bildirmeli');

    const names = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(names.includes('gt:periodicSweep:continue'),
      `devam alarmi kurulmali; kurulanlar: ${names.join(', ') || '(yok)'}`);

    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(after.thirdPartyCount > 0,
      'is yarida kaldiysa 3. taraf haritasi KORUNMALI - silinirse o CDN bir daha temizlenmez');
  });

  test('KLAVYE KISAYOLU: devam alarmi kurar, haritayi korur', async () => {
    await seedBig();
    const restore = jumpyClock();
    try {
      await chrome.commands.onCommand._fire('quick-purge-all');
      await settle(250);
    } finally {
      restore();
    }

    const names = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(names.includes('gt:periodicSweep:continue'),
      `kisayol da devam alarmi kurmali; kurulanlar: ${names.join(', ') || '(yok)'}`);

    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(after.thirdPartyCount > 0, 'harita korunmali');
  });

  test('is TAMAMLANDIYSA devam alarmi kurulmaz, harita bosaltilir', async () => {
    await reset({ history: [makeHistoryItem('https://bad.com/a')], tabs: [] });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://bad.com/', hosts: ['cdn.izleyici.com']
    });

    const res = await sendMessage({ action: Action.PURGE_ALL_NON_WHITELIST });
    await settle(150);

    assert.equal(res.remaining, 0, 'kucuk isde kalan olmamali');
    const names = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(!names.includes('gt:periodicSweep:continue'), 'gereksiz devam alarmi olmamali');
    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(after.thirdPartyCount, 0, 'is bittiyse harita bosalmali');
  });

  test('SECILI SITELER yarim kalirsa harita budanmaz', async () => {
    await reset({ history: manyHistory('bad.com', 900), tabs: [] });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://bad.com/', hosts: ['cdn.izleyici.com']
    });
    const before = await sendMessage({ action: Action.GET_DIAGNOSTICS });

    const restore = jumpyClock();
    let res;
    try {
      res = await sendMessage({ action: Action.PURGE_SELECTED_DOMAINS, domains: ['bad.com'] });
      await settle(250);
    } finally {
      restore();
    }

    assert.ok(res.remaining > 0, 'kalan is bildirilmeli');
    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(after.thirdPartyCount, before.thirdPartyCount,
      'yarim kalan isde budama yapilmamali');
  });
});

describe('yetim taramasi: yarim kalan isde kayit yok edilmez', () => {
  // BULGU: delay===0 dalinda purgeDomain'in `remaining` alani gormezden
  // gelinip TUM partinin 3. taraf kaydi budaniyordu. Butceye takilan alan
  // adinin CDN kayitlari silinince o veriler bir daha aday listesine girmez.
  //
  // NOT: onRemoved'in URL bilinmedigi durumda erken donmesi BILINCLI - gizli
  // sekme kapanisini "harita kayboldu" durumundan ayirt edemiyor ve devam
  // etmek normal profildeki veriyi silmek olurdu. Bkz. service-worker.js.

  test('butceye takilan alan adinin 3. taraf kaydi KORUNUR', async () => {
    // Riskli olan, BUTCEYE TAKILAN alan adinin KENDI kaydi. 3. taraf
    // kayitlari CDN host'una gore tutuldugu icin buyuk gecmisi CDN'e veriyoruz.
    const history = [];
    for (let i = 0; i < 900; i++) history.push(makeHistoryItem(`https://cdn.yavas.com/p${i}`));

    await reset({
      cookies: [makeCookie({ domain: 'cdn.yavas.com' })],
      history,
      tabs: [{ id: 9, url: 'https://baska.com/', active: true, incognito: false }],
      settings: { cleanDelay: 0 }
    });
    await chrome.tabs.onCreated._fire({ id: 9, url: 'https://baska.com/', incognito: false });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://haber.com/',
      hosts: ['cdn.yavas.com']
    });
    const before = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(before.thirdPartyCount > 0, 'on kosul: haritada kayit olmali');

    chromeStub._state.tabs = [];
    const real = Date.now;
    let calls = 0;
    const base = real();
    Date.now = () => base + (calls++ * 30_000);
    try {
      await chrome.tabs.onRemoved._fire(9);
      await settle(300);
    } finally {
      Date.now = real;
    }

    const after = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(after.thirdPartyCount > 0,
      'butceye takilan isde kayit korunmali; silinirse o CDN bir daha bulunamaz');
  });

  test('is tamamlaninca kayit dusulur', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'yetim.com' })],
      tabs: [{ id: 9, url: 'https://baska.com/', active: true, incognito: false }],
      settings: { cleanDelay: 0 }
    });
    await chrome.tabs.onCreated._fire({ id: 9, url: 'https://baska.com/', incognito: false });
    await sendMessage({
      action: Action.REPORT_THIRD_PARTY,
      parent: 'https://yetim.com/',
      hosts: ['yetim.com']
    });

    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(9);
    await settle(250);

    assert.equal(chromeStub._state.cookies.length, 0, 'yetim alan adi temizlenmeli');
  });
});

describe('gizli sekmeden gelen 3. taraf bildirimi haritaya YAZILMAZ', () => {
  // BULGU: REPORT_THIRD_PARTY'de gizli pencere korumasi yoktu; kardesi
  // REPORT_STORAGE_ESTIMATE'te var. Kayit registerContentScripts ile gizli
  // sekmelerde de calisiyor, yani gizli gezintide gorulen 3. taraflar oturum
  // haritasina yaziliyor ve normal profilde gorunur hale geliyordu.
  // v2.4.0'da kapatilan sizintinin ayni sinifi.

  test('gizli sekme bildirimi reddedilir', async () => {
    await reset({ tabs: [], settings: { trackThirdParty: true } });

    const res = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['cdn.gizli.com'] },
      { tab: { id: 1, url: 'https://gizli-site.com/', incognito: true } }
    );

    assert.equal(res.success, false, 'gizli sekme bildirimi kabul edilmemeli');
    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(diag.thirdPartyCount, 0,
      'gizli gezinti normal profil haritasina yazilmamali');
  });

  test('normal sekme bildirimi kabul edilir', async () => {
    await reset({ tabs: [], settings: { trackThirdParty: true } });

    const res = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, hosts: ['cdn.normal.com'] },
      { tab: { id: 2, url: 'https://normal-site.com/', incognito: false } }
    );

    assert.equal(res.success, true);
    const diag = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok(diag.thirdPartyCount > 0, 'normal gezinti kaydedilmeli');
  });
});

describe('beyaz liste istisnasi: yarim kalan gecmis temizligi surdurulur', () => {
  // BULGU: runWhitelistExceptionCleanup yalnizca count ve bytes okuyor;
  // cleanHistoryForDomain'in dondurdugu `remaining` gormezden geliniyordu.
  // Buyuk gecmisli bir beyaz liste sitesinde is butceye takilirsa kalan kisim
  // icin devam alarmi kurulmuyor ve gecmis diskte kaliyor. Diger cagri
  // yerlerinde bu sinif kapatildi, burada acik kalmisti.

  const WHITE = { 'safe.com': { type: 'white', domain: 'safe.com' } };

  test('butceye takilirsa devam alarmi kurulur', async () => {
    const history = [];
    for (let i = 0; i < 900; i++) history.push(makeHistoryItem(`https://safe.com/p${i}`));

    await reset({
      history,
      tabs: [],
      rules: WHITE,
      settings: { whitelistCleanHistory: true, cleanDelay: 0 }
    });

    const real = Date.now;
    let calls = 0;
    const base = real();
    Date.now = () => base + (calls++ * 30_000);
    try {
      await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
      await settle(300);
    } finally {
      Date.now = real;
    }

    const names = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(names.includes('gt:wlclean:safe.com'),
      `yarim kalan istisna icin devam alarmi kurulmali; kurulanlar: ${names.join(', ') || '(yok)'}`);
    assert.ok(chromeStub._state.history.length > 0, 'is gercekten yarim kalmis olmali');
  });

  test('is tamamlanirsa devam alarmi kurulmaz', async () => {
    await reset({
      history: [makeHistoryItem('https://safe.com/a')],
      tabs: [],
      rules: WHITE,
      settings: { whitelistCleanHistory: true, cleanDelay: 0 }
    });

    await chrome.alarms.onAlarm._fire({ name: 'gt:wlclean:safe.com' });
    await settle(150);

    const names = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(!names.includes('gt:wlclean:safe.com'), 'gereksiz devam alarmi olmamali');
    assert.equal(chromeStub._state.history.length, 0, 'gecmis tamamen silinmeli');
  });
});

describe('icerik script kaydi: zaten kayitliysa uyari degil GERI DOLDURMA', () => {
  // BULGU (gercek Chrome 151, canli log): eklenti yuklendikten sonra
  //   WARN "Icerik script'i kaydi guncellenemedi: Duplicate script ID
  //         'ghosttrace-trace-observer'"
  //
  // Kayit persistAcrossSessions:true ile yapiliyor, yani eklenti yeniden
  // yuklendiginde tarayici surecinde SAKLI kalir. getRegisteredContentScripts
  // bu kayit geri yuklenmeden once sorulursa BOS doner; kod da "kayit yok"
  // sanip registerContentScripts cagirir ve Duplicate alir.
  //
  // Zarari uyarinin kendisi degil: catch'e dusuldugu icin hemen ardindaki
  //   await backfillObserverIntoOpenTabs()
  // satirina HIC gelinmez. Kayit yalnizca SONRAKI sayfa yuklemelerine uygular,
  // yani o an ACIK olan sekmelerde 3. taraf tespiti hic baslamaz -> o CDN'ler
  // haritaya girmez -> sekme kapaninca temizlenmez. Tam da eklenti
  // guncellemesinden sonraki ilk oturum, yani en cok acik sekmenin oldugu an.

  const SCRIPT_ID = 'ghosttrace-trace-observer';

  const warnings = async () => (await logger.getLogs())
    .filter(l => l.level === 'WARN' && /kaydi guncellenemedi/i.test(l.message))
    .map(l => l.message.slice(0, 90));

  test('sakli kayit gorunmezken tekrar kayit denemesi UYARI uretmez', async () => {
    await reset({
      settings: { logLevel: 'info', enabled: true, trackThirdParty: true },
      tabs: [{ id: 1, url: 'https://haber.com/', active: true }]
    });

    // Kayit tarayicida VAR ama sorgu henuz gormuyor (geri yukleme penceresi).
    chrome.scripting._registered.set(SCRIPT_ID, { id: SCRIPT_ID });
    chrome.scripting._hideRegistrations = true;

    await observer.syncContentScriptRegistration({ backfillOpenTabs: true });
    await settle(40);

    assert.deepEqual(await warnings(), [],
      'sakli kayit Duplicate uretmemeli; bu hal beklenen bir hal');
  });

  test('sakli kayit durumunda ACIK sekmeler geri doldurulur', async () => {
    await reset({
      settings: { logLevel: 'info', enabled: true, trackThirdParty: true },
      tabs: [
        { id: 1, url: 'https://haber.com/', active: true },
        { id: 2, url: 'https://baska.com/', active: false }
      ]
    });

    chrome.scripting._registered.set(SCRIPT_ID, { id: SCRIPT_ID });
    chrome.scripting._hideRegistrations = true;

    await observer.syncContentScriptRegistration({ backfillOpenTabs: true });
    await settle(40);

    // Asil zarar burada: enjeksiyon hic denenmezse acik sekmelerde tespit yok.
    const injected = chrome.scripting._executed || [];
    assert.ok(injected.length > 0,
      `Duplicate'e dusen yol geri doldurmayi atlar; acik sekmelere enjeksiyon denenmeli (denenen: ${injected.length})`);
  });

  test('gercekten kayitli degilse normal kayit yolu bozulmaz', async () => {
    await reset({ settings: { logLevel: 'info', enabled: true, trackThirdParty: true } });

    await observer.syncContentScriptRegistration();
    await settle(40);

    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    assert.equal(registered.length, 1, 'temiz durumda kayit yapilmali');
    assert.deepEqual(await warnings(), []);
  });

  test('takip kapaliysa kayit KALMAZ', async () => {
    await reset({ settings: { logLevel: 'info', enabled: true, trackThirdParty: true } });
    await observer.syncContentScriptRegistration();
    await settle(20);

    await chrome.storage.local.set({ trackThirdParty: false });
    storage.__resetCacheForTests();
    await observer.syncContentScriptRegistration();
    await settle(40);

    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    assert.equal(registered.length, 0,
      'kullanici kapattiysa kayit kalmamali - aksi halde kapali sanir ama kod calisir');
  });
});

describe('teshis yaniti: oturum bellegi kotasi da bildirilir', () => {
  // Kota arayuzde SABIT GOMULU olamaz: tarayici surumune gore degisebilir ve
  // yanlis bir sabit "doluluk" hesabini sessizce yanlislar. Isleyici degeri
  // chrome.storage.session.QUOTA_BYTES'tan CALISMA ANINDA okur; API o alani
  // sunmuyorsa null doner ve arayuz eski davranisa duser.

  test('QUOTA_BYTES varsa yanitta sessionQuota doner', async () => {
    await reset();
    const response = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.equal(typeof response.sessionQuota, 'number',
      'kota okunabiliyorsa sayi olarak donmeli');
    assert.ok(response.sessionQuota > 0, 'kota pozitif olmali');
  });

  test('QUOTA_BYTES yoksa sessionQuota null olur, uydurulmaz', async () => {
    await reset();
    const kayitli = chrome.storage.session.QUOTA_BYTES;
    delete chrome.storage.session.QUOTA_BYTES;
    try {
      const response = await sendMessage({ action: Action.GET_DIAGNOSTICS });
      assert.equal(response.sessionQuota, null,
        'API kota sunmuyorsa sabit gomulmemeli');
    } finally {
      chrome.storage.session.QUOTA_BYTES = kayitli;
    }
  });

  test('gecersiz QUOTA_BYTES degeri null sayilir', async () => {
    await reset();
    const kayitli = chrome.storage.session.QUOTA_BYTES;
    chrome.storage.session.QUOTA_BYTES = 0;
    try {
      const response = await sendMessage({ action: Action.GET_DIAGNOSTICS });
      assert.equal(response.sessionQuota, null,
        'sifir ya da anlamsiz kota yuzde hesabini bozar; null saymak dogru');
    } finally {
      chrome.storage.session.QUOTA_BYTES = kayitli;
    }
  });

  test('indirme silme izni de yanitta duruyor', async () => {
    await reset();
    const response = await sendMessage({ action: Action.GET_DIAGNOSTICS });
    assert.ok('downloadsRemovalPermitted' in response,
      'arayuzun gosterebilmesi icin yanitta bulunmali');
  });
});

describe('kisitli site erisimi TUM temizlik yollarinda gorunur (v2.7.0)', () => {
  // Kontrol motorun tek girisinde (purgeDomain) duruyor. Bu blok, o kararin
  // cagri yerlerine DOGRU sekilde yansidigini olcuyor: kullaniciya "temizlendi"
  // denmemeli ve 3. taraf kaydi DUSURULMEMELI - kayit, o alan adinda hala veri
  // bulundugunun tek sinyali.

  test('mesaj isleyicisi basari raporlamaz', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'ornek.com' })],
      revokedOrigins: ['https://ornek.com/']
    });

    const response = await sendMessage({ action: Action.PURGE_DOMAIN, domain: 'ornek.com' });

    assert.equal(response.success, false, 'yapilmamis temizlik basarili donmemeli');
    assert.equal(response.error, 'NO_HOST_ACCESS');
    assert.equal(chromeStub._state.cookies.length, 1, 'veri yerinde durmali');
  });

  test('klavye kisayolu "temizlendi" bildirimi GOSTERMEZ', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'ornek.com' })],
      tabs: [{ id: 1, url: 'https://ornek.com/', active: true, incognito: false }],
      revokedOrigins: ['https://ornek.com/'],
      settings: { notifyOnClean: true }
    });

    await chrome.commands.onCommand._fire('quick-purge-current');
    await settle(40);

    const cleaned = chromeStub._state.notifications
      .filter(n => /temizlendi|cleaned/i.test(`${n.title} ${n.message}`));
    assert.equal(cleaned.length, 0,
      `yapilmamis temizlik bildirilmemeli; bildirimler: ${JSON.stringify(chromeStub._state.notifications)}`);
  });

  test('yetim taramasi kaydi DUSURMEZ', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'cdn.com' })],
      tabs: [],
      settings: { cleanDelay: 0 },
      revokedOrigins: ['https://cdn.com/']
    });
    const sessionState = await import('../lib/session-state.js');
    await sessionState.recordThirdParty('haber.com', ['cdn.com']);

    const { sweepOrphanDomains } = await import('../lib/sw/sweep.js');
    await sweepOrphanDomains({ force: true });
    await settle(20);

    const map = await sessionState.getThirdPartyMap();
    assert.ok(map['cdn.com'],
      'temizlenemeyen alan adinin kaydi silinmemeli; yoksa o veriye bir daha ulasilamaz');
  });

  test('erisim VARKEN kayit normal sekilde dusurulur', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'cdn.com' })],
      tabs: [],
      settings: { cleanDelay: 0 }
    });
    const sessionState = await import('../lib/session-state.js');
    await sessionState.recordThirdParty('haber.com', ['cdn.com']);

    const { sweepOrphanDomains } = await import('../lib/sw/sweep.js');
    await sweepOrphanDomains({ force: true });
    await settle(20);

    const map = await sessionState.getThirdPartyMap();
    assert.equal(map['cdn.com'], undefined, 'temizlenen alan adinin kaydi dusmeli');
  });
});

describe('iframe 3. taraf izleme: opsiyonel, varsayilan KAPALI (v2.7.0)', () => {
  // Resource Timing tamponu YALNIZCA kendi cercevesinin kaynaklarini tasir.
  // allFrames:false iken bir reklam iframe'inin yukledigi izleyiciler haritaya
  // HIC girmiyor, dolayisiyla hic temizlenmiyordu. Acmak bedava degil: reklam
  // yogun bir sayfada onlarca script ornegi demek. Bu yuzden ayara bagli.

  const registered = () => chrome.scripting._registered.get('ghosttrace-trace-observer');

  test('ayar KAPALIYKEN kayit yalnizca ust cerceve', async () => {
    await reset({ settings: { trackThirdParty: true, trackThirdPartyFrames: false } });
    await observer.syncContentScriptRegistration();
    await settle(20);

    assert.equal(registered()?.allFrames, false,
      'ayar kapaliyken yalnizca ust cerceve izlenmeli');
  });

  test('VARSAYILAN kayit tum cerceveleri kapsar (v2.7.0)', async () => {
    // Ayar hic yazilmamis: varsayilan devrede olmali. iframe reklamlarin
    // izleyicileri ust cerceveden GORUNMEZ, gorunmeyen de temizlenmez.
    await reset({ settings: { trackThirdParty: true } });
    await observer.syncContentScriptRegistration();
    await settle(20);

    assert.equal(registered()?.allFrames, true,
      'varsayilan olarak iframe icleri de izlenmeli');
  });

  test('ayar ACIKKEN kayit tum cerceveleri kapsar', async () => {
    await reset({ settings: { trackThirdParty: true, trackThirdPartyFrames: true } });
    await observer.syncContentScriptRegistration();
    await settle(20);

    assert.equal(registered()?.allFrames, true);
  });

  test('ayar degisince kayit YENIDEN kurulur', async () => {
    await reset({ settings: { trackThirdParty: true, trackThirdPartyFrames: false } });
    await observer.syncContentScriptRegistration();
    await settle(20);
    assert.equal(registered()?.allFrames, false);

    await chrome.storage.local.set({ trackThirdPartyFrames: true });
    await settle(40);

    assert.equal(registered()?.allFrames, true,
      'ayar degistiginde kayit guncellenmeli; yoksa secim bir sonraki tarayici acilisina kadar etkisiz kalir');
  });

  test('geri doldurma da ayni kapsami kullanir', async () => {
    await reset({
      settings: { trackThirdParty: true, trackThirdPartyFrames: true },
      tabs: [{ id: 7, url: 'https://haber.com/', active: true, incognito: false }]
    });

    await observer.backfillObserverIntoOpenTabs();
    await settle(20);

    const injection = chrome.scripting._executed.find(e => e.tabId === 7);
    assert.ok(injection, 'acik sekmeye enjeksiyon yapilmali');
    assert.equal(injection.allFrames, true,
      'kayit ile geri doldurma AYNI kapsami kullanmali; sapma "acikta calisiyor kapalida calismiyor" uretir');
  });

  test('kapaliyken geri doldurma ust cerceveyle sinirli', async () => {
    await reset({
      settings: { trackThirdParty: true, trackThirdPartyFrames: false },
      tabs: [{ id: 8, url: 'https://haber.com/', active: true, incognito: false }]
    });

    await observer.backfillObserverIntoOpenTabs();
    await settle(20);

    const injection = chrome.scripting._executed.find(e => e.tabId === 8);
    assert.equal(injection.allFrames, false);
  });
});

describe('GIZLI PENCERE normal profile SIZMAZ (kullanici bildirimi)', () => {
  // Bildirilen hata: gizli pencerede bir site acilip kapatilinca NORMAL
  // profildeki ayni sitenin verisi siliniyordu. Sebep: service worker
  // (spanning modda) normal profilin cerez baglaminda calisir ama
  // chrome.tabs.query({}) gizli sekmeleri DE dondurur.
  //
  // v2.4.0 bunu duzelttigini soyluyordu ama HICBIR TEST bu senaryoyu
  // olcmuyordu - yalnizca rozet ve popup tarafi kapsanmisti. Asagidakiler
  // tam olarak bildirilen davranisi sinar.

  const gizliSekme = (id, url) => ({ id, url, active: true, incognito: true });
  const normalSekme = (id, url) => ({ id, url, active: true, incognito: false });

  test('GIZLI sekme kapaninca NORMAL profil verisi SILINMEZ', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'ornek.com' })],
      tabs: [gizliSekme(7, 'https://ornek.com/')],
      settings: { cleanDelay: 0 }
    });

    // Gizli sekme once olusur, sonra kapanir - gercek akisin aynisi.
    await chrome.tabs.onCreated._fire(gizliSekme(7, 'https://ornek.com/'));
    await settle(30);
    await chrome.tabs.onRemoved._fire(7);
    await settle(120);

    assert.equal(chromeStub._state.cookies.length, 1,
      'gizli sekmenin kapanmasi NORMAL profildeki veriyi silmemeli');
  });

  test('GIZLI sekme, sekme haritasina HIC girmez', async () => {
    await reset({ tabs: [], settings: { cleanDelay: 0 } });
    await chrome.tabs.onCreated._fire(gizliSekme(8, 'https://ornek.com/'));
    await settle(50);

    const harita = await chrome.storage.session.get('gt_tabMap');
    assert.deepEqual(harita.gt_tabMap || {}, {},
      'gizli sekme haritaya yazilmamali; yazilirsa kapanisinda temizlik tetikler');
  });

  test('GIZLI sekme ACIK diye NORMAL temizligi ENGELLEMEZ', async () => {
    // Ters yon: gizli pencerede ayni site acik oldugu icin normal profildeki
    // temizlik iptal edilmemeli.
    await reset({
      cookies: [makeCookie({ domain: 'ornek.com' })],
      tabs: [gizliSekme(9, 'https://ornek.com/'), normalSekme(10, 'https://ornek.com/')],
      settings: { cleanDelay: 0 }
    });

    await chrome.tabs.onCreated._fire(normalSekme(10, 'https://ornek.com/'));
    await settle(30);
    // Normal sekme kapaniyor; geride YALNIZCA gizli sekme kaliyor.
    chromeStub._state.tabs = chromeStub._state.tabs.filter(t => t.id !== 10);
    await chrome.tabs.onRemoved._fire(10);
    await settle(200);

    assert.equal(chromeStub._state.cookies.length, 0,
      'geride yalnizca gizli sekme kaldiysa temizlik YAPILMALI');
  });

  test('GIZLI sekmeden gelen 3. taraf raporu REDDEDILIR', async () => {
    await reset({ tabs: [], settings: { trackThirdParty: true } });
    const yanit = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, parent: 'haber.com', hosts: ['izleyici.com'] },
      { tab: { id: 11, url: 'https://haber.com/', incognito: true } }
    );

    assert.equal(yanit.success, false, 'gizli gezintinin 3. taraflari kabul edilmemeli');
    const harita = await chrome.storage.session.get('gt_thirdParty');
    assert.deepEqual(harita.gt_thirdParty || {}, {},
      'gizli gezinti normal profil haritasina yazilmamali');
  });

  test('NORMAL sekmeden gelen 3. taraf raporu KABUL edilir', async () => {
    await reset({ tabs: [], settings: { trackThirdParty: true } });
    const yanit = await sendMessage(
      { action: Action.REPORT_THIRD_PARTY, parent: 'haber.com', hosts: ['izleyici.com'] },
      { tab: { id: 12, url: 'https://haber.com/', incognito: false } }
    );

    assert.equal(yanit.success, true, 'normal gezinti kabul edilmeli');
    const harita = await chrome.storage.session.get('gt_thirdParty');
    assert.ok(harita.gt_thirdParty['izleyici.com'], 'kayit olusmali');
  });

  test('GIZLI sekmeden gelen depolama olcumu REDDEDILIR', async () => {
    await reset({ tabs: [], settings: { trackThirdParty: true } });
    const yanit = await sendMessage(
      { action: Action.REPORT_STORAGE_ESTIMATE, usage: 5_000_000 },
      { tab: { id: 13, url: 'https://ornek.com/', incognito: true } }
    );

    assert.equal(yanit.success, false, 'gizli olcum kabul edilmemeli');
    const olcumler = await chrome.storage.session.get('gt_storageEstimates');
    assert.deepEqual(olcumler.gt_storageEstimates || {}, {}, 'kayit olusmamali');
  });

  test('GIZLI sekmeye gozlemci ENJEKTE EDILMEZ', async () => {
    await reset({
      tabs: [gizliSekme(14, 'https://gizli.com/'), normalSekme(15, 'https://normal.com/')],
      settings: { trackThirdParty: true }
    });
    chrome.scripting._executed.length = 0;

    await observer.backfillObserverIntoOpenTabs();
    await settle(50);

    const hedefler = chrome.scripting._executed.map(e => e.tabId);
    assert.ok(!hedefler.includes(14), 'gizli sekmeye enjeksiyon yapilmamali');
    assert.ok(hedefler.includes(15), 'normal sekmeye enjeksiyon yapilmali');
  });
});

describe('GIZLI PENCERE sizintisinin DIGER iki kapisi (kod incelemesi)', () => {
  // Gizli sekme korumasi onCreated/onUpdated yolunda vardi ama iki giris
  // noktasi ATLANMISTI. Ikisi de sekme haritasina gizli URL yaziyor; harita
  // kapanista temizlik tetikledigi icin sonuc bildirilen hatanin aynisi:
  // gizli sekme kapaninca NORMAL profil verisi siliniyor.

  test('reconcileTabMap gizli sekmeyi haritaya YAZMAZ', async () => {
    // Bu yol her tarayici acilisinda ve storage.session her temizlendiginde
    // calisiyor (lightBootstrap -> harita bossa yeniden kur).
    await reset({
      tabs: [
        { id: 21, url: 'https://gizli.com/', active: true, incognito: true },
        { id: 22, url: 'https://normal.com/', active: true, incognito: false }
      ]
    });
    const sessionState = await import('../lib/session-state.js');
    const domain = await import('../lib/domain.js');

    await sessionState.reconcileTabMap(domain.isInternalUrl);

    const harita = await sessionState.getTabMap();
    const urller = Object.values(harita);
    assert.ok(!urller.some(u => String(u).includes('gizli.com')),
      `gizli sekme haritaya girmemeli; harita: ${JSON.stringify(harita)}`);
    assert.ok(urller.some(u => String(u).includes('normal.com')),
      'normal sekme haritada olmali');
  });

  test('reconcile sonrasi gizli sekme kapanisi NORMAL veriyi silmez', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'gizli.com' })],
      tabs: [{ id: 23, url: 'https://gizli.com/', active: true, incognito: true }],
      settings: { cleanDelay: 0 }
    });
    const sessionState = await import('../lib/session-state.js');
    const domain = await import('../lib/domain.js');
    await sessionState.reconcileTabMap(domain.isInternalUrl);

    chromeStub._state.tabs = [];
    await chrome.tabs.onRemoved._fire(23);
    await settle(200);

    assert.equal(chromeStub._state.cookies.length, 1,
      'gizli sekmenin kapanmasi NORMAL profildeki veriyi silmemeli');
  });

  test('onReplaced gizli sekmeyi haritaya YAZMAZ', async () => {
    // Prerender/onceden yukleme aktiflesince onReplaced tetiklenir.
    await reset({
      tabs: [{ id: 24, url: 'https://gizli.com/', active: true, incognito: true }]
    });
    await chrome.tabs.onReplaced._fire(24, 99);
    await settle(80);

    const sessionState = await import('../lib/session-state.js');
    const harita = await sessionState.getTabMap();
    assert.ok(!Object.values(harita).some(u => String(u).includes('gizli.com')),
      `onReplaced gizli sekmeyi yazmamali; harita: ${JSON.stringify(harita)}`);
  });
});

describe('yetim taramasi: KOK korumaliysa alt alan adi kor noktada kalmamali', () => {
  // Tarama adaylari kayit edilebilir KOKE indirgiyor. Kullanici ornek.com'u
  // "yalnizca bu adres" kapsamiyla beyaz listeye aldiysa kok korumali olur ve
  // aday listesinden dusulur - ama o kullanici tam da alt alan adlarinin
  // TEMIZLENMESINI istedigi icin dar kapsam secmisti. Emniyet agi sessizce
  // ads.ornek.com'u disarida birakiyordu.

  test('KOK "yalnizca bu adres" ise alt alan adi yine de taranir', async () => {
    await reset({
      cookies: [
        makeCookie({ name: 'korunan', domain: 'ornek.com' }),
        makeCookie({ name: 'temizlenmeli', domain: 'ads.ornek.com' })
      ],
      tabs: [],
      rules: { 'ornek.com': whiteRule('ornek.com', { subdomains: false }) },
      settings: { cleanDelay: 0 }
    });

    const { sweepOrphanDomains } = await import('../lib/sw/sweep.js');
    await sweepOrphanDomains({ force: true });
    await settle(300);

    const kalan = chromeStub._state.cookies.map(c => c.name).sort();
    assert.deepEqual(kalan, ['korunan'],
      `korumasiz alt alan adi taramada yakalanmali; kalan: ${kalan.join(', ')}`);
  });

  test('KOK genis kapsamliysa alt alan adi KORUNUR', async () => {
    await reset({
      cookies: [
        makeCookie({ name: 'kok', domain: 'ornek.com' }),
        makeCookie({ name: 'alt', domain: 'ads.ornek.com' })
      ],
      tabs: [],
      rules: { 'ornek.com': whiteRule('ornek.com', { subdomains: true }) },
      settings: { cleanDelay: 0 }
    });

    const { sweepOrphanDomains } = await import('../lib/sw/sweep.js');
    await sweepOrphanDomains({ force: true });
    await settle(300);

    assert.equal(chromeStub._state.cookies.length, 2,
      'genis kapsamda ikisi de korunmali');
  });
});

describe('toplu temizlik sonrasi 3. taraf kaydi: TEMIZLENMEYEN dusurulmemeli', () => {
  // Kayit, o alan adinda hala veri bulundugunun TEK sinyali (Chrome origin
  // listeleme API'si vermiyor). Yetim taramasi bu ilkeye uyuyor: butceye
  // takilanin ve erisilemeyenin kaydini dusurmuyor.
  //
  // settleBulkPurge ise haritayi KOMPLE siliyordu. Acik sekme korumasi
  // eklenince bu bir sizinti oldu: atlanan site temizlenmedi ama kaydi gitti.
  // Beyaz listedeki bir 3. taraf icin de ayni sorun ZATEN vardi.

  const harita = () => chrome.storage.session.get('gt_thirdParty')
    .then(d => Object.keys(d.gt_thirdParty || {}).sort());

  test('ACIK sekmeli sitenin kaydi KORUNUR, temizlenenin dusulur', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'acik.com' }), makeCookie({ domain: 'kapali.com' })],
      tabs: [{ id: 1, url: 'https://acik.com/', active: true, incognito: false }],
      settings: { cleanDelay: 0 }
    });
    const sessionState = await import('../lib/session-state.js');
    await sessionState.recordThirdParty('haber.com', ['acik.com']);
    await sessionState.recordThirdParty('haber.com', ['kapali.com']);

    const { purgeAllNonWhitelisted } = await import('../lib/purge/index.js');
    const { settleBulkPurge } = await import('../lib/sw/scheduler.js');
    const sonuc = await purgeAllNonWhitelisted();
    await settleBulkPurge(sonuc);
    await settle(80);

    const kalan = await harita();
    assert.ok(kalan.includes('acik.com'),
      `atlanan sitenin kaydi durmali; kalan: ${kalan.join(', ') || '(bos)'}`);
    assert.ok(!kalan.includes('kapali.com'),
      `temizlenen sitenin kaydi dusmeli; kalan: ${kalan.join(', ')}`);
  });

  test('BEYAZ LISTEDEKI 3. tarafin kaydi da KORUNUR', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'cdn.com' })],
      tabs: [],
      rules: { 'cdn.com': whiteRule('cdn.com') },
      settings: { cleanDelay: 0 }
    });
    const sessionState = await import('../lib/session-state.js');
    await sessionState.recordThirdParty('haber.com', ['cdn.com']);

    const { purgeAllNonWhitelisted } = await import('../lib/purge/index.js');
    const { settleBulkPurge } = await import('../lib/sw/scheduler.js');
    await settleBulkPurge(await purgeAllNonWhitelisted());
    await settle(80);

    const kalan = await harita();
    assert.ok(kalan.includes('cdn.com'),
      `beyaz listedeki 3. tarafin kaydi durmali (verisi silinmedi); kalan: ${kalan.join(', ') || '(bos)'}`);
  });
});

describe('secili site temizligi: ATLANANIN kaydi dusurulmemeli', () => {
  // Ayni ilke: kayit, o alan adinda hala veri bulundugunun tek sinyali.
  // Korumali oldugu icin atlanan bir site temizlenmedi - kaydini silmek o
  // veriye ulasmanin tek yolunu yok etmek olur.

  test('korumali site atlanir ama kaydi KORUNUR', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'temiz.com' }), makeCookie({ domain: 'korumali.com' })],
      tabs: [],
      rules: { 'korumali.com': whiteRule('korumali.com') },
      settings: { cleanDelay: 0 }
    });
    const sessionState = await import('../lib/session-state.js');
    await sessionState.recordThirdParty('haber.com', ['temiz.com']);
    await sessionState.recordThirdParty('haber.com', ['korumali.com']);

    const sonuc = await sendMessage({
      action: Action.PURGE_SELECTED_DOMAINS, domains: ['temiz.com', 'korumali.com']
    });
    await settle(120);

    assert.equal(sonuc.skippedProtected, 1, 'korumali site atlanmali');
    const d = await chrome.storage.session.get('gt_thirdParty');
    const kalan = Object.keys(d.gt_thirdParty || {}).sort();
    assert.ok(kalan.includes('korumali.com'),
      `atlanan korumali sitenin kaydi durmali; kalan: ${kalan.join(', ') || '(bos)'}`);
    assert.ok(!kalan.includes('temiz.com'),
      `temizlenen sitenin kaydi dusmeli; kalan: ${kalan.join(', ')}`);
  });
});

describe('GET_ACTIVE_TAB_INFO: genel ayarlar HER dalda donmeli', () => {
  // enabled ve cleanDelay sekmeye degil GENEL ayarlara ait. Erken donusler
  // bunlari atlayinca popup `info.enabled !== false` ile undefined okuyor ve
  // ACIK gosteriyor: kullanici chrome://newtab uzerinde popup'i actiginda
  // otomatik temizleme KAPALI oldugu halde anahtar acik gorunuyor.
  // cleanDelay yoklugu da rozete ham `{delay}s bekleme` sablonunu basiyor.

  test('tarayici ici sayfada enabled ve cleanDelay yine gelir', async () => {
    await reset({
      tabs: [{ id: 1, url: 'chrome://newtab', active: true }],
      settings: { enabled: false, cleanDelay: 90 }
    });
    const r = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });

    assert.equal(r.isInternal, true, 'dahili sayfa isaretlenmeli');
    assert.equal(r.enabled, false,
      `otomatik temizleme KAPALI raporlanmali, gelen: ${JSON.stringify(r.enabled)}`);
    assert.equal(typeof r.cleanDelay, 'number',
      `cleanDelay sayi olmali, gelen: ${JSON.stringify(r.cleanDelay)}`);
  });

  test('gizli pencerede de enabled ve cleanDelay gelir', async () => {
    await reset({
      tabs: [{ id: 1, url: 'https://ornek.com/', active: true, incognito: true }],
      settings: { enabled: false, cleanDelay: 90 }
    });
    const r = await sendMessage({ action: Action.GET_ACTIVE_TAB_INFO });

    assert.equal(r.isIncognito, true, 'gizli pencere isaretlenmeli');
    assert.equal(r.enabled, false, 'otomatik temizleme KAPALI raporlanmali');
    assert.equal(typeof r.cleanDelay, 'number', 'cleanDelay sayi olmali');
  });
});

describe('YETIM SUPURMESI kisitlaninca ERTELENMELI (v2.7.0)', () => {
  // GERCEK KULLANIM BULGUSU: kullanici butun sekmelerini arka arkaya kapatti.
  // Supurme ilk kapanista kostu, kalan dokuz kapanis 5 dakikalik kisitlamaya
  // takildi ve HIC kosmadi. Kapatacak baska sekme kalmadigi icin emniyet agini
  // tetikleyecek hicbir olay da kalmadi: sekme kapanisi yolunun goremedigi
  // seyler (bir sitenin YUKLEDIGI 3. taraflar, ust alan adi cerezleri)
  // tarayici yeniden baslatilana ya da kullanici elle "Tumunu Temizle"
  // diyene kadar durdu.
  //
  // Kisitlama dogru; SESSIZCE IPTAL etmek yanlis. Erteleme sart.

  test('kisitlama devredeyken supurme icin ALARM kurulur', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'yetim.com' })],
      tabs: [],
      settings: { enabled: true }
    });

    // Ilk supurme: slot alinir, alarm gerekmez.
    await sweep.sweepOrphanDomains({});
    const ilkAlarmlar = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(!ilkAlarmlar.includes('gt:sweepRetry'),
      `ilk supurmede erteleme alarmi olmamali; alarmlar: ${ilkAlarmlar.join(', ')}`);

    // Hemen ardindan ikinci cagri: kisitlamaya takilir.
    const sonuc = await sweep.sweepOrphanDomains({});
    assert.equal(sonuc.throttled, true, 'ikinci cagri kisitlanmali');

    const alarmlar = (await chrome.alarms.getAll()).map(a => a.name);
    assert.ok(alarmlar.includes('gt:sweepRetry'),
      `kisitlanan supurme ERTELENMELI; kurulan alarmlar: ${alarmlar.join(', ') || '(yok)'}`);
  });

  test('erteleme alarmi ZATEN varsa yenisi kurulmaz', async () => {
    await reset({ cookies: [], tabs: [], settings: { enabled: true } });
    await sweep.sweepOrphanDomains({});
    await sweep.sweepOrphanDomains({});
    await sweep.sweepOrphanDomains({});
    await sweep.sweepOrphanDomains({});

    const alarmlar = (await chrome.alarms.getAll()).filter(a => a.name === 'gt:sweepRetry');
    assert.equal(alarmlar.length, 1,
      `tek erteleme alarmi olmali, bulunan: ${alarmlar.length}`);
  });

  test('erteleme alarmi tetiklenince supurme GERCEKTEN kosar', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'yetim2.com' })],
      tabs: [],
      settings: { enabled: true, cleanDelay: 0 }
    });
    await sweep.sweepOrphanDomains({});
    await sweep.sweepOrphanDomains({});   // kisitlandi -> alarm kuruldu

    // Kisitlama penceresi gecmis gibi yap ve alarmi tetikle.
    await chrome.storage.session.set({ gt_lastSweep: 0 });
    await chrome.alarms._fire('gt:sweepRetry');
    await settle(120);

    // Alarm kendini tuketmeli (tekrar tekrar birikmesin).
    const kalan = (await chrome.alarms.getAll()).filter(a => a.name === 'gt:sweepRetry');
    assert.equal(kalan.length, 0,
      'tetiklenen erteleme alarmi kendini temizlemeli');
  });
});

describe('ALT ALAN ADI kapaninca UST alan adi da temizlenir (v2.7.0)', () => {
  // GERCEK KULLANIM BULGUSU: kullanici forum.mobilism.org'u ziyaret etti ve
  // kapatti. Sekme kapanisi yolu `forum.mobilism.org` kapsamini temizledi
  // ama cerez `.mobilism.org` uzerindeydi ve KALDI - ekran goruntusunde
  // "mobilism.org | Ana Site | 1 cerez | Izin Verilmeyen" olarak duruyordu.
  //
  // MEKANIZMA (olculdu): bunu sekme kapanisi yolu DEGIL, ayni olayda kosan
  // YETIM SUPURMESI yapiyor - o kok alan adini hedefliyor (selectPurgeTarget
  // -> getRootDomain). Sekme kapanisi yolu yalnizca ziyaret edilen host'u
  // temizler ve bu dogru: kapsam yukari genislemez.
  //
  // Kullanicinin oturumunda cerezin kalmasinin sebebi supurmenin 5 dakikalik
  // KISITLAMAYA takilip sessizce iptal edilmesiydi; bkz. erteleme testleri.
  // Bu test o zinciri butun halinde koruyor.
  //
  // Kural korumasi degismez: kok korumaliysa koke dokunulmaz.

  test('alt alan adi kapaninca UST alan adinin cerezi de silinir', async () => {
    await reset({
      cookies: [
        makeCookie({ domain: '.mobilism.org', name: 'ust' }),
        makeCookie({ domain: 'forum.mobilism.org', name: 'alt', hostOnly: true })
      ],
      tabs: [{ id: 7, url: 'https://forum.mobilism.org/', active: true }],
      settings: { cleanDelay: 0 }
    });

    // Sekme haritasina KAYDET: kapanista host ancak buradan cozuluyor.
    await chrome.tabs.onCreated._fire({ id: 7, url: 'https://forum.mobilism.org/' });
    await settle(30);
    chromeStub._state.tabs = chromeStub._state.tabs.filter(t => t.id !== 7);
    await chrome.tabs.onRemoved._fire(7);
    await settle(200);

    const kalan = await chrome.cookies.getAll({});
    assert.equal(kalan.length, 0,
      `ust alan adinin cerezi de silinmeli; kalan: ${kalan.map(c => c.domain + '|' + c.name).join(', ')}`);
  });

  test('KOK KORUMALIYSA koke dokunulmaz, yalnizca alt alan adi temizlenir', async () => {
    await reset({
      cookies: [
        makeCookie({ domain: '.mobilism.org', name: 'ust' }),
        makeCookie({ domain: 'forum.mobilism.org', name: 'alt', hostOnly: true })
      ],
      tabs: [{ id: 8, url: 'https://forum.mobilism.org/', active: true }],
      rules: { 'mobilism.org': whiteRule('mobilism.org') },
      settings: { cleanDelay: 0 }
    });

    // Sekme haritasina KAYDET: kapanista host ancak buradan cozuluyor.
    await chrome.tabs.onCreated._fire({ id: 8, url: 'https://forum.mobilism.org/' });
    await settle(30);
    chromeStub._state.tabs = chromeStub._state.tabs.filter(t => t.id !== 8);
    await chrome.tabs.onRemoved._fire(8);
    await settle(200);

    const kalan = await chrome.cookies.getAll({});
    const ustVar = kalan.some(c => c.domain === '.mobilism.org');
    assert.ok(ustVar,
      `korumali kokun cerezi DURMALI; kalan: ${kalan.map(c => c.domain).join(', ') || '(bos)'}`);
  });
});

describe('KORUMASIZ OTURUM tespiti (v2.7.0)', () => {
  // Kurallar sayfasi bosken, kullanicinin GIRIS YAPMIS oldugu ama korumada
  // OLMAYAN siteleri gostermek icin gerekli sinyal. En sik yasanan sorun bu:
  // farkinda olmadan oturum kaybetmek.
  //
  // GONDERILEN SEY YALNIZCA BOOLE. Cerez adi ya da degeri arayuze cikmaz -
  // "cerez degeri asla sizmaz" guvencesi bu ozellikle de bozulmamali.

  test('oturum cerezi olan site hasSessionCookie: true bildirir', async () => {
    await reset({
      cookies: [
        makeCookie({ domain: 'github.com', name: 'user_session' }),
        makeCookie({ domain: 'izleyici.com', name: '_ga' })
      ],
      tabs: []
    });

    const r = await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS });
    const github = r.domains.find(d => d.domain === 'github.com');
    const izleyici = r.domains.find(d => d.domain === 'izleyici.com');

    assert.equal(github?.hasSessionCookie, true,
      `giris cerezi olan site isaretlenmeli; gelen: ${JSON.stringify(github)}`);
    assert.equal(izleyici?.hasSessionCookie, false,
      'izleme cerezi oturum sayilmamali');
  });

  test('cerez ADI ve DEGERI arayuze SIZMAZ', async () => {
    await reset({
      cookies: [makeCookie({ domain: 'github.com', name: 'user_session', value: 'COK-GIZLI' })],
      tabs: []
    });

    const r = await sendMessage({ action: Action.GET_ALL_STORED_DOMAINS });
    const metin = JSON.stringify(r);
    assert.ok(!metin.includes('COK-GIZLI'), 'cerez DEGERI sizmamali');
    assert.ok(!metin.includes('user_session'), 'cerez ADI da sizmamali');
  });
});

describe('sag tik menusu: es zamanli kurulum YARISI', () => {
  // GERCEK KULLANIMDA BULUNDU. Kullanici ayari acinca gunluge su dusuyordu:
  //   WARN  Sag tik menusu guncellenemedi: Cannot find menu item with id gt:menu:root
  // ...ama menu yine de dogru kuruluyordu ("uyari veriyor ama aktif de oluyor").
  //
  // Sebep: AYNI ayar yazmasi isi IKI yoldan tetikliyor - SETTINGS_CHANGED
  // isleyicisi dogrudan cagiriyor, o yazma da storage.onChanged'i tetikleyip
  // dinleyiciye cagirtiyor. Paralel kostuklarinda biri digerinin yeni kurdugu
  // koku removeAll ile siliyor, oteki alt oge yaratmaya calisirken patliyor.
  // Son kosan tamamladigi icin sonuc dogru gorunuyor; hata yalnizca gunlukte.
  //
  // Ayni desen icerik script'i kaydinda (lib/sw/observer.js) zaten zincirle
  // cozulmustu; menu tarafina uygulanmamisti.

  const menuIds = () => [...chrome.contextMenus._items.keys()].sort();

  test('iki es zamanli kurulum uyari URETMEZ ve menuyu TAM kurar', async () => {
    await reset({ settings: { contextMenuEnabled: true, logLevel: 'info' } });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    storage.__resetCacheForTests();

    const { syncContextMenus } = await import('../lib/sw/context-menu.js');
    await Promise.all([syncContextMenus(), syncContextMenus(), syncContextMenus()]);
    await settle(40);

    const logs = await logger.getLogs(50);
    const menuUyarilari = logs.filter(l => /Sag tik menusu guncellenemedi/.test(l.message));
    assert.deepEqual(menuUyarilari.map(l => l.message), [],
      'es zamanli kurulum uyari uretmemeli');

    assert.deepEqual(menuIds(), ['gt:menu:purge', 'gt:menu:root', 'gt:menu:whitelist'],
      `menu tam kurulmali; kurulan: ${menuIds().join(', ') || '(bos)'}`);
  });

  test('ayar KAPATILINCA menu tamamen kalkar (yaris olsa bile)', async () => {
    await reset({ settings: { contextMenuEnabled: true, logLevel: 'info' } });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    storage.__resetCacheForTests();
    const { syncContextMenus } = await import('../lib/sw/context-menu.js');
    await syncContextMenus();
    assert.equal(menuIds().length, 3, 'once kurulmus olmali');

    await chrome.storage.local.set({ contextMenuEnabled: false });
    storage.__resetCacheForTests();
    await Promise.all([syncContextMenus(), syncContextMenus()]);
    await settle(40);

    assert.deepEqual(menuIds(), [], 'ayar kapaliyken hicbir oge kalmamali');
  });

  test('IZIN yokken ayar ACIKSA sessiz kalmaz', async () => {
    // Eskiden her worker uyanisinda kosulsuz "contextMenus izni yok" diye bir
    // INFO dusuyordu - ayar kapaliyken bile, yani gunlugu dolduran gurultu.
    // Anlamli olan tek durum: kullanici menuyu ISTEDI ama izin yok.
    await reset({ settings: { contextMenuEnabled: true, logLevel: 'info' } });
    await chrome.storage.local.set({ contextMenuEnabled: true });
    storage.__resetCacheForTests();

    const gercek = chrome.contextMenus;
    delete chrome.contextMenus;
    try {
      const { syncContextMenus } = await import('../lib/sw/context-menu.js');
      await syncContextMenus();
      await settle(40);
    } finally {
      chrome.contextMenus = gercek;
    }

    const logs = await logger.getLogs(50);
    assert.ok(logs.some(l => l.level === 'WARN' && /Sag tik menusu acik ama/.test(l.message)),
      `izin eksikligi raporlanmali; loglar: ${logs.map(l => l.message).join(' | ')}`);
  });

  test('IZIN yokken ayar KAPALIYSA hicbir sey soylenmez', async () => {
    await reset({ settings: { contextMenuEnabled: false, logLevel: 'info' } });
    const gercek = chrome.contextMenus;
    delete chrome.contextMenus;
    try {
      const { syncContextMenus } = await import('../lib/sw/context-menu.js');
      await syncContextMenus();
      await settle(40);
    } finally {
      chrome.contextMenus = gercek;
    }

    const logs = await logger.getLogs(50);
    assert.ok(!logs.some(l => /contextMenus|sag tik/i.test(l.message)),
      `beklenen durum icin gunluge satir dusmemeli: ${logs.map(l => l.message).join(' | ')}`);
  });
});
