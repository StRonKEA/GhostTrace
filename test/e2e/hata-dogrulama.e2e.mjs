// GhostTrace E2E - BULUNAN HATALARIN GERCEK SITEDE DOGRULANMASI.
//
// Bu dosyanin tek isi var: bu projede BULUNMUS ve DUZELTILMIS urun hatalarinin
// gercek sitelerde, gercek arayuzden bir daha olmadigini kanitlamak.
//
// Birim testleri (scenarios.test.js L/M/N bloklari) her hatanin mekanizmasini
// taklit `chrome.*` uzerinde kilitliyor. Burasi ayni hatalari GERCEK Chrome'da,
// GERCEK sitelerde ve GERCEK popup tiklamalariyla yeniden dener. Uc hatanin
// ucu de zaten yalnizca bu kosullarda gorunmustu:
//
//   HATA 1 - Ana anahtar acilinca biriken veri bekliyordu.
//     Anahtar kapaliyken sekme kapanislari HIC alarm kurmuyor; geri acilinca
//     o veriyi bekleyen hicbir sey yoktu. Bir sonraki periyodik supurmeye
//     (varsayilan 60 dk) kaliyordu. Olculdu: 120 saniye sonra hala duruyordu.
//     Duzeltme: SET_AUTOMATIC_CLEANING_ENABLED acilista yetisme supurmesi
//     tetikliyor (silmez, PLANLAR: cleanDelay'e uyar, acik sekmeye dokunmaz).
//
//   HATA 2 - Popup'tan verilen sureli izin HIC DOLMUYORDU.
//     Popup yalnizca `durationMinutes` gonderiyor, ayarlar sayfasi ayrica
//     `expiresAt` hesapliyordu; normalizeRule yalnizca ikincisini okudugu icin
//     popup yolunda bitis yazilmiyor, alarm kurulmuyordu. "1 saat koru" =
//     sonsuza kadar koru. Duzeltme: normalizeRule bitisi SUREDEN turetiyor,
//     donusum tek yerde toplandi.
//
//   HATA 3 - Son sekme ALT ALAN ADINDAYSA cerezler hic silinmiyordu.
//     Kullanici siteyi gezip son olarak bir alt alan adinda birakinca kapsam
//     oraya cipalaniyor; sitenin cerezleri UST alan adinda oldugu icin ne
//     cekiliyor ne esleşiyordu. Arayuz "Temizlendi" diyor, cerezler duruyordu -
//     ne uyari ne hata. Duzeltme: kapsam kayit edilebilir alan adina genisler
//     (kok ya da alt alan adi korumaliysa GENISLEMEZ).
//
//   HATA 4 (kucuk) - Popup kapsam dugmelerinin erisilebilir ADI yoktu.
//     Metinleri aktif sekme verisi dolduruyordu; veri gelmeden dugmeler
//     adsizdi. Duzeltme: data-i18n ile varsayilan ad.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, attach, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  REKLAM_YOGUN, POPULER, cerezler, tumSekmeleriKapat, okuyormusGibi
} from './gercek.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(6)}sn] ${m}`);

