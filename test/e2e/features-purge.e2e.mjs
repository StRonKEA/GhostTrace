// KADEME 3-4: Temizlik yollari ve veri turleri.
//
// Yedi ayri temizlik yolu var (sekme kapanisi, gecikmeli alarm, tek site,
// secili siteler, toplu, yalnizca-gecmis, periyodik) ve alti veri turu.
// Her birinin AYRI dogrulanmasi gerekiyor: birinin calismasi digerini
// garanti etmiyor - bu oturumda tam da oyle bir sapma bulundu.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  sleep, waitFor, createRunner, assertEqual, assertOk, evaluate
} from './harness.mjs';
import {
  makeMsg, makeEval, cookieCountFor,
  setTestCookie, resetAll, applySettings, alarmNames
} from './features-common.mjs';

// Kontrollu, reklamsiz, kararli gercek origin'ler.
const A = { url: 'https://example.com/', host: 'example.com' };
const B = { url: 'https://www.iana.org/', host: 'iana.org' };

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  const ac = async (url, settleMs = 4000) => {
    const tab = await visit(chrome.client, url, { settleMs: 0 });
    await chrome.client.send('Page.enable', {}, tab.sessionId).catch(() => {});
    await sleep(settleMs);
    return tab;
  };
  const sayfaCalistir = (tab, expr) => chrome.client.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true
  }, tab.sessionId).then(r => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'sayfa hatasi');
    return r.result.value;
  });

  /**
   * Bir origin'e localStorage + IndexedDB yazar.
   *
   * Yazma sirasinda OTOMATIK TEMIZLIK KAPATILIR: sekmeyi kapatmak cleanDelay
   * 0 iken aninda temizlik tetikliyor ve tohum daha olculmeden siliniyordu.
   * Ilk kurguda bu, bazi testleri YANLIS SEBEPLE yesil gosteriyordu.
   */
  async function veriYaz(url) {
    await run(`await chrome.storage.local.set({ enabled: false }); return true;`);
    await msg({ action: 'SETTINGS_CHANGED' });
    const tab = await ac(url, 2500);
    await sayfaCalistir(tab, `
      localStorage.setItem('gt_ls', 'var');
      await new Promise((ok, hata) => {
        const req = indexedDB.open('gt_db', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('s');
        req.onsuccess = () => { req.result.close(); ok(); };
        req.onerror = () => hata(req.error);
      });
      return true;
    `);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(600);
    await run(`await chrome.storage.local.set({ enabled: true }); return true;`);
    await msg({ action: 'SETTINGS_CHANGED' });
    await sleep(300);
  }

  /** Origin'deki veriyi OKUR (yazmadan) - okuma da temizlik tetiklemesin. */
  async function veriOku(url) {
    await run(`await chrome.storage.local.set({ enabled: false }); return true;`);
    await msg({ action: 'SETTINGS_CHANGED' });
    const tab = await ac(url, 2500);
    const sonuc = await sayfaCalistir(tab, `
      const ls = localStorage.getItem('gt_ls');
      const dbler = (await indexedDB.databases()).map(d => d.name);
      return { ls, idb: dbler.includes('gt_db') };
    `);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(400);
    await run(`await chrome.storage.local.set({ enabled: true }); return true;`);
    await msg({ action: 'SETTINGS_CHANGED' });
    return sonuc;
  }

  const gecmisSayisi = (metin) => run(
    `const h = await chrome.history.search({ text: ${JSON.stringify(metin)}, startTime: 0, maxResults: 500 });
     return h.length;`);

  console.log(`\nKADEME 3-4: temizlik yollari ve veri turleri (eklenti ${extensionId})\n`);

  // ============================================================ KADEME 3
  console.log('--- KADEME 3: yedi temizlik yolu ---');

  await runner.test('3.1 TEK SITE temizligi (PURGE_DOMAIN)', async () => {
    await applySettings(msg, run, { enabled: true, cleanDelay: 0 });
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    await setTestCookie(run, B.host);

    const r = await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    assertOk(r.success, `temizlik basarili olmali: ${JSON.stringify(r)}`);
    assertEqual(await cookieCountFor(run, A.host), 0, 'hedef silinmeli');
    assertOk(await cookieCountFor(run, B.host) > 0, 'digeri dokunulmamali');
  });

  await runner.test('3.2 SECILI SITELER temizligi (PURGE_SELECTED_DOMAINS)', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    await setTestCookie(run, B.host);
    await setTestCookie(run, 'github.com');

    const r = await msg({ action: 'PURGE_SELECTED_DOMAINS', domains: [A.host, B.host] });
    assertOk(r.success, 'basarili olmali');
    assertEqual(await cookieCountFor(run, A.host), 0, 'A silinmeli');
    assertEqual(await cookieCountFor(run, B.host), 0, 'B silinmeli');
    assertOk(await cookieCountFor(run, 'github.com') > 0, 'secilmeyen dokunulmamali');
  });

  await runner.test('3.3 SECILI SITELER korumalıyı ATLAR ve raporlar', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    await setTestCookie(run, B.host);
    await msg({ action: 'SET_RULE', domain: B.host, type: 'white', options: { subdomains: true } });

    const r = await msg({ action: 'PURGE_SELECTED_DOMAINS', domains: [A.host, B.host] });
    assertEqual(r.skippedProtected, 1, 'korumali site atlandi diye raporlanmali');
    assertOk(await cookieCountFor(run, B.host) > 0, 'korumali durmali');
  });

  await runner.test('3.4 TOPLU temizlik (PURGE_ALL_NON_WHITELIST)', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    await setTestCookie(run, B.host);
    await msg({ action: 'SET_RULE', domain: A.host, type: 'white', options: { subdomains: true } });

    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);
    assertOk(await cookieCountFor(run, A.host) > 0, 'beyaz liste durmali');
    assertEqual(await cookieCountFor(run, B.host), 0, 'digeri gitmeli');
  });

  await runner.test('3.5 GECIKME 0: sekme kapaninca ANINDA temizlenir', async () => {
    await applySettings(msg, run, { enabled: true, cleanDelay: 0 });
    await resetAll(msg, run);
    const tab = await ac(A.url);
    await setTestCookie(run, A.host);
    await closeTarget(chrome.client, tab.targetId);

    await waitFor('aninda temizlik', async () => (await cookieCountFor(run, A.host)) === 0,
      { timeoutMs: 15000, intervalMs: 500 });
  });

  await runner.test('3.6 GECIKME 60: hemen silinmez, ALARM kurulur', async () => {
    await applySettings(msg, run, { enabled: true, cleanDelay: 60 });
    await resetAll(msg, run);
    const tab = await ac(A.url);
    await setTestCookie(run, A.host);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(4000);

    assertOk(await cookieCountFor(run, A.host) > 0,
      'gecikme dolmadan silinmemeli');
    const alarms = await alarmNames(run);
    assertOk(alarms.some(a => a.startsWith('gt:purge:')),
      `temizlik alarmi kurulmali; alarmlar: ${alarms.join(', ')}`);
    await applySettings(msg, run, { cleanDelay: 0 });
  });

  await runner.test('3.7 ANA ANAHTAR kapaliyken HICBIR SEY silinmez', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: false });

    const tab = await ac(A.url);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(5000);
    assertOk(await cookieCountFor(run, A.host) > 0, 'kapaliyken silinmemeli');

    const alarms = await alarmNames(run);
    assertOk(!alarms.some(a => a.startsWith('gt:purge:')),
      'kapaliyken bekleyen temizlik alarmi kalmamali');
    await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });
  });

  await runner.test('3.8 PERIYODIK supurme alarmi kurulur ve kaldirilir', async () => {
    await applySettings(msg, run, { periodicCleanEnabled: true, periodicCleanInterval: 15 });
    await sleep(800);
    assertOk((await alarmNames(run)).includes('gt:periodicSweep'), 'periyodik alarm kurulmali');

    await applySettings(msg, run, { periodicCleanEnabled: false });
    await sleep(800);
    assertOk(!(await alarmNames(run)).includes('gt:periodicSweep'), 'kapatilinca alarm kalkmali');
  });

  await runner.test('3.9 BAKIM alarmi her zaman kurulu', async () => {
    assertOk((await alarmNames(run)).includes('gt:maintenance'), 'bakim alarmi olmali');
  });

  // ------------------------------------------- beyaz liste istisnasi
  await runner.test('3.10 YALNIZCA GECMIS temizligi (beyaz listedeki site)', async () => {
    await applySettings(msg, run, { enabled: true, cleanDelay: 0, cleanHistory: true });
    await resetAll(msg, run);
    await msg({ action: 'SET_RULE', domain: A.host, type: 'white', options: { subdomains: true } });

    const tab = await ac(A.url);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(1500);
    await setTestCookie(run, A.host);
    assertOk(await gecmisSayisi('example.com') > 0, 'once gecmis kaydi olmali');

    const r = await msg({ action: 'PURGE_DOMAIN_HISTORY_ONLY', domain: A.host });
    assertOk(r.success, 'basarili olmali');
    assertEqual(await gecmisSayisi('example.com'), 0, 'gecmis gitmeli');
    assertOk(await cookieCountFor(run, A.host) > 0, 'CEREZ korunmali - yalnizca gecmis silinir');
  });

  await runner.test('3.11 TOPLU temizlik ACIK sekmeyi atlar, kapaninca temizler', async () => {
    await applySettings(msg, run, { enabled: true, cleanDelay: 0 });
    await resetAll(msg, run);
    await msg({ action: 'SET_RULE', domain: 'github.com', type: 'white', options: { subdomains: true } });
    await setTestCookie(run, 'github.com', 'beyaz');
    await setTestCookie(run, A.host, 'acik');
    await setTestCookie(run, B.host, 'kapali');

    const tab = await ac(A.url);
    const sonuc = await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(2500);

    assertOk(sonuc.skippedOpen >= 1, 'atlanan acik site raporlanmali');
    assertOk(await cookieCountFor(run, 'github.com') > 0, 'beyaz liste korunmali');
    assertOk(await cookieCountFor(run, A.host) > 0, 'ACIK sekmenin verisi korunmali');
    assertEqual(await cookieCountFor(run, B.host), 0, 'kapali site temizlenmeli');

    // Erteleme degil iptal DEGIL: sekme kapaninca is tamamlanmali.
    await closeTarget(chrome.client, tab.targetId);
    await waitFor('sekme kapaninca temizlik', async () =>
      (await cookieCountFor(run, A.host)) === 0, { timeoutMs: 20000, intervalMs: 700 });
  });

  // ============================================================ KADEME 4
  console.log('--- KADEME 4: veri turleri ve tur anahtarlari ---');

  await runner.test('4.1 CEREZ + GECMIS + localStorage + IndexedDB birlikte silinir', async () => {
    await applySettings(msg, run, {
      enabled: true, cleanDelay: 0, cleanCookies: true, cleanHistory: true,
      cleanLocalStorage: true, cleanIndexedDB: true
    });
    await resetAll(msg, run);
    await veriYaz(A.url);
    await setTestCookie(run, A.host);

    const once = await veriOku(A.url);
    assertOk(once.ls === 'var' && once.idb, `once veri olmali: ${JSON.stringify(once)}`);

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(2500);

    assertEqual(await cookieCountFor(run, A.host), 0, 'cerez gitmeli');
    assertEqual(await gecmisSayisi('example.com'), 0, 'gecmis gitmeli');
    const sonra = await veriOku(A.url);
    assertEqual(sonra.ls, null, 'localStorage gitmeli');
    assertEqual(sonra.idb, false, 'IndexedDB gitmeli');
  });

  await runner.test('4.2 cleanCookies KAPALI: cerez KORUNUR', async () => {
    await applySettings(msg, run, { cleanCookies: false, cleanHistory: true });
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    const tab = await ac(A.url);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(1200);

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(1500);
    assertOk(await cookieCountFor(run, A.host) > 0, 'tur kapaliyken cerez korunmali');
    await applySettings(msg, run, { cleanCookies: true });
  });

  await runner.test('4.3 cleanHistory KAPALI: gecmis KORUNUR', async () => {
    await applySettings(msg, run, { cleanHistory: false, cleanCookies: true });
    await resetAll(msg, run);
    const tab = await ac(A.url);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(1500);
    assertOk(await gecmisSayisi('example.com') > 0, 'once gecmis olmali');

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(1500);
    assertOk(await gecmisSayisi('example.com') > 0, 'tur kapaliyken gecmis korunmali');
    await applySettings(msg, run, { cleanHistory: true });
  });

  await runner.test('4.4 cleanLocalStorage KAPALI: localStorage KORUNUR', async () => {
    await applySettings(msg, run, { cleanLocalStorage: false });
    await resetAll(msg, run);
    await veriYaz(A.url);

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(2500);
    const sonra = await veriOku(A.url);
    assertEqual(sonra.ls, 'var', 'tur kapaliyken localStorage korunmali');
    await applySettings(msg, run, { cleanLocalStorage: true });
  });

  await runner.test('4.5 cleanIndexedDB KAPALI: IndexedDB KORUNUR', async () => {
    await applySettings(msg, run, { cleanIndexedDB: false, cleanLocalStorage: true });
    await resetAll(msg, run);
    await veriYaz(A.url);

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(2500);
    const sonra = await veriOku(A.url);
    assertEqual(sonra.idb, true, 'tur kapaliyken IndexedDB korunmali');
    assertEqual(sonra.ls, null, 'localStorage yine de gitmeli (tur acik)');
    await applySettings(msg, run, { cleanIndexedDB: true });
  });

  await runner.test('4.6 KAPSAM DISI origin etkilenmez', async () => {
    await applySettings(msg, run, { cleanLocalStorage: true, cleanIndexedDB: true });
    await resetAll(msg, run);
    await veriYaz(A.url);
    await veriYaz(B.url);

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(2500);

    const a = await veriOku(A.url);
    const b = await veriOku(B.url);
    assertEqual(a.ls, null, 'hedefin verisi gitmeli');
    assertEqual(b.ls, 'var', 'kapsam disi origin dokunulmamali');
  });

  await runner.test('4.7 ADSIZ cerez GERCEKTEN silinir', async () => {
    // Kullanicinin gercek gunlugunden gelen ariza: bir cerez bes temizlikte
    // de silinemedi (attempted 1, failed 1, removed 0 - her seferinde ayni).
    //
    // Sebep: siteler `document.cookie = "=deger"` ile ADSIZ cerez
    // olusturabiliyor. Chrome bunu kuruyor, getAll donduruyor ve
    // remove({name:''}) ile siliniyor - ama removeCookie'nin girisindeki
    // `!cookie.name` kosulu bos dizeyi falsy gorup remove'u HIC CAGIRMIYORDU.
    //
    // Taklit stub bunu gosteremezdi: hatanin tamami "bos dize falsy'dir"
    // JavaScript davranisinda ve gercek Chrome'un adsiz cerezi KABUL
    // etmesinde. Olcum bu yuzden gercek tarayicida.
    await resetAll(msg, run);

    const H = JSON.stringify(A.host);
    const kuruldu = await run(
      'await chrome.cookies.set({' +
      '  url: "https://" + ' + H + ' + "/", name: "", value: "adsiz",' +
      '  domain: ' + H + ', path: "/",' +
      '  expirationDate: Math.floor(Date.now()/1000) + 3600' +
      '});' +
      'const hepsi = await chrome.cookies.getAll({ url: "https://" + ' + H + ' + "/" });' +
      'return hepsi.map(c => c.name);'
    );
    assertOk(kuruldu.includes(''),
      `adsiz cerez kurulmali; bulunan: ${JSON.stringify(kuruldu)}`);

    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(1500);

    const kalan = await cookieCountFor(run, A.host);
    assertEqual(kalan, 0, 'adsiz cerez de temizlenmeli');
  });

  await runner.test('4.8 POPUP onay kapisi GERCEK sayfada duruyor', async () => {
    // BOSLUK BUYDU: popup'i yalnizca yerlesim testi aciyordu, o da olcum
    // icin. Birim testleri TAKLIT DOM kullaniyor, ekran goruntulerinde ise
    // bloklari elle actim. Yani onay kapisinin GERCEK eklenti sayfasinda da
    // yerinde durdugu hic otomatik olarak dogrulanmiyordu.
    const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
    await sleep(900);

    const onay = await evaluate(chrome.client, popup.sessionId, `
      const kutu = document.getElementById('confirmBox');
      const kararlar = document.getElementById('decisionBlock');
      return JSON.stringify({
        kutuVar: Boolean(kutu),
        kutuGizli: kutu ? kutu.classList.contains('hidden') : null,
        kararlarVar: Boolean(kararlar),
        evetVar: Boolean(document.getElementById('btnConfirmYes')),
        hayirVar: Boolean(document.getElementById('btnConfirmNo'))
      });
    `);
    const o = JSON.parse(onay);
    assertOk(o.kutuVar && o.kararlarVar, 'onay ve karar bloklari sayfada olmali');
    assertOk(o.evetVar && o.hayirVar, 'onay dugmeleri sayfada olmali');
    assertEqual(o.kutuGizli, true, 'onay bloku basta GIZLI olmali');

    // Vazgec dugmesi BELIRGIN SEKILDE genis olmali: yanlis tik korumasi
    // konumdan geliyor, animasyon suresinden degil. Esit olsalardi
    // tetikleyicinin ortasina gelen ikinci tik kumar olurdu.
    const oran = await evaluate(chrome.client, popup.sessionId, `
      // Popup eklenti sayfasinda aciliyor, bu yuzden eylemler bolumu
      // gizli. Gizli bir kabin icindeki ogenin genisligi 0'dir - olcumden
      // once kabi da acmak gerekiyor.
      const bolum = document.getElementById('actionsSection');
      const bolumGizliydi = bolum.classList.contains('hidden');
      bolum.classList.remove('hidden');
      const kutu = document.getElementById('confirmBox');
      kutu.classList.remove('hidden');
      const hayir = document.getElementById('btnConfirmNo').getBoundingClientRect().width;
      const evet = document.getElementById('btnConfirmYes').getBoundingClientRect().width;
      kutu.classList.add('hidden');
      if (bolumGizliydi) bolum.classList.add('hidden');
      return JSON.stringify({ hayir: Math.round(hayir), evet: Math.round(evet) });
    `);
    const g = JSON.parse(oran);
    assertOk(g.hayir > g.evet * 1.5,
      'Vazgec belirgin sekilde genis olmali; olculen hayir=' + g.hayir + 'px evet=' + g.evet + 'px');
    console.log('      -> onay kapisi yerinde | Vazgec ' + g.hayir + 'px, Evet ' + g.evet + 'px');
  });

} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  const ok = runner.summary() && !setupError;
  await chrome.close();
  process.exit(ok ? 0 : 1);
}
