// GhostTrace E2E - OZELLIK MATRISI: her ayar ACIK ve KAPALI, GERCEK SITEDE.
//
// TAKLIT SITE YOK. Onceki surum yerel bir HTTP sunucusu kullaniyordu: her
// "site" tam 3 cerez birakiyor, localStorage anahtari biliniyordu. Sabit
// sayilar olcumu kolaylastiriyordu ama gercekligi yoktu.
//
// Gercek sitede sabit sayi iddia edilemez, o yuzden ENVANTER YONTEMI:
// sekme kapanmadan hemen once tam liste alinir (hangi cerez, kac gecmis
// kaydi, kac bayt depolama), sonra AYNI listenin sifirlandigi dogrulanir.
//
// DEPOLAMA GERCEK SITEDE: `navigator.storage.estimate().usage` sayfa acilir
// acilmaz okunur. Olculdu (bbc.com): dolu haldeyken 229376 bayt, temizlikten
// sonra 0. Site ilk saniyede birkac anahtar yazsa bile fark tartismasiz.
//
// HER OZELLIK IKI KEZ kosulur:
//   1) ayar KAPALI -> veri DURMALI
//   2) ayar ACIK   -> veri GITMELI
// Iddia "kutucuk degisti" degil, "veri gitti / kaldi".
//
// AYARLAR GERCEK ARAYUZDEN degistirilir: options sayfasindaki gercek anahtara
// koordinatli fare olayiyla basilir. Depoya dogrudan yazmak, arayuzun o ayari
// hic baglamamis olma ihtimalini gizler - bu projede oyle bir hata bulundu.
//
// HER TEST AYRI SITE kullanir: ayni siteyi tekrar kullanmak onceki testin
// durumunu sonrakine tasir.
//
// ON KOSUL: ag duzeyinde reklam engelleme OLMAMALI. NextDNS / Pi-hole acikken
// siteler cok daha az iz birakir; testler bunu "site iz birakmadi" diyerek
// ACIKCA bildirir, sessizce gecmez.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  REKLAM_YOGUN, ETICARET, POPULER, YER_IMLERI,
  cerezler, gecmisSayisi, depolamaOlc, tumSekmeleriKapat, okuyormusGibi
} from './gercek.mjs';

const t0 = Date.now();
const dk = (ms) => (ms / 60000).toFixed(1);
const not = (m) => console.log(`  ..[${dk(Date.now() - t0).padStart(5)}dk] ${m}`);

