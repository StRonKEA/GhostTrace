// GhostTrace E2E - BIR GUNLUK KULLANIM AKISI, GERCEK SITELERDE.
//
// TAKLIT SITE YOK. Onceki surum yerel bir sunucuda 12 uydurma site geziyordu;
// artik gercek siteler geziliyor, gercek cerezler birakiliyor, gercek reklam
// aglari yukleniyor.
//
// BU DOSYA BIR ANLATIDIR: kullanici sabah birkac site geziyor, bazilarini
// koruyor, birine sureli izin veriyor, sekmeleri kapatiyor, gun sonunda
// yalnizca korumali sitelerin verisi kaliyor. Tek tek ozellik sinamak baska
// takimlarin isi (ozellik-matrisi); burada olculen sey AKISIN KENDISI -
// adimlarin birbirini bozmamasi.
//
// GERCEK SITEDE SABIT SAYI IDDIA EDILMEZ: her adimda envanter cikarilir ve
// sonraki adimda AYNI listenin ne olduguna bakilir.
//
// ON KOSUL: agda reklam engelleme olmamali. Site iz birakmazsa o adim ACIKCA
// "olcum yapilamadi" der; sessizce gecmez.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  YER_IMLERI, REKLAM_YOGUN, ETICARET, POPULER,
  cerezler, gecmisSayisi, depolamaOlc, tumSekmeleriKapat, okuyormusGibi
} from './gercek.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const dk = (ms) => (ms / 60000).toFixed(1);
const not = (m) => console.log(`  ..[${dk(Date.now() - t0).padStart(5)}dk] ${m}`);

