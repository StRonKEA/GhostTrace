// KADEME 8: GIZLI PENCERE yalitimi (elle hazirlik gerektirir).
//
// Kullanici bildirimi: gizli pencerede bir site acilip kapatilinca NORMAL
// profildeki ayni sitenin verisi siliniyordu. Sebep, service worker'in
// (spanning modda) normal profilin baglaminda calisirken chrome.tabs.query({})
// ile gizli sekmeleri DE gormesi.
//
// ON KOSUL: eklentinin "Gizli pencerede calistir" izni ACIK olmali. Chrome bu
// izni programatik olarak vermiyor - Secure Preferences yamasi MAC dogrulamasi
// tarafindan geri aliniyor, chrome://extensions anahtarina tiklamak ise
// eklentiyi yeniden baslatip otomasyonu koparıyor. Izin YOKSA bu takim
// SESSIZCE GECMEZ: acikca durur ve ne yapilacagini soyler.
//
// Elle hazirlik:
//   1) npm run e2e:setup ile inen tarayiciyi kalici bir profille acin
//   2) chrome://extensions -> GhostTrace -> Ayrintilar
//   3) "Gizli pencerede calistir" acin
//   4) GT_PROFILE=<profil-yolu> npm run test:e2e:incognito

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  sleep, waitFor, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { makeMsg, makeEval, cookieCountFor, setTestCookie, resetAll, applySettings } from './features-common.mjs';

const SITE = { url: 'https://example.com/', host: 'example.com' };

const chrome = await launchChrome({
  live: true, headless: true,
  profileDir: process.env.GT_PROFILE || null,
  keepProfile: Boolean(process.env.GT_PROFILE)
});
const runner = createRunner();
let setupError = null;
let cikis = 0;

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  const izin = await run(`return await chrome.extension.isAllowedIncognitoAccess();`);
  if (!izin) {
    console.error([
      '',
      'OLCUM YAPILAMAZ: eklentinin GIZLI PENCERE izni kapali.',
      '',
      'Izin olmadan eklenti gizli sekmeleri HIC GORMEZ; "gizli sekme normal',
      'profili etkilemiyor" testi otomatik gecerdi ama HICBIR SEY olcmezdi.',
      'Sessiz bir yesil uretmektense duruyoruz.',
      '',
      'Hazirlik:',
      '  1) chrome://extensions -> GhostTrace -> Ayrintilar',
      '  2) "Gizli pencerede calistir" secenegini ACIN',
      '  3) O profilin yolunu vererek tekrar calistirin:',
      '     GT_PROFILE=<profil-yolu> npm run test:e2e:incognito',
      '',
      'Not: gizli pencere yalitimi BIRIM testlerinde tam olarak kapsanmistir',
      '     (test/service-worker.test.js -> "GIZLI PENCERE normal profile SIZMAZ").',
      ''
    ].join('\n'));
    cikis = 2;
  } else {
    console.log(`\nKADEME 8: gizli pencere yalitimi (eklenti ${extensionId})\n`);
    await applySettings(msg, run, { enabled: true, cleanDelay: 0, trackThirdParty: true });

    /** Gizli baglamda sekme acar. */
    async function gizliSekmeAc(url) {
      const { browserContextId } = await chrome.client.send('Target.createBrowserContext', {});
      const { targetId } = await chrome.client.send('Target.createTarget', { url, browserContextId });
      await sleep(4000);
      return { targetId, browserContextId };
    }

    await runner.test('8.1 Eklenti gizli sekmeyi GORUYOR (on kosul dogrulamasi)', async () => {
      const t = await gizliSekmeAc(SITE.url);
      const sekmeler = await run(`
        const t = await chrome.tabs.query({});
        return t.filter(x => x.incognito === true).length;
      `);
      await chrome.client.send('Target.closeTarget', { targetId: t.targetId });
      await sleep(1500);
      assertOk(sekmeler > 0,
        'izin acikken eklenti gizli sekmeyi gormeli - yoksa sonraki testler bos olcum yapar');
    });

    await runner.test('8.2 GIZLI sekme kapaninca NORMAL profil verisi SILINMEZ', async () => {
      await resetAll(msg, run);
      await setTestCookie(run, SITE.host, 'normal_veri');
      assertOk(await cookieCountFor(run, SITE.host) > 0, 'once normal profilde veri olmali');

      const t = await gizliSekmeAc(SITE.url);
      await chrome.client.send('Target.closeTarget', { targetId: t.targetId });
      await sleep(6000);

      assertOk(await cookieCountFor(run, SITE.host) > 0,
        'BILDIRILEN HATA: gizli sekmenin kapanmasi normal profildeki veriyi silmemeli');
    });

    await runner.test('8.3 GIZLI sekme ACIK diye NORMAL temizlik ENGELLENMEZ', async () => {
      await resetAll(msg, run);
      const gizli = await gizliSekmeAc(SITE.url);
      const normal = await visit(chrome.client, SITE.url, { settleMs: 3000 });
      await setTestCookie(run, SITE.host, 'temizlenecek');
      await closeTarget(chrome.client, normal.targetId);

      await waitFor('normal sekme kapanisinda temizlik', async () =>
        (await cookieCountFor(run, SITE.host)) === 0, { timeoutMs: 20000, intervalMs: 700 })
        .finally(() => chrome.client.send('Target.closeTarget', { targetId: gizli.targetId }).catch(() => {}));
    });

    await runner.test('8.4 GIZLI gezintinin 3. taraflari haritaya GIRMEZ', async () => {
      await resetAll(msg, run);
      const t = await gizliSekmeAc('https://www.bbc.com/news');
      await sleep(8000);
      const harita = await run(`
        const d = await chrome.storage.session.get('gt_thirdParty');
        return Object.keys(d.gt_thirdParty || {});
      `);
      await chrome.client.send('Target.closeTarget', { targetId: t.targetId });
      assertEqual(harita, [],
        `gizli gezintide gorulen 3. taraflar normal profil haritasina yazilmamali; yazilan: ${harita.join(', ')}`);
    });

    await runner.test('8.5 GIZLI sekme, sekme haritasina GIRMEZ', async () => {
      const t = await gizliSekmeAc(SITE.url);
      const harita = await run(`
        const d = await chrome.storage.session.get('gt_tabMap');
        return Object.values(d.gt_tabMap || {});
      `);
      await chrome.client.send('Target.closeTarget', { targetId: t.targetId });
      assertOk(!harita.some(u => String(u).includes('example.com')),
        `gizli sekme haritaya yazilmamali; harita: ${JSON.stringify(harita)}`);
    });
  }
} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  if (cikis === 0) {
    const ok = runner.summary() && !setupError;
    cikis = ok ? 0 : 1;
  }
  await chrome.close();
  process.exit(cikis);
}
