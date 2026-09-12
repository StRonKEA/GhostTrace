// SONDA: popup'taki 3. taraf sayisi GERCEK KULLANIMDA neden sifir gorunuyor?
//
// Onceki olcum (sonda-ucuncuTarafVerisi) ayarlari ZORLA acti ve sayfa
// yuklendikten hemen sonra taze profilde olctu. Gercek kullanim o degil.
// Kullanici "genelde sifir" diyor; bu sonda sifirin SEBEBINI ayirt eder:
//
//   harita BOS mu?              -> gozlemci hic bildirmedi / kayit budandi
//   harita DOLU ama filtre 0 mi? -> ebeveyn esleyicisi yanlis
//
// Bes senaryo, hepsi VARSAYILAN ayarlarla (hicbir sey zorlanmaz):
//   A  sayfa yuklendi, 6sn beklendi        -> normal hal
//   B  popup HEMEN acildi (flush oncesi)   -> 3sn'lik FLUSH_INTERVAL penceresi
//   C  arada bes site gezildi, geri donuldu -> MAX_PARENTS_PER_HOST kayan penceresi
//   D  periyodik supurme zorlandi           -> pruneThirdParty kaydi dusuruyor mu
//   E  sekme kapatildi, site yeniden acildi -> yeni sayfa ornegi
import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, createRunner, assertOk
} from './harness.mjs';
import { okuyormusGibi } from './gercek.mjs';

const ANA = { url: 'https://www.sozcu.com.tr/', kok: 'sozcu.com.tr' };
const ARADAKILER = [
  'https://www.hurriyet.com.tr/', 'https://www.milliyet.com.tr/',
  'https://www.cnnturk.com/', 'https://www.ntv.com.tr/', 'https://www.mynet.com/'
];

