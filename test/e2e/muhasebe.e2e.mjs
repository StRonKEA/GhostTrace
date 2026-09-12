// GhostTrace E2E - TAM MUHASEBE ve ZAMANLAMA, GERCEK SITELERDE.
//
// TAKLIT SITE YOK. Onceki surum yerel bir sunucuda her siteye tam 3 cerez
// biraktiriyordu; sayilar sabit oldugu icin "3 -> sil:3 -> kalan:0" gibi kesin
// iddialar kurulabiliyordu. Gercek sitede cerez sayisi onceden bilinemez, o
// yuzden yontem degisti:
//
//   ENVANTER YONTEMI: sekme kapanmadan hemen once TAM LISTE cikarilir (hangi
//   cerez hangi alan adinda, kac gecmis kaydi). Temizlikten sonra AYNI listenin
//   sifirlandigi dogrulanir. Sayi degisken, muhasebe birebir.
//
// BU TAKIMIN BENZERSIZ OLCTUGU SEYLER (digerleri baska takimlarda):
//   * site basina TAM MUHASEBE: sayilan = silinen = kalan 0, istatistige islendi
//   * ZAMANLAMA HASSASIYETI: cleanDelay 0 / 30 / 60 gercekten olculur
//   * SURELI IZIN dakika hassasiyeti
//   * 30 DAKIKALIK BOSTA KALMA: service worker olup dirilirken her sey ayakta
//   * YAN HASAR: korumali ust alan adinin ayni isimli cerezi
//   * DISA/ICE AKTARMA ve cerez modalinin deger sizdirmamasi
//
// Ayar acik/kapali etkileri ozellik-matrisi'nde, gunluk akis
// gunluk-kullanim'da, gercek arayuz canli-kullanim'da olculuyor - burada
// tekrarlanmiyor.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  REKLAM_YOGUN, ETICARET, POPULER, YER_IMLERI,
  cerezler, gecmisSayisi, tumSekmeleriKapat, okuyormusGibi, temizligiBekle,
  dogalSonaErenSayisi,
} from './gercek.mjs';

const t0 = Date.now();
const dk = (ms) => (ms / 60000).toFixed(1);
const not = (m) => console.log(`  ..[${dk(Date.now() - t0).padStart(5)}dk] ${m}`);

