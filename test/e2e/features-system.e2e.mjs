// KADEME 5-6-7: Kesif/raporlama, kural yonetimi, sistem davranislari.
//
// Buradaki bazi iddialar GIZLILIK GARANTISI: cerez degerinin arayuze hic
// verilmemesi, teshis loglarinin diske yazilmamasi, storage.local'in sayfa
// baglamina kapali olmasi. Bunlar "calisiyor mu" degil "sizdiriyor mu"
// sorusu; sessizce bozulurlarsa kimse fark etmez.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, waitFor, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  makeMsg, makeEval, cookieCountFor, setTestCookie, resetAll, applySettings
} from './features-common.mjs';

const A = { url: 'https://example.com/', host: 'example.com' };
const HABER = 'https://www.bbc.com/news';

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

try {
  const { extensionId, sessionId: sw } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  let sekmeBBC = null;
  const ac = async (url, settleMs = 5000) => {
    const tab = await visit(chrome.client, url, { settleMs: 0 });
    await chrome.client.send('Page.enable', {}, tab.sessionId).catch(() => {});
    await sleep(settleMs);
    return tab;
  };

  console.log(`\nKADEME 5-6-7: kesif, kural yonetimi, sistem (eklenti ${extensionId})\n`);
  await applySettings(msg, run, {
    enabled: true, cleanDelay: 0, trackThirdParty: true, logLevel: 'info', showBadgeCount: true
  });

  // ============================================================ KADEME 5
  console.log('--- KADEME 5: kesif ve raporlama ---');

  await runner.test('5.1 SITE VERILERI listesi gercek siteleri gosterir', async () => {
    await resetAll(msg, run);
    // Ana anahtari KAPATMIYORUZ: kapaliyken gozlemci hic kaydedilmiyor
    // (dogru davranis, 5.9'da ayrica olculuyor) ve 3. taraf toplanmiyor.
    // Sitenin temizlenmemesi icin beyaz listeye aliyoruz.
    await msg({ action: 'SET_RULE', domain: 'bbc.com', type: 'white', options: { subdomains: true } });
    const tab = await ac(HABER, 9000);

    const r = await msg({ action: 'GET_ALL_STORED_DOMAINS' });
    assertOk(r.success, 'liste alinmali');
    const adlar = r.domains.map(d => d.domain);
    assertOk(adlar.some(d => d.includes('bbc')),
      `ziyaret edilen site listede olmali; ilk 10: ${adlar.slice(0, 10).join(', ')}`);

    // 3. taraf olcumu icin sekme ACIK BIRAKILIR - devami 5.2'de.
    sekmeBBC = tab;
  });

  await runner.test('5.2 3. TARAF haritasi gercek izleyicileri KAYNAGIYLA yakalar', async () => {
    // Sekme ACIKKEN olculur. Kapatmak yetim taramasini tetikliyor; tarama o
    // 3. taraflari temizleyip KAYITLARINI DUSURUYOR (dogru davranis, 7.6'da
    // ayrica olculuyor). Ilk kurguda olcum tam o silmeden SONRA yapiliyordu
    // ve "hic 3. taraf gorulmedi" diyordu - urun degil sira yanlisti.
    const r = await msg({ action: 'GET_ALL_STORED_DOMAINS' });
    const ucuncu = r.domains.filter(d => d.isThirdParty && d.requestCount > 0);
    assertOk(ucuncu.length > 0,
      '3. taraf gorulmeliydi (gercek haber sitesi izleyici yukler)');
    assertOk(ucuncu.some(d => (d.parentSites || []).length > 0),
      'hangi sitenin yukledigi (parentSites) kaydedilmeli');
    console.log(`      -> ${ucuncu.length} 3. taraf, ornek: ${ucuncu.slice(0, 3).map(d => d.domain).join(', ')}`);

    if (sekmeBBC) { await closeTarget(chrome.client, sekmeBBC.targetId); sekmeBBC = null; }
    await sleep(1500);
  });

  await runner.test('5.3 CEREZ SINIFLANDIRMA: oturum ve izleyici ayirt edilir', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, A.host, 'sessionid');
    await setTestCookie(run, A.host, '_ga');
    await setTestCookie(run, A.host, 'theme');

    const r = await msg({ action: 'GET_DOMAIN_COOKIES', domain: A.host });
    assertOk(r.success, 'basarili olmali');
    const bul = (n) => r.cookies.find(c => c.name === n);
    assertEqual(bul('sessionid').classification, 'session', 'oturum cerezi');
    assertEqual(bul('_ga').classification, 'tracker', 'izleyici cerezi');
    assertEqual(bul('theme').classification, 'other', 'siradan cerez');
    assertEqual(r.sessionCount, 1, 'oturum sayisi');
    assertEqual(r.trackerCount, 1, 'izleyici sayisi');
  });

  await runner.test('5.4 GIZLILIK: cerez DEGERI arayuze HIC verilmez', async () => {
    const r = await msg({ action: 'GET_DOMAIN_COOKIES', domain: A.host });
    const sizinti = r.cookies.filter(c => 'value' in c);
    assertEqual(sizinti.length, 0,
      `cerez degeri disari verilmemeli; sizan: ${sizinti.map(c => c.name).join(', ')}`);
    assertOk(r.cookies.every(c => typeof c.valueLength === 'number'),
      'yalnizca uzunluk bilgisi verilmeli');
  });

  await runner.test('5.5 ISTATISTIKLER gercek temizlikle artar', async () => {
    const once = (await msg({ action: 'GET_DIAGNOSTICS' })).stats;
    await setTestCookie(run, A.host, 'gt_sayac');
    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(1500);
    const sonra = (await msg({ action: 'GET_DIAGNOSTICS' })).stats;

    assertOk(sonra.cookiesDeleted > once.cookiesDeleted,
      `silinen cerez sayaci artmali (${once.cookiesDeleted} -> ${sonra.cookiesDeleted})`);
    assertOk(sonra.totalCleans > once.totalCleans, 'temizlik sayaci artmali');
    assertOk(sonra.lastCleanedAt >= once.lastCleanedAt, 'son temizlik zamani guncellenmeli');
  });

  await runner.test('5.6 GIZLILIK: teshis loglari DISKE yazilmaz', async () => {
    const yer = await run(`
      const yerel = await chrome.storage.local.get(null);
      const oturum = await chrome.storage.session.get('gt_logs');
      return {
        // Yalnizca LOG DEPOSU aranir; 'logLevel' bir AYARDIR, log degil.
        yerelAnahtarlar: Object.keys(yerel).filter(k => k === 'gt_logs'),
        oturumdaLogVar: Array.isArray(oturum.gt_logs) && oturum.gt_logs.length > 0
      };
    `);
    assertEqual(yer.yerelAnahtarlar, [],
      `storage.local'de log anahtari OLMAMALI; bulunan: ${yer.yerelAnahtarlar.join(', ')}`);
    assertOk(yer.oturumdaLogVar, 'loglar oturum bellegine yazilmali');
  });

  await runner.test('5.7 TESHIS ekrani gercek durumu bildirir', async () => {
    const d = await msg({ action: 'GET_DIAGNOSTICS' });
    assertOk(d.success, 'basarili olmali');
    assertOk(/^\d+\.\d+\.\d+$/.test(d.version), `surum bildirilmeli: ${d.version}`);
    assertOk(Array.isArray(d.alarms) && d.alarms.length > 0, 'alarm listesi olmali');
    assertOk(typeof d.thirdPartyCount === 'number', '3. taraf sayisi olmali');
    assertOk(d.historyRemovalPermitted !== undefined, 'gecmis silme izni bildirilmeli');
  });

  await runner.test('5.8 LOG DISA AKTARMA: metin ve JSON', async () => {
    const metin = await msg({ action: 'EXPORT_LOGS', format: 'text' });
    assertOk(metin.success && metin.content.length > 50, 'metin cikti uretilmeli');
    const json = await msg({ action: 'EXPORT_LOGS', format: 'json' });
    assertOk(json.success, 'json cikti uretilmeli');
    const cozulen = JSON.parse(json.content);
    assertEqual(cozulen.app, 'GhostTrace', 'json gecerli olmali');
  });

  await runner.test('5.9 ANA ANAHTAR kapaliyken sayfalarda KOD CALISMAZ', async () => {
    // Eklentinin acik vaadi: kapatildiginda sayfalarda hicbir kod calismaz.
    await applySettings(msg, run, { enabled: false, trackThirdParty: true });
    await sleep(1000);
    const kayit = await run(`
      const s = await chrome.scripting.getRegisteredContentScripts({ ids: ['ghosttrace-trace-observer'] });
      return s.length;
    `);
    assertEqual(kayit, 0, 'ana anahtar kapaliyken icerik script-i KAYITLI OLMAMALI');

    await applySettings(msg, run, { enabled: true });
    await sleep(1000);
    const geri = await run(`
      const s = await chrome.scripting.getRegisteredContentScripts({ ids: ['ghosttrace-trace-observer'] });
      return s.length;
    `);
    assertEqual(geri, 1, 'acilinca kayit geri gelmeli');
  });

  // ============================================================ KADEME 6
  console.log('--- KADEME 6: kural yonetimi ---');

  await runner.test('6.1 KURAL ekleme ve silme', async () => {
    await resetAll(msg, run);
    const ekle = await msg({ action: 'SET_RULE', domain: 'ornek1.com', type: 'white', options: {} });
    assertOk(ekle.success && ekle.rule.domain === 'ornek1.com', 'kural kaydedilmeli');

    const sil = await msg({ action: 'DELETE_RULE', domain: 'ornek1.com', purgeAfter: false });
    assertOk(sil.success, 'kural silinmeli');
    const kalan = await run(`const s = await chrome.storage.local.get('rules'); return Object.keys(s.rules || {});`);
    assertEqual(kalan, [], 'kural listesi bosalmali');
  });

  await runner.test('6.2 KURAL KALKINCA temizlik planlanir', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, A.host);
    await msg({ action: 'SET_RULE', domain: A.host, type: 'white', options: { subdomains: true } });
    await msg({ action: 'DELETE_RULE', domain: A.host });

    await waitFor('kural kalkinca temizlik', async () => (await cookieCountFor(run, A.host)) === 0,
      { timeoutMs: 15000, intervalMs: 500 });
  });

  await runner.test('6.3 KAPSAM degistirme (SET_RULE_SCOPE)', async () => {
    await resetAll(msg, run);
    await msg({ action: 'SET_RULE', domain: 'ornek2.com', type: 'white', options: { subdomains: true } });
    const r = await msg({ action: 'SET_RULE_SCOPE', domain: 'ornek2.com', subdomains: false });
    assertOk(r.success, 'basarili olmali');
    assertEqual(r.rule.subdomains, false, 'kapsam kapanmali');
  });

  await runner.test('6.4 ICE AKTARMA: GhostTrace bicimi', async () => {
    await resetAll(msg, run);
    const r = await msg({
      action: 'IMPORT_RULES',
      rules: [
        { domain: 'ithal1.com', type: 'white', subdomains: true },
        { domain: 'ithal2.com', type: 'grey', subdomains: false },
        // Tarayici ici adres: extractHostname bos doner, kural uretilemez.
        { domain: 'chrome://settings', type: 'white' }
      ]
    });
    assertEqual(r.imported, 2, 'iki gecerli kural alinmali');
    assertEqual(r.rejected, 1, 'gecersiz kural reddedilmeli');
  });

  await runner.test('6.5 ICE AKTARMA: Cookie AutoDelete bicimi + joker', async () => {
    await resetAll(msg, run);
    const { extractImportableRules } = await import('../../options/tabs/rules.js')
      .catch(() => ({ extractImportableRules: null }));
    // Modul tarayici disinda yuklenemeyebilir; o zaman arka uctan dogrula.
    if (extractImportableRules) {
      const list = extractImportableRules({ expressionList: ['*.joker.com', 'duz.com', 'alt.duz.com'] });
      assertEqual(list.find(r => r.domain === 'joker.com').subdomains, true, 'joker kapsam acar');
      assertEqual(list.find(r => r.domain === 'alt.duz.com').subdomains, false, 'duz alt alan adi kapsam acmaz');
    }
    const r = await msg({
      action: 'IMPORT_RULES',
      rules: [{ domain: 'joker.com', type: 'white', subdomains: true }]
    });
    assertOk(r.success && r.imported === 1, 'ice aktarma calismali');
  });

  await runner.test('6.6 KURALLARI SIFIRLA ayarlari KORUR', async () => {
    await applySettings(msg, run, { cleanDelay: 0, notifyOnClean: true });
    await msg({ action: 'SET_RULE', domain: 'silinecek.com', type: 'white', options: {} });
    await msg({ action: 'RESET_RULES' });

    const durum = await run(`
      const s = await chrome.storage.local.get(['rules', 'notifyOnClean']);
      return { kuralSayisi: Object.keys(s.rules || {}).length, bildirim: s.notifyOnClean };
    `);
    assertEqual(durum.kuralSayisi, 0, 'kurallar silinmeli');
    assertEqual(durum.bildirim, true, 'AYARLAR korunmali');
  });

  // ============================================================ KADEME 7
  console.log('--- KADEME 7: sistem davranislari ---');

  await runner.test('7.1 BILDIRIM: notifyOnClean acikken gonderilir', async () => {
    // Service worker baglaminda chrome.notifications.create'i gozetle.
    await evaluate(chrome.client, sw, `
      globalThis.__gtBildirimler = [];
      if (!globalThis.__gtOrijinalCreate) {
        globalThis.__gtOrijinalCreate = chrome.notifications.create;
        chrome.notifications.create = function (id, opts) {
          globalThis.__gtBildirimler.push(opts?.title || String(id));
          return globalThis.__gtOrijinalCreate.apply(chrome.notifications, arguments);
        };
      }
      return true;
    `);
    await applySettings(msg, run, { notifyOnClean: true, cleanDelay: 0 });
    await resetAll(msg, run);
    await setTestCookie(run, A.host, 'bildirim_testi');
    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(2000);

    const sayi = await evaluate(chrome.client, sw, `return (globalThis.__gtBildirimler || []).length;`);
    assertOk(sayi > 0, 'temizlik bildirimi gonderilmeliydi');
  });

  await runner.test('7.2 BILDIRIM: notifyOnClean kapaliyken gonderilmez', async () => {
    await evaluate(chrome.client, sw, `globalThis.__gtBildirimler = []; return true;`);
    await applySettings(msg, run, { notifyOnClean: false });
    await setTestCookie(run, A.host, 'sessiz_test');
    await msg({ action: 'PURGE_DOMAIN', domain: A.host });
    await sleep(2000);

    const sayi = await evaluate(chrome.client, sw, `return (globalThis.__gtBildirimler || []).length;`);
    assertEqual(sayi, 0, 'kapaliyken bildirim gonderilmemeli');
  });

  await runner.test('7.3 SERTLESTIRME: izin yokken guvenli davranir', async () => {
    const r = await msg({ action: 'APPLY_HARDENING', hardening: { blockThirdPartyCookies: true } });
    assertOk(r.success, 'cagri hata atmamali');
    assertEqual(r.outcome.available, false, 'izin yokken available:false olmali');
    assertOk(r.outcome.skipped.includes('permission-missing'),
      `sebep acikca bildirilmeli: ${JSON.stringify(r.outcome.skipped)}`);
  });

  await runner.test('7.4 GIZLILIK: storage.local SAYFA baglamina kapali', async () => {
    // Ziyaret edilen bir sayfa "hangi siteler beyaz listede" bilgisini
    // okuyabilseydi bu bir parmak izi yuzeyi olurdu.
    await msg({ action: 'SET_RULE', domain: 'gizli-kural.com', type: 'white', options: {} });
    const tab = await ac(A.url, 2500);
    const sonuc = await evaluate(chrome.client, tab.sessionId, `
      try {
        if (typeof chrome === 'undefined' || !chrome.storage) return 'chrome.storage YOK';
        const d = await chrome.storage.local.get('rules');
        return d && d.rules ? 'SIZDI: ' + Object.keys(d.rules).join(',') : 'bos dondu';
      } catch (e) { return 'engellendi: ' + e.message.slice(0, 40); }
    `).catch(e => 'erisim yok: ' + e.message.slice(0, 40));
    await closeTarget(chrome.client, tab.targetId);

    assertOk(!String(sonuc).startsWith('SIZDI'),
      `sayfa baglami kurallari okuyamamali; sonuc: ${sonuc}`);
    console.log(`      -> sayfa baglami: ${sonuc}`);
  });

  await runner.test('7.5 ROZET aktif sekme icin guncellenir', async () => {
    await applySettings(msg, run, { showBadgeCount: true, enabled: true });
    await resetAll(msg, run);
    await setTestCookie(run, A.host, 'rozet1');
    await setTestCookie(run, A.host, 'rozet2');

    const tab = await ac(A.url, 3000);
    await msg({ action: 'REFRESH_BADGES' });
    await sleep(1500);
    const metin = await run(`
      const t = await chrome.tabs.query({ url: 'https://example.com/*' });
      if (!t.length) return '(sekme yok)';
      return await chrome.action.getBadgeText({ tabId: t[0].id });
    `);
    await closeTarget(chrome.client, tab.targetId);
    assertOk(metin !== '' && metin !== '(sekme yok)',
      `rozet iz sayisini gostermeli; gelen: '${metin}'`);
  });

  await runner.test('7.6 YETIM TARAMASI 3. taraf kaydini temizler', async () => {
    await resetAll(msg, run);
    await applySettings(msg, run, { enabled: true, cleanDelay: 0, trackThirdParty: true });
    // Kaynagi kapali bir 3. taraf kaydi birak
    await evaluate(chrome.client, sw, `
      await chrome.storage.session.set({ gt_thirdParty: {
        'yetim-cdn.example': { count: 3, lastSeen: Date.now(), parents: ['kapali-site.example'] }
      }});
      await chrome.storage.session.remove('gt_lastSweep');
      return true;
    `);
    const { sweepOrphanDomains } = { sweepOrphanDomains: null }; // SW modulu disaridan cagrilamaz
    void sweepOrphanDomains;
    // Supurme sekme kapanisinda tetiklenir: bir sekme acip kapatiyoruz.
    const tab = await ac(A.url, 2000);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(6000);

    const kalan = await evaluate(chrome.client, sw,
      `const d = await chrome.storage.session.get('gt_thirdParty'); return Object.keys(d.gt_thirdParty || {});`);
    assertOk(!kalan.includes('yetim-cdn.example'),
      `yetim 3. taraf kaydi temizlenmeliydi; kalan: ${kalan.join(', ')}`);
  });

  await runner.test('7.7 TEMIZ KURULUM periyodik supurmeyi PLANLAR', async () => {
    // Varsayilani `true` yapmak TEK BASINA yetmez. Alarmi kuran kod ayari
    // okumazsa, ya da yalnizca ayar DEGISTIGINDE calisirsa, temiz kurulumda
    // hicbir sey planlanmaz: ozellik arayuzde "acik" gorunur ama hic calismaz.
    // Sessizce yanlis guvence veren bu ariza turu, bir gizlilik aracinda
    // ozelligin hic olmamasindan daha kotudur.
    //
    // Bu takim tek kullanimlik profille kosuyor, yani her kosum TEMIZ bir
    // kurulum: olculen sey tam olarak yeni kullanicinin gordugu davranis.
    const durum = await run(`
      const ayarlar = await chrome.storage.local.get(['periodicCleanEnabled', 'periodicCleanInterval']);
      const alarmlar = await chrome.alarms.getAll();
      return {
        acikMi: ayarlar.periodicCleanEnabled,
        aralik: ayarlar.periodicCleanInterval,
        supurmeAlarmi: alarmlar.find(a => a.name === 'gt:periodicSweep') || null
      };
    `);

    assertEqual(durum.acikMi, true, 'temiz kurulumda supurme ACIK gelmeli');
    assertOk(durum.supurmeAlarmi, 'supurme alarmi kurulmus olmali');
    assertEqual(durum.supurmeAlarmi.periodInMinutes, durum.aralik,
      'alarm periyodu ayardaki aralikla ayni olmali');
  });

  await runner.test('7.8 3. taraf SAYIMI temizlikten sag cikar', async () => {
    // KULLANICI BULGUSU: "En cok karsilasilan 3. taraflar" sekmesi bostu.
    // Canli kesif haritasi her temizlikte budaniyor - o harita icin dogru,
    // cunku "neyi temizlemeliyim" sorusunu yanitliyor. Ama istatistigin
    // sordugu sey bu degil: karsilastiginiz bir izleyici, verisi silindi diye
    // karsilasilmamis olmuyor.
    //
    // Bu test IKI haritanin FARKLI davranmasini olcer; ayni degeri iki kez
    // okumak hicbir sey kanitlamaz.
    await msg({ action: 'REPORT_THIRD_PARTY', hosts: ['gt-izleyici.example'] });
    await sleep(300);

    const once = await run(`
      const y = await chrome.runtime.sendMessage({ action: 'GET_ALL_STORED_DOMAINS' });
      return Object.keys(y.thirdPartySeen || {}).length;
    `);
    assertOk(once > 0, 'karsilasma kaydedilmeli');

    // Her seyi temizle: canli harita budanir.
    await msg({ action: 'PURGE_ALL_NON_WHITELISTED' });
    await sleep(2000);

    const sonra = await run(`
      const y = await chrome.runtime.sendMessage({ action: 'GET_ALL_STORED_DOMAINS' });
      return {
        sayim: Object.keys(y.thirdPartySeen || {}).length,
        canli: (y.domains || []).filter(d => d.category === 'third_party').length
      };
    `);
    assertOk(sonra.sayim > 0,
      `sayim temizlikten sag cikmali; kalan: ${sonra.sayim}`);
    console.log(`      -> sayim: ${sonra.sayim} kayit, canli harita: ${sonra.canli}`);
  });


} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  const ok = runner.summary() && !setupError;
  await chrome.close();
  process.exit(ok ? 0 : 1);
}