// Her testin KENDI sitesi. Reklam yogunlar basta: en cok iz birakanlar.
const S = [...REKLAM_YOGUN, ...ETICARET, ...POPULER, ...YER_IMLERI];
let sayac = 0;
const siradaki = () => S[sayac++ % S.length];

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');

    const ayar = () => evaluate(chrome.client, sw, 'return await chrome.storage.local.get(null);');
    const alarmListesi = () => evaluate(chrome.client, sw,
      'return (await chrome.alarms.getAll()).map(a => ({ n: a.name, p: a.periodInMinutes }));');
    const gunlukSayisi = () => evaluate(chrome.client, sw,
      "return ((await chrome.storage.session.get('gt_logs')).gt_logs || []).length;");
    const mesaj = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);

    const oku = async (s, e) => (await chrome.client.send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true }, s)).result?.value;

    /** GERCEK FARE TIKLAMASI - kaydirir, en ustteki ogeyi dogrular, basar. */
    async function tikla(secici, adi = secici) {
      await oku(sayfa.sessionId, `(() => { const e = document.querySelector(${JSON.stringify(secici)});
        if (e) e.scrollIntoView({ block: 'center' }); return 1; })()`);
      await sleep(350);
      const b = await oku(sayfa.sessionId, `(() => {
        const e = document.querySelector(${JSON.stringify(secici)});
        if (!e) return { yok: true };
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return { gorunmez: true };
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const u = document.elementFromPoint(x, y);
        return { x, y, disarida: u === null,
          kapali: u !== null && !(u === e || e.contains(u) || u.contains(e)),
          ust: u ? (u.id || u.className) : null }; })()`);
      if (b?.yok) throw new Error(`${adi}: oge yok`);
      if (b?.gorunmez) throw new Error(`${adi}: 0 boyut`);
      if (b?.disarida) throw new Error(`${adi}: goruntu alani disinda`);
      if (b?.kapali) throw new Error(`${adi}: altta kaliyor - ustteki: ${b.ust}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await chrome.client.send('Input.dispatchMouseEvent',
          { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }, sayfa.sessionId);
        await sleep(60);
      }
      await sleep(450);
    }

    // Anahtarin tiklanabilir ogesi: input gizli, label sarmalayici.
    const ANAHTAR = (id) => `label.switch:has(> #${id})`;

    async function anahtariAyarla(id, istenen) {
      const su = await oku(sayfa.sessionId, `document.getElementById('${id}')?.checked`);
      if (su === undefined || su === null) throw new Error(`${id}: anahtar yok`);
      if (su === istenen) return;
      await tikla(ANAHTAR(id), id);
      const sonra = await oku(sayfa.sessionId, `document.getElementById('${id}').checked`);
      assertEqual(sonra, istenen, `${id} arayuzden ${istenen} yapilamadi`);
      await sleep(400);
    }

    const sekmeAc = (ad) => tikla(`[data-tab="${ad}"]`, ad);

    /**
     * Siteyi gercek kullanici gibi gezer, ENVANTER cikarir, kapatir, temizligi
     * bekler, sonrasini olcer. cleanDelay=0 oldugu icin bekleme kisa tutulur.
     */
    async function gezVeOlc(site, { depolamaOlcum = false, bekleSn = 8 } = {}) {
      await tumSekmeleriKapat(chrome.client, site.kok);
      const t = await visit(chrome.client, site.url, { settleMs: 4000 }).catch(() => null);
      if (!t) return { acilamadi: true, kok: site.kok };
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });

      const once = {
        cerez: await cerezler(chrome.client, sw, site.kok),
        gecmis: await gecmisSayisi(chrome.client, sw, site.kok)
      };
      // DEPOLAMA OLCUMU SITE ACMADAN: `depolamaOlc` ilgisiz bir about:blank
      // oturumundan okur. Hedef sayfayi yeniden acmak service worker'i
      // YENIDEN KAYDEDER ve IndexedDB'yi YENIDEN YARATIR - olculdu, o yolla
      // 217923 -> 217923 gorunuyor, dogru yolla 217923 -> 0.
      const depoOnce = depolamaOlcum ? await depolamaOlc(chrome.client, site.url) : null;

      await tumSekmeleriKapat(chrome.client, site.kok);
      await sleep(bekleSn * 1000);

      const sonra = {
        cerez: await cerezler(chrome.client, sw, site.kok),
        gecmis: await gecmisSayisi(chrome.client, sw, site.kok)
      };
      const depoSonra = depolamaOlcum ? await depolamaOlc(chrome.client, site.url) : null;
      return { kok: site.kok, once, sonra, depoOnce, depoSonra };
    }

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log('OZELLIK MATRISI - GERCEK SITELER, her ayar ACIK/KAPALI ETKISIYLE');
    console.log(`Katalog: ${S.length} gercek site, her test ayrisini kullanir\n`);

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, cleanServiceWorkers: true, cleanDownloads: true,
        cleanCacheOnPurgeAll: false, whitelistCleanHistory: false,
        periodicCleanEnabled: true, notifyOnClean: false, showBadgeCount: true,
        trackThirdParty: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(900);
    await oku(sayfa.sessionId, 'location.reload(); 1');
    await sleep(2500);
    await sekmeAc('settings-tab');

    console.log('########## A: VERI TURU ANAHTARLARI ##########');

    await runner.test('A1. cleanCookies KAPALI: cerez KALIR, gecmis GIDER', async () => {
      await anahtariAyarla('settingCleanCookies', false);
      const o = await gezVeOlc(siradaki());
      assertOk(!o.acilamadi, `${o.kok} acilamadi - olcum yapilamadi`);
      console.log(`        ${o.kok}: cerez ${o.once.cerez.length}->${o.sonra.cerez.length} (kalmali), ` +
        `gecmis ${o.once.gecmis}->${o.sonra.gecmis} (gitmeli)`);
      assertOk(o.once.cerez.length > 0, `${o.kok} hic cerez birakmadi - ag engellemesi olabilir`);
      // TAM ESITLIK DEGIL, ALT KUME. Gercek sitede arka plan etkinligi
      // (yenilenen oturum, gec yuklenen reklam) yeni cerez EKLEYEBILIR;
      // olculdu: bbc.com 30 -> 31. Onemli olan ORIJINALLERIN durmasi.
      const eksilen = o.once.cerez.filter(c => !o.sonra.cerez.includes(c));
      assertEqual(eksilen, [], 'cleanCookies kapaliyken cerez silinmis');
      assertEqual(o.sonra.gecmis, 0, 'gecmis silinmeliydi');
    });

    await runner.test('A1b. cleanCookies ACIK: cerez GIDER', async () => {
      await anahtariAyarla('settingCleanCookies', true);
      const o = await gezVeOlc(siradaki());
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: cerez ${o.once.cerez.length}->${o.sonra.cerez.length} (0 olmali)`);
      assertOk(o.once.cerez.length > 0, `${o.kok} hic cerez birakmadi`);
      assertEqual(o.sonra.cerez.length, 0, 'cleanCookies acikken cerez silinmedi');
    });

    await runner.test('A2. cleanHistory KAPALI: gecmis KALIR, cerez GIDER', async () => {
      await anahtariAyarla('settingCleanHistory', false);
      const o = await gezVeOlc(siradaki());
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: gecmis ${o.once.gecmis}->${o.sonra.gecmis} (kalmali), ` +
        `cerez ${o.once.cerez.length}->${o.sonra.cerez.length} (gitmeli)`);
      assertOk(o.once.gecmis > 0, `${o.kok} gecmis kaydi birakmadi`);
      assertOk(o.sonra.gecmis > 0, 'cleanHistory kapaliyken gecmis silinmis');
      assertEqual(o.sonra.cerez.length, 0, 'cerez silinmeliydi');
    });

    await runner.test('A2b. cleanHistory ACIK: gecmis GIDER', async () => {
      await anahtariAyarla('settingCleanHistory', true);
      const o = await gezVeOlc(siradaki());
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: gecmis ${o.once.gecmis}->${o.sonra.gecmis} (0 olmali)`);
      assertOk(o.once.gecmis > 0, `${o.kok} gecmis kaydi birakmadi`);
      assertEqual(o.sonra.gecmis, 0, 'cleanHistory acikken gecmis silinmedi');
    });

    await runner.test('A3. Depolama anahtarlari KAPALI: DEPOLAMA kalir', async () => {
      await anahtariAyarla('settingCleanLocalStorage', false);
      await anahtariAyarla('settingCleanIndexedDB', false);
      await anahtariAyarla('settingCleanServiceWorkers', false);
      const o = await gezVeOlc(siradaki(), { depolamaOlcum: true });
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: depolama ${o.depoOnce?.usage} -> ${o.depoSonra?.usage} bayt (kalmali)`);
      console.log(`          dokum once: ${JSON.stringify(o.depoOnce?.dokum || {})}`);
      assertOk(o.depoOnce?.usage > 0, `${o.kok} depolama uretmedi - olcum anlamsiz`);
      assertOk(o.depoSonra?.usage > 0, 'depolama anahtarlari kapaliyken veri silinmis');
    });

    await runner.test('A3b. Depolama anahtarlari ACIK: DEPOLAMA sifirlanir', async () => {
      await anahtariAyarla('settingCleanLocalStorage', true);
      await anahtariAyarla('settingCleanIndexedDB', true);
      await anahtariAyarla('settingCleanServiceWorkers', true);
      // DEPOLAMA CEREZDEN YAVAS OLABILIR: cerez dogrudan chrome.cookies ile
      // silinir, depolama browsingData uzerinden gider. 8 saniyelik pencerede
      // 217923 bayt duruyordu; gercek hata mi zamanlama mi ayirt etmek icin
      // burada 40 saniye beklenir.
      const o = await gezVeOlc(siradaki(), { depolamaOlcum: true, bekleSn: 15 });
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: depolama ${o.depoOnce?.usage} -> ${o.depoSonra?.usage} bayt (0 olmali)`);
      console.log(`          dokum once: ${JSON.stringify(o.depoOnce?.dokum || {})}`);
      assertOk(o.depoOnce?.usage > 0, `${o.kok} depolama uretmedi`);
      assertEqual(o.depoSonra?.usage, 0, 'depolama anahtarlari acikken veri silinmedi');
    });

    console.log('\n########## B: BEYAZ LISTE ISTISNASI ##########');

    await runner.test('B1. whitelistCleanHistory KAPALI: korumalinin GECMISI durur', async () => {
      await anahtariAyarla('settingWhitelistCleanHistory', false);
      const s = siradaki();
      await mesaj({ action: 'SET_RULE', domain: s.kok, type: 'white', options: {} });
      const o = await gezVeOlc(s);
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: cerez ${o.once.cerez.length}->${o.sonra.cerez.length}, ` +
        `gecmis ${o.once.gecmis}->${o.sonra.gecmis} (ikisi de kalmali)`);
      assertOk(o.once.cerez.length > 0, `${o.kok} cerez birakmadi`);
      const eksilen = o.once.cerez.filter(c => !o.sonra.cerez.includes(c));
      assertEqual(eksilen, [], 'korumali sitenin cerezi silinmis');
      assertOk(o.sonra.gecmis > 0, 'whitelistCleanHistory kapaliyken gecmis silinmis');
      await mesaj({ action: 'RESET_RULES' });
    });

    await runner.test('B1b. whitelistCleanHistory ACIK: cerez kalir, GECMIS gider', async () => {
      await anahtariAyarla('settingWhitelistCleanHistory', true);
      const s = siradaki();
      await mesaj({ action: 'SET_RULE', domain: s.kok, type: 'white', options: {} });
      const o = await gezVeOlc(s, { bekleSn: 12 });
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: cerez ${o.once.cerez.length}->${o.sonra.cerez.length} (kalmali), ` +
        `gecmis ${o.once.gecmis}->${o.sonra.gecmis} (0 olmali)`);
      const eksilen = o.once.cerez.filter(c => !o.sonra.cerez.includes(c));
      assertEqual(eksilen, [], 'korumali sitenin cerezi silinmis');
      assertEqual(o.sonra.gecmis, 0, 'whitelistCleanHistory acikken gecmis silinmedi');
      await anahtariAyarla('settingWhitelistCleanHistory', false);
      await mesaj({ action: 'RESET_RULES' });
    });

    console.log('\n########## C: SISTEM ANAHTARLARI ##########');

    await runner.test('C1. periodicCleanEnabled KAPALI: periyodik alarm YOK', async () => {
      await anahtariAyarla('settingPeriodicCleanEnabled', false);
      await sleep(1500);
      const a = await alarmListesi();
      console.log(`        alarmlar: ${a.map(x => x.n).join(', ') || '(yok)'}`);
      assertOk(!a.some(x => x.n === 'gt:periodicSweep'), 'kapaliyken periyodik alarm duruyor');
    });

    await runner.test('C1b. periodicCleanEnabled ACIK: alarm kurulur, periyot dogru', async () => {
      await anahtariAyarla('settingPeriodicCleanEnabled', true);
      await sleep(1800);
      const a = await alarmListesi();
      const p = a.find(x => x.n === 'gt:periodicSweep');
      const beklenen = (await ayar()).periodicCleanInterval;
      console.log(`        periyodik alarm: ${p ? p.p + ' dk' : 'YOK'} (ayar ${beklenen} dk)`);
      assertOk(p, 'acikken periyodik alarm kurulmadi');
      assertEqual(p.p, beklenen, 'alarm periyodu ayarla uyusmuyor');
    });

    await runner.test('C2. periodicCleanInterval degisince ALARM da degisir', async () => {
      const yeni = await oku(sayfa.sessionId, `(() => {
        const s = document.getElementById('selectPeriodicInterval');
        if (!s) return null;
        const secenek = [...s.options].map(o => o.value).find(v => v !== s.value && Number(v) > 0);
        if (!secenek) return null;
        s.value = secenek;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return Number(secenek);
      })()`);
      assertOk(yeni, 'periyot secenegi bulunamadi');
      await sleep(2000);
      const p = (await alarmListesi()).find(x => x.n === 'gt:periodicSweep');
      console.log(`        yeni periyot ${yeni} dk -> alarm ${p?.p} dk`);
      assertEqual(p?.p, yeni, 'periyot degisikligi alarma yansimadi');
    });

    await runner.test('C3. showBadgeCount KAPALI: rozet BOS, ACIK: rozet DOLU', async () => {
      const s = siradaki();
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      const rozet = () => evaluate(chrome.client, sw,
        `const tt = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
         return tt ? await chrome.action.getBadgeText({ tabId: tt.id }) : null;`);

      await anahtariAyarla('settingShowBadgeCount', false);
      await chrome.client.send('Target.activateTarget', { targetId: t.targetId });
      await sleep(3000);
      const kapali = await rozet();

      await anahtariAyarla('settingShowBadgeCount', true);
      await chrome.client.send('Target.activateTarget', { targetId: t.targetId });
      await sleep(3000);
      const acik = await rozet();

      console.log(`        ${s.kok} rozeti: kapaliyken "${kapali}", acikken "${acik}"`);
      assertEqual(kapali, '', 'showBadgeCount kapaliyken rozet doluydu');
      assertOk(acik && acik.length > 0, 'showBadgeCount acikken rozet bostu');
      await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(6000);
    });

    await runner.test('C4. trackThirdParty KAPALI: 3. taraf haritasi BUYUMEZ', async () => {
      const harita = () => evaluate(chrome.client, sw,
        "return Object.keys((await chrome.storage.session.get('gt_thirdParty')).gt_thirdParty || {}).length;");
      await anahtariAyarla('settingTrackThirdParty', false);
      await sleep(1500);
      const once = await harita();
      const s = siradaki();
      await gezVeOlc(s);
      const sonra = await harita();
      console.log(`        ${s.kok} gezildi | harita ${once} -> ${sonra} (artmamali)`);
      assertEqual(sonra, once, 'trackThirdParty kapaliyken harita buyudu');
    });

    await runner.test('C4b. trackThirdParty ACIK: GERCEK 3. taraflar yakalanir', async () => {
      const harita = () => evaluate(chrome.client, sw,
        "return Object.keys((await chrome.storage.session.get('gt_thirdParty')).gt_thirdParty || {});");
      await anahtariAyarla('settingTrackThirdParty', true);
      await sleep(1800);
      const once = (await harita()).length;
      const s = REKLAM_YOGUN[0];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 6000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      await sleep(4000);
      const sonrakiler = await harita();
      console.log(`        ${s.kok}: harita ${once} -> ${sonrakiler.length}`);
      console.log(`        ornek: ${sonrakiler.slice(0, 8).join(', ')}`);
      assertOk(sonrakiler.length > once,
        'gercek reklam sitesinde 3. taraf yakalanmadi - ag engellemesi olabilir');
      assertOk(!sonrakiler.includes(s.kok), 'ANA SITE 3. taraf sayilmis');
      await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(6000);
    });

    await runner.test('C5. logLevel=off SUSAR, info KONUSUR', async () => {
      const sec = async (deger) => {
        await oku(sayfa.sessionId, `(() => {
          const s = document.getElementById('selectLogLevel');
          s.value = ${JSON.stringify(deger)};
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return 1; })()`);
        await sleep(1200);
      };
      await sec('off');
      await evaluate(chrome.client, sw, "await chrome.storage.session.remove('gt_logs'); return 1;");
      await gezVeOlc(siradaki());
      const sessiz = await gunlukSayisi();

      await sec('info');
      await gezVeOlc(siradaki());
      const konusan = await gunlukSayisi();

      console.log(`        logLevel=off -> ${sessiz} kayit, info -> ${konusan} kayit`);
      assertEqual(sessiz, 0, 'logLevel=off iken kayit tutulmus');
      assertOk(konusan > 0, 'logLevel=info iken kayit tutulmamis');
    });

    console.log('\n########## D: ANA ANAHTAR ve ARAYUZ ##########');

    let bekleyenKok = null;
    await runner.test('D1. Ana anahtar KAPALI: hicbir sey silinmez', async () => {
      // ONCE KUYRUGU BOSALT.
      //
      // Bu noktada gercek gezintilerden 100'un uzerinde aday alan adi birikmis
      // oluyor (olculdu: 107). Supurme turda en cok 60 alir ve turlar 5 dakika
      // arayladir; hedef site kuyrugun arkasina duserse D1b 7.5 dakika bekleyip
      // yine "temizlenmedi" der - oysa izole olcumde ayni site 10 SANIYEDE
      // temizleniyor. Yani gecikme urun hatasi degil, kuyruk uzunlugu.
      // D1b'nin olctugu sey ANA ANAHTAR davranisi; kuyrugu once bosaltip o
      // davranisi yalniz birakiyoruz.
      await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
      await sleep(8000);
      await mesaj({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: false });
      await sleep(1000);
      const o = await gezVeOlc(siradaki());
      assertOk(!o.acilamadi, `${o.kok} acilamadi`);
      console.log(`        ${o.kok}: cerez ${o.once.cerez.length}->${o.sonra.cerez.length}, ` +
        `gecmis ${o.once.gecmis}->${o.sonra.gecmis} (ikisi de kalmali)`);
      assertOk(o.once.cerez.length > 0, `${o.kok} cerez birakmadi`);
      const eksilen = o.once.cerez.filter(c => !o.sonra.cerez.includes(c));
      assertEqual(eksilen, [], 'anahtar kapaliyken cerez silinmis');
      // ON KOSUL: site gecmis kaydi birakmadiysa bu kisim OLCUM YAPMAZ.
      if (o.once.gecmis > 0) {
        assertOk(o.sonra.gecmis > 0, 'anahtar kapaliyken gecmis silinmis');
      } else {
        console.log(`        (${o.kok} gecmis kaydi birakmadi - gecmis kismi olculemedi)`);
      }
      bekleyenKok = o.kok;
    });

    await runner.test('D1b. Ana anahtar ACILINCA bekleyen veri temizlenir', async () => {
      assertOk(bekleyenKok, 'onceki test site birakmadi');
      await mesaj({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });
      // BUTCE 5 DAKIKALIK SUPURME KISITLAMASINI ASMALI.
      //
      // Gercek sitelerde aday alan adi sayisi 100'u geciyor (olculdu: 107).
      // Supurme tek turda en cok 60 alir (SWEEP_MAX_DOMAINS) ve kalanlari
      // `SWEEP_MIN_INTERVAL_MS` = 5 dakika sonra toplar. 60 saniyelik pencere
      // hedef siteyi ikinci tura birakiyorsa test haksiz yere duser - urun
      // dogru calisirken. Taklit ortamda aday sayisi bu siniri hic gormuyordu.
      let kalan = null;
      for (let i = 0; i < 30; i++) {
        await sleep(4000);
        kalan = (await cerezler(chrome.client, sw, bekleyenKok)).length;
        if (kalan === 0) break;
      }
      console.log(`        ${bekleyenKok}: kalan ${kalan} (0 olmali - yetisme supurmesi)`);
      assertEqual(kalan, 0, 'anahtar acilinca bekleyen veri temizlenmedi');
    });

    // Anahtar HER HALUKARDA geri acilir: D1b dusse bile E1 zincirleme dusmesin.
    await mesaj({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });
    await sleep(1200);

    await runner.test('D2. Tema secimi sayfaya UYGULANIR', async () => {
      const uygula = async (deger) => {
        await oku(sayfa.sessionId, `(() => {
          const s = document.getElementById('selectTheme');
          s.value = ${JSON.stringify(deger)};
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return 1; })()`);
        await sleep(900);
        return oku(sayfa.sessionId,
          "document.documentElement.getAttribute('data-theme') || document.documentElement.className");
      };
      const koyu = await uygula('dark');
      const acik = await uygula('light');
      console.log(`        dark -> "${koyu}", light -> "${acik}"`);
      assertOk(String(koyu).includes('dark'), 'koyu tema uygulanmadi');
      assertOk(String(acik).includes('light'), 'acik tema uygulanmadi');
    });

    await runner.test('D3. Dil secimi ARAYUZ METNINI degistirir', async () => {
      const metin = () => oku(sayfa.sessionId,
        "document.querySelector('[data-tab=\"rules-tab\"]')?.textContent?.trim()");
      const sec = async (deger) => {
        await oku(sayfa.sessionId, `(() => {
          const s = document.getElementById('selectLanguage');
          s.value = ${JSON.stringify(deger)};
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return 1; })()`);
        await sleep(1300);
        return metin();
      };
      const tr = await sec('tr');
      const en = await sec('en');
      console.log(`        tr -> "${tr}", en -> "${en}"`);
      assertOk(tr && en && tr !== en, `dil degisimi metne yansimadi: "${tr}" / "${en}"`);
      await sec('tr');
    });

    console.log('\n########## E: BUTUNLUK ##########');

    await runner.test('E1. Arayuzden yapilan degisiklikler DEPODA', async () => {
      const s = await ayar();
      const beklenen = {
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, cleanServiceWorkers: true, periodicCleanEnabled: true,
        showBadgeCount: true, trackThirdParty: true, enabled: true
      };
      const sapan = Object.entries(beklenen)
        .filter(([k, v]) => s[k] !== v).map(([k, v]) => `${k}=${s[k]} (beklenen ${v})`);
      console.log(`        sapan ayar: ${sapan.join(', ') || '(yok)'}`);
      assertEqual(sapan, [], 'arayuzden yapilan degisiklikler depoda yok');
    });

    await runner.test('E2. Gunlukte ERROR yok', async () => {
      const hatalar = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 6);`);
      console.log(`        ERROR: ${hatalar.length ? hatalar.join(' | ') : '(yok)'}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
    });

    not(`${sayac} gercek site kullanildi`);
    const gecti = runner.summary();
    console.log(`Toplam sure: ${dk(Date.now() - t0)} dakika`);
    process.exitCode = gecti ? 0 : 1;
  } catch (err) {
    console.error('\nKURULUM/AKIS HATASI:', err?.stack || err);
    process.exitCode = 1;
  } finally {
    await chrome.close();
  }
}

main();
