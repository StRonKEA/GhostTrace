// GhostTrace E2E - GIZLI ve NORMAL pencere AYNI ANDA kullanildiginda.
//
// KULLANICI BILDIRIMI: "gizli sekme ve normal sekme onceden ayni anda
// kullanildiginda eklentinin kafasi karisiyordu ve cerez silmeyebiliyordu."
//
// Mevcut `features-incognito.e2e.mjs` gizli pencereyi TEK YONLU olcuyor:
// gizli acilir, gizli kapanir, normal profil etkilenmemeli. Bu dosya KARISIK
// kullanimi olcer - ayni sitenin IKI PROFILDE ayni anda acik olmasi ve
// sekmelerin FARKLI SIRALARLA kapanmasi.
//
// NEDEN AYRI BIR RISK: temizlik karari "bu sitenin acik sekmesi var mi?"
// sorusuna dayanir. O sorgu iki profili ayirt etmezse iki yonlu hata olur:
//   * gizli sekme ACIK diye normal profilin temizligi ATLANIR (veri kalir)
//   * gizli sekme KAPANDI diye normal profilin verisi SILINIR (erken silme)
// Ikisi de sessizdir: ne hata ne uyari uretir.
//
// CEREZ DEPOLARI AYRIDIR: gizli pencerenin kendi storeId'si vardir.
// Olcum bunu ayirt etmeli, yoksa "silindi mi?" sorusu yanlis depodan
// cevaplanir. Bu dosyadaki her olcum storeId'yi ACIKCA ayirir.
//
// ON KOSUL: eklentinin "Gizli pencerede calistir" izni ACIK olmali.
//   node tools/prep-profile.mjs
//   GT_PROFILE=<profil-yolu> npm run test:e2e:gizli

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, waitFor, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { makeMsg, makeEval } from './features-common.mjs';

const SITE = { url: 'https://example.com/', host: 'example.com' };
const SITE2 = { url: 'https://example.org/', host: 'example.org' };

const chrome = await launchChrome({
  live: true, headless: process.env.GT_HEADED !== '1',
  profileDir: process.env.GT_PROFILE || null,
  keepProfile: Boolean(process.env.GT_PROFILE)
});
const runner = createRunner();
let setupError = null;
let cikis = 0;