// GUNUN GEZINTISI - gercek bir kullanicinin sabah acacagi karisim.
const GUNUN_SITELERI = [
  REKLAM_YOGUN[0],   // bbc
  REKLAM_YOGUN[2],   // hurriyet
  REKLAM_YOGUN[3],   // milliyet
  POPULER[1],        // stackoverflow
  POPULER[2],        // reddit
  ETICARET[1],       // trendyol
  YER_IMLERI[1],     // github  -> BEYAZ LISTE
  YER_IMLERI[2],     // deepl   -> SECICI KORUMA
  POPULER[4],        // imdb    -> SURELI IZIN
  REKLAM_YOGUN[4]    // sozcu   -> ACIK KALACAK
];
const BEYAZ = YER_IMLERI[1];
const SECICI = YER_IMLERI[2];
const ACIK_KALAN = REKLAM_YOGUN[4];

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
    const istatistik = () => evaluate(chrome.client, sw,
      "return (await chrome.storage.local.get('stats')).stats || {};");
    const alarmlar = () => evaluate(chrome.client, sw,
      'return (await chrome.alarms.getAll()).map(a => a.name);');
    const gunluk = () => evaluate(chrome.client, sw,
      "return (await chrome.storage.session.get('gt_logs')).gt_logs || [];");
    /** Cerezleri sona erme zamaniyla doner: silinme ile dogal sona ermeyi
     *  ancak expirationDate ayirt eder. */
    const cerezDetay = (kok) => evaluate(chrome.client, sw,
      `const l = await chrome.cookies.getAll({ domain: ${JSON.stringify(kok)} });
       return l.map(c => ({ ad: c.domain.replace(/^[.]/, '') + '|' + c.name,
         bitis: c.expirationDate || null, oturum: c.session }));`);

    const ucuncuTaraf = () => evaluate(chrome.client, sw,
      "return Object.keys((await chrome.storage.session.get('gt_thirdParty')).gt_thirdParty || {});");

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`BIR GUNLUK KULLANIM - ${GUNUN_SITELERI.length} gercek site\n`);

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 30,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, cleanServiceWorkers: true, trackThirdParty: true,
        periodicCleanEnabled: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'RESET_STATS' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(1000);
    await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(8000);

    // ================================================================
    console.log('########## SABAH: kullanici gunun sitelerini geziyor ##########');
    const defter = [];
    let korunacakCerez = null;   // secici korumada korunan GERCEK cerez adi
    let sureliSite = null;       // sureli izin verilecek site (calisma aninda secilir)
    for (const s of GUNUN_SITELERI) {
      const t = await visit(chrome.client, s.url, { settleMs: 4000 }).catch(() => null);
      if (!t) { console.log(`        ${s.kok.padEnd(22)} ACILAMADI`); continue; }
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const c = await cerezler(chrome.client, sw, s.kok);
      const detay = await cerezDetay(s.kok);
      const g = await gecmisSayisi(chrome.client, sw, s.kok);
      defter.push({ ...s, tab: t.targetId, cerez: c, detay, gecmis: g });
      console.log(`        ${s.kok.padEnd(22)} cerez ${String(c.length).padStart(3)}  gecmis ${g}`);
      await sleep(400);
    }

    await runner.test('1. Gezilen siteler GERCEKTEN iz birakti', async () => {
      const izsiz = defter.filter(d => d.cerez.length === 0);
      const toplam = defter.reduce((a, d) => a + d.cerez.length, 0);
      console.log(`        ${defter.length} site, toplam ${toplam} cerez | iz birakmayan: ` +
        `${izsiz.map(d => d.kok).join(', ') || '(yok)'}`);
      assertOk(defter.length >= GUNUN_SITELERI.length - 2,
        `cok fazla site acilamadi: ${defter.length}/${GUNUN_SITELERI.length}`);
      assertOk(toplam > 20, 'gercek sitelerden beklenenden az iz - ag engellemesi olabilir');
    });

    await runner.test('2. 3. TARAF gozlemcisi gercek reklam aglarini yakaladi', async () => {
      const h = await ucuncuTaraf();
      const gezilen = defter.map(d => d.kok);
      const ortak = h.filter(x => gezilen.includes(x));
      console.log(`        ${h.length} ucuncu taraf | ornek: ${h.slice(0, 8).join(', ')}`);
      if (ortak.length) console.log(`        hem gezilen hem 3. taraf: ${ortak.join(', ')}`);
      assertOk(h.length > 10, 'gercek reklam aglari yakalanmadi');
      // "ZIYARET EDILEN HICBIRI 3. TARAF OLAMAZ" IDDIASI GERCEK DUNYADA YANLIS.
      // Olculdu: imdb.com hem gezildi hem BASKA sitelerde gomulu kaynak olarak
      // yuklendi (Amazon'a ait, yaygin). Bir alan adi ayni oturumda hem ana
      // site hem ucuncu taraf olabilir - urun de dogrusunu yapiyor, yalnizca
      // O ANKI SAYFANIN kendisini haric tutuyor. O kesin iddia observer
      // takiminda (2.3) tek sayfayla olculuyor; burada rapor yeterli.
    });

    // ================================================================
    console.log('\n########## OGLEN: kullanici korumalari ayarliyor ##########');
    await runner.test('3. Beyaz liste, secici koruma ve sureli izin kuruldu', async () => {
      await mesaj({ action: 'SET_RULE', domain: BEYAZ.kok, type: 'white', options: {} });

      // SECICI KORUMA: gercek sitenin GERCEK cerez adlarindan birini koru.
      const seciciKayit = defter.find(d => d.kok === SECICI.kok);
      assertOk(seciciKayit && seciciKayit.cerez.length >= 2,
        `${SECICI.kok} secici koruma icin yeterli cerez birakmadi`);
      const korunacak = seciciKayit.cerez[0].split('|')[1];
      await mesaj({
        action: 'SET_RULE', domain: SECICI.kok, type: 'white',
        options: { keepMode: 'custom', keepCookies: [korunacak] }
      });
      korunacakCerez = korunacak;

      // SURELI IZIN SITESI CALISMA ANINDA SECILIR: gercek sitede hangi
      // sitenin cerez birakacagi garanti degil. Olculdu: imdb.com bu turda
      // hic cerez birakmadi ve "sure dolmadan veri duruyor" olcumu bos kaldi.
      // Ayrica sure 2 dakikaydi ve sirasi gelmeden doluyordu; 4 dakika.
      sureliSite = defter.find(d =>
        ![BEYAZ.kok, SECICI.kok, ACIK_KALAN.kok].includes(d.kok) && d.cerez.length >= 2);
      assertOk(sureliSite, 'sureli izin icin cerezi olan site bulunamadi');
      await mesaj({ action: 'SET_RULE', domain: sureliSite.kok, type: 'temp',
        options: { durationMinutes: 4 } });

      const k = await kurallar();
      console.log(`        ${BEYAZ.kok}=${k[BEYAZ.kok]?.type}, ` +
        `${SECICI.kok}=${k[SECICI.kok]?.keepMode} (korunan: ${korunacak}), ` +
        `${sureliSite.kok}=${k[sureliSite.kok]?.type}`);
      assertEqual(k[BEYAZ.kok]?.type, 'white', 'beyaz liste kurulmadi');
      assertEqual(k[SECICI.kok]?.keepMode, 'custom', 'secici koruma kurulmadi');
      assertEqual(k[sureliSite.kok]?.type, 'temp', 'sureli izin kurulmadi');
    });

    await runner.test('4. Sureli izin icin SNOOZE alarmi kuruldu', async () => {
      const a = await alarmlar();
      const snooze = a.find(x => x.includes(sureliSite.kok));
      console.log(`        snooze alarmi: ${snooze || 'YOK'}`);
      assertOk(snooze, 'sureli izin alarmi kurulmadi - izin hic dolmazdi');
    });

    // ================================================================
    console.log('\n########## AKSAM: sekmeler kapatiliyor ##########');
    const kapananlar = defter.filter(d => d.kok !== ACIK_KALAN.kok);
    for (const d of kapananlar) await tumSekmeleriKapat(chrome.client, d.kok);
    not(`${kapananlar.length} sitenin sekmesi kapatildi, ${ACIK_KALAN.kok} ACIK kaldi`);

    await runner.test('5. Kapanan sekmeler icin ALARM kuruldu', async () => {
      await sleep(3000);
      const a = (await alarmlar()).filter(x => x.startsWith('gt:purge:'));
      console.log(`        bekleyen temizlik alarmi: ${a.length}`);
      assertOk(a.length > 0, 'sekme kapanislari icin alarm kurulmadi');
    });

    await runner.test('6. Sure dolunca KORUMASIZ sitelerin verisi GITTI', async () => {
      const korumasiz = kapananlar.filter(d =>
        ![BEYAZ.kok, SECICI.kok, sureliSite.kok].includes(d.kok) && d.cerez.length > 0);
      assertOk(korumasiz.length >= 3, 'olcum icin yeterli korumasiz site yok');

      const bas = Date.now();
      let kalanlar = [];
      for (let i = 0; i < 30; i++) {
        await sleep(4000);
        kalanlar = [];
        for (const d of korumasiz) {
          const c = await cerezler(chrome.client, sw, d.kok);
          if (c.length) kalanlar.push(`${d.kok}=${c.length}`);
        }
        if (!kalanlar.length) break;
      }
      console.log(`        ${korumasiz.length} korumasiz site, ${sn(Date.now() - bas)}sn | ` +
        `kalan: ${kalanlar.join(', ') || '(yok)'}`);
      assertEqual(kalanlar, [], 'korumasiz sitelerin verisi temizlenmedi');
    });

    await runner.test('7. ACIK sekmenin verisine DOKUNULMADI', async () => {
      const d = defter.find(x => x.kok === ACIK_KALAN.kok);
      assertOk(d && d.cerez.length > 0, `${ACIK_KALAN.kok} cerez birakmadi`);
      const sonra = await cerezler(chrome.client, sw, ACIK_KALAN.kok);
      const eksilen = d.cerez.filter(c => !sonra.includes(c));
      const simdi = Date.now() / 1000;
      // KAYBOLANI SINIFLANDIR: suresi gecmis olan KENDI KENDINE sona ermistir.
      const sonaEren = eksilen.filter(ad => {
        const k = d.detay.find(x => x.ad === ad);
        return k && k.bitis && k.bitis <= simdi + 60;
      });
      const silinen = eksilen.filter(ad => !sonaEren.includes(ad));
      console.log(`        ${ACIK_KALAN.kok} (ACIK): ${d.cerez.length} -> ${sonra.length}, ` +
        `eksilen ${eksilen.length} (dogal sona eren ${sonaEren.length}, silinen ${silinen.length})`);
      if (sonaEren.length) console.log(`        dogal sona erenler: ${sonaEren.join(', ')}`);
      assertEqual(silinen, [], 'ACIK sekmenin verisi SILINMIS');
    });

    await runner.test('8. BEYAZ LISTEDEKI site korundu', async () => {
      const d = defter.find(x => x.kok === BEYAZ.kok);
      const sonra = await cerezler(chrome.client, sw, BEYAZ.kok);
      const eksilen = d.cerez.filter(c => !sonra.includes(c));
      console.log(`        ${BEYAZ.kok}: ${d.cerez.length} -> ${sonra.length}, eksilen ${eksilen.length}`);
      assertOk(d.cerez.length > 0, `${BEYAZ.kok} cerez birakmadi`);
      assertEqual(eksilen, [], 'beyaz listedeki sitenin verisi silinmis');
    });

    await runner.test('9. SECICI korumada yalnizca secilen cerez KALDI', async () => {
      assertOk(korunacakCerez, 'secici koruma testi cerez adi birakmadi');
      const korunacak = korunacakCerez;

      // Temizlik cleanDelay (30sn) sonunda calisir; beklemeden olcmek
      // rastgele gecip kalan bir test uretiyordu.
      let adlar = [];
      let fazlalik = [];
      const bas = Date.now();
      for (let i = 0; i < 30; i++) {
        adlar = (await cerezler(chrome.client, sw, SECICI.kok)).map(c => c.split('|')[1]);
        fazlalik = adlar.filter(n => n !== korunacak);
        if (!fazlalik.length) break;
        await sleep(4000);
      }
      console.log(`        ${SECICI.kok}: korunan "${korunacak}" | ${sn(Date.now() - bas)}sn | ` +
        `kalan: ${adlar.join(', ') || '(yok)'}`);
      assertOk(adlar.includes(korunacak), 'SECILEN cerez silinmis');
      assertEqual(fazlalik, [], 'secici korumada secilmeyen cerezler de kalmis');
    });

    // ================================================================
    console.log('\n########## SURELI IZNIN DOLMASI ##########');
    await runner.test('10. Sure DOLMADAN veri DURUYOR', async () => {
      const d = sureliSite;
      const sonra = await cerezler(chrome.client, sw, sureliSite.kok);
      console.log(`        ${sureliSite.kok}: ${d.cerez.length} -> ${sonra.length} (durmali)`);
      assertOk(sonra.length > 0, 'sureli izin suresinde veri silinmis');
    });

    await runner.test('11. Sure DOLUNCA kural dustu ve veri temizlendi', async () => {
      // BUTCE SUREDEN UZUN OLMALI. Onceki kosumda sure 6 dakikaydi, yoklama
      // butcesi 5 dakika - izin daha dolmadan test dustu. Urun degil olcum
      // penceresi yanlisti.
      const bas = Date.now();
      let kural = true, kalan = 1;
      for (let i = 0; i < 84; i++) {
        await sleep(5000);
        kural = Boolean((await kurallar())[sureliSite.kok]);
        kalan = (await cerezler(chrome.client, sw, sureliSite.kok)).length;
        if (!kural && kalan === 0) break;
      }
      console.log(`        ${sureliSite.kok}: kural=${kural ? 'DURUYOR' : 'dustu'}, ` +
        `cerez ${kalan}, ${sn(Date.now() - bas)}sn`);
      assertOk(!kural, 'suresi dolan kural listeden dusmedi');
      assertEqual(kalan, 0, 'suresi dolan sitenin verisi temizlenmedi');
    });

    // ================================================================
    console.log('\n########## GUN SONU ##########');
    await runner.test('12. Toplu temizlik ACIK sekmeyi ATLADI ve raporladi', async () => {
      const y = await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
      await sleep(6000);
      const acik = await cerezler(chrome.client, sw, ACIK_KALAN.kok);
      console.log(`        rapor: cerez=${y?.cookies} gecmis=${y?.history} ` +
        `atlanan=${y?.skipped ?? '-'} | ${ACIK_KALAN.kok}: ${acik.length} cerez`);
      assertOk(y?.success, 'toplu temizlik basarisiz');
      assertOk(acik.length > 0, 'toplu temizlik ACIK sekmenin verisini sildi');
    });

    await runner.test('13. Toplu temizlik BEYAZ LISTEYI korudu', async () => {
      const c = await cerezler(chrome.client, sw, BEYAZ.kok);
      console.log(`        ${BEYAZ.kok}: ${c.length} cerez (durmali)`);
      assertOk(c.length > 0, 'toplu temizlik beyaz listeyi sildi');
    });

    await runner.test('14. GECMIS de temizlendi', async () => {
      // SURELI IZIN ALAN SITE HARIC: izni dolana kadar KORUMALI, gecmisinin
      // durmasi dogru davranis. Onceki kosumda bbc.com sureli izin almisti ve
      // test onu korumasiz sanip haksiz yere dustu.
      const kalanlar = [];
      for (const d of kapananlar) {
        if (![BEYAZ.kok, SECICI.kok, sureliSite.kok].includes(d.kok) && d.gecmis > 0) {
          const g = await gecmisSayisi(chrome.client, sw, d.kok);
          if (g > 0) kalanlar.push(`${d.kok}=${g}`);
        }
      }
      console.log(`        gecmisi kalan: ${kalanlar.join(', ') || '(hicbiri)'}`);
      assertEqual(kalanlar, [], 'korumasiz sitelerin gecmisi silinmedi');
    });

    await runner.test('15. DEPOLAMA da temizlendi', async () => {
      const hedef = kapananlar.find(d =>
        ![BEYAZ.kok, SECICI.kok, sureliSite.kok].includes(d.kok));
      const d = await depolamaOlc(chrome.client, hedef.url);
      console.log(`        ${hedef.kok}: ${d.usage} bayt (0 olmali)`);
      assertEqual(d.usage, 0, 'temizlenen sitenin depolamasi kalmis');
    });

    await runner.test('16. ISTATISTIK gercek silmelerle tutarli', async () => {
      const s = await istatistik();
      const silinmesiGereken = kapananlar
        .filter(d => ![BEYAZ.kok, SECICI.kok].includes(d.kok))
        .reduce((a, d) => a + d.cerez.length, 0);
      console.log(`        istatistik: cerez=${s.cookiesDeleted} gecmis=${s.historyDeleted} ` +
        `temizlik=${s.totalCleans} | sayilan (en az): ${silinmesiGereken}`);
      assertOk((s.cookiesDeleted || 0) >= silinmesiGereken,
        `istatistik sayilandan az: ${s.cookiesDeleted} < ${silinmesiGereken}`);
      assertOk((s.totalCleans || 0) > 3, 'temizlik sayaci dusuk');
    });

    await runner.test('17. Gunlukte ERROR yok, temizlikler KAYITLI', async () => {
      const g = await gunluk();
      const hatalar = g.filter(x => (x.level || '').toUpperCase() === 'ERROR');
      const temizlik = g.filter(x => /temizlendi|silindi/i.test(x.message || ''));
      console.log(`        ${g.length} kayit | ERROR ${hatalar.length} | temizlik kaydi ${temizlik.length}`);
      for (const h of hatalar.slice(0, 5)) console.log(`          ${h.message}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
      assertOk(temizlik.length > 0, 'hic temizlik kaydi yok');
    });

    await runner.test('18. Gun sonunda KALAN veri yalnizca korumali sitelere ait', async () => {
      const k = await kurallar();
      const korunan = Object.keys(k);
      const acikSekmeler = [ACIK_KALAN.kok];
      const kalanlar = [];
      for (const d of defter) {
        const c = await cerezler(chrome.client, sw, d.kok);
        if (c.length && !korunan.includes(d.kok) && !acikSekmeler.includes(d.kok)) {
          kalanlar.push(`${d.kok}=${c.length}`);
        }
      }
      console.log(`        korumali kural: ${korunan.join(', ')}`);
      console.log(`        acik sekme: ${acikSekmeler.join(', ')}`);
      console.log(`        korumasiz kalan: ${kalanlar.join(', ') || '(hicbiri)'}`);
      assertEqual(kalanlar, [],
        'gun sonunda korumasiz ve kapali bir sitenin verisi kalmis');
    });

    not('gun bitti');
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
