// GhostTrace E2E - KAPSAM (alt alan adlari), GERCEK SITELERDE.
//
// TAKLIT SITE YOK. Onceki surum `ornek.example` / `alt.ornek.example` gibi
// uydurma bir aile kuruyordu. Gercek bir ailede ise:
//   * alt alan adinin KENDI cerezleri olur
//   * kok alan adinin AYRI cerezleri olur (alt alan adindan girilse bile)
//   * kardes alt alan adlari birbirinden bagimsizdir
// Taklit ortam bu ucunu de kusursuz kuruyordu, gercekte hicbiri garanti degil -
// ve bu projede alt alan adi kapsamiyla ilgili GERCEK bir veri kaybi bulundu.
//
// WIKIPEDIA neden secildi: dil alt alan adlari (tr./en.) gercek kardeslerdir,
// ikisi de kendi cerezini birakir ve `.wikipedia.org` uzerinde ORTAK cerezler
// vardir. Yani "kok korunurken alt dal ne oluyor" sorusu gercekten sorulabilir.
//
// ON KOSUL testleri once kosar: aile beklenen sekli tasimiyorsa (ornegin site
// degismis, cerez birakmiyor) sonraki testler BOS OLCUM yapar. Bos gecen test,
// olmayan testtir - o yuzden on kosullar ACIKCA patlar.

import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { cerezler, tumSekmeleriKapat, okuyormusGibi, depolamaOlc } from './gercek.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(6)}sn] ${m}`);

const AILE = {
  kok: 'wikipedia.org',
  kokUrl: 'https://www.wikipedia.org/',
  dal: 'tr.wikipedia.org',
  dalUrl: 'https://tr.wikipedia.org/wiki/Gizlilik',
  kardes: 'en.wikipedia.org',
  kardesUrl: 'https://en.wikipedia.org/wiki/Privacy'
};

