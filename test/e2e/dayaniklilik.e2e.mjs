// GhostTrace E2E - DAYANIKLILIK: saatler gecince ne bozuluyor? GERCEK SITELER.
//
// TAKLIT SITE YOK. Onceki surum yerel bir sunucuda sabit 3 cerezlik sayfalar
// servis ediyordu. Artik her tur GERCEK siteler geziliyor: gercek reklam
// aglari, gercek depolama, gercek ucuncu taraf birikimi.
//
// BU DOSYA MEVCUT SENARYOLARI TEKRAR ETMEZ. Kapsam baska takimlarda; burada
// olculen sey YALNIZCA ZAMANLA BIRIKEN riskler - hicbiri kisa turlarda
// gorunmez:
//
//   * ALARM KAYMASI      - saatler icinde birikimli sapiyor mu?
//   * OTURUM DEPOSU      - sinirsiz mi buyuyor? (gercek sitelerde 3. taraf
//                          haritasi cok daha hizli sisiyor - taklitte 1-2 host,
//                          gercekte tur basina 100+)
//   * GUNLUK TAMPONU     - yuzlerce temizlikten sonra sinir tutuyor mu?
//   * ISTATISTIK         - binlerce silmeden sonra sayaclar bozuluyor mu?
//   * SERVICE WORKER     - yuzlerce kez olup dirildikten sonra diriliyor mu?
//   * UZUN SURELI IZIN   - 4 saatlik izin TAM zamaninda mi dusuyor? (24 saatlik
//                          ayarin gercek karsiligi; 3 dakikalik test bunu
//                          kanitlamaz)
//   * SUPURME KUYRUGU    - gercek gezintide aday alan adi 100'u geciyor;
//                          kuyruk kapaniyor mu yoksa surekli buyuyor mu?
//
// COKMEYE KARSI: her kontrol noktasi ANINDA diske yazilir (JSONL). Kosum 5.
// saatte coksede elde 5 saatlik egri kalir.
//
// Kullanim: npm run test:e2e:dayaniklilik        (varsayilan 6 saat)
//           GT_SAAT=1 npm run test:e2e:dayaniklilik   (kisa deneme)

import { appendFileSync, writeFileSync } from 'node:fs';
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
const SAAT = Number(process.env.GT_SAAT || 6);
const TOPLAM_MS = SAAT * 60 * 60 * 1000;
const TUR_ARALIGI_MS = 15 * 60 * 1000;                       // her 15 dk bir tur
// Izin suresi kosumun YARISI: her uzunlukta olcum penceresi kalir. Onceki
// sabit oran kisa kosumda izni kosumdan uzun yapiyordu ve 1.8 bos geciyordu.
const SURELI_IZIN_DK = Math.max(2, Math.round(SAAT * 60 * 0.5));
const DEFTER = 'dayaniklilik-olcumleri.jsonl';
// MUHASEBE ARALIGI KOSUM SURESINE UYARLANIR.
// Sabit "saat basi" olcum, kisa kosumda HIC tetiklenmiyordu: 42 dakikalik
// denemede 1.6 ve 1.7 "olcum yok" deyip SESSIZCE gecti. Bos gecen test,
// olmayan testtir. Aralik en fazla toplam surenin dortte biri.
const MUHASEBE_ARALIGI_MS = Math.min(60 * 60 * 1000, Math.max(10 * 60 * 1000, TOPLAM_MS / 4));

const dk = (ms) => (ms / 60000).toFixed(1);

// Her turda GERCEK gezinti: kucuk bir karisim, sirayla doner.
const HAVUZ = [...REKLAM_YOGUN, ...ETICARET, ...POPULER, ...YER_IMLERI];
let havuzSayac = 0;
const turSiteleri = (n = 3) =>
  Array.from({ length: n }, () => HAVUZ[havuzSayac++ % HAVUZ.length]);