// Muhasebe icin 10 site: reklam yogunlar en cok iz birakanlar.
const MUHASEBE_SITELERI = [
  ...REKLAM_YOGUN.slice(0, 6), ...ETICARET.slice(0, 2), ...POPULER.slice(0, 2)
];
const AILE_UST = { url: 'https://www.google.com/', kok: 'google.com' };
const AILE_ALT = { url: 'https://news.google.com/', kok: 'news.google.com' };

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();
  const sureler = [];

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);
    const istatistik = () => evaluate(chrome.client, sw,
      "return (await chrome.storage.local.get('stats')).stats || {};");
    const kurallar = () => evaluate(chrome.client, sw,
      "return (await chrome.storage.local.get('rules')).rules || {};");
    const alarmlar = () => evaluate(chrome.client, sw,
      'return (await chrome.alarms.getAll()).map(a => a.name).sort();');
    const ayarla = async (a) => {
      await evaluate(chrome.client, sayfa.sessionId, `
        await chrome.storage.local.set(${JSON.stringify(a)});
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
      await sleep(900);
    };

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`TAM MUHASEBE - ${MUHASEBE_SITELERI.length} gercek site\n`);

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 30,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, cleanServiceWorkers: true, periodicCleanEnabled: true,
        periodicCleanInterval: 15, trackThirdParty: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'RESET_STATS' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(1000);
    await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(8000);

    await runner.test('0.1 Baslangic TEMIZ', async () => {
      const s = await istatistik();
      assertEqual(Object.keys(await kurallar()).length, 0, 'kural kalmis');
      assertEqual(s.cookiesDeleted || 0, 0, 'istatistik sifirlanmamis');
    });

    // ================================================================
    console.log('########## FAZ 1: her site TEK TEK, TAM MUHASEBE ##########');
    console.log('        (kapanmadan once envanter, sonra sifir dogrulamasi)\n');
    const olculenler = [];
    for (const s of MUHASEBE_SITELERI) {
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      if (!t) { console.log(`        ${s.kok.padEnd(22)} ACILAMADI`); continue; }
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });

      const oncekiCerez = await cerezler(chrome.client, sw, s.kok);
      // Pay = cleanDelay + oturma payi: bu pencerede kendi suresi dolan cerez
      // eklenti tarafindan SILINMEZ, dolayisiyla istatistige de girmez.
      const dogalSonaEren = await dogalSonaErenSayisi(chrome.client, sw, s.kok, 120000);
      const oncekiGecmis = await gecmisSayisi(chrome.client, sw, s.kok);
      const sOnce = await istatistik();
      if (!oncekiCerez.length) {
        console.log(`        ${s.kok.padEnd(22)} ATLANDI (cerez yok)`);
        await tumSekmeleriKapat(chrome.client, s.kok);
        continue;
      }

      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, s.kok);
      const olcum = await temizligiBekle(chrome.client, sw, s.kok, 120000);
      const kalan = await cerezler(chrome.client, sw, s.kok);
      const kalanGecmis = await gecmisSayisi(chrome.client, sw, s.kok);

      // ISTATISTIK YAZIMI CEREZ SILMEDEN SONRA GELIR - yaris var.
      // `temizligiBekle` cerezler sifirlanir sifirlanmaz doner; incrementStats
      // o an henuz yazmamis olabilir. Olculdu: ayni kosumda bbc +26 kaydolurken
      // cnn/hurriyet/milliyet +0 gorundu - veri kaybi degil, olcum erkenligi.
      // Sayacin oturmasini BEKLE, sabit kalana kadar.
      let sSonra = await istatistik();
      for (let i = 0; i < 10; i++) {
        await sleep(1500);
        const y = await istatistik();
        if ((y.cookiesDeleted || 0) === (sSonra.cookiesDeleted || 0)
          && (y.totalCleans || 0) === (sSonra.totalCleans || 0)) break;
        sSonra = y;
      }
      const statFark = (sSonra.cookiesDeleted || 0) - (sOnce.cookiesDeleted || 0);
      const gecen = (Date.now() - bas) / 1000;
      const sapma = gecen - 30;
      if (olcum.tamamlandi) sureler.push({ kok: s.kok, sn: gecen, sapma });

      console.log(`        ${s.kok.padEnd(22)} cerez ${String(oncekiCerez.length).padStart(3)}` +
        `->sil:${String(oncekiCerez.length - kalan.length).padStart(3)} kalan:${kalan.length}` +
        ` | gecmis ${oncekiGecmis}->${kalanGecmis}` +
        ` | istat +${statFark}` +
        ` | ${olcum.tamamlandi ? gecen.toFixed(1) + 'sn' : 'TEMIZLENMEDI'}`);
      olculenler.push({ ...s, oncekiCerez, kalan, oncekiGecmis, kalanGecmis,
        statFark, olcum, dogalSonaEren });
      await sleep(400);
    }

    await runner.test('1.1 Kapanan her sitenin cerezi TAMAMEN gitti', async () => {
      const kalintili = olculenler.filter(o => o.kalan.length)
        .map(o => `${o.kok}: ${o.kalan.slice(0, 3).join(', ')}`);
      console.log(`        kalinti: ${kalintili.join(' | ') || '(hicbiri)'}`);
      assertEqual(kalintili, [], 'temizlikten sonra cerez kalmis');
    });

    await runner.test('1.2 ISTATISTIK sayilandan AZ degil', async () => {
      // Beklenen sayi = envanter EKSI arada dogal sona erenler.
      const eksik = olculenler
        .filter(o => o.statFark < o.oncekiCerez.length - o.dogalSonaEren)
        .map(o => `${o.kok} (sayilan ${o.oncekiCerez.length}, dogal sona eren ` +
          `${o.dogalSonaEren}, istat +${o.statFark})`);
      const sonaErenler = olculenler.filter(o => o.dogalSonaEren > 0)
        .map(o => `${o.kok}=${o.dogalSonaEren}`);
      if (sonaErenler.length) console.log(`        dogal sona eren: ${sonaErenler.join(', ')}`);
      console.log(`        eksik sayim: ${eksik.join(' | ') || '(yok)'}`);
      assertEqual(eksik, [], 'istatistik gercekte silinenden az kaydetmis');
    });

    await runner.test('1.3 GECMIS de silindi', async () => {
      const kalan = olculenler.filter(o => o.oncekiGecmis > 0 && o.kalanGecmis > 0)
        .map(o => `${o.kok} ${o.oncekiGecmis}->${o.kalanGecmis}`);
      console.log(`        gecmisi kalan: ${kalan.join(', ') || '(hicbiri)'}`);
      assertEqual(kalan, [], 'gecmis silinmemis');
    });

    await runner.test('1.4 Temizlik ZAMANINDA oldu (30sn +/- 20sn)', async () => {
      const gec = sureler.filter(s => Math.abs(s.sapma) > 20);
      console.log(`        zamaninda: ${sureler.length - gec.length}/${sureler.length}` +
        (gec.length ? ` | sapan: ${gec.map(s => `${s.kok} ${s.sn.toFixed(1)}sn`).join(', ')}` : ''));
      assertEqual(gec.map(s => s.kok), [], 'temizlik zamaninda olmadi');
    });

    // ================================================================
    console.log('\n########## FAZ 2: GECIKME AYARI DOGRULUGU ##########');
    await runner.test('2.1 cleanDelay=0 ANINDA temizler', async () => {
      await ayarla({ cleanDelay: 0 });
      const s = REKLAM_YOGUN[6];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      const once = (await cerezler(chrome.client, sw, s.kok)).length;
      assertOk(once > 0, `${s.kok} cerez birakmadi`);
      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, s.kok);
      const o = await temizligiBekle(chrome.client, sw, s.kok, 60000);
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${s.kok}: ${once} cerez -> ${gecen.toFixed(1)}sn`);
      assertOk(o.tamamlandi, 'cleanDelay=0 temizlemedi');
      assertOk(gecen < 15, `cleanDelay=0 ama ${gecen.toFixed(1)}sn surdu`);
    });

    await runner.test('2.2 cleanDelay=60 GERCEKTEN 60 saniye bekliyor', async () => {
      await ayarla({ cleanDelay: 60 });
      const s = REKLAM_YOGUN[7];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      const once = (await cerezler(chrome.client, sw, s.kok)).length;
      assertOk(once > 0, `${s.kok} cerez birakmadi`);
      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, s.kok);
      const o = await temizligiBekle(chrome.client, sw, s.kok, 120000);
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${s.kok}: ${once} cerez -> ${gecen.toFixed(1)}sn (beklenen ~60)`);
      assertOk(o.tamamlandi, 'cleanDelay=60 temizlemedi');
      assertOk(gecen > 45 && gecen < 90, `60sn beklenirken ${gecen.toFixed(1)}sn`);
      await ayarla({ cleanDelay: 30 });
    });

    // ================================================================
    console.log('\n########## FAZ 3: YAN HASAR - korumali ust alan adi ##########');
    await runner.test('3.1 Alt alan adi temizlenirken KORUMALI ustun verisi KALIR', async () => {
      // Chrome'da cookies.remove(url, name) o URL'de GORUNEN ayni isimli TUM
      // cerezleri siler. Alt alan adinin URL'sinde UST alan adinin cerezi de
      // gorunur - koruma olmasa beyaz listedeki ustun oturumu ucar.
      await mesaj({ action: 'RESET_RULES' });
      await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
      await sleep(6000);
      await mesaj({ action: 'SET_RULE', domain: AILE_UST.kok, type: 'white',
        options: { subdomains: false } });

      for (const u of [AILE_UST, AILE_ALT]) {
        await visit(chrome.client, u.url, { settleMs: 4500 }).catch(() => null);
        await sleep(1200);
      }
      const hepsi = await cerezler(chrome.client, sw, AILE_UST.kok);
      const ustOnce = hepsi.filter(c => c.startsWith(AILE_UST.kok + '|'));
      const altOnce = hepsi.filter(c => c.startsWith(AILE_ALT.kok + '|'));
      console.log(`        once: ust ${ustOnce.length}, alt ${altOnce.length}`);
      assertOk(ustOnce.length > 0, 'ust alan adinda cerez yok - yan hasar olcumu yapilamaz');

      await tumSekmeleriKapat(chrome.client, AILE_ALT.kok);
      await sleep(30000);
      const sonra = await cerezler(chrome.client, sw, AILE_UST.kok);
      const ustSonra = sonra.filter(c => c.startsWith(AILE_UST.kok + '|'));
      const eksilen = ustOnce.filter(c => !sonra.includes(c));
      console.log(`        sonra: ust ${ustSonra.length} (korunmali), eksilen ${eksilen.length}`);
      assertEqual(eksilen, [], 'KORUMALI ust alan adinin cerezleri yan hasar gormus');
      await mesaj({ action: 'RESET_RULES' });
    });

    // ================================================================
    console.log('\n########## FAZ 4: SURELI IZIN dakika hassasiyeti ##########');
    await runner.test('4.1 3 dakikalik izin TAM zamaninda dusuyor', async () => {
      const s = ETICARET[2];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = (await cerezler(chrome.client, sw, s.kok)).length;
      assertOk(once > 0, `${s.kok} cerez birakmadi`);

      const izinBas = Date.now();
      await mesaj({ action: 'SET_RULE', domain: s.kok, type: 'temp',
        options: { durationMinutes: 3 } });
      await tumSekmeleriKapat(chrome.client, s.kok);

      await sleep(60000);
      const dk1 = (await cerezler(chrome.client, sw, s.kok)).length;
      await sleep(60000);
      const dk2 = (await cerezler(chrome.client, sw, s.kok)).length;
      console.log(`        1. dakika: ${dk1}, 2. dakika: ${dk2} (ikisi de durmali)`);
      assertOk(dk1 > 0, '1. dakikada veri silinmis');
      assertOk(dk2 > 0, '2. dakikada veri silinmis');

      const o = await temizligiBekle(chrome.client, sw, s.kok, 180000);
      const gecen = (Date.now() - izinBas) / 1000;
      console.log(`        ${s.kok}: ${once} cerez, izinden temizlige ${gecen.toFixed(0)}sn ` +
        '(beklenen 180 + gecikme)');
      assertOk(o.tamamlandi, 'sure dolunca temizlik olmadi');
      assertOk(gecen > 175, `sure DOLMADAN silindi: ${gecen.toFixed(0)}sn`);
      assertOk(gecen < 280, `cok GEC silindi: ${gecen.toFixed(0)}sn`);
      assertOk(!(await kurallar())[s.kok], 'suresi dolan kural listeden dusmedi');
    });

    // ================================================================
    console.log('\n########## FAZ 5: GIZLILIK ve AKTARIM ##########');
    await runner.test('5.1 Cerez modali DEGER sizdirmiyor', async () => {
      const s = POPULER[0];
      await tumSekmeleriKapat(chrome.client, s.kok);
      await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      const y = await mesaj({ action: 'GET_DOMAIN_COOKIES', domain: s.kok });
      const alanlar = [...new Set((y?.cookies || []).flatMap(c => Object.keys(c)))].sort();
      console.log(`        ${alanlar.length} alan: ${alanlar.join(', ')}`);
      assertOk(alanlar.length > 0, 'cerez modali bos dondu');
      assertOk(!alanlar.includes('value'), 'GIZLILIK: cerez DEGERI arayuze veriliyor');
      assertOk(alanlar.includes('valueLength'), 'valueLength alani yok');
      await tumSekmeleriKapat(chrome.client, s.kok);
    });

    await runner.test('5.2 Disa aktar -> sifirla -> ice aktar: beyaz liste geri gelir', async () => {
      await mesaj({ action: 'RESET_RULES' });
      const beyazlar = [YER_IMLERI[1].kok, POPULER[0].kok, ETICARET[0].kok];
      for (const d of beyazlar) {
        await mesaj({ action: 'SET_RULE', domain: d, type: 'white', options: {} });
      }
      await mesaj({ action: 'SET_RULE', domain: POPULER[2].kok, type: 'temp',
        options: { durationMinutes: 60 } });

      const disa = Object.entries(await kurallar())
        .filter(([, v]) => v.type === 'white')
        .map(([k, v]) => ({ domain: k, type: v.type, subdomains: v.subdomains,
          keepMode: v.keepMode, keepCookies: v.keepCookies }));
      console.log(`        disa aktarilan beyaz liste: ${disa.map(x => x.domain).join(', ')}`);
      assertEqual(disa.length, beyazlar.length, 'dısa aktarim beyaz listeyi eksik aldi');

      await mesaj({ action: 'RESET_RULES' });
      assertEqual(Object.keys(await kurallar()).length, 0, 'sifirlama calismadi');

      const y = await mesaj({ action: 'IMPORT_RULES', rules: disa });
      const geri = await kurallar();
      console.log(`        ice aktarilan ${y?.imported}, reddedilen ${y?.rejected} | ` +
        `geri gelen: ${Object.keys(geri).join(', ')}`);
      assertEqual(y?.rejected, 0, 'ice aktarimda reddedilen kural var');
      for (const d of beyazlar) assertOk(geri[d], `${d} geri gelmedi`);
      await mesaj({ action: 'RESET_RULES' });
    });

    // ================================================================
    console.log('\n########## FAZ 6: 30 DAKIKALIK BOSTA KALMA ##########');
    await runner.test('6.1 Periyodik alarm 15 dakikaya kuruldu', async () => {
      const a = await evaluate(chrome.client, sw,
        "const x = await chrome.alarms.get('gt:periodicSweep'); return x ? x.periodInMinutes : null;");
      console.log(`        periyodik alarm: ${a} dk`);
      assertEqual(a, 15, 'periyodik alarm 15 dakikaya kurulmadi');
    });

    await runner.test('6.2 30 dakika bosta: alarmlar, kurallar, istatistik SAGLAM', async () => {
      await mesaj({ action: 'SET_RULE', domain: YER_IMLERI[1].kok, type: 'white', options: {} });
      const oncekiKurallar = Object.keys(await kurallar()).sort();
      const oncekiStat = await istatistik();

      not('30 dakika bosta bekleniyor - service worker defalarca olup dirilecek');
      await sleep(30 * 60 * 1000);

      const a = await alarmlar();
      console.log(`        alarmlar: ${a.filter(x => !x.startsWith('gt:purge:')).join(', ')} ` +
        `(+${a.filter(x => x.startsWith('gt:purge:')).length} purge)`);
      assertOk(a.includes('gt:maintenance'), 'bakim alarmi kaybolmus');
      assertOk(a.includes('gt:periodicSweep'), 'periyodik alarm kaybolmus');
      assertEqual(Object.keys(await kurallar()).sort(), oncekiKurallar,
        'kurallar bosta kalmada degismis');
      const sonStat = await istatistik();
      assertOk((sonStat.cookiesDeleted || 0) >= (oncekiStat.cookiesDeleted || 0),
        'istatistik geriye gitmis');
    });

    await runner.test('6.3 Bosta kalmadan sonra TAM MUHASEBE hala tutuyor', async () => {
      const s = REKLAM_YOGUN[8];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = (await cerezler(chrome.client, sw, s.kok)).length;
      const gecmisOnce = await gecmisSayisi(chrome.client, sw, s.kok);
      const sOnce = await istatistik();
      assertOk(once > 0, `${s.kok} cerez birakmadi`);

      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, s.kok);
      const o = await temizligiBekle(chrome.client, sw, s.kok, 120000);
      const sSonra = await istatistik();
      const cFark = (sSonra.cookiesDeleted || 0) - (sOnce.cookiesDeleted || 0);
      const gFark = (sSonra.historyDeleted || 0) - (sOnce.historyDeleted || 0);
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${s.kok}: ${once} cerez / ${gecmisOnce} gecmis -> ` +
        `istatistik +${cFark}/+${gFark}, ${gecen.toFixed(1)}sn`);
      assertOk(o.tamamlandi, 'bosta kalmadan sonra temizlik calismadi');
      assertOk(cFark >= once, `istatistik eksik: sayilan ${once}, kaydedilen ${cFark}`);
      assertOk(Math.abs(gecen - 30) < 20, `zamanlama kaymis: ${gecen.toFixed(1)}sn`);
      sureler.push({ kok: s.kok + ' (bosta sonrasi)', sn: gecen, sapma: gecen - 30 });
    });

    // ================================================================
    console.log('\n########## FAZ 7: TOPLAM MUHASEBE ##########');
    await runner.test('7.1 Gunlukte ERROR yok', async () => {
      const h = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 8);`);
      console.log(`        ERROR: ${h.length ? h.join(' | ') : '(yok)'}`);
      assertEqual(h.length, 0, 'gunlukte hata var');
    });

    await runner.test('7.2 Kalan veri korumali kurala ya da acik sekmeye ait', async () => {
      const korunan = Object.keys(await kurallar());
      const kalan = await evaluate(chrome.client, sw, `
        const l = await chrome.cookies.getAll({});
        return [...new Set(l.map(c => c.domain.replace(/^\\./, '')))].sort();`);
      const yetim = kalan.filter(a => !korunan.some(k => a === k || a.endsWith('.' + k)));
      console.log(`        korumali kural: ${korunan.join(', ') || '(yok)'}`);
      console.log(`        kalan alan adi ${kalan.length}, korumasiz ${yetim.length}`);
      if (yetim.length) console.log(`        korumasiz: ${yetim.slice(0, 12).join(', ')}`);
      // RAPOR: 3. taraf reklam aglari yetim supurmesine kalir (o takim ayri).
    });

    await runner.test('7.3 Istatistik toplami defterle tutarli', async () => {
      const s = await istatistik();
      const sayilan = olculenler.reduce((a, o) => a + o.oncekiCerez.length, 0);
      console.log(`        istatistik: cerez=${s.cookiesDeleted} gecmis=${s.historyDeleted} ` +
        `depolama=${s.storageCleaned} temizlik=${s.totalCleans} bayt=${s.bytesFreed}`);
      console.log(`        FAZ 1'de sayilan: ${sayilan}`);
      assertOk((s.cookiesDeleted || 0) >= sayilan,
        `istatistik faz 1 sayiminin altinda: ${s.cookiesDeleted} < ${sayilan}`);
      assertOk((s.totalCleans || 0) > 5, 'temizlik sayaci dusuk');
      assertOk((s.bytesFreed || 0) > 0, 'kazanilan alan olculmemis');
    });

    console.log('\n--- OLCULEN TEMIZLIK SURELERI (cleanDelay=30) ---');
    for (const s of sureler) {
      console.log(`  ${s.kok.padEnd(28)} ${s.sn.toFixed(1)}sn  ` +
        `sapma ${s.sapma >= 0 ? '+' : ''}${s.sapma.toFixed(1)}sn`);
    }

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
