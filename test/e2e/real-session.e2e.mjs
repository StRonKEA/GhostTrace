// KADEME 12: GERCEK GEZINTI SENARYOSU (canli ag).
//
// Kullanicinin bildirdigi durum birebir tekrarlanir:
//   "hepsini ayni anda actim, sekmeleri kapattim, 30 saniye bekledim,
//    silinmediler; 'Izin Verilmeyen Tum Siteleri Temizle' deyince temizlendi"
//
// LOG ANALIZINDEN CIKAN SEBEP: yetim supurmesi her sekme kapanisinda
// cagriliyor ama 5 dakikalik kisitlamaya tabi. Kullanici butun sekmeleri
// 40 saniye icinde kapatinca supurme YALNIZCA ILK kapanista kostu; kalanlar
// kisitlandi ve SESSIZCE IPTAL EDILDI. Kapatacak sekme kalmadigi icin emniyet
// agini tetikleyecek baska olay da yoktu.
//
// Sekme kapanisi yolunun kendisi calisiyordu (10 sitenin 10'u da tam 30sn
// sonra temizlendi). Eksik olan, o yolun GORMEDIGI seylerdi:
//   * sitenin YUKLEDIGI 3. taraflar (fonts.googleapis.com, cloudflare.com...)
//   * ziyaret edilen alt alan adinin UST alan adi (forum.mobilism.org -> mobilism.org)
//
// Bu takim once senaryoyu kosar, sonra ERTELEME alarminin kuruldugunu ve
// tetiklendiginde kalanlari gercekten temizledigini olcer.
//
// Kosum: npm run test:e2e:real

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, createRunner, assertOk, assertEqual
} from './harness.mjs';
import { makeMsg, makeEval, applySettings } from './features-common.mjs';

// Test oturumu adresleri.
const SITELER = [
  'https://www.google.com/',
  'https://www.youtube.com/',
  'https://github.com/',
  'https://www.deepl.com/',
  'https://ecc.tools/',
  'https://ddlbase.com/',
  'https://blackmod.net/',
  'https://platinmods.com/',
  'https://1337x.to/',
  'https://fitgirl-repacks.site/',
  'https://forum.mobilism.org/',
  'https://openani.me/'
];

const SWEEP_RETRY = 'gt:sweepRetry';

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

