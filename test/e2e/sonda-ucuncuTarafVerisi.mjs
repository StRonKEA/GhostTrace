// SONDA: popup'a "bu sayfanin yukledigi 3. taraflar - N alan adi, M cerez"
// satirini koymak icin gereken veri ELDE Mi, ve BEDELI ne?
//
// Iddia olculuyor: gt_thirdParty zaten bellekte, dolayisiyla ALAN ADI sayisi
// bedava; CEREZ sayisi icin tek bir filtresiz cookies.getAll() yeterli ve
// gecmis taramasi HIC gerekmiyor (3. tarafin tanimi geregi gecmisi yok).
//
// Olculen dort sey:
//   1. Acik sekmenin altinda kac 3. taraf host gorulüyor
//   2. O host'larin toplam kac cerezi var
//   3. Tek getAll'in suresi (popup acilisinda kabul edilebilir mi)
//   4. Ayni isi collectStoredDomains yoluyla yapmanin suresi (karsilastirma)
//
// SINIR: `parents` listesi MAX_PARENTS_PER_HOST=5 ile kayan pencere. Aktif
// sekme icin guvenilir (en son bildiren o), ama popup cok sonra acilirsa
// eski ebeveyn dusebilir. Bu da olculuyor.
import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertOk
} from './harness.mjs';
import { okuyormusGibi, tumSekmeleriKapat } from './gercek.mjs';

// Reklam yogun ve sade, iki uc: fark satirda ne yazacagini belirliyor.
const SITELER = [
  { url: 'https://www.sozcu.com.tr/', kok: 'sozcu.com.tr' },
  { url: 'https://www.w3schools.com/', kok: 'w3schools.com' },
  { url: 'https://github.com/', kok: 'github.com' }
];