try {
  const { extensionId, sessionId: sw } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  const izin = await run('return await chrome.extension.isAllowedIncognitoAccess();');
  if (!izin) {
    console.error([
      '',
      'OLCUM YAPILAMAZ: eklentinin GIZLI PENCERE izni kapali.',
      '',
      'Elle hazirlik:',
      '  1) node tools/prep-profile.mjs',
      '  2) Uzantilar sekmesi -> "Gizli modda izin ver" ACIN',
      '  3) GT_PROFILE=<profil-yolu> npm run test:e2e:gizli',
      ''
    ].join('\n'));
    cikis = 2;
  } else {
    console.log(`\nGIZLI + NORMAL KARISIK KULLANIM (eklenti ${extensionId})\n`);

    // ------------------------------------------------------------ olcum
    /**
     * Cerezleri DEPOSUNA gore ayirir.
     *
     * chrome.cookies.getAll({}) varsayilan olarak yalnizca CAGIRANIN deposunu
     * dondurur; gizli pencerenin ayri bir storeId'si vardir. Ikisini
     * ayirmadan "silindi mi?" sorusu yanlis depodan cevaplanir - bu dosyanin
     * olcmeye calistigi hatanin ta kendisi olcum tarafinda tekrarlanirdi.
     */
    const cerezler = (host) => evaluate(chrome.client, sw, `
      const depolar = await chrome.cookies.getAllCookieStores();
      const sonuc = {};
      for (const d of depolar) {
        const l = await chrome.cookies.getAll({ domain: ${JSON.stringify(host)}, storeId: d.id });
        sonuc[d.id] = l.map(c => c.name).sort();
      }
      return sonuc;`);

    /** Normal profildeki (varsayilan depo) cerez sayisi. */
    async function normalCerez(host) {
      const d = await cerezler(host);
      return (d['0'] || []).length;
    }

    /** Gizli depolardaki toplam cerez sayisi. */
    async function gizliCerez(host) {
      const d = await cerezler(host);
      return Object.entries(d).filter(([id]) => id !== '0')
        .reduce((t, [, l]) => t + l.length, 0);
    }

    /** Normal profile dogrudan cerez yazar (varsayilan depo). */
    const normalCerezYaz = (host, ad) => evaluate(chrome.client, sw, `
      await chrome.cookies.set({ url: 'https://${host}/', name: ${JSON.stringify(ad)},
        value: '1', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
      return 1;`);

    const istatistik = () => evaluate(chrome.client, sw,
      `return (await chrome.storage.local.get('stats')).stats || {};`);

    const sekmeHaritasi = () => evaluate(chrome.client, sw,
      `return Object.keys((await chrome.storage.session.get('gt_tabMap')).gt_tabMap || {}).length;`);

    /** Gizli baglamda sekme acar. */
    async function gizliAc(url) {
      const { browserContextId } = await chrome.client.send('Target.createBrowserContext', {});
      const { targetId } = await chrome.client.send('Target.createTarget', { url, browserContextId });
      await sleep(4000);
      return { targetId, browserContextId };
    }
    const gizliKapat = async (t) => {
      await chrome.client.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      await sleep(1500);
    };

    async function temizle() {
      await msg({ action: 'RESET_RULES' });
      await evaluate(chrome.client, sw, `
        const depolar = await chrome.cookies.getAllCookieStores();
        for (const d of depolar) {
          for (const c of await chrome.cookies.getAll({ storeId: d.id })) {
            const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\\./, '') + c.path;
            await chrome.cookies.remove({ url, name: c.name, storeId: d.id }).catch(() => {});
          }
        }
        return 1;`);
      await sleep(600);
    }

    await evaluate(chrome.client, page.sessionId, `
      await chrome.storage.local.set({ enabled: true, cleanDelay: 0, cleanCookies: true,
        cleanHistory: true, cleanLocalStorage: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(800);

    // ================================================================
    // 1) AYNI SITE IKI PROFILDE ACIK - NORMAL kapanir
    // ================================================================
    await runner.test('K1. Ayni site iki profilde acik, NORMAL kapanir: normal veri TEMIZLENIR', async () => {
      // BILDIRILEN HATANIN BIRINCI YONU: gizli sekme acik diye "bu sitenin
      // sekmesi hala var" sanilirsa normal profilin temizligi ATLANIR.
      await temizle();
      const gizli = await gizliAc(SITE.url);
      const normal = await visit(chrome.client, SITE.url, { settleMs: 3000 });
      await normalCerezYaz(SITE.host, 'normal_veri');

      const once = await normalCerez(SITE.host);
      assertOk(once > 0, 'olcum icin normal profilde cerez gerekli');

      await closeTarget(chrome.client, normal.targetId);
      const temizlendi = await waitFor('normal profil temizligi',
        async () => (await normalCerez(SITE.host)) === 0,
        { timeoutMs: 25000, intervalMs: 700 }).then(() => true).catch(() => false);

      const kalan = await normalCerez(SITE.host);
      console.log(`        normal ${once} -> ${kalan} cerez (gizli sekme ACIK kaldi)`);
      await gizliKapat(gizli);
      assertOk(temizlendi, 'gizli sekme acik diye normal profilin temizligi ATLANDI');
    });

    // ================================================================
    // 2) AYNI SITE IKI PROFILDE ACIK - GIZLI kapanir
    // ================================================================
    await runner.test('K2. Ayni site iki profilde acik, GIZLI kapanir: normal veri DURUR', async () => {
      // BILDIRILEN HATANIN IKINCI YONU: gizli sekmenin kapanmasi normal
      // profilde temizlik tetiklerse kullanici hala o sitedeyken verisi ucar.
      await temizle();
      const normal = await visit(chrome.client, SITE.url, { settleMs: 3000 });
      const gizli = await gizliAc(SITE.url);
      await normalCerezYaz(SITE.host, 'durmali');

      const once = await normalCerez(SITE.host);
      assertOk(once > 0, 'olcum icin normal profilde cerez gerekli');

      await gizliKapat(gizli);
      await sleep(8000);

      const sonra = await normalCerez(SITE.host);
      console.log(`        normal ${once} -> ${sonra} cerez (normal sekme ACIK, durmali)`);
      await closeTarget(chrome.client, normal.targetId);
      await sleep(3000);
      assertEqual(sonra, once,
        'gizli sekmenin kapanmasi ACIK normal sekmenin verisini sildi');
    });

    // ================================================================
    // 3) SIRALAMA: once gizli, sonra normal
    // ================================================================
    await runner.test('K3. Once GIZLI sonra NORMAL kapanir: sonunda temizlenir', async () => {
      await temizle();
      const normal = await visit(chrome.client, SITE.url, { settleMs: 3000 });
      const gizli = await gizliAc(SITE.url);
      await normalCerezYaz(SITE.host, 'sira_a');

      await gizliKapat(gizli);
      await sleep(5000);
      const ortada = await normalCerez(SITE.host);
      assertOk(ortada > 0, 'gizli kapaninca normal veri erken silinmis');

      await closeTarget(chrome.client, normal.targetId);
      const temizlendi = await waitFor('normal temizlik',
        async () => (await normalCerez(SITE.host)) === 0,
        { timeoutMs: 25000, intervalMs: 700 }).then(() => true).catch(() => false);
      console.log(`        gizli kapandi -> ${ortada} durdu, normal kapandi -> ${await normalCerez(SITE.host)}`);
      assertOk(temizlendi, 'her iki sekme kapandiktan sonra temizlik olmadi');
    });

    // ================================================================
    // 4) SIRALAMA: once normal, sonra gizli
    // ================================================================
    await runner.test('K4. Once NORMAL sonra GIZLI kapanir: cift temizlik hatasi YOK', async () => {
      await temizle();
      const normal = await visit(chrome.client, SITE.url, { settleMs: 3000 });
      const gizli = await gizliAc(SITE.url);
      await normalCerezYaz(SITE.host, 'sira_b');

      const gunlukOnce = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR').length;`);

      await closeTarget(chrome.client, normal.targetId);
      await waitFor('normal temizlik', async () => (await normalCerez(SITE.host)) === 0,
        { timeoutMs: 25000, intervalMs: 700 }).catch(() => {});
      await gizliKapat(gizli);
      await sleep(5000);

      const gunlukSonra = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR').length;`);
      console.log(`        ERROR sayisi ${gunlukOnce} -> ${gunlukSonra} (artmamali)`);
      assertEqual(gunlukSonra, gunlukOnce, 'ikinci kapanis hata uretti');
    });

    // ================================================================
    // 5) GIZLI PENCEREDE COK SEKME
    // ================================================================
    await runner.test('K5. Gizli pencerede UC sekme tek tek kapanir: normal veri hic etkilenmez', async () => {
      await temizle();
      await normalCerezYaz(SITE.host, 'dokunma');
      const once = await normalCerez(SITE.host);

      const sekmeler = [];
      for (let i = 0; i < 3; i++) sekmeler.push(await gizliAc(`${SITE.url}?g=${i}`));
      for (const t of sekmeler) { await gizliKapat(t); await sleep(2500); }
      await sleep(4000);

      const sonra = await normalCerez(SITE.host);
      console.log(`        normal ${once} -> ${sonra} cerez (3 gizli sekme kapandi)`);
      assertEqual(sonra, once, 'gizli sekmelerin kapanmasi normal profilin verisini sildi');
    });

    // ================================================================
    // 6) BEKLEYEN TEMIZLIK gizli kapanisiyla BOZULMAZ
    // ================================================================
    await runner.test('K6. BASKA sitenin bekleyen temizligi gizli kapanisla bozulmaz', async () => {
      await temizle();
      await evaluate(chrome.client, page.sessionId, `
        await chrome.storage.local.set({ cleanDelay: 30 });
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
      await sleep(600);

      const hedef = await visit(chrome.client, SITE2.url, { settleMs: 3000 });
      await normalCerezYaz(SITE2.host, 'bekleyen');
      await closeTarget(chrome.client, hedef.targetId);     // 30 sn'lik temizlik planlandi

      // Bekleme SIRASINDA gizli pencere ac ve kapat.
      const gizli = await gizliAc(SITE.url);
      await sleep(3000);
      await gizliKapat(gizli);

      const temizlendi = await waitFor('bekleyen temizlik',
        async () => (await normalCerez(SITE2.host)) === 0,
        { timeoutMs: 60000, intervalMs: 1000 }).then(() => true).catch(() => false);
      console.log(`        ${SITE2.host} bekleyen temizligi: ${temizlendi ? 'TAMAM' : 'YAPILMADI'}`);

      await evaluate(chrome.client, page.sessionId, `
        await chrome.storage.local.set({ cleanDelay: 0 });
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
      assertOk(temizlendi, 'gizli pencere hareketi bekleyen temizligi iptal etti');
    });

    // ================================================================
    // 7) BEYAZ LISTE gizli gezintiden etkilenmez
    // ================================================================
    await runner.test('K7. Beyaz listedeki site gizli pencerede gezilse de KURAL bozulmaz', async () => {
      await temizle();
      await msg({ action: 'SET_RULE', domain: SITE.host, type: 'white', options: {} });
      await normalCerezYaz(SITE.host, 'korumali');

      const gizli = await gizliAc(SITE.url);
      await gizliKapat(gizli);
      await sleep(5000);

      const kural = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.local.get('rules')).rules || {})[${JSON.stringify(SITE.host)}] || null;`);
      const kalan = await normalCerez(SITE.host);
      console.log(`        kural=${kural?.type || 'YOK'}, normal cerez ${kalan} (durmali)`);
      assertOk(kural, 'gizli gezinti beyaz liste kuralini sildi');
      assertOk(kalan > 0, 'korumali sitenin normal profil verisi silinmis');
      await msg({ action: 'RESET_RULES' });
    });

    // ================================================================
    // 8) ISTATISTIK ve SEKME HARITASI gizli hareketten sismez
    // ================================================================
    await runner.test('K8. Gizli hareket istatistigi ve sekme haritasini SISIRMEZ', async () => {
      await temizle();
      const sOnce = await istatistik();
      const hOnce = await sekmeHaritasi();

      const g1 = await gizliAc(SITE.url);
      const g2 = await gizliAc(SITE2.url);
      const hOrta = await sekmeHaritasi();
      await gizliKapat(g1);
      await gizliKapat(g2);
      await sleep(5000);

      const sSonra = await istatistik();
      const hSonra = await sekmeHaritasi();
      console.log(`        sekme haritasi ${hOnce} -> ${hOrta} (gizli acikken) -> ${hSonra}`);
      console.log(`        istatistik cerez ${sOnce.cookiesDeleted || 0} -> ${sSonra.cookiesDeleted || 0}`);
      assertEqual(hOrta, hOnce, 'gizli sekmeler sekme haritasina girdi');
      assertEqual(sSonra.cookiesDeleted || 0, sOnce.cookiesDeleted || 0,
        'gizli hareket istatistigi sisirdi');
    });

    // ================================================================
    // 9) GIZLI DEPO gercekten AYRI
    // ================================================================
    await runner.test('K9. Gizli ve normal cerez DEPOLARI birbirine karismiyor', async () => {
      await temizle();
      const gizli = await gizliAc(SITE.url);
      await sleep(2500);
      const g = await gizliCerez(SITE.host);
      const n = await normalCerez(SITE.host);
      console.log(`        gizli depoda ${g}, normal depoda ${n} cerez`);
      await gizliKapat(gizli);
      // Gercek site cerez birakmayabilir; iddia SAYI degil AYRIM uzerine.
      assertOk(n === 0, 'gizli gezinti NORMAL depoya cerez yazdi');
    });
  }
} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  const ok = runner.summary() && !setupError;
  await chrome.close();
  process.exit(cikis === 2 ? 2 : (ok ? 0 : 1));
}
