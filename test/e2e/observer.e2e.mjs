// GhostTrace E2E - 3. TARAF GOZLEMCISI, GERCEK REKLAM AGLARINA KARSI.
//
// TAKLIT SITE YOK. Onceki surum yerel bir sunucuda `tracker.example` ve
// `tracker-in-frame.example` uyduruyordu: iframe icindeki izleyici oraya
// bilerek konuluyordu, yani "iframe ayari ise yariyor mu?" sorusunun cevabi
// zaten kurgunun icine yazilmisti.
//
// Gercek reklam ekosisteminde durum boyle degil: bir sitede ust cerceveden
// gorulen izleyicilerle YALNIZCA iframe icinde calisanlar farkli kumelerdir
// ve bu fark siteye gore degisir. Ayarin GERCEK kazanci ancak burada olculur.
//
// OLCUM: ayni site iki kez gezilir - once `trackThirdPartyFrames` KAPALI,
// sonra ACIK. Aradaki FARK, ayarin ekledigi hostlardir. Iddia sabit bir sayi
// degil (siteler degisir); iddia "acikken gorulen kume kapalidakini KAPSAR
// ve daha buyuktur".
//
// ON KOSUL: agda reklam engelleme OLMAMALI. NextDNS / Pi-hole acikken reklam
// cerceveleri hic yuklenmez, iki olcum de bos cikar ve test "ayar ise
// yaramiyor" gibi yanlis bir sonuc uretir. Bu tuzaga bir kez dusuldu; asagida
// yetersiz veri ACIKCA bildirilir.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  REKLAM_YOGUN, cerezler, tumSekmeleriKapat, okuyormusGibi
} from './gercek.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(6)}sn] ${m}`);

