// GhostTrace - 3. taraf iz gozlemcisi (icerik script'i)
//
// NEDEN VAR: content/trace-observer.js 3. taraf tespitinin TUM girdisi ve
// olculen kapsamda hic gorunmuyordu - yani hicbir testten gecmiyordu. Buradan
// gelmeyen bir host haritaya girmez, haritaya girmeyen host temizlenmez.
//
// Dosya bir IIFE ve ESM onbellegi yuzunden tekrar import edilince yeniden
// calismaz; bu yuzden metni okuyup her testte TAZE calistiriyoruz - gercek
// sayfa baglamina en yakin hal.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'content', 'trace-observer.js'), 'utf8');

let sent;
let listeners;
let pageEvents;
let observerCallback;
let resourceEntries;

/** Sayfa baglamini kurar ve script'i TAZE calistirir. */
function runObserver({ host = 'haber.com', keepWindow = null, keepListeners = false, topFrame = true, storageUsage = null } = {}) {
  sent = [];
  if (!keepListeners) listeners = [];
  pageEvents = {};
  observerCallback = null;

  globalThis.window = keepWindow || {
    addEventListener(type, fn) { pageEvents[type] = fn; }
  };
  // Ust cerceve mi alt cerceve mi? Icerik script'i her cercevede AYRI bir
  // ornek olarak calisir; window === window.top yalnizca ust cercevede dogrudur.
  globalThis.window.top = topFrame ? globalThis.window : { __other: true };
  globalThis.location = { hostname: host, href: `https://${host}/` };
  globalThis.performance = {
    getEntriesByType: () => resourceEntries.map(name => ({ name }))
  };
  globalThis.PerformanceObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  // Node'da navigator yalnizca okunur; defineProperty ile geciyoruz.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      storage: storageUsage === null
        ? undefined
        : { estimate: async () => ({ usage: storageUsage }) }
    },
    configurable: true, writable: true
  });
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) { sent.push(msg); if (cb) cb(); },
      onMessage: { addListener(fn) { listeners.push(fn); } }
    }
  };

  new Function(SOURCE)();
  return globalThis.window;
}