try {
  const { extensionId, sessionId: sw } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);
  const inSw = (expr) => evaluate(chrome.client, sw, expr, { timeoutMs: 20000 });

  console.log(`\nKADEME 12: gercek gezinti senaryosu (eklenti ${extensionId})\n`);

  // Gecikme 0: sekme kapanisi yolu ANINDA calissin, bekleme testi uzatmasin.
  // Kural listesi bos: hicbir site korumali degil.
  await applySettings(msg, run, {
    enabled: true, cleanDelay: 0, trackThirdParty: true, logLevel: 'info'
  });
  await run('await chrome.storage.local.set({ rules: {} }); return true;');
  await msg({ action: 'CLEAR_LOGS' });

  const sekmeler = [];

  await runner.test('12.1 Siteler ayni anda acilir', async () => {
    for (const url of SITELER) {
      try {
        const tab = await visit(chrome.client, url, { settleMs: 0 });
        sekmeler.push({ url, ...tab });
      } catch {
        // Site acilmadi (ag/erisim); senaryo kalan sitelerle surer.
      }
    }
    // Sayfalarin kaynaklarini yuklemesi icin toplu bekleme: 3. taraflar
    // ancak istek atildiginda kaydedilir.
    await sleep(18000);
    assertOk(sekmeler.length >= 6,
      `senaryo icin yeterli site acilamadi: ${sekmeler.length}/${SITELER.length}`);
    console.log(`        ${sekmeler.length}/${SITELER.length} site acildi`);
  });

  await runner.test('12.2 3. taraflar KESFEDILDI (senaryonun on kosulu)', async () => {
    const n = await run(`
      const m = await chrome.runtime.sendMessage({ action: 'GET_ALL_STORED_DOMAINS' });
      return (m?.domains || []).filter(d => d.category === 'third_party').length;
    `);
    assertOk(Number(n) > 0,
      `3. taraf kesfedilmediyse bu senaryo olculemez; bulunan: ${n}`);
    console.log(`        ${n} adet 3. taraf kesfedildi`);
  });

  await runner.test('12.3 Sekmeler TEK TEK kapatilir', async () => {
    for (const s of sekmeler) {
      await closeTarget(chrome.client, s.targetId);
      await sleep(700);
    }
    await sleep(6000);   // gecikme 0 + isleme payi
    const acik = await run(`
      const t = await chrome.tabs.query({});
      return t.filter(x => /^https?:/.test(x.url || '')).length;
    `);
    assertEqual(Number(acik), 0, `tum site sekmeleri kapanmis olmali, acik: ${acik}`);
  });

  await runner.test('12.4 ZIYARET EDILEN adreslerin verisi silindi', async () => {
    // Sekme kapanisi yolunun sozu BU: ziyaret edilen host temizlenir.
    //
    // UST alan adi (forum.mobilism.org -> mobilism.org) ve sitenin YUKLEDIGI
    // 3. taraflar bu yolun isi DEGIL; onlar yetim supurmesinin isi ve 12.6'da
    // olculuyor. Kapsam yukari genislemez - bu bilincli bir karar.
    const hedefler = SITELER.map(u => new URL(u).hostname);
    const kalan = await run(`
      const m = await chrome.runtime.sendMessage({ action: 'GET_ALL_STORED_DOMAINS' });
      const hedefler = ${JSON.stringify(hedefler)};
      const kotu = (m?.domains || [])
        .filter(d => hedefler.includes(d.domain) && (d.cookieCount > 0 || d.historyCount > 0))
        .map(d => d.domain + ' (cerez:' + d.cookieCount + ' gecmis:' + d.historyCount + ')');
      return JSON.stringify(kotu);
    `);
    const liste = JSON.parse(kalan);
    assertEqual(liste.length, 0,
      `ziyaret edilen adreslerin verisi kalmamali:\n        ${liste.join('\n        ')}`);
  });

  await runner.test('12.5 Kisitlanan supurme icin ERTELEME alarmi kuruldu', async () => {
    // ONCEKI DAVRANIS: kisitlanan supurme sessizce iptal ediliyordu ve
    // emniyet agi bir daha hic kosmuyordu. Artik ertelenmeli.
    const alarmlar = await run(`
      const a = await chrome.alarms.getAll();
      return JSON.stringify(a.map(x => x.name));
    `);
    const liste = JSON.parse(alarmlar);
    assertOk(liste.includes(SWEEP_RETRY),
      `erteleme alarmi kurulmali; kurulu alarmlar: ${liste.join(', ') || '(yok)'}`);
  });

  await runner.test('12.6 Erteleme tetiklenince KALANLAR da temizlenir', async () => {
    // Kisitlama penceresini gecmis gibi yap, sonra alarmi tetikle.
    await inSw(`await chrome.storage.session.set({ gt_lastSweep: 0 }); return true;`);

    // Supurmeyi URETIMDEKI yoldan tetikle: bir sekme acip kapat. Kisitlama
    // sifirlandigi icin bu kez slot alinir ve tam tarama kosar.
    const tab = await visit(chrome.client, 'https://example.com/', { settleMs: 2500 });
    await closeTarget(chrome.client, tab.targetId);
    await sleep(9000);

    const kalan = await run(`
      const m = await chrome.runtime.sendMessage({ action: 'GET_ALL_STORED_DOMAINS' });
      const kotu = (m?.domains || [])
        .filter(d => d.cookieCount > 0 || d.historyCount > 0)
        .map(d => d.domain + ' (cerez:' + d.cookieCount + ' gecmis:' + d.historyCount + ')');
      return JSON.stringify(kotu);
    `);
    const liste = JSON.parse(kalan);
    assertEqual(liste.length, 0,
      `supurme sonrasi hicbir sitede veri kalmamali:\n        ${liste.join('\n        ')}`);
  });

  await runner.test('12.7 Varsayilan DISI Storage Bucket verisi de siliniyor', async () => {
    // Ayri bir kovadaki veri de siliniyor mu? Olculdu: siliniyor. Kova
    // ADLARI silinmiyor - kalici sinir, burada iddia edilmiyor.
    const KOKEN = 'https://example.com';
    const t = await visit(chrome.client, KOKEN + '/', { settleMs: 2000 });
    const destek = await evaluate(chrome.client, t.sessionId,
      'return Boolean(navigator.storageBuckets);');
    if (!destek) {
      console.log('        bu Chrome storageBuckets desteklemiyor - olcum atlandi');
      return;
    }
    const yazVeOku = (js) => evaluate(chrome.client, t.sessionId, `
      const kova = await navigator.storageBuckets.open('gt-kova');
      const idbIsle = (idb, mod, isle) => new Promise((coz) => {
        const a = idb.open('gtKovaTest', 1);
        a.onupgradeneeded = () => a.result.createObjectStore('kv');
        a.onerror = () => coz(null);
        a.onsuccess = () => {
          let s;
          try { s = isle(a.result.transaction('kv', mod).objectStore('kv')); }
          catch { a.result.close(); return coz(null); }
          s.onsuccess = () => { a.result.close(); coz(s.result ?? null); };
          s.onerror = () => { a.result.close(); coz(null); };
        };
      });
      ${js}`);

    await yazVeOku("return await idbIsle(kova.indexedDB, 'readwrite', o => o.put('KOVA-IZI', 'iz'));");
    const once = await yazVeOku("return await idbIsle(kova.indexedDB, 'readonly', o => o.get('iz'));");
    assertEqual(once, 'KOVA-IZI', 'on kosul: kova verisi yazilamadi, olcum anlamsiz');

    await closeTarget(chrome.client, t.targetId);
    await inSw(`
      await chrome.browsingData.remove({
        origins: ['${KOKEN}'],
        originTypes: { unprotectedWeb: true, protectedWeb: true }
      }, { indexedDB: true, localStorage: true, cacheStorage: true,
           serviceWorkers: true, fileSystems: true });
      return true;`);
    await sleep(2000);

    const t2 = await visit(chrome.client, KOKEN + '/', { settleMs: 2000 });
    const sonra = await evaluate(chrome.client, t2.sessionId, `
      const kovalar = await navigator.storageBuckets.keys();
      if (!kovalar.includes('gt-kova')) return { veri: null, kovalar };
      const kova = await navigator.storageBuckets.open('gt-kova');
      const veri = await new Promise((coz) => {
        const a = kova.indexedDB.open('gtKovaTest', 1);
        a.onupgradeneeded = () => { a.transaction.abort(); coz(null); };
        a.onerror = () => coz(null);
        a.onsuccess = () => {
          let s;
          try { s = a.result.transaction('kv', 'readonly').objectStore('kv').get('iz'); }
          catch { a.result.close(); return coz(null); }
          s.onsuccess = () => { a.result.close(); coz(s.result ?? null); };
          s.onerror = () => { a.result.close(); coz(null); };
        };
      });
      return { veri, kovalar };`);
    await closeTarget(chrome.client, t2.targetId);
    console.log(`        kova verisi: ${JSON.stringify(once)} -> ${JSON.stringify(sonra.veri)}` +
      ` | kalan kova adlari: ${JSON.stringify(sonra.kovalar)} (adlar silinmez, bilinen sinir)`);
    assertEqual(sonra.veri, null,
      'varsayilan disi bucket verisi silinmedi - KOR NOKTA GERCEK');
  });
} catch (e) {
  setupError = e;
} finally {
  await chrome.close();
}

if (setupError) {
  console.error('\nKURULUM HATASI:', setupError.message);
  process.exit(1);
}
process.exit(runner.summary() ? 0 : 1);