// Cerceve icinde izleyici barindirma olasiligi en yuksek siteler.
const OLCUM_SITELERI = [REKLAM_YOGUN[0], REKLAM_YOGUN[1], REKLAM_YOGUN[3]];

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);

    const harita = () => evaluate(chrome.client, sw,
      "return Object.keys((await chrome.storage.session.get('gt_thirdParty')).gt_thirdParty || {}).sort();");
    const haritayiSil = () => evaluate(chrome.client, sw,
      "await chrome.storage.session.remove('gt_thirdParty'); return 1;");
    const kayitliBetikler = () => evaluate(chrome.client, sw,
      `const s = await chrome.scripting.getRegisteredContentScripts();
       return s.map(x => ({ id: x.id, allFrames: x.allFrames }));`).catch(() => []);

    const ayarla = async (a) => {
      await evaluate(chrome.client, sayfa.sessionId, `
        await chrome.storage.local.set(${JSON.stringify(a)});
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
      await sleep(1500);
    };

    /** Siteleri gezer ve o turda GORULEN 3. taraf kumesini doner. */
    async function turAt() {
      await haritayiSil();
      await sleep(600);
      for (const s of OLCUM_SITELERI) {
        await tumSekmeleriKapat(chrome.client, s.kok);
        const t = await visit(chrome.client, s.url, { settleMs: 7000 }).catch(() => null);
        if (!t) { console.log(`        ${s.kok} ACILAMADI`); continue; }
        await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
        await sleep(2500);
      }
      const gorulen = await harita();
      for (const s of OLCUM_SITELERI) await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(2000);
      return gorulen;
    }

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`3. TARAF GOZLEMCISI - gercek reklam aglari (${OLCUM_SITELERI.length} site)\n`);

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
        cleanCookies: true, cleanHistory: true, trackThirdParty: true,
        trackThirdPartyFrames: false, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(1000);

    // ================================================================
    console.log('########## 1: IFRAME AYARININ GERCEK KAZANCI ##########');
    let kapaliKume = [];
    let acikKume = [];

    await runner.test('1.1 iframe KAPALI: ust cerceveden gorulen 3. taraflar yakalanir', async () => {
      await ayarla({ trackThirdPartyFrames: false });
      kapaliKume = await turAt();
      console.log(`        KAPALI: ${kapaliKume.length} host`);
      console.log(`        ornek: ${kapaliKume.slice(0, 8).join(', ')}`);
      assertOk(kapaliKume.length > 0,
        'ust cerceveden hic 3. taraf gorulmedi - agda reklam engelleme olabilir');
    });

    await runner.test('1.2 iframe ACIK: kume BUYUR ve kapalidakini KAPSAR', async () => {
      await ayarla({ trackThirdPartyFrames: true });
      acikKume = await turAt();
      const ek1 = acikKume.filter(h => !kapaliKume.includes(h));
      const kayip = kapaliKume.filter(h => !acikKume.includes(h));
      console.log(`        ACIK: ${acikKume.length} host (KAPALI: ${kapaliKume.length})`);
      console.log(`        AYARIN EKLEDIGI: ${ek1.length} host`);
      console.log(`        ornek: ${ek1.slice(0, 10).join(', ') || '(yok)'}`);
      if (kayip.length) console.log(`        acikken gorulmeyen: ${kayip.slice(0, 5).join(', ')}`);

      // Gercek sitelerde reklam yuku her turda birebir ayni degildir; bu
      // yuzden "kapsar" iddiasi TOLERANSLI: kapalidaki hostlarin buyuk
      // cogunlugu acikken de gorulmeli.
      const kapsamaOrani = kapaliKume.length
        ? (kapaliKume.length - kayip.length) / kapaliKume.length : 1;
      console.log(`        kapsama orani: %${(kapsamaOrani * 100).toFixed(0)}`);
      assertOk(kapsamaOrani >= 0.7,
        `acik kume kapalidakini kapsamiyor (%${(kapsamaOrani * 100).toFixed(0)})`);
      assertOk(acikKume.length >= kapaliKume.length,
        'iframe ACIKKEN daha AZ host gorulmus - ayar ters calisiyor');
    });

    await runner.test('1.3 Kayit GERCEKTEN allFrames ile kuruluyor', async () => {
      const acikta = await kayitliBetikler();
      console.log(`        ACIKKEN: ${JSON.stringify(acikta)}`);
      assertOk(acikta.length > 0, 'icerik betigi kayitli degil');
      assertOk(acikta.some(x => x.allFrames === true),
        'iframe ayari ACIKKEN kayit allFrames:true olmali');

      await ayarla({ trackThirdPartyFrames: false });
      const kapalida = await kayitliBetikler();
      console.log(`        KAPALIYKEN: ${JSON.stringify(kapalida)}`);
      assertOk(kapalida.length > 0, 'ayar kapaninca kayit tamamen silinmis');
      assertOk(!kapalida.some(x => x.allFrames === true),
        'ayar kapaninca kayit allFrames:false a daralmali');
    });

    // ================================================================
    console.log('\n########## 2: GOZLEMCI ANA ANAHTARI ##########');
    await runner.test('2.1 trackThirdParty KAPALI: kayit tamamen KALKAR', async () => {
      await ayarla({ trackThirdParty: false });
      const k = await kayitliBetikler();
      console.log(`        kayitli betik: ${k.length}`);
      assertEqual(k.length, 0, 'gozlemci kapaliyken icerik betigi hala kayitli');
    });

    await runner.test('2.2 trackThirdParty ACIK: kayit GERI GELIR', async () => {
      await ayarla({ trackThirdParty: true });
      const k = await kayitliBetikler();
      console.log(`        kayitli betik: ${k.map(x => x.id).join(', ') || '(yok)'}`);
      assertOk(k.length > 0, 'gozlemci acilinca kayit geri gelmedi');
    });

    await runner.test('2.3 ZIYARET EDILEN site 3. taraf sayilmaz', async () => {
      await haritayiSil();
      const s = OLCUM_SITELERI[0];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 7000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      await sleep(3000);
      const h = await harita();
      console.log(`        ${s.kok} gezildi | haritada ${h.length} host`);
      assertOk(h.length > 0, '3. taraf yakalanmadi');
      assertOk(!h.includes(s.kok), 'ANA SITE 3. taraf olarak sayilmis');
      await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(3000);
    });

    // ================================================================
    console.log('\n########## 3: TEMIZLIK - gozlemci ile birlikte ##########');
    await runner.test('3.1 Sekme kapaninca site OTOMATIK temizlenir', async () => {
      await mesaj({ action: 'RESET_RULES' });
      const s = OLCUM_SITELERI[1];
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 5000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = (await cerezler(chrome.client, sw, s.kok)).length;
      assertOk(once > 0, `${s.kok} cerez birakmadi`);

      await tumSekmeleriKapat(chrome.client, s.kok);
      let kalan = once;
      for (let i = 0; i < 15; i++) {
        await sleep(3000);
        kalan = (await cerezler(chrome.client, sw, s.kok)).length;
        if (kalan === 0) break;
      }
      console.log(`        ${s.kok}: ${once} -> ${kalan}`);
      assertEqual(kalan, 0, 'sekme kapanisinda temizlik olmadi');
    });

    await runner.test('3.2 BEYAZ LISTEDEKI site sekme kapaninca KORUNUR', async () => {
      const s = OLCUM_SITELERI[2];
      await mesaj({ action: 'SET_RULE', domain: s.kok, type: 'white', options: {} });
      await tumSekmeleriKapat(chrome.client, s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 5000 }).catch(() => null);
      assertOk(t, `${s.kok} acilamadi`);
      await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
      const once = await cerezler(chrome.client, sw, s.kok);
      assertOk(once.length > 0, `${s.kok} cerez birakmadi`);

      await tumSekmeleriKapat(chrome.client, s.kok);
      await sleep(20000);
      const sonra = await cerezler(chrome.client, sw, s.kok);
      const eksilen = once.filter(c => !sonra.includes(c));
      console.log(`        ${s.kok} (KORUMALI): ${once.length} -> ${sonra.length}, eksilen ${eksilen.length}`);
      assertEqual(eksilen, [], 'beyaz listedeki sitenin cerezleri silinmis');
      await mesaj({ action: 'RESET_RULES' });
    });

    await runner.test('4.1 Gunlukte ERROR yok', async () => {
      const hatalar = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 6);`);
      console.log(`        ERROR: ${hatalar.length ? hatalar.join(' | ') : '(yok)'}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
    });

    not('gozlemci testleri bitti');
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