/** Toplanan host'lari gozlemciye verir. */
function emit(...urls) {
  resourceEntries = urls;
  if (observerCallback) {
    observerCallback({ getEntries: () => urls.map(name => ({ name })) });
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

beforeEach(() => { resourceEntries = []; });

describe('3. taraf host toplama', () => {
  test('harici host bildirilir, KENDI host bildirilmez', async () => {
    runObserver({ host: 'haber.com' });
    emit('https://cdn.baska.com/a.js', 'https://haber.com/kendi.js');
    await wait(3200);

    const report = sent.find(m => m.action === 'REPORT_THIRD_PARTY');
    assert.ok(report, `bildirim gonderilmeli; gonderilenler: ${JSON.stringify(sent)}`);
    assert.ok(report.hosts.includes('cdn.baska.com'), 'harici host bildirilmeli');
    assert.ok(!report.hosts.includes('haber.com'), 'kendi host bildirilmemeli');
  });

  test('http/https disi adresler atlanir', async () => {
    runObserver();
    emit('data:text/plain;base64,AAA', 'blob:https://x/y', 'https://gercek.com/a.js');
    await wait(3200);

    const report = sent.find(m => m.action === 'REPORT_THIRD_PARTY');
    assert.deepEqual(report.hosts, ['gercek.com']);
  });

  test('ayni host iki kez bildirilmez', async () => {
    runObserver();
    emit('https://cdn.baska.com/a.js');
    await wait(3200);
    emit('https://cdn.baska.com/b.js');
    await wait(3200);

    const reports = sent.filter(m => m.action === 'REPORT_THIRD_PARTY');
    const total = reports.flatMap(r => r.hosts);
    assert.equal(total.filter(h => h === 'cdn.baska.com').length, 1,
      'tekrar bildirim gereksiz mesaj trafigi uretir');
  });
});

describe('sayfa kapanirken toplanan host KAYBEDILMEZ', () => {
  test('pagehide bekleyen host listesini BOSALTIR', async () => {
    // BULGU: pagehide `stopped = true` yapip flush zamanlayicisini
    // BOSALTMADAN iptal ediyordu. 3 saniyeden kisa ziyaretlerde toplanan
    // hostlar tamamen kayboluyor, yani o CDN'ler haritaya hic girmiyor ve
    // hic temizlenmiyordu.
    const win = runObserver();
    emit('https://cdn.kisa-ziyaret.com/a.js');

    // Kullanici 3 saniye dolmadan sekmeyi kapatiyor
    assert.ok(pageEvents.pagehide, 'pagehide dinleyicisi kurulmali');
    pageEvents.pagehide();
    await wait(60);

    const report = sent.find(m => m.action === 'REPORT_THIRD_PARTY');
    assert.ok(report, 'kapanirken bekleyen hostlar gonderilmeli');
    assert.ok(report.hosts.includes('cdn.kisa-ziyaret.com'),
      'kisa ziyaretin 3. taraflari da bildirilmeli');
    assert.ok(win, 'pencere korunmali');
  });

  test('bekleyen host yoksa pagehide bos mesaj gondermez', async () => {
    runObserver();
    pageEvents.pagehide();
    await wait(60);
    assert.equal(sent.filter(m => m.action === 'REPORT_THIRD_PARTY').length, 0);
  });
});

describe('takip kapatilip ACILINCA gozlem yeniden baslar', () => {
  test('STOP sonrasi yeniden enjeksiyon gozlemi diriltir', async () => {
    // BULGU: STOP `stopped = true` yapiyor ama window.__ghostTraceObserverActive
    // TRUE kaliyordu. Ayar yeniden acildiginda service worker script'i tekrar
    // enjekte ediyor, ama en ustteki koruma aninda donuyordu -> acik sekmelerde
    // tespit bir daha hic baslamiyordu.
    const win = runObserver();
    assert.ok(listeners.length > 0, 'STOP dinleyicisi kurulmali');
    listeners[0]({ action: 'STOP_THIRD_PARTY_OBSERVER' });

    // Ayar yeniden acildi: ayni sayfaya tekrar enjekte edilir.
    sent = [];
    runObserver({ keepWindow: win });
    emit('https://cdn.yeniden.com/a.js');
    await wait(3200);

    const report = sent.find(m => m.action === 'REPORT_THIRD_PARTY');
    assert.ok(report, 'yeniden enjeksiyondan sonra gozlem calismali');
    assert.ok(report.hosts.includes('cdn.yeniden.com'));
  });

  test('AYNI enjeksiyon iki kez calismaz', async () => {
    const win = runObserver();
    sent = [];
    // Ayni sayfada ikinci kez calistirmak (STOP olmadan) yeni gozlemci kurmamali
    const before = listeners.length;
    runObserver({ keepWindow: win, keepListeners: true });
    assert.equal(listeners.length, before,
      'durdurulmamis gozlemci varken ikinci kez kurulmamali');
  });
});

describe('depolama olcumu YALNIZCA ust cercevede yapilir (v2.7.0)', () => {
  // iframe izleme acildiginda script her cercevede calisir. Alt cerceveden
  // gelen navigator.storage.estimate() O CERCEVENIN origin'ini olcer, ama
  // isleyici degeri gonderenin SEKME url'sine, yani UST siteye yazar.
  // Sonuc: reklam cercevesinin depolamasi haber sitesine mal edilir - hem
  // istatistik yanlis olur hem de temizlik hedefi saptirilir.

  // Olcum, sayfa YERLESTIKTEN sonra yapiliyor (birkac saniyelik gecikme).
  // Gercek sureyi beklemek testi saniyelerce uzatir; gecikmeyi kisaltiyoruz.
  // Esik bir SABITE baglanmiyor: "uzun" gecikme neyse o kisaltilir, boylece
  // uretimdeki deger degisse de test anlamli kalir.
  const realSetTimeout = globalThis.setTimeout;
  const shortenLongDelays = () => {
    globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 5000 ? 5 : ms);
  };
  const restoreTimers = () => { globalThis.setTimeout = realSetTimeout; };
  const waitForMeasure = () => new Promise(resolve => realSetTimeout(resolve, 40));

  test('ust cerceve olcumu BILDIRIR', async () => {
    shortenLongDelays();
    runObserver({ host: 'haber.com', topFrame: true, storageUsage: 4096 });
    await waitForMeasure();
    restoreTimers();

    const report = sent.find(m => m.action === 'REPORT_STORAGE_ESTIMATE');
    assert.ok(report, `ust cerceve olcum gondermeli; gonderilenler: ${JSON.stringify(sent)}`);
    assert.equal(report.usage, 4096);
  });

  test('alt cerceve olcum GONDERMEZ', async () => {
    shortenLongDelays();
    runObserver({ host: 'ads.com', topFrame: false, storageUsage: 4096 });
    await waitForMeasure();
    restoreTimers();

    const report = sent.find(m => m.action === 'REPORT_STORAGE_ESTIMATE');
    assert.equal(report, undefined,
      'alt cerceve olcumu ust siteye yanlis mal edilir; hic gonderilmemeli');
  });

  test('alt cerceve 3. taraf host bildirmeye DEVAM eder', async () => {
    resourceEntries = ['https://tracker-x.com/pixel.gif'];
    runObserver({ host: 'ads.com', topFrame: false, storageUsage: 4096 });
    await new Promise(resolve => setTimeout(resolve, 3100));

    const report = sent.find(m => m.action === 'REPORT_THIRD_PARTY');
    assert.ok(report, 'iframe icindeki izleyiciyi bildirmek bu ozelligin TUM amaci');
    assert.ok(report.hosts.includes('tracker-x.com'));
  });
});