// Uzun sureli izin ve saatlik muhasebe icin AYRILMIS siteler: tur gezintisine
// karismasinlar ki olcumleri baska adimlar bozmasin.
const IZIN_SITESI = YER_IMLERI[0];      // ecc.tools
const SAATLIK = REKLAM_YOGUN[0];        // bbc

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();
  const olcumler = [];

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);

    /** Tek cagride tum saglik gostergeleri. */
    const nabiz = () => evaluate(chrome.client, sw, `
      const st = (await chrome.storage.local.get('stats')).stats || {};
      const ru = (await chrome.storage.local.get('rules')).rules || {};
      const oturum = await chrome.storage.session.get(null);
      const logs = oturum.gt_logs || [];
      const alarms = await chrome.alarms.getAll();
      const cerezAlan = new Set((await chrome.cookies.getAll({}))
        .map(c => c.domain.replace(/^\\./, '')));
      return {
        bayt: JSON.stringify(oturum).length,
        ucuncuTaraf: Object.keys(oturum.gt_thirdParty || {}).length,
        gunluk: logs.length,
        hata: logs.filter(x => (x.level || '').toUpperCase() === 'ERROR').length,
        uyari: logs.filter(x => (x.level || '').toUpperCase() === 'WARN').length,
        kural: Object.keys(ru).length,
        cerezSilinen: st.cookiesDeleted || 0,
        gecmisSilinen: st.historyDeleted || 0,
        temizlik: st.totalCleans || 0,
        cerezliAlan: cerezAlan.size,
        purgeAlarm: alarms.filter(a => a.name.startsWith('gt:purge:')).length,
        alarmlar: alarms.map(a => a.name).filter(n => !n.startsWith('gt:purge:')).sort() };`);

    function defteryaz(kayit) {
      olcumler.push(kayit);
      try {
        appendFileSync(DEFTER,
          JSON.stringify({ ...kayit, tDk: Number(dk(Date.now() - t0)) }) + '\n');
      } catch { /* disk dolabilir */ }
    }

    /** Bir tur GERCEK gezinti: uc site ac, oku, kapat. */
    async function turGez() {
      const siteler = turSiteleri(3);
      for (const s of siteler) {
        await tumSekmeleriKapat(chrome.client, s.kok);
        const t = await visit(chrome.client, s.url, { settleMs: 3500 }).catch(() => null);
        if (!t) continue;
        await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
        await tumSekmeleriKapat(chrome.client, s.kok);
        await sleep(500);
      }
      return siteler.map(s => s.kok);
    }

    /** Saat basi TAM MUHASEBE - ayrilmis site uzerinde. */
    async function saatlikMuhasebe() {
      await tumSekmeleriKapat(chrome.client, SAATLIK.kok);
      const t = await visit(chrome.client, SAATLIK.url, { settleMs: 4000 }).catch(() => null);
      if (!t) return { acilamadi: true };
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = (await cerezler(chrome.client, sw, SAATLIK.kok)).length;
      const sonaEren = await dogalSonaErenSayisi(chrome.client, sw, SAATLIK.kok, 120000);
      const gecmisOnce = await gecmisSayisi(chrome.client, sw, SAATLIK.kok);
      const sOnce = await nabiz();

      const bas = Date.now();
      await tumSekmeleriKapat(chrome.client, SAATLIK.kok);
      const o = await temizligiBekle(chrome.client, sw, SAATLIK.kok, 120000);
      // Istatistik yazimi cerez silmeden SONRA gelir; sayac otursun.
      let sSonra = await nabiz();
      for (let i = 0; i < 10; i++) {
        await sleep(1500);
        const y = await nabiz();
        if (y.cerezSilinen === sSonra.cerezSilinen) break;
        sSonra = y;
      }
      const gecen = (Date.now() - bas) / 1000;
      return {
        sayilan: once, gecmisOnce, sonaEren,
        kalan: (await cerezler(chrome.client, sw, SAATLIK.kok)).length,
        istatistikFark: sSonra.cerezSilinen - sOnce.cerezSilinen,
        tamamlandi: o.tamamlandi, sureSn: gecen, sapmaSn: gecen - 30
      };
    }

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`DAYANIKLILIK - ${SAAT} saat, GERCEK SITELER`);
    console.log(`Her ${TUR_ARALIGI_MS / 60000} dakikada 3 site geziliyor -> ${DEFTER}`);
    console.log(`Uzun sureli izin: ${SURELI_IZIN_DK} dakika (${IZIN_SITESI.kok})\n`);
    try { writeFileSync(DEFTER, ''); } catch { /* olmasa da olur */ }

    // ================================================================
    console.log('########## KURULUM ##########');
    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 30,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, cleanServiceWorkers: true, trackThirdParty: true,
        periodicCleanEnabled: true, periodicCleanInterval: 15, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'RESET_STATS' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(1000);
    await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(8000);

    // UZUN SURELI IZIN: 24 saatlik ayarin gercek karsiligini olcen tek yol.
    const izinBas = Date.now();
    await tumSekmeleriKapat(chrome.client, IZIN_SITESI.kok);
    const izinTab = await visit(chrome.client, IZIN_SITESI.url, { settleMs: 4000 })
      .catch(() => null);
    await mesaj({ action: 'SET_RULE', domain: IZIN_SITESI.kok, type: 'temp',
      options: { durationMinutes: SURELI_IZIN_DK } });
    if (izinTab) await tumSekmeleriKapat(chrome.client, IZIN_SITESI.kok);

    const baslangic = await nabiz();
    defteryaz({ tur: 'baslangic', ...baslangic });
    console.log(`        oturum ${baslangic.bayt} bayt, gunluk ${baslangic.gunluk}, ` +
      `alarm ${baslangic.alarmlar.length}`);
    console.log(`        ${SURELI_IZIN_DK} dakikalik izin verildi (${IZIN_SITESI.kok})\n`);

    await runner.test('0.1 Uzun sureli izin ALARMI kuruldu', async () => {
      const a = await evaluate(chrome.client, sw,
        `const x = await chrome.alarms.get('gt:snooze:${IZIN_SITESI.kok}');
         return x ? Math.round((x.scheduledTime - Date.now()) / 60000) : null;`);
      console.log(`        snooze alarmi: ${a === null ? 'YOK' : a + ' dk sonra'}`);
      assertOk(a !== null, 'uzun sureli izin alarmi kurulmadi');
      assertOk(Math.abs(a - SURELI_IZIN_DK) < 3,
        `alarm ${a} dk sonraya kurulmus, beklenen ${SURELI_IZIN_DK}`);
    });

    // ================================================================
    console.log('########## IZLEME DONGUSU (her tur GERCEK gezinti) ##########');
    let saatSayaci = 0;
    let izinDustuMu = false;
    let izinDusmeAni = null;
    const saatlikOlcumler = [];

    while (Date.now() - t0 < TOPLAM_MS) {
      const gezilen = await turGez();
      await sleep(Math.max(0, TUR_ARALIGI_MS - 3 * 60 * 1000));

      let n;
      try { n = await nabiz(); } catch (e) {
        defteryaz({ tur: 'HATA', mesaj: String(e.message).slice(0, 200) });
        console.log(`  ..[${dk(Date.now() - t0)}dk] NABIZ ALINAMADI: ${String(e.message).slice(0, 70)}`);
        continue;
      }
      defteryaz({ tur: 'kontrol', gezilen, ...n });
      console.log(`  ..[${dk(Date.now() - t0).padStart(6)}dk] ` +
        `oturum ${String(n.bayt).padStart(7)} | 3.taraf ${String(n.ucuncuTaraf).padStart(4)} | ` +
        `gunluk ${String(n.gunluk).padStart(4)} | temizlik ${String(n.temizlik).padStart(4)} | ` +
        `cerez ${String(n.cerezSilinen).padStart(5)} | cerezli alan ${String(n.cerezliAlan).padStart(3)} | ` +
        `purge ${String(n.purgeAlarm).padStart(3)} | ERROR ${n.hata}`);

      if (!izinDustuMu) {
        const kural = await evaluate(chrome.client, sw,
          `return ((await chrome.storage.local.get('rules')).rules || {})['${IZIN_SITESI.kok}'] || null;`);
        if (!kural) {
          izinDustuMu = true;
          izinDusmeAni = Date.now() - izinBas;
          defteryaz({ tur: 'izin-dustu', gecenDk: izinDusmeAni / 60000 });
          console.log(`  >>> uzun sureli izin DUSTU: ${(izinDusmeAni / 60000).toFixed(1)} dk ` +
            `(beklenen ${SURELI_IZIN_DK})`);
        }
      }

      const gecen = Date.now() - t0;
      if (Math.floor(gecen / MUHASEBE_ARALIGI_MS) > saatSayaci) {
        saatSayaci = Math.floor(gecen / MUHASEBE_ARALIGI_MS);
        try {
          const o = await saatlikMuhasebe();
          saatlikOlcumler.push({ saat: saatSayaci, ...o });
          defteryaz({ tur: 'saatlik-muhasebe', saat: saatSayaci, ...o });
          console.log(`  >>> ${saatSayaci}. MUHASEBE: ${o.sayilan} cerez -> kalan ${o.kalan}, ` +
            `istatistik +${o.istatistikFark}` +
          `${o.sonaEren ? ' (dogal sona eren ' + o.sonaEren + ')' : ''}, ` +
            `${o.tamamlandi ? o.sureSn.toFixed(1) + 'sn (sapma ' +
              (o.sapmaSn >= 0 ? '+' : '') + o.sapmaSn.toFixed(1) + ')' : 'TEMIZLENMEDI'}`);
        } catch (e) {
          defteryaz({ tur: 'saatlik-HATA', saat: saatSayaci, mesaj: String(e.message).slice(0, 200) });
          console.log(`  >>> ${saatSayaci}. MUHASEBE BASARISIZ: ${String(e.message).slice(0, 80)}`);
        }
      }
    }

    // ================================================================
    console.log('\n########## SONUC OLCUMLERI ##########');
    const son = await nabiz();
    defteryaz({ tur: 'bitis', ...son });

    await runner.test('1.1 OTURUM DEPOSU sinirsiz buyumedi', async () => {
      const b = olcumler.filter(o => o.bayt).map(o => o.bayt);
      const enCok = Math.max(...b);
      console.log(`        oturum bayt: ilk ${baslangic.bayt}, en cok ${enCok}, son ${son.bayt}`);
      console.log(`        3. taraf haritasi: en cok ${Math.max(...olcumler.filter(o => o.ucuncuTaraf).map(o => o.ucuncuTaraf))}`);
      assertOk(enCok < 5_000_000, `oturum deposu ${enCok} bayta cikti - sinirsiz buyume`);
    });

    await runner.test('1.2 GUNLUK TAMPONU sinirini asmadi', async () => {
      const g = olcumler.filter(o => typeof o.gunluk === 'number').map(o => o.gunluk);
      const enCok = Math.max(...g);
      console.log(`        gunluk kaydi: en cok ${enCok}, son ${son.gunluk}`);
      assertOk(enCok < 10000, `gunluk ${enCok} kayda cikti - tampon sinirlanmiyor`);
    });

    await runner.test('1.3 ISTATISTIK hic GERIYE gitmedi', async () => {
      const seri = olcumler.filter(o => typeof o.cerezSilinen === 'number');
      const dususler = [];
      for (let i = 1; i < seri.length; i++) {
        if (seri[i].cerezSilinen < seri[i - 1].cerezSilinen) {
          dususler.push(`cerez ${seri[i - 1].cerezSilinen}->${seri[i].cerezSilinen}`);
        }
        if (seri[i].temizlik < seri[i - 1].temizlik) {
          dususler.push(`temizlik ${seri[i - 1].temizlik}->${seri[i].temizlik}`);
        }
      }
      console.log(`        ${seri.length} olcum, dusus: ${dususler.join(', ') || '(yok)'}`);
      assertEqual(dususler, [], 'istatistik geriye gitti - sayac bozulmasi');
    });

    await runner.test('1.4 ALARMLAR hic KAYBOLMADI', async () => {
      const eksik = olcumler
        .filter(o => Array.isArray(o.alarmlar))
        .filter(o => !o.alarmlar.includes('gt:maintenance')).length;
      console.log(`        bakim alarmi eksik olcum: ${eksik}`);
      assertEqual(eksik, 0, 'bakim alarmi bir noktada kaybolmus');
    });

    await runner.test('1.5 SUPURME KUYRUGU kapaniyor (surekli buyumuyor)', async () => {
      // Gercek gezintide aday alan adi surekli artar. Kuyruk kapanmiyorsa
      // bekleyen purge alarmi sayisi monoton buyur - o zaman veri hic gitmez.
      const p = olcumler.filter(o => typeof o.purgeAlarm === 'number').map(o => o.purgeAlarm);
      const c = olcumler.filter(o => typeof o.cerezliAlan === 'number').map(o => o.cerezliAlan);
      console.log(`        bekleyen purge alarmi: ilk ${p[0]}, en cok ${Math.max(...p)}, son ${p[p.length - 1]}`);
      console.log(`        cerezi olan alan adi:  ilk ${c[0]}, en cok ${Math.max(...c)}, son ${c[c.length - 1]}`);

      // Eski iddia (`son < enCok*2`) anlamsizdi: `son` zaten `enCok`'u
      // gecemez, yalnizca hepsi 0 olunca patliyordu. Olculebilir hali:
      // kosum sonunda bekleyen is birikmis olmamali.
      const sonAlarm = p[p.length - 1];
      const sonCerezli = c[c.length - 1];
      assertOk(sonAlarm <= 5,
        `kosum sonunda ${sonAlarm} purge alarmi bekliyor - kuyruk kapanmiyor`);
      assertOk(sonCerezli <= 5,
        `kosum sonunda ${sonCerezli} alan adinda hala cerez var - temizlik yetismiyor`);
    });

    await runner.test('1.6 Duzenli araliklarla temizlik HER SEFERINDE tam calisti', async () => {
      // OLCUM YOKSA TEST BOS GECMEZ. Kisa kosumda hic tetiklenmeyip sessizce
      // PASS vermek, olculmemis bir yolu olculmus gostermek olurdu.
      assertOk(saatlikOlcumler.length >= 2,
        `yalnizca ${saatlikOlcumler.length} muhasebe olcumu yapildi - kosum cok kisa`);
      const bozuk = saatlikOlcumler.filter(o =>
        o.acilamadi || o.kalan !== 0 || !o.tamamlandi || o.istatistikFark < o.sayilan - o.sonaEren);
      for (const o of saatlikOlcumler) {
        console.log(`        ${o.saat}. saat: ${o.sayilan} -> kalan ${o.kalan}, ` +
          `istatistik +${o.istatistikFark}, ` +
          `${o.tamamlandi ? o.sureSn.toFixed(1) + 'sn' : 'TEMIZLENMEDI'}`);
      }
      assertEqual(bozuk.map(o => o.saat), [], 'bazi saatlerde temizlik eksik kaldi');
    });

    await runner.test('1.7 ZAMANLAMA saatler gectikce KAYMADI', async () => {
      const s = saatlikOlcumler.filter(o => o.tamamlandi).map(o => o.sapmaSn);
      assertOk(s.length >= 2, `sapma egrisi icin yeterli olcum yok (${s.length})`);
      const enBuyuk = Math.max(...s.map(Math.abs));
      console.log(`        sapmalar: ${s.map(x => (x >= 0 ? '+' : '') + x.toFixed(1)).join(', ')}`);
      console.log(`        en buyuk mutlak sapma: ${enBuyuk.toFixed(1)}sn`);
      assertOk(enBuyuk < 20, `zamanlama ${enBuyuk.toFixed(1)}sn kaydi`);
      if (s.length >= 3) {
        const ilk = Math.abs(s[0]), sonS = Math.abs(s[s.length - 1]);
        console.log(`        ilk saat ${ilk.toFixed(1)}sn -> son saat ${sonS.toFixed(1)}sn`);
        assertOk(sonS < ilk + 15, 'sapma saatler gectikce BIRIKIYOR');
      }
    });

    await runner.test('1.8 UZUN SURELI IZIN tam zamaninda dustu', async () => {
      assertOk(SURELI_IZIN_DK < SAAT * 60 - 10,
        `izin ${SURELI_IZIN_DK} dk, kosum ${SAAT * 60} dk - olcum penceresi yok`);
      assertOk(izinDustuMu, `${SURELI_IZIN_DK} dakikalik izin hic dusmedi`);
      const gecenDk = izinDusmeAni / 60000;
      console.log(`        izin ${gecenDk.toFixed(1)} dk sonra dustu (beklenen ${SURELI_IZIN_DK})`);
      assertOk(gecenDk >= SURELI_IZIN_DK,
        `izin SURESINDEN ONCE dustu: ${gecenDk.toFixed(1)} < ${SURELI_IZIN_DK}`);
      // Tespit gecikmesi: kontrol araligi kadar olabilir.
      assertOk(gecenDk < SURELI_IZIN_DK + 20,
        `izin cok GEC dustu: ${gecenDk.toFixed(1)} > ${SURELI_IZIN_DK + 20}`);
    });

    await runner.test('1.9 Gunlukte ERROR yok', async () => {
      const h = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 10);`);
      console.log(`        ERROR: ${h.length ? h.join(' | ') : '(yok)'}`);
      assertEqual(h.length, 0, 'gunlukte hata var');
    });

    await runner.test('2.0 Eklenti SONUNDA hala calisiyor', async () => {
      const t = await mesaj({ action: 'GET_DIAGNOSTICS' });
      assertOk(t?.success, 'mesajlasma bozulmus');
      const o = await saatlikMuhasebe();
      console.log(`        final: ${o.sayilan} cerez -> kalan ${o.kalan}, ` +
        `${o.tamamlandi ? o.sureSn.toFixed(1) + 'sn' : 'TEMIZLENMEDI'}`);
      assertEqual(o.kalan, 0, 'kosum sonunda temizlik calismiyor');
      assertOk(o.tamamlandi && Math.abs(o.sapmaSn) < 20, 'kosum sonunda zamanlama bozuk');
    });

    console.log(`\nOlcum defteri: ${DEFTER} (${olcumler.length} kayit)`);
    const gecti = runner.summary();
    console.log(`Toplam sure: ${(Number(dk(Date.now() - t0)) / 60).toFixed(2)} saat`);
    process.exitCode = gecti ? 0 : 1;
  } catch (err) {
    console.error('\nKURULUM/AKIS HATASI:', err?.stack || err);
    console.error(`Olcum defteri yine de yazildi: ${DEFTER}`);
    process.exitCode = 1;
  } finally {
    await chrome.close();
  }
}

main();