// HATA 3 icin GERCEK bir alt alan adi ailesi gerekiyor: alt alan adindan
// girilecek, cerezler UST alan adinda duracak. Wikipedia tam boyle - dil
// alt alan adlarindan girilir, cerezler `.wikipedia.org` uzerindedir.
const AILE = {
  kok: 'wikipedia.org',
  altUrl: 'https://tr.wikipedia.org/wiki/Gizlilik',
  altHost: 'tr.wikipedia.org'
};

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);
    const kurallar = () => evaluate(chrome.client, sw,
      "return (await chrome.storage.local.get('rules')).rules || {};");
    const alarmlar = () => evaluate(chrome.client, sw,
      'return (await chrome.alarms.getAll()).map(a => a.name).sort();');

    /** GERCEK popup - simgeye tiklamanin karsiligi. */
    async function popupAc() {
      await evaluate(chrome.client, sw,
        'try { chrome.action.openPopup(); } catch { /* acik olabilir */ } return 1;');
      await sleep(1400);
      const { targetInfos } = await chrome.client.send('Target.getTargets');
      const p = targetInfos.find(t => t.url.includes('popup/popup.html'));
      if (!p) throw new Error('popup acilmadi');
      const sessionId = await attach(chrome.client, p.targetId);
      await chrome.client.send('Runtime.enable', {}, sessionId);
      await sleep(800);
      return { sessionId, targetId: p.targetId };
    }
    const popupKapat = async (p) => {
      await chrome.client.send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
      await sleep(300);
    };
    const oku = async (s, e) => (await chrome.client.send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true }, s)).result?.value;

    /** GERCEK FARE TIKLAMASI - element.click() degil. */
    async function tikla(sessionId, secici, adi = secici) {
      const b = await oku(sessionId, `(() => {
        const e = document.querySelector(${JSON.stringify(secici)});
        if (!e) return { yok: true };
        e.scrollIntoView({ block: 'center' });
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
          { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }, sessionId);
        await sleep(70);
      }
      await sleep(700);
    }

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log('BULUNAN HATALARIN GERCEK SITEDE DOGRULANMASI\n');

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, cleanServiceWorkers: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(800);

    // ================================================================
    console.log('########## HATA 1: ana anahtar yetisme supurmesi ##########');
    // Kuyrugu bosalt: gercek gezintide 100+ aday birikiyor, hedef site
    // kuyrugun arkasina duserse olcum urunu degil kuyrugu olcer.
    await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(8000);

    const h1Site = REKLAM_YOGUN[2];       // hurriyet.com.tr
    let h1Once = 0;
    let h3Envanter = null;   // HATA 3 on kosul testinden gelir
    await runner.test('1.1 Anahtar KAPALIYKEN sekme kapanisi HICBIR SEY silmez', async () => {
      await mesaj({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: false });
      await sleep(1000);
      await tumSekmeleriKapat(chrome.client, h1Site.kok);
      const t = await visit(chrome.client, h1Site.url, { settleMs: 4000 });
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      h1Once = (await cerezler(chrome.client, sw, h1Site.kok)).length;
      assertOk(h1Once > 0, `${h1Site.kok} cerez birakmadi - olcum yapilamaz`);

      await tumSekmeleriKapat(chrome.client, h1Site.kok);
      await sleep(20000);
      const kalan = (await cerezler(chrome.client, sw, h1Site.kok)).length;
      console.log(`        ${h1Site.kok}: ${h1Once} -> ${kalan} (degismemeli)`);
      assertEqual(kalan, h1Once, 'anahtar kapaliyken silme yapildi');
    });

    await runner.test('1.2 DUZELTME: anahtar ACILINCA bekleyen veri temizlenir', async () => {
      // HATA BUYDU: eskiden burada hicbir sey olmuyordu; veri bir sonraki
      // periyodik supurmeye (60 dk) kaliyordu. Olculmustu: 120 sn sonra durur.
      const bas = Date.now();
      await mesaj({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });
      let kalan = h1Once;
      for (let i = 0; i < 30; i++) {
        await sleep(4000);
        kalan = (await cerezler(chrome.client, sw, h1Site.kok)).length;
        if (kalan === 0) break;
      }
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${h1Site.kok}: ${h1Once} -> ${kalan}, ${gecen.toFixed(0)}sn`);
      assertEqual(kalan, 0, 'HATA 1 GERI GELDI: anahtar acilinca bekleyen veri temizlenmedi');
    });

    // ================================================================
    console.log('\n########## HATA 2: popup sureli izni ##########');
    const h2Site = POPULER[4];            // imdb.com
    await runner.test('2.1 DUZELTME: popup "1 saat" GERCEKTEN bitis zamani yaziyor', async () => {
      // HATA BUYDU: popup yalnizca durationMinutes gonderiyordu, expiresAt
      // bos kaliyor ve snooze alarmi HIC kurulmuyordu -> izin hic dolmuyordu.
      await mesaj({ action: 'RESET_RULES' });
      await tumSekmeleriKapat(chrome.client, h2Site.kok);
      await visit(chrome.client, h2Site.url, { settleMs: 4000 });

      const p = await popupAc();
      await tikla(p.sessionId, '#cardProtect', 'Koru');
      await tikla(p.sessionId, '.durseg__b[data-dur="60"]', '1 saat');
      await popupKapat(p);
      await sleep(1200);

      const k = (await kurallar())[h2Site.kok];
      const kalanDk = k?.expiresAt ? (k.expiresAt - Date.now()) / 60000 : null;
      const a = await alarmlar();
      const snooze = a.find(x => x.includes(h2Site.kok));
      console.log(`        ${h2Site.kok}: tip=${k?.type} bitis=${k?.expiresAt ? 'VAR' : 'YOK'} ` +
        `kalan=${kalanDk?.toFixed(0)}dk`);
      console.log(`        snooze alarmi: ${snooze || 'YOK'}`);

      assertEqual(k?.type, 'temp', 'popup sureli kural olusturmadi');
      assertOk(k?.expiresAt,
        'HATA 2 GERI GELDI: popup sureli izninde BITIS ZAMANI yazilmiyor');
      assertOk(kalanDk >= 58 && kalanDk <= 61, `1 saat yerine ${kalanDk?.toFixed(1)} dakika`);
      assertOk(snooze,
        'HATA 2 GERI GELDI: sureli izin ALARMI kurulmuyor - izin hic dolmazdi');
    });

    await runner.test('2.2 Popup "Kalici" secilince bitis zamani KALKAR', async () => {
      const p = await popupAc();
      await tikla(p.sessionId, '.durseg__b[data-dur="white"]', 'Kalici');
      await popupKapat(p);
      await sleep(1000);
      const k = (await kurallar())[h2Site.kok];
      console.log(`        ${h2Site.kok}: tip=${k?.type} bitis=${k?.expiresAt || 'yok'}`);
      assertEqual(k?.type, 'white', 'kalici secilmedi');
      assertOk(!k?.expiresAt, 'kalici kuralda bitis zamani kalmis');
      await mesaj({ action: 'RESET_RULES' });
    });

    // ================================================================
    console.log('\n########## HATA 3: alt alan adindan cikis ##########');
    await runner.test('3.1 ON KOSUL: alt alan adindan girilince cerezler USTTE', async () => {
      await tumSekmeleriKapat(chrome.client, AILE.kok);
      await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
      await sleep(6000);
      const t = await visit(chrome.client, AILE.altUrl, { settleMs: 4000 });
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });

      const hepsi = await cerezler(chrome.client, sw, AILE.kok);
      const ustte = hepsi.filter(c => !c.startsWith(AILE.altHost + '|'));
      console.log(`        ${AILE.altHost} gezildi | toplam ${hepsi.length} cerez, ` +
        `ust alan adinda ${ustte.length}`);
      console.log(`        ornek: ${hepsi.slice(0, 5).join(', ')}`);
      assertOk(hepsi.length > 0, 'olcum icin cerez gerekli');
      assertOk(ustte.length > 0,
        'bu ailede cerezler ust alan adinda degil - HATA 3 senaryosu kurulamaz');
      h3Envanter = { hepsi, ustte };
    });

    await runner.test('3.2 DUZELTME: alt alan adindan cikista UST alan adi da temizlenir', async () => {
      // HATA BUYDU: kapsam alt alan adina cipalaniyordu; ust alan adindaki
      // cerezler ne cekiliyor ne esleşiyordu. Gunluk "cerez: 0" yazip
      // BASARIYLA bitiyordu - ne uyari ne hata.
      assertOk(h3Envanter, 'on kosul testi envanter birakmadi');
      const { hepsi } = h3Envanter;
      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, AILE.kok);
      let kalan = hepsi.length;
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        kalan = (await cerezler(chrome.client, sw, AILE.kok)).length;
        if (kalan === 0) break;
      }
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${AILE.kok}: ${hepsi.length} -> ${kalan} cerez, ${gecen.toFixed(0)}sn`);
      assertEqual(kalan, 0,
        'HATA 3 GERI GELDI: alt alan adindan cikista ust alan adinin cerezleri kaldi');
    });

    await runner.test('3.3 Kok KORUMALIYSA kapsam genislemez (duzeltme fazla silmiyor)', async () => {
      // Duzeltmenin sinirini olcer: kok korumaliysa alt alan adindan cikis
      // kokü SILMEMELI. Fazla silen bir duzeltme, hatadan beter olurdu.
      await mesaj({ action: 'SET_RULE', domain: AILE.kok, type: 'white',
        options: { subdomains: false } });
      await sleep(600);
      await tumSekmeleriKapat(chrome.client, AILE.kok);
      const t = await visit(chrome.client, AILE.altUrl, { settleMs: 4000 });
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = (await cerezler(chrome.client, sw, AILE.kok)).length;
      assertOk(once > 0, 'olcum icin cerez gerekli');

      await tumSekmeleriKapat(chrome.client, AILE.kok);
      await sleep(25000);
      const kalan = (await cerezler(chrome.client, sw, AILE.kok)).length;
      console.log(`        ${AILE.kok} (KORUMALI): ${once} -> ${kalan} (durmali)`);
      assertOk(kalan > 0, 'duzeltme KORUMALI kokun verisini sildi - fazla siliyor');
      await mesaj({ action: 'RESET_RULES' });
    });

    // ================================================================
    console.log('\n########## HATA 4: popup kapsam dugmeleri ##########');
    await runner.test('4.1 DUZELTME: kapsam dugmeleri ERISILEBILIR AD tasiyor', async () => {
      await tumSekmeleriKapat(chrome.client, h2Site.kok);
      await visit(chrome.client, h2Site.url, { settleMs: 3500 });
      const p = await popupAc();
      const adlar = await oku(p.sessionId, `JSON.stringify(
        [...document.querySelectorAll('button')]
          .filter(b => !(b.textContent || '').trim() && !b.getAttribute('aria-label'))
          .map(b => b.id || b.className))`);
      const isimsiz = JSON.parse(adlar);
      console.log(`        isimsiz dugme: ${isimsiz.join(', ') || '(yok)'}`);
      await popupKapat(p);
      assertEqual(isimsiz, [], 'HATA 4 GERI GELDI: popup"ta adsiz dugme var');
    });

    await runner.test('4.2 Bildirilen popup hatasi: kapsama tiklayinca "Temizle" AKTIFLESMIYOR', async () => {
      // Kullanicinin bildirdigi hata: "Koru" secip kapsama tiklayinca aninda
      // "Temizle" aktiflesiyordu ("sanki crash yiyor gibi").
      const p = await popupAc();
      await tikla(p.sessionId, '#cardProtect', 'Koru');
      await sleep(600);
      await tikla(p.sessionId, '#scopeSubs', 'Alt siteler dahil');
      await sleep(800);
      const d = JSON.parse(await oku(p.sessionId, `JSON.stringify({
        koru: document.getElementById('cardProtect')?.classList.contains('is-protect'),
        temizle: document.getElementById('cardClean')?.classList.contains('is-clean'),
        kapsamAlt: document.getElementById('scopeSubs')?.classList.contains('active')
      })`));
      const k = (await kurallar())[h2Site.kok];
      console.log(`        koru=${d.koru} temizle=${d.temizle} kapsamAlt=${d.kapsamAlt} | ` +
        `kural=${k?.type || 'YOK'}`);
      await popupKapat(p);
      assertOk(k, 'kapsama tiklayinca kural SILINDI - bildirilen hata');
      assertOk(d.temizle !== true, '"Temizle" kendiliginden aktiflesti - bildirilen hata');
      assertOk(d.koru === true, '"Koru" secimi kayboldu');
      await mesaj({ action: 'RESET_RULES' });
    });

    await runner.test('5.1 Gunlukte ERROR yok', async () => {
      const hatalar = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 6);`);
      console.log(`        ERROR: ${hatalar.length ? hatalar.join(' | ') : '(yok)'}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
    });

    not('dogrulama bitti');
    const gecti = runner.summary();
    console.log(`Toplam sure: ${(Number(sn(Date.now() - t0)) / 60).toFixed(1)} dakika`);
    process.exitCode = gecti ? 0 : 1;
  } catch (err) {
    console.error('\nKURULUM/AKIS HATASI:', err?.stack || err);
    process.exitCode = 1;
  } finally {
    await chrome.close();
  }
}

main();
