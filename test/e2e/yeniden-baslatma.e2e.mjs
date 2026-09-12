// GhostTrace E2E - TARAYICI KAPANIP YENIDEN ACILINCA, GERCEK SITELERDE.
//
// TAKLIT SITE YOK. Onceki surum yerel bir sunucu kullaniyordu; artik gercek
// siteler geziliyor, gercek cerezler birakiliyor ve tarayici gercekten
// kapatilip AYNI PROFILLE yeniden aciliyor.
//
// NEDEN BU SENARYO: `chrome.runtime.reload()` bu duzenekte olculemiyor
// (--load-extension ile yuklenen eklenti geri gelmiyor). Ama kullanicinin her
// gun yasadigi sey zaten o degil, TARAYICIYI KAPATIP ACMAK. Olculen:
//
//   * Kurallar sag cikiyor mu?          (beyaz liste kaybolursa oturumlar ucar)
//   * Gecici iznin BITIS ZAMANI korunuyor mu?
//   * Alarmlar yeniden kuruluyor mu?
//   * Kapanmadan ONCE bekleyen temizlik acilista yapiliyor mu?
//     (oturum deposu kapanista silinir; sekme haritasi gider - en kirilgan yol)
//   * Korumali sitenin verisi duruyor mu?
//   * Istatistik sag cikiyor mu?
//
// ONSTARTUP BU DUZENEKTE URETILEMEZ - olculdu, tahmin degil: ikinci acilista
// urunun kendi gunlugu "Kurulum/guncelleme: install" yaziyor. Chrome,
// `--load-extension` ile acilan eklentiyi HER BASLATMADA yeni kurulum sayiyor
// ve `onStartup` yerine `onInstalled` tetikliyor; 80 saniye beklendi,
// "Tarayici baslatildi" kaydi hic gelmedi. Ikinci kanit: onStartup
// `cancelAllScheduledPurges()` cagirir, ama `gt:purge:` alarmi yerinde
// duruyordu. Bu yuzden gri listenin tarayici kapanisinda DUSMESI ve snooze
// alarminin YENIDEN KURULMASI burada olculemez - ikisi de o yolda. Mekanizma
// birim testinde gercekten tetiklenerek kapsaniyor
// (test/service-worker.test.js -> onStartup._fire()).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  REKLAM_YOGUN, POPULER, cerezler, tumSekmeleriKapat, okuyormusGibi
} from './gercek.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(6)}sn] ${m}`);

const BEYAZ = POPULER[0];           // wikipedia
const GRI = POPULER[1];             // stackoverflow
const SURELI = POPULER[4];          // imdb
const KORUMASIZ = REKLAM_YOGUN[3];  // milliyet
const YENI = REKLAM_YOGUN[4];       // sozcu - yeniden baslatmadan SONRA