/** Kok alan adinin KENDI cerezleri (alt alan adlarininki HARIC). */
const kokCerezleri = (l) => l.filter(c => c.startsWith('wikipedia.org|'));
const dalCerezleri = (l, host) => l.filter(c => c.startsWith(host + '|'));

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const mesaj = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);

    /** Aileyi bastan kurar: her uc adresi gezer, envanter doner. */
    async function aileyiGez() {
      for (const u of [AILE.kokUrl, AILE.dalUrl, AILE.kardesUrl]) {
        await visit(chrome.client, u, { settleMs: 3500 }).catch(() => null);
        await sleep(600);
      }
      // Okuma davranisi cerez uretimini artirir.
      const { targetInfos } = await chrome.client.send('Target.getTargets');
      for (const t of targetInfos) {
        if (t.type !== 'page' || !t.url.includes('wikipedia')) continue;
        const s = await chrome.client.send('Target.attachToTarget',
          { targetId: t.targetId, flatten: true }).then(r => r.sessionId).catch(() => null);
        if (s) await okuyormusGibi(chrome.client, s, { tikla: false });
      }
      return cerezler(chrome.client, sw, AILE.kok);
    }

    async function temizle() {
      await mesaj({ action: 'RESET_RULES' });
      await mesaj({ action: 'PURGE_ALL_NON_WHITELIST' });
      await sleep(6000);
    }

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`KAPSAM TESTLERI - gercek aile: ${AILE.kok} / ${AILE.dal} / ${AILE.kardes}\n`);

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
        cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
        cleanIndexedDB: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(800);

    // ================================================================
    let ilkEnvanter = [];
    await runner.test('0.1 ON KOSUL: gercek aile beklenen sekli tasiyor', async () => {
      await temizle();
      ilkEnvanter = await aileyiGez();
      const kok = kokCerezleri(ilkEnvanter);
      const dal = dalCerezleri(ilkEnvanter, AILE.dal);
      const kardes = dalCerezleri(ilkEnvanter, AILE.kardes);
      console.log(`        toplam ${ilkEnvanter.length} | kok ${kok.length}, ` +
        `${AILE.dal} ${dal.length}, ${AILE.kardes} ${kardes.length}`);
      console.log(`        kok cerezleri: ${kok.join(', ') || '(yok)'}`);
      assertOk(kok.length > 0,
        'kok alan adinda cerez yok - bu ailede kapsam olcumu yapilamaz');
      assertOk(dal.length > 0, `${AILE.dal} kendi cerezini birakmadi`);
    });

    // ================================================================
    console.log('\n########## KOK KURAL: varsayilan kapsam ##########');
    await runner.test('1.1 KOK kuralda kapsam VARSAYILAN ACIK', async () => {
      await mesaj({ action: 'SET_RULE', domain: AILE.kok, type: 'white', options: {} });
      const k = (await evaluate(chrome.client, sw,
        "return (await chrome.storage.local.get('rules')).rules || {};"))[AILE.kok];
      console.log(`        ${AILE.kok}: subdomains=${k?.subdomains}`);
      assertEqual(k?.subdomains, true, 'kok kuralda kapsam varsayilan ACIK olmali');
    });

    await runner.test('1.2 KOK kural TUM alt alan adlarini korur', async () => {
      await tumSekmeleriKapat(chrome.client, AILE.kok);
      const once = await aileyiGez();
      assertOk(once.length > 0, 'olcum icin cerez gerekli');
      await tumSekmeleriKapat(chrome.client, AILE.kok);
      await sleep(20000);
      const sonra = await cerezler(chrome.client, sw, AILE.kok);
      const eksilen = once.filter(c => !sonra.includes(c));
      console.log(`        ${once.length} -> ${sonra.length} cerez | eksilen: ${eksilen.length}`);
      console.log(`        ${AILE.dal}: ${dalCerezleri(sonra, AILE.dal).length}, ` +
        `${AILE.kardes}: ${dalCerezleri(sonra, AILE.kardes).length}, ` +
        `kok: ${kokCerezleri(sonra).length}`);
      assertEqual(eksilen, [], 'kok kural kapsam ACIKKEN alt alan adlarini korumadi');
    });

    // ================================================================
    console.log('\n########## KOK KURAL: kapsam KAPALI ##########');
    await runner.test('2.1 Kapsam KAPALI: kok korunur, ALT DALLAR temizlenir', async () => {
      await temizle();
      await mesaj({ action: 'SET_RULE', domain: AILE.kok, type: 'white',
        options: { subdomains: false } });
      const once = await aileyiGez();
      const kokOnce = kokCerezleri(once).length;
      const dalOnce = dalCerezleri(once, AILE.dal).length;
      assertOk(kokOnce > 0 && dalOnce > 0, 'olcum icin hem kokte hem dalda cerez gerekli');

      await tumSekmeleriKapat(chrome.client, AILE.kok);
      await sleep(25000);
      const sonra = await cerezler(chrome.client, sw, AILE.kok);
      const kokSonra = kokCerezleri(sonra).length;
      const dalSonra = dalCerezleri(sonra, AILE.dal).length;
      console.log(`        kok ${kokOnce}->${kokSonra} (korunmali), ` +
        `${AILE.dal} ${dalOnce}->${dalSonra} (gitmeli)`);
      assertOk(kokSonra > 0, 'kapsam kapaliyken KOKUN kendi cerezleri silinmis');
      assertEqual(dalSonra, 0, 'kapsam kapaliyken alt dal temizlenmedi');
    });

    // ================================================================
    console.log('\n########## ALT DAL KURALI ##########');
    await runner.test('3.1 Alt dal kuralinda kapsam VARSAYILAN KAPALI', async () => {
      await temizle();
      await mesaj({ action: 'SET_RULE', domain: AILE.dal, type: 'white', options: {} });
      const k = (await evaluate(chrome.client, sw,
        "return (await chrome.storage.local.get('rules')).rules || {};"))[AILE.dal];
      console.log(`        ${AILE.dal}: subdomains=${k?.subdomains}`);
      assertEqual(k?.subdomains, false,
        'alt alan adi kuralinda kapsam varsayilan KAPALI olmali (opt-in)');
    });

    await runner.test('3.2 Alt dal kurali YALNIZCA kendini korur - KARDES korunmaz', async () => {
      const once = await aileyiGez();
      const dalOnce = dalCerezleri(once, AILE.dal).length;
      const kardesOnce = dalCerezleri(once, AILE.kardes).length;
      assertOk(dalOnce > 0, `${AILE.dal} cerez birakmadi`);
      assertOk(kardesOnce > 0, `${AILE.kardes} cerez birakmadi - kardes olcumu yapilamaz`);

      await tumSekmeleriKapat(chrome.client, AILE.kok);
      await sleep(25000);
      const sonra = await cerezler(chrome.client, sw, AILE.kok);
      const dalSonra = dalCerezleri(sonra, AILE.dal).length;
      const kardesSonra = dalCerezleri(sonra, AILE.kardes).length;
      console.log(`        ${AILE.dal} ${dalOnce}->${dalSonra} (korunmali), ` +
        `${AILE.kardes} ${kardesOnce}->${kardesSonra} (gitmeli)`);
      assertOk(dalSonra > 0, 'korumali alt dalin cerezleri silinmis');
      assertEqual(kardesSonra, 0, 'KARDES alan adi korunmus - kapsam sizmis');
    });

    // ================================================================
    console.log('\n########## DEPOLAMA da kapsama uyuyor mu ##########');
    // DEPOLAMA olcumu AYRI BIR AILEDE: Wikipedia localStorage/IndexedDB
    // kullanmiyor (olculdu: 0 bayt), yani orada depolama kapsami sinanamaz.
    // Adaylar tarandi ve `news.google.com` 2.8 MB depolama uretiyor -
    // kapsamin depolamaya da uygulandigini gosterecek tek gercek zemin.
    const DEPO = { kok: 'google.com', dal: 'news.google.com',
      dalUrl: 'https://news.google.com/' };

    await runner.test('4.1 KORUNAN alt dalin DEPOLAMASI silinmez', async () => {
      await temizle();
      await mesaj({ action: 'SET_RULE', domain: DEPO.dal, type: 'white', options: {} });
      const t = await visit(chrome.client, DEPO.dalUrl, { settleMs: 5000 }).catch(() => null);
      assertOk(t, `${DEPO.dal} acilamadi`);
      await sleep(3000);
      await tumSekmeleriKapat(chrome.client, DEPO.kok);
      const once = await depolamaOlc(chrome.client, DEPO.dalUrl);
      assertOk(once.usage > 0, `${DEPO.dal} depolama uretmedi - olcum yapilamaz`);

      await sleep(25000);
      const sonra = await depolamaOlc(chrome.client, DEPO.dalUrl);
      console.log(`        ${DEPO.dal} (KORUMALI): ${once.usage} -> ${sonra.usage} bayt (kalmali)`);
      console.log(`          dokum: ${JSON.stringify(once.dokum)}`);
      assertOk(sonra.usage > 0, 'korumali alt dalin depolamasi silinmis');
    });

    await runner.test('4.2 KORUMASIZ alt dalin DEPOLAMASI silinir', async () => {
      await temizle();
      const t = await visit(chrome.client, DEPO.dalUrl, { settleMs: 5000 }).catch(() => null);
      assertOk(t, `${DEPO.dal} acilamadi`);
      await sleep(3000);
      const once = await depolamaOlc(chrome.client, DEPO.dalUrl);
      assertOk(once.usage > 0, `${DEPO.dal} depolama uretmedi`);

      await tumSekmeleriKapat(chrome.client, DEPO.kok);
      let sonra = once;
      for (let i = 0; i < 12; i++) {
        await sleep(4000);
        sonra = await depolamaOlc(chrome.client, DEPO.dalUrl);
        if (sonra.usage === 0) break;
      }
      console.log(`        ${DEPO.dal} (korumasiz): ${once.usage} -> ${sonra.usage} bayt (0 olmali)`);
      assertEqual(sonra.usage, 0, 'korumasiz alt dalin depolamasi silinmedi');
    });

    await runner.test('5.1 Gunlukte ERROR yok', async () => {
      const hatalar = await evaluate(chrome.client, sw,
        `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
           .filter(x => (x.level || '').toUpperCase() === 'ERROR')
           .map(x => x.message).slice(0, 6);`);
      console.log(`        ERROR: ${hatalar.length ? hatalar.join(' | ') : '(yok)'}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
    });

    not('kapsam testleri bitti');
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