const t0 = Date.now();
const not = (m) => console.log(`  ..[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}sn] ${m}`);

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();
  const bulgular = [];

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({
        rules: {}, enabled: true, cleanDelay: 0,
        trackThirdParty: true, trackThirdPartyFrames: true,
        periodicCleanEnabled: false, logLevel: 'info'
      });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(2000);

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log('3. TARAF VERISI - popup satiri icin olcum\n');

    for (const site of SITELER) {
      // ONCE ONCEKI SITENIN SEKMELERINI KAPAT, SONRA haritayi sil.
      //
      // Ilk kosumda bu yapilmadi ve atif karisti: sozcu 85 host, w3schools da
      // 85 host, ornek listeleri ayni cikti. Acik kalan sekmenin gozlemcisi
      // bildirmeye devam ediyor. README'nin uyardigi tuzak: "3. taraf olcumu
      // sekme ACIKKEN yapilmali" - yani OLCULEN sekme acik, digerleri KAPALI.
      for (const s of SITELER) await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(2500);
      await evaluate(chrome.client, sw, "await chrome.storage.session.remove('gt_thirdParty'); return 1;");
      await sleep(700);

      not(`${site.kok} geziliyor`);
      const t = await visit(chrome.client, site.url, { settleMs: 7000 }).catch(() => null);
      if (!t) { console.log(`        ACILAMADI`); continue; }
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      await sleep(4000);   // gozlemcinin 3sn'lik flush penceresi gecsin

      // ---- POPUP'IN YAPACAGI IS, service worker baglaminda ----
      const olcum = await evaluate(chrome.client, sw, `
        const kok = ${JSON.stringify(site.kok)};

        // 1) ALAN ADI sayisi - gt_thirdParty'den, ek API cagrisi YOK.
        const b0 = performance.now();
        const { gt_thirdParty: harita = {} } =
          await chrome.storage.session.get('gt_thirdParty');
        const altinda = Object.entries(harita)
          .filter(([, bilgi]) => (bilgi.parents || [])
            .some(p => p === kok || p.endsWith('.' + kok)))
          .map(([host]) => host);
        const b1 = performance.now();

        // 2) CEREZ sayisi - TEK filtresiz getAll, host'a gore gruplama.
        const c0 = performance.now();
        const hepsi = await chrome.cookies.getAll({});
        const kova = new Map();
        for (const c of hepsi) {
          const d = c.domain.replace(/^\\./, '');
          kova.set(d, (kova.get(d) || 0) + 1);
        }
        // Bir 3. taraf host'un kendi cerezleri + alt alan adlarininkiler.
        let cerez = 0;
        for (const h of altinda) {
          for (const [d, n] of kova) {
            if (d === h || d.endsWith('.' + h)) cerez += n;
          }
        }
        const c1 = performance.now();

        // ATIF KANITI: filtreye takilmayan kayit sayisi ve ornek ebeveynler.
        const disarida = Object.entries(harita).length - altinda.length;
        const ebeveynler = [...new Set(Object.values(harita)
          .flatMap(b => b.parents || []))].sort();

        return {
          disarida,
          ebeveynler,
          hostSayisi: altinda.length,
          cerezSayisi: cerez,
          toplamCerez: hepsi.length,
          haritaBoyu: Object.keys(harita).length,
          msHarita: +(b1 - b0).toFixed(1),
          msGetAll: +(c1 - c0).toFixed(1),
          ornek: altinda.slice(0, 5)
        };`);

      // ---- KARSILASTIRMA: agir yol (options sayfasinin kullandigi) ----
      const agir = await evaluate(chrome.client, sayfa.sessionId, `
        const a0 = performance.now();
        const y = await chrome.runtime.sendMessage({ action: 'GET_ALL_STORED_DOMAINS' });
        const a1 = performance.now();
        return { ms: +(a1 - a0).toFixed(1), alan: (y?.domains || []).length };`);

      console.log(`        3. taraf host   : ${olcum.hostSayisi}  (harita ${olcum.haritaBoyu})`);
      console.log(`        onlarin cerezi  : ${olcum.cerezSayisi}  (profildeki toplam ${olcum.toplamCerez})`);
      console.log(`        ornek           : ${olcum.ornek.join(', ') || '-'}`);
      console.log(`        gorulen ebeveyn : ${olcum.ebeveynler.join(', ') || '-'}`);
      console.log(`        filtre disi     : ${olcum.disarida}`);
      console.log(`        HAFIF yol       : harita ${olcum.msHarita}ms + getAll ${olcum.msGetAll}ms`);
      console.log(`        AGIR yol        : ${agir.ms}ms (${agir.alan} alan adi)`);
      bulgular.push({ ...site, ...olcum, agirMs: agir.ms });
    }

    // ---- IDDIALAR ----
    await runner.test('ON KOSUL en az bir sitede 3. taraf gorulüyor', () => {
      assertOk(bulgular.some(b => b.hostSayisi > 0),
        `hicbir sitede 3. taraf yok: ${JSON.stringify(bulgular.map(b => [b.kok, b.hostSayisi]))}`);
    });

    await runner.test('ATIF DOGRU: haritadaki tek ebeveyn olculen site', () => {
      const kirli = bulgular.filter(b => b.ebeveynler
        .some(p => !(p === b.kok || p.endsWith('.' + b.kok))));
      assertOk(kirli.length === 0,
        'baska sitenin ebeveyni haritaya karismis: ' +
        JSON.stringify(kirli.map(b => [b.kok, b.ebeveynler])));
    });

    await runner.test('ALAN ADI sayisi bedava (harita okumasi < 20ms)', () => {
      const enYavas = Math.max(...bulgular.map(b => b.msHarita));
      assertOk(enYavas < 20, `harita okumasi ${enYavas}ms - bedava sayilmaz`);
    });

    await runner.test('TEK getAll popup acilisinda kabul edilebilir (< 150ms)', () => {
      const enYavas = Math.max(...bulgular.map(b => b.msGetAll));
      assertOk(enYavas < 150, `getAll ${enYavas}ms - popup acilisini geciktirir`);
    });

    // Ilk kosumda "hafif yol belirgin hizli" diye iddia edilmisti ve GECMEDI:
    // olculen oran 1.7x. Yani ayri kod yolunun gerekcesi PERFORMANS DEGIL.
    // Iddia dogru olana cevrildi: ikisi de popup acilisinda kabul edilebilir.
    await runner.test('IKI YOL DA popup acilisinda kabul edilebilir (< 150ms)', () => {
      const enYavas = Math.max(...bulgular.map(b => Math.max(b.msHarita + b.msGetAll, b.agirMs)));
      assertOk(enYavas < 150, `en yavas yol ${enYavas}ms - popup acilisini geciktirir`);
    });

    console.log('');
    console.log('  SONUC');
    for (const b of bulgular) {
      console.log(`    ${b.kok.padEnd(18)} ${String(b.hostSayisi).padStart(3)} host, ` +
        `${String(b.cerezSayisi).padStart(4)} cerez | hafif ${(b.msHarita + b.msGetAll).toFixed(1)}ms, agir ${b.agirMs}ms`);
    }
  } finally {
    await chrome.close();
  }

  process.exit(runner.summary() ? 0 : 1);
}

main().catch((e) => { console.error('\nSONDA PATLADI:', e); process.exit(1); });