const t0 = Date.now();
const not = (m) => console.log(`  ..[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}sn] ${m}`);

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();
  const kayit = {};

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;

    // AYARLARA DOKUNULMAZ. Yalnizca kural listesi bosaltilir ki site korumali
    // sayilmasin; trackThirdParty ve trackThirdPartyFrames VARSAYILANDA kalir.
    const ayar = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    await evaluate(chrome.client, ayar.sessionId,
      "await chrome.storage.local.set({ rules: {} }); return 1;");
    await sleep(1200);

    const ayarlar = await evaluate(chrome.client, sw, `
      const s = await chrome.storage.local.get(null);
      return {
        trackThirdParty: s.trackThirdParty,
        trackThirdPartyFrames: s.trackThirdPartyFrames,
        periodicCleanEnabled: s.periodicCleanEnabled,
        cleanDelay: s.cleanDelay
      };`);
    const kayitliBetik = await evaluate(chrome.client, sw,
      'const x = await chrome.scripting.getRegisteredContentScripts(); return x.map(y => y.id + (y.allFrames ? " (allFrames)" : ""));')
      .catch(() => []);

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`VARSAYILAN ayarlar: ${JSON.stringify(ayarlar)}`);
    console.log(`Kayitli icerik script: ${JSON.stringify(kayitliBetik)}\n`);

    /** Popup'in yaptigi isi ve haritanin ham halini birlikte doner. */
    const bak = async (etiket) => {
      const info = await evaluate(chrome.client, ayar.sessionId,
        "return await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_TAB_INFO' });");
      const ham = await evaluate(chrome.client, sw, `
        const { gt_thirdParty: h = {} } = await chrome.storage.session.get('gt_thirdParty');
        const ebeveynler = [...new Set(Object.values(h).flatMap(b => b.parents || []))];
        return { haritaBoyu: Object.keys(h).length, ebeveynler: ebeveynler.slice(0, 8) };`);
      const sonuc = {
        etiket,
        alan: info?.domain ?? null,
        sayi: info?.thirdPartyCount ?? null,
        haritaBoyu: ham.haritaBoyu,
        ebeveynler: ham.ebeveynler
      };
      console.log(`  ${etiket.padEnd(30)} alan=${String(sonuc.alan).padEnd(16)} sayi=${String(sonuc.sayi).padStart(3)}  harita=${String(sonuc.haritaBoyu).padStart(3)}  ebeveyn=${JSON.stringify(sonuc.ebeveynler.slice(0, 3))}`);
      return sonuc;
    };

    /** Sekmeyi ON PLANA alir - popup AKTIF sekmeyi okuyor. */
    const onePlanaAl = (url) => evaluate(chrome.client, sw,
      `const [x] = await chrome.tabs.query({ url: ${JSON.stringify(url)} });
       if (x) await chrome.tabs.update(x.id, { active: true });
       return x ? x.id : null;`);

    // ---- B: FLUSH ONCESI (once bu, cunku sayfa yeni) --------------------
    not('ana site aciliyor');
    const anaSekme = await visit(chrome.client, ANA.url, { settleMs: 1200 });
    await onePlanaAl('https://www.sozcu.com.tr/*');
    kayit.B = await bak('B flush oncesi (~1.5sn)');

    // ---- A: NORMAL HAL -------------------------------------------------
    await okuyormusGibi(chrome.client, anaSekme.sessionId, { tikla: false });
    await sleep(6000);
    await onePlanaAl('https://www.sozcu.com.tr/*');
    kayit.A = await bak('A normal (~8sn sonra)');

    // ---- C: ARADA BES SITE GEZILDI -------------------------------------
    not('arada bes site geziliyor (kayan pencere sinaniyor)');
    for (const u of ARADAKILER) {
      const t = await visit(chrome.client, u, { settleMs: 4500 }).catch(() => null);
      if (t) { await sleep(1500); await closeTarget(chrome.client, t.targetId).catch(() => {}); }
      await sleep(800);
    }
    await onePlanaAl('https://www.sozcu.com.tr/*');
    kayit.C = await bak('C bes site sonra');

    // ---- D: SUPURME ZORLANDI -------------------------------------------
    not('periyodik supurme zorlaniyor');
    await evaluate(chrome.client, sw,
      "await chrome.alarms.create('gt:periodicSweep', { when: Date.now() + 100 }); return 1;");
    await sleep(12000);
    await onePlanaAl('https://www.sozcu.com.tr/*');
    kayit.D = await bak('D supurme sonrasi');

    // ---- E: SEKME KAPANDI, SITE YENIDEN ACILDI -------------------------
    not('sekme kapatilip site yeniden aciliyor');
    await closeTarget(chrome.client, anaSekme.targetId).catch(() => {});
    await sleep(3000);
    const yeni = await visit(chrome.client, ANA.url, { settleMs: 6000 });
    await okuyormusGibi(chrome.client, yeni.sessionId, { tikla: false });
    await sleep(4000);
    await onePlanaAl('https://www.sozcu.com.tr/*');
    kayit.E = await bak('E yeniden acilis');

    // ---- IDDIALAR ------------------------------------------------------
    await runner.test('ON KOSUL gozlemci KAYITLI (ayar varsayilanda acik)', () => {
      assertOk(kayitliBetik.length > 0,
        `icerik script kayitli degil - trackThirdParty varsayilani kapali olabilir: ${JSON.stringify(ayarlar)}`);
    });

    await runner.test('A normal halde sayi SIFIR DEGIL', () => {
      assertOk(kayit.A.sayi > 0,
        `normal halde 0 dondu (harita ${kayit.A.haritaBoyu}) - ` +
        (kayit.A.haritaBoyu > 0 ? 'HARITA DOLU, yani FILTRE eslemedi' : 'HARITA BOS, yani gozlemci bildirmedi'));
    });

    await runner.test('C arada gezinme sayiyi SIFIRLAMAZ', () => {
      assertOk(kayit.C.sayi > 0,
        `bes site sonra 0 (harita ${kayit.C.haritaBoyu}) - MAX_PARENTS_PER_HOST kayan penceresi kaydi dusurmus olabilir`);
    });

    await runner.test('D supurme ACIK sekmenin sayisini SIFIRLAMAZ', () => {
      assertOk(kayit.D.sayi > 0,
        `supurme sonrasi 0 (harita ${kayit.D.haritaBoyu}) - sourceStillOpen korumasi calismamis`);
    });

    await runner.test('E yeniden acilista sayi geri gelir', () => {
      assertOk(kayit.E.sayi > 0, `yeniden acilista 0 (harita ${kayit.E.haritaBoyu})`);
    });

    console.log('');
    console.log('  SONUC');
    for (const k of Object.keys(kayit).sort()) {
      const s = kayit[k];
      console.log(`    ${s.etiket.padEnd(30)} sayi ${String(s.sayi).padStart(3)}  harita ${String(s.haritaBoyu).padStart(3)}`);
    }
  } finally {
    await chrome.close();
  }

  process.exit(runner.summary() ? 0 : 1);
}

main().catch((e) => { console.error('\nSONDA PATLADI:', e); process.exit(1); });