async function main() {
  const profil = mkdtempSync(join(tmpdir(), 'gt-e2e-restart-'));
  const runner = createRunner();
  let chrome = null;

  const ac = () => launchChrome({
    live: true,
    headless: process.env.GT_HEADED !== '1',
    profileDir: profil,
    keepProfile: true,       // kapanista profil SILINMEMELI
    // Duzenek kalici profillerde eklentiyi runtime.reload() ile tazeliyor;
    // BOS bir profilde reload komut satirindan yuklenen eklentiyi tamamen
    // dusuruyor (olculdu). Profil zaten her acilista diskten yukluyor.
    refreshExtension: false
  });

  try {
    console.log('\nTARAYICI YENIDEN BASLATMA - GERCEK SITELER');
    console.log(`Profil: ${profil}\n`);

    // ================================================================
    console.log('########## 1. OTURUM: durum kuruluyor ##########');
    chrome = await ac();
    let ek = await attachExtension(chrome.client);
    let sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj1 = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 30,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, periodicCleanEnabled: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'RESET_STATS' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(1000);

    await mesaj1({ action: 'SET_RULE', domain: BEYAZ.kok, type: 'white', options: {} });
    await mesaj1({ action: 'SET_RULE', domain: GRI.kok, type: 'grey', options: {} });
    await mesaj1({ action: 'SET_RULE', domain: SURELI.kok, type: 'temp',
      options: { durationMinutes: 120 } });

    for (const s of [BEYAZ, GRI, SURELI, KORUMASIZ]) {
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      if (!t) { console.log(`        ${s.kok} ACILAMADI`); continue; }
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(600);
    }

    // KORUMASIZ sitenin sekmesi kapandi, 30 saniyelik alarm kuruldu. Tarayici
    // ALARM TETIKLENMEDEN kapatilacak - acilista toplanmasi gerekiyor.
    const oncekiDurum = await evaluate(chrome.client, ek.sessionId, `
      const r = (await chrome.storage.local.get('rules')).rules || {};
      const s = (await chrome.storage.local.get('stats')).stats || {};
      return {
        kurallar: Object.keys(r).sort(),
        tipler: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.type])),
        sureliBitis: r[${JSON.stringify(SURELI.kok)}]?.expiresAt || null,
        istatistik: s.cookiesDeleted || 0,
        alarmlar: (await chrome.alarms.getAll()).map(a => a.name).sort() };`);
    const korumasizOnce = (await cerezler(chrome.client, ek.sessionId, KORUMASIZ.kok)).length;
    const beyazOnce = await cerezler(chrome.client, ek.sessionId, BEYAZ.kok);

    console.log(`        kurallar: ${JSON.stringify(oncekiDurum.tipler)}`);
    console.log(`        ${KORUMASIZ.kok}: ${korumasizOnce} cerez (temizligi BEKLIYOR)`);
    console.log(`        ${BEYAZ.kok}: ${beyazOnce.length} cerez (KORUMALI)`);
    console.log(`        alarmlar: ${oncekiDurum.alarmlar.join(', ')}`);

    await runner.test('1.1 ON KOSUL: kurallar kuruldu, temizlik BEKLIYOR', async () => {
      assertEqual(oncekiDurum.kurallar, [BEYAZ.kok, GRI.kok, SURELI.kok].sort(),
        'kurallar kurulamadi');
      assertOk(korumasizOnce > 0,
        'korumasiz sitede veri olmali - bekleyen temizligi olcecegiz');
      assertOk(beyazOnce.length > 0, 'korumali sitede veri olmali');
      assertOk(oncekiDurum.alarmlar.some(a => a.startsWith('gt:purge:')),
        'bekleyen temizlik alarmi kurulmali - yoksa acilis temizligi olculemez');
    });

    // ISTATISTIK GECMISI: 'session' saklamasi tarayici kapanisinda silinmeli.
    // Bu ancak GERCEK kapanma/acilma ile olculur - sessionBootstrap yalnizca
    // onStartup/onInstalled ile kosar.
    await evaluate(chrome.client, ek.sessionId, `
      await chrome.storage.local.set({
        statsHistoryRetention: 'session',
        statsHistory: { thirdParty: { 'oturumluk.test': { n: 3, t: Date.now() } }, sites: {} }
      });
      return 1;`);

    not('tarayici KAPATILIYOR (bekleyen temizlik tetiklenmeden)');
    await chrome.close();
    chrome = null;
    await sleep(5000);

    // ================================================================
    console.log('\n########## 2. OTURUM: ayni profille yeniden aciliyor ##########');
    chrome = await ac();
    ek = await attachExtension(chrome.client);
    sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj2 = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);
    await sleep(5000);

    const sonrakiDurum = await evaluate(chrome.client, ek.sessionId, `
      const r = (await chrome.storage.local.get('rules')).rules || {};
      const s = (await chrome.storage.local.get('stats')).stats || {};
      return {
        kurallar: Object.keys(r).sort(),
        tipler: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.type])),
        sureliBitis: r[${JSON.stringify(SURELI.kok)}]?.expiresAt || null,
        istatistik: s.cookiesDeleted || 0,
        alarmlar: (await chrome.alarms.getAll()).map(a => a.name).sort() };`);
    console.log(`        kurallar: ${JSON.stringify(sonrakiDurum.tipler)}`);
    console.log(`        alarmlar: ${sonrakiDurum.alarmlar.join(', ')}`);
    console.log(`        istatistik: ${oncekiDurum.istatistik} -> ${sonrakiDurum.istatistik}`);

    await runner.test('2.1 KURALLAR yeniden baslatmadan sag cikti', async () => {
      assertEqual(sonrakiDurum.kurallar, oncekiDurum.kurallar,
        'kural listesi yeniden baslatmada degisti');
      assertEqual(sonrakiDurum.tipler[BEYAZ.kok], 'white',
        'beyaz liste kurali kayboldu - kullanicinin oturumlari ucardi');
    });

    await runner.test('2.2 KORUMALI sitenin verisi DURUYOR', async () => {
      const sonra = await cerezler(chrome.client, ek.sessionId, BEYAZ.kok);
      const eksilen = beyazOnce.filter(c => !sonra.includes(c));
      console.log(`        ${BEYAZ.kok}: ${beyazOnce.length} -> ${sonra.length}, ` +
        `eksilen ${eksilen.length}`);
      assertEqual(eksilen, [], 'yeniden baslatmada korumali sitenin verisi silinmis');
    });

    await runner.test('2.3 Gecici iznin BITIS ZAMANI korundu', async () => {
      const kalanDk = sonrakiDurum.sureliBitis
        ? (sonrakiDurum.sureliBitis - Date.now()) / 60000 : null;
      console.log(`        ${SURELI.kok}: tip=${sonrakiDurum.tipler[SURELI.kok]} ` +
        `kalan=${kalanDk?.toFixed(0)}dk`);
      assertEqual(sonrakiDurum.tipler[SURELI.kok], 'temp', 'gecici izin tipi degismis');
      assertEqual(sonrakiDurum.sureliBitis, oncekiDurum.sureliBitis,
        'gecici iznin BITIS ZAMANI yeniden baslatmada degismis');
      assertOk(kalanDk > 100 && kalanDk <= 120, `bitis zamani bozulmus: ${kalanDk}`);
    });

    await runner.test('2.4 ALARMLAR yeniden kuruldu', async () => {
      console.log(`        alarmlar: ${sonrakiDurum.alarmlar.join(', ')}`);
      assertOk(sonrakiDurum.alarmlar.includes('gt:maintenance'), 'bakim alarmi yok');
      assertOk(sonrakiDurum.alarmlar.includes('gt:periodicSweep'), 'periyodik alarm yok');
    });

    await runner.test('2.5 ISTATISTIK geriye gitmedi', async () => {
      assertOk(sonrakiDurum.istatistik >= oncekiDurum.istatistik,
        `istatistik geriye gitti: ${oncekiDurum.istatistik} -> ${sonrakiDurum.istatistik}`);
    });

    await runner.test('2.6 Kapanmadan ONCE bekleyen temizlik ACILISTA yapildi', async () => {
      // EN KIRILGAN YOL: oturum deposu (sekme haritasi) kapanista silinir.
      // Kapanmadan once planlanan temizligi acilis toplamak zorunda.
      const bas = Date.now();
      let kalan = korumasizOnce;
      for (let i = 0; i < 40; i++) {
        kalan = (await cerezler(chrome.client, ek.sessionId, KORUMASIZ.kok)).length;
        if (kalan === 0) break;
        await sleep(3000);
      }
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${KORUMASIZ.kok}: ${korumasizOnce} -> ${kalan} (${gecen.toFixed(0)}sn)`);
      assertEqual(kalan, 0,
        'kapanmadan once bekleyen temizlik acilista YAPILMADI - veri kaldi');
    });

    await runner.test('2.7 Yeniden baslatmadan sonra NORMAL temizlik calisiyor', async () => {
      await tumSekmeleriKapat(chrome.client, YENI.kok);
      const t = await visit(chrome.client, YENI.url, { settleMs: 4000 }).catch(() => null);
      assertOk(t, `${YENI.kok} acilamadi`);
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = (await cerezler(chrome.client, ek.sessionId, YENI.kok)).length;
      assertOk(once > 0, `${YENI.kok} cerez birakmadi`);

      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, YENI.kok);
      let kalan = once;
      for (let i = 0; i < 40; i++) {
        await sleep(2000);
        kalan = (await cerezler(chrome.client, ek.sessionId, YENI.kok)).length;
        if (kalan === 0) break;
      }
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${YENI.kok}: ${once} -> ${kalan} cerez, ${gecen.toFixed(1)}sn`);
      assertEqual(kalan, 0, 'yeniden baslatmadan sonra temizlik calismiyor');
      assertOk(Math.abs(gecen - 30) < 20, `zamanlama bozuk: ${gecen.toFixed(1)}sn`);
    });

    await runner.test('2.8 ARAYUZ yeniden baslatmadan sonra calisiyor', async () => {
      const tani = await mesaj2({ action: 'GET_DIAGNOSTICS' });
      assertOk(tani?.success, 'mesajlasma bozulmus');
      const depodaki = await evaluate(chrome.client, ek.sessionId,
        "return Object.keys((await chrome.storage.local.get('rules')).rules || {}).length;");
      const satir = await evaluate(chrome.client, sayfa.sessionId,
        "return document.querySelectorAll('#rulesTableBody tr, .rule-row').length;")
        .catch(() => 0);
      console.log(`        depoda ${depodaki} kural, arayuzde ${satir} satir`);
      assertOk(depodaki > 0, 'depoda kural kalmamis');
    });

    await runner.test("2.8b ISTATISTIK GECMISI: 'session' saklamasi acilista SILINDI", async () => {
      const g = await evaluate(chrome.client, ek.sessionId,
        "return (await chrome.storage.local.get('statsHistory')).statsHistory || { thirdParty: {}, sites: {} };");
      const kalan = Object.keys(g.thirdParty);
      console.log(`        acilistan sonra kayit: ${kalan.length ? kalan.join(', ') : '(yok)'}`);
      assertOk(!g.thirdParty['oturumluk.test'],
        "'session' secildiyse gecmis tarayici acilisinda silinmeliydi");
    });

    await runner.test("2.8c KONTROL: 'monthly' saklamasi acilisi SAG ATLATIR", async () => {
      // Karsit olcum: silme her acilista degil, YALNIZCA 'session' secildiginde
      // olmali. Ayni yolu kalici ayarla tekrar kosuyoruz.
      await evaluate(chrome.client, ek.sessionId, `
        await chrome.storage.local.set({
          statsHistoryRetention: 'monthly',
          statsHistory: { thirdParty: { 'kalici.test': { n: 5, t: Date.now() } }, sites: {} }
        });
        return 1;`);
      await chrome.close();
      await sleep(4000);
      chrome = await ac();
      ek = await attachExtension(chrome.client);
      await sleep(3000);

      const g = await evaluate(chrome.client, ek.sessionId,
        "return (await chrome.storage.local.get('statsHistory')).statsHistory || { thirdParty: {}, sites: {} };");
      console.log(`        kalici kayit duruyor mu: ${Boolean(g.thirdParty['kalici.test'])}`);
      assertOk(g.thirdParty['kalici.test'],
        "'monthly' secildiyse gecmis acilista SILINMEMELI");
    });

    await runner.test('2.9 Gunlukte ERROR yok', async () => {
      const hatalar = await evaluate(chrome.client, ek.sessionId,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 8);`);
      console.log(`        ERROR: ${hatalar.length ? hatalar.join(' | ') : '(yok)'}`);
      assertEqual(hatalar.length, 0, 'yeniden baslatmadan sonra gunlukte hata var');
    });

    const gecti = runner.summary();
    console.log(`Toplam sure: ${(Number(sn(Date.now() - t0)) / 60).toFixed(1)} dakika`);
    process.exitCode = gecti ? 0 : 1;
  } catch (err) {
    console.error('\nKURULUM/AKIS HATASI:', err?.stack || err);
    process.exitCode = 1;
  } finally {
    if (chrome) await chrome.close();
  }
}

main();
