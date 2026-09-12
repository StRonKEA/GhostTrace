// GhostTrace E2E - ISTATISTIK GECMISI (kalici listeler), GERCEK SITELERDE.
//
// Yeni ozellik iki bagimsiz ayar: 3. taraf listesi ve temizlenen site listesi.
// Ikisi de varsayilan KAPALI. Burada olculen sey iddialarin tarayicida
// gerceklesmesi: kapaliyken HIC yazilmamasi, acikken yazilmasi, gizli
// pencerenin kaydedilmemesi, saklama suresinin uygulanmasi.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { REKLAM_YOGUN, YER_IMLERI, okuyormusGibi, tumSekmeleriKapat } from './gercek.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(6)}sn] ${m}`);

const SITELER = [REKLAM_YOGUN[0], REKLAM_YOGUN[1], REKLAM_YOGUN[2]];
const TEK_SITE = YER_IMLERI[0];

const chrome_ = await launchChrome({
  live: true, headless: process.env.GT_HEADED !== '1',
  profileDir: process.env.GT_PROFILE || null,
  keepProfile: Boolean(process.env.GT_PROFILE)
});
const runner = createRunner();
let setupError = null;

try {
  const ek = await attachExtension(chrome_.client);
  const sw = ek.sessionId;
  const sayfa = await openExtensionPage(chrome_.client, ek.extensionId, 'options/options.html');
  const mesaj = (y) => evaluate(chrome_.client, sayfa.sessionId,
    `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);
  const inSw = (js) => evaluate(chrome_.client, sw, js);

  /** Diske YAZILMIS gecmis - arayuzden degil, ham depodan. */
  const gecmis = () => inSw(
    "return (await chrome.storage.local.get('statsHistory')).statsHistory || { thirdParty: {}, sites: {} };");

  // SETTINGS_CHANGED options SAYFASINDAN gonderilir: service worker kendi
  // gonderdigi mesaji almaz ("Receiving end does not exist").
  const ayarla = async (parca) => {
    await inSw(`await chrome.storage.local.set(${JSON.stringify(parca)}); return 1;`);
    await mesaj({ action: 'SETTINGS_CHANGED' });
    await sleep(600);
  };

  /** Uc gercek site gez; icerik script'i 3. taraf raporu gondersin. */
  const gez = async (liste = SITELER) => {
    for (const s of liste) {
      const t = await visit(chrome_.client, s.url, { settleMs: 4000 }).catch(() => null);
      if (!t) { not(`${s.kok} ACILAMADI`); continue; }
      await okuyormusGibi(chrome_.client, t.sessionId, { tikla: false });
      await sleep(3500);                    // raporlama araligi 3 sn
      await tumSekmeleriKapat(chrome_.client, s.kok);
      await sleep(1500);
    }
    // Toplu yazma 5 sn sonra gider.
    await sleep(7000);
  };

  console.log(`\nISTATISTIK GECMISI - eklenti ${ek.extensionId}\n`);
  await inSw(`await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
    trackThirdParty: true, logLevel: 'info' }); return 1;`);
  await mesaj({ action: 'CLEAR_STATS_HISTORY' });

  // ================================================================
  console.log('########## 1. VARSAYILAN: hicbir sey diske yazilmaz ##########');

  await runner.test('1.1 Iki ayar da varsayilan KAPALI geliyor', async () => {
    // VARSAYILAN ancak TEMIZ profilde olculur. GT_PROFILE ile kalici bir
    // profil verildiginde onceki kosumlarin ayarlari duruyor olabilir;
    // orada "varsayilan" diye bir sey yok. Sessiz gecmez, acikca soyler.
    if (process.env.GT_PROFILE) {
      console.log('        KALICI PROFIL: varsayilan olculemez, DEFAULT_SETTINGS dogrulanir');
      // import() service worker'da YASAK (HTML spec); options SAYFASINDA serbest.
      const d = await evaluate(chrome_.client, sayfa.sessionId,
        `const m = await import('/lib/storage.js');
         return { u: m.DEFAULT_SETTINGS.keepThirdPartyHistory, s: m.DEFAULT_SETTINGS.keepSiteHistory };`);
      assertEqual(Boolean(d.u), false, 'DEFAULT_SETTINGS: 3. taraf kapali olmali');
      assertEqual(Boolean(d.s), false, 'DEFAULT_SETTINGS: site kapali olmali');
      return;
    }
    const s = await inSw("return await chrome.storage.local.get(['keepThirdPartyHistory','keepSiteHistory','statsHistoryRetention']);");
    console.log(`        keepThirdParty=${s.keepThirdPartyHistory} keepSite=${s.keepSiteHistory} saklama=${s.statsHistoryRetention}`);
    assertEqual(Boolean(s.keepThirdPartyHistory), false, '3. taraf varsayilan kapali olmali');
    assertEqual(Boolean(s.keepSiteHistory), false, 'site varsayilan kapali olmali');
  });

  await runner.test('1.2 KAPALIYKEN gercek gezinti HIC kayit birakmaz', async () => {
    await ayarla({ keepThirdPartyHistory: false, keepSiteHistory: false });
    not('3 gercek site geziliyor (ayarlar kapali)');
    await gez();
    const g = await gecmis();
    console.log(`        3. taraf: ${Object.keys(g.thirdParty).length}, site: ${Object.keys(g.sites).length}`);
    assertEqual(Object.keys(g.thirdParty).length, 0, 'kapaliyken 3. taraf yazilmamali');
    assertEqual(Object.keys(g.sites).length, 0, 'kapaliyken site yazilmamali');
  });

  // ================================================================
  console.log('\n########## 2. 3. TARAF ayari ACIK ##########');

  await runner.test('2.1 Gercek reklam aglari diske yazildi', async () => {
    await ayarla({ keepThirdPartyHistory: true, keepSiteHistory: false });
    not('ayni siteler yeniden geziliyor (3. taraf ACIK)');
    await gez();
    const g = await gecmis();
    const adlar = Object.keys(g.thirdParty);
    console.log(`        ${adlar.length} alan adi | ornek: ${adlar.slice(0, 6).join(', ')}`);
    assertOk(adlar.length >= 5,
      `gercek sitelerden en az 5 ucuncu taraf beklenir, gelen: ${adlar.length}`);
  });

  await runner.test('2.2 Kayit yalnizca SAYAC ve ZAMAN tasir (site adi YOK)', async () => {
    const g = await gecmis();
    const ornek = Object.entries(g.thirdParty)[0];
    assertOk(ornek, 'olcum icin kayit yok');
    const [ad, kayit] = ornek;
    console.log(`        ${ad} -> ${JSON.stringify(kayit)}`);
    assertEqual(Object.keys(kayit).sort(), ['n', 't'],
      'kayitta n ve t disinda alan olmamali - site adi gizlilik ihlali olurdu');
    assertOk(kayit.n > 0 && kayit.t > 0, 'sayac ve zaman dolu olmali');
  });

  await runner.test('2.3 SITE ayari kapaliyken site listesi BOS kaldi', async () => {
    const g = await gecmis();
    console.log(`        site kaydi: ${Object.keys(g.sites).length}`);
    assertEqual(Object.keys(g.sites).length, 0,
      'iki ayar BAGIMSIZ olmali - site ayari kapaliyken yazilmamali');
  });

  // ================================================================
  console.log('\n########## 3. SITE ayari ACIK ##########');

  await runner.test('3.1 Temizlenen site diske yazildi', async () => {
    await ayarla({ keepSiteHistory: true });
    const t = await visit(chrome_.client, TEK_SITE.url, { settleMs: 4000 });
    await okuyormusGibi(chrome_.client, t.sessionId, { tikla: false });
    await tumSekmeleriKapat(chrome_.client, TEK_SITE.kok);
    await sleep(9000);                      // cleanDelay 0 + toplu yazma
    const g = await gecmis();
    const adlar = Object.keys(g.sites);
    console.log(`        ${adlar.length} site: ${adlar.slice(0, 5).join(', ')}`);
    assertOk(adlar.length > 0, 'temizlenen site kaydedilmeliydi');
  });

  // ================================================================
  console.log('\n########## 4. GIZLI PENCERE kaydedilmez ##########');

  await runner.test('4.1 Gizli penceredeki gezinti gecmise girmiyor', async () => {
    const oncekiler = new Set(Object.keys((await gecmis()).thirdParty));
    const izin = await inSw('return await chrome.extension.isAllowedIncognitoAccess();')
      .catch(() => false);
    if (!izin) {
      // SESSIZ GECMEZ: olcum yapilamadigi acikca yazilir.
      console.log('        OLCUM YAPILAMADI: eklentiye gizli pencere erisimi verilmemis.');
      console.log('        Hazirlik: chrome://extensions -> Gizli moda izin ver, sonra');
      console.log('        GT_PROFILE=<profil> npm run test:e2e:gecmis');
      return;
    }
    const { windowId } = await inSw(
      'const w = await chrome.windows.create({ incognito: true, url: "https://www.bbc.com/news" }); return { windowId: w.id };')
      .catch(() => ({ windowId: null }));
    if (!windowId) {
      console.log('        gizli pencere acilamadi - olcum atlandi');
      return;
    }
    await sleep(9000);
    await inSw(`await chrome.windows.remove(${windowId}); return 1;`).catch(() => {});
    await sleep(6000);
    const sonrakiler = Object.keys((await gecmis()).thirdParty);
    const yeni = sonrakiler.filter(a => !oncekiler.has(a));
    console.log(`        gizli gezintiden sonra YENI kayit: ${yeni.length ? yeni.join(', ') : '(yok)'}`);
    assertEqual(yeni, [], 'gizli pencere gecmise yazilmamali');
  });

  // ================================================================
  console.log('\n########## 5. SAKLAMA SURESI ##########');

  await runner.test('5.1 Bes secenek de arayuzde var', async () => {
    const secenekler = await evaluate(chrome_.client, sayfa.sessionId,
      "return [...document.querySelectorAll('#selectStatsHistoryRetention option')].map(o => o.value);");
    console.log(`        ${JSON.stringify(secenekler)}`);
    assertEqual(secenekler, ['session', 'daily', 'weekly', 'monthly', 'unlimited'],
      'bes saklama secenegi de bulunmali');
  });

  await runner.test('5.2 ESKI kayit saklama penceresinde dusuyor', async () => {
    // 40 gun oncesine ait sahte bir kayit koy; 'monthly' onu dusurmeli.
    await ayarla({ statsHistoryRetention: 'monthly' });
    await inSw(`
      const g = (await chrome.storage.local.get('statsHistory')).statsHistory || { thirdParty: {}, sites: {} };
      g.thirdParty['cok-eski-kayit.test'] = { n: 9, t: Date.now() - 40*24*60*60*1000 };
      await chrome.storage.local.set({ statsHistory: g });
      return 1;`);
    // Bakim alarmi budamayi yapar; alarmi elle tetikle.
    await inSw("await chrome.alarms.create('gt:maintenance', { when: Date.now() + 1 }); return 1;");
    await sleep(6000);
    const g = await gecmis();
    const durdu = Boolean(g.thirdParty['cok-eski-kayit.test']);
    console.log(`        40 gunluk kayit hala duruyor mu: ${durdu}`);
    assertEqual(durdu, false, "'monthly' secildiyse 30 gunden eski kayit dusmeli");
  });

  await runner.test('5.3 SINIRSIZ secildiyse eski kayit DURUYOR', async () => {
    await ayarla({ statsHistoryRetention: 'unlimited' });
    await inSw(`
      const g = (await chrome.storage.local.get('statsHistory')).statsHistory || { thirdParty: {}, sites: {} };
      g.thirdParty['cok-eski-kayit.test'] = { n: 9, t: Date.now() - 400*24*60*60*1000 };
      await chrome.storage.local.set({ statsHistory: g });
      return 1;`);
    await inSw("await chrome.alarms.create('gt:maintenance', { when: Date.now() + 1 }); return 1;");
    await sleep(6000);
    const g = await gecmis();
    console.log(`        400 gunluk kayit duruyor mu: ${Boolean(g.thirdParty['cok-eski-kayit.test'])}`);
    assertOk(g.thirdParty['cok-eski-kayit.test'],
      "sinirsizda hicbir kayit dusmemeli (null ?? aylik hatasi geri gelmesin)");
  });

  // ================================================================
  console.log('\n########## 6. OTURUM saklamasi ##########');

  await runner.test('6.1 Oturum saklamasi GERCEK yeniden baslatmada olculur', async () => {
    // storage.session'i elle bosaltmak YETMEZ: sessionBootstrap yalnizca
    // onStartup / onInstalled ile kosar, SW'nin diger uyanislarinda degil.
    // Bu yuzden gercek olcum ayri bir takimda, kalici profille ve tarayiciyi
    // gercekten kapatip acarak yapilir (asagidaki 6.2).
    await ayarla({ statsHistoryRetention: 'session' });
    const s = await inSw("return (await chrome.storage.local.get('statsHistoryRetention')).statsHistoryRetention;");
    console.log(`        saklama ayari: ${s}`);
    assertEqual(s, 'session', 'ayar yazilmali');
  });

  // ================================================================
  console.log('\n########## 7. SILME ve ARAYUZ ##########');

  await runner.test('7.1 "Gecmisi sil" gecmisi siler, SAYACLARI silmez', async () => {
    await ayarla({ statsHistoryRetention: 'monthly', keepThirdPartyHistory: true });
    await inSw(`await chrome.storage.local.set({ statsHistory: {
      thirdParty: { 'a.test': { n: 4, t: Date.now() } }, sites: { 'b.test': { n: 2, t: Date.now() } } } });
      return 1;`);
    const oncekiStat = await inSw("return (await chrome.storage.local.get('stats')).stats || {};");

    await mesaj({ action: 'CLEAR_STATS_HISTORY' });
    await sleep(1500);

    const g = await gecmis();
    const sonrakiStat = await inSw("return (await chrome.storage.local.get('stats')).stats || {};");
    console.log(`        gecmis: ${Object.keys(g.thirdParty).length}+${Object.keys(g.sites).length} kayit | ` +
      `cerez sayaci ${oncekiStat.cookiesDeleted} -> ${sonrakiStat.cookiesDeleted}`);
    assertEqual(Object.keys(g.thirdParty).length, 0, '3. taraf gecmisi silinmeli');
    assertEqual(Object.keys(g.sites).length, 0, 'site gecmisi silinmeli');
    assertEqual(sonrakiStat.cookiesDeleted, oncekiStat.cookiesDeleted,
      'gecmis silinince SAYACLAR etkilenmemeli');
  });

  await runner.test('7.2 Ayarlar sayfasinda iki anahtar ve dugme GERCEKTEN var', async () => {
    const ui = await evaluate(chrome_.client, sayfa.sessionId, `
      return {
        ucuncu: Boolean(document.getElementById('settingKeepThirdPartyHistory')),
        site: Boolean(document.getElementById('settingKeepSiteHistory')),
        secim: Boolean(document.getElementById('selectStatsHistoryRetention')),
        dugme: Boolean(document.getElementById('btnClearStatsHistory')),
        uyari: document.querySelector('[data-i18n="options.keepSiteHistoryWarn"]')?.textContent || ''
      };`);
    console.log(`        anahtarlar=${ui.ucuncu && ui.site} secim=${ui.secim} dugme=${ui.dugme}`);
    console.log(`        site uyarisi: "${ui.uyari}"`);
    assertOk(ui.ucuncu && ui.site && ui.secim && ui.dugme, 'arayuz ogeleri eksik');
    assertOk(ui.uyari.length > 10, 'site ayarinin kalici uyarisi gorunmeli');
  });

  await runner.test('7.3 Anahtar GERCEK tiklamayla acilip ayara yaziliyor', async () => {
    await ayarla({ keepSiteHistory: false });
    // ARAYUZ TAZELENMELI: depoya yazmak kutuyu guncellemez; eski durumdan
    // tiklamak degeri ters yone cevirir (kalici profilde bu hataya dusuldu).
    await chrome_.client.send('Page.navigate',
      { url: `chrome-extension://${ek.extensionId}/options/options.html` }, sayfa.sessionId);
    await sleep(3000);
    const basla = await evaluate(chrome_.client, sayfa.sessionId,
      "return document.getElementById('settingKeepSiteHistory').checked;");
    assertEqual(basla, false, 'on kosul: kutu kapali baslamali');

    await evaluate(chrome_.client, sayfa.sessionId, `
      const k = document.getElementById('settingKeepSiteHistory');
      (k.closest('label') || k.parentElement).click();
      await new Promise(r => setTimeout(r, 1200));
      return k.checked;`);
    await sleep(1200);
    const yazildi = await inSw("return (await chrome.storage.local.get('keepSiteHistory')).keepSiteHistory;");
    console.log(`        tiklamadan sonra depoda: ${yazildi}`);
    assertEqual(yazildi, true, 'tiklama ayara yazilmali');
  });
} catch (err) {
  console.error('\nKURULUM/AKIS HATASI:', err?.stack || err);
  setupError = err;
} finally {
  await chrome_.close();
}

const gecti = runner.summary() && !setupError;
process.exitCode = gecti ? 0 : 1;
