// KADEME 9: GIZLILIK SERTLESTIRME (elle hazirlik gerektirir).
//
// Bes sertlestirme anahtari chrome.privacy uzerinden yazilir ve GERI
// OKUNARAK dogrulanir. Bunun icin opsiyonel `privacy` izni gerekli.
//
// ON KOSUL: izin verilmis olmali. chrome.permissions.request kullanici jesti
// istiyor; CDP'nin userGesture bayragi istemi ACIYOR ama headless'ta kimse
// kapatmadigi icin cagri ASILIYOR. Izin yoksa bu takim SESSIZCE GECMEZ.
//
// Elle hazirlik:
//   1) Kalici bir profille tarayiciyi acin
//   2) Eklenti Ayarlar -> Gizlilik Sertlestirme -> izin ver
//   3) GT_PROFILE=<profil-yolu> npm run test:e2e:hardening

import {
  launchChrome, attachExtension, openExtensionPage,
  createRunner, assertEqual, assertOk, sleep
} from './harness.mjs';
import { makeMsg, makeEval } from './features-common.mjs';

const chrome = await launchChrome({
  live: true, headless: true,
  profileDir: process.env.GT_PROFILE || null,
  keepProfile: Boolean(process.env.GT_PROFILE)
});
const runner = createRunner();
let setupError = null;
let cikis = 0;

/** Kalici olanlar - Chrome bunlari kaldirmiyor. */
const KALICI = ['blockThirdPartyCookies'];
/** Kaldirilma yolunda olanlar - yoksa "unsupported" beklenir, hata degil.
 *  Topics/FLEDGE/Attribution 2026-08-30'da KAPSAM DISI birakildi (silme isine
 *  katkilari yoktu); tasfiye yolundaki tek anahtar RWS kaldi. */
const TASFIYE = ['disableRelatedWebsiteSets'];
/** Uzak sunucuda iz olusmasini ONLEYENLER. */
const ONLEYICI = ['disableNetworkPrediction', 'disableSearchSuggest', 'disableAlternateErrorPages'];

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  const izin = await run(`return await chrome.permissions.contains({ permissions: ['privacy'] });`);
  if (!izin) {
    console.error([
      '',
      'OLCUM YAPILAMAZ: opsiyonel `privacy` izni verilmemis.',
      '',
      'Izin olmadan applyHardening zaten available:false donuyor (bu durum',
      'features-system 7.3 ile ZATEN test ediliyor). Anahtarlarin tarayiciya',
      'GERCEKTEN yazilip yazilmadigini olcmek icin izin sart.',
      '',
      'Hazirlik:',
      '  1) Kalici bir profille tarayiciyi acin',
      '  2) Eklenti Ayarlar -> Gizlilik Sertlestirme -> izin ver',
      '  3) GT_PROFILE=<profil-yolu> npm run test:e2e:hardening',
      ''
    ].join('\n'));
    cikis = 2;
  } else {
    console.log(`\nKADEME 9: gizlilik sertlestirme (eklenti ${extensionId})\n`);

    await runner.test('9.1 Izin varken available:true doner', async () => {
      const r = await msg({ action: 'APPLY_HARDENING', hardening: {} });
      assertOk(r.success, 'cagri basarili olmali');
      assertEqual(r.outcome.available, true, 'izin varken available true olmali');
    });

    await runner.test('9.2 KALICI anahtarlar tarayiciya GERCEKTEN yazilir', async () => {
      const acik = Object.fromEntries(KALICI.map(k => [k, true]));
      const r = await msg({ action: 'APPLY_HARDENING', hardening: acik });

      for (const anahtar of KALICI) {
        assertOk(r.outcome.applied.some(a => a.startsWith(anahtar)),
          `${anahtar} uygulanmali; applied: ${JSON.stringify(r.outcome.applied)}`);
      }
      // GERI OKUMA: iddia degil tarayicinin kendi cevabi.
      assertEqual(r.state.values.blockThirdPartyCookies, true,
        '3. taraf cerezleri gercekten engellenmis olmali');
    });

    await runner.test('9.3 Chrome API kaldirdiysa "unsupported" der, sessiz kalmaz', async () => {
      const r = await msg({
        action: 'APPLY_HARDENING',
        hardening: Object.fromEntries(TASFIYE.map(k => [k, true]))
      });
      for (const anahtar of TASFIYE) {
        const uygulandi = r.outcome.applied.some(a => a.startsWith(anahtar));
        const desteksiz = r.outcome.unsupported.includes(anahtar);
        assertOk(uygulandi || desteksiz,
          `${anahtar} ya uygulanmali ya "unsupported" olmali - sessizce yutulmamali`);
      }
      console.log(`      -> uygulanan: ${r.outcome.applied.length}, kaldirilmis: ${r.outcome.unsupported.join(', ') || '(yok)'}`);
    });

    await runner.test('9.4 ONLEYICI anahtarlar (ag/arama) uygulanir', async () => {
      const r = await msg({
        action: 'APPLY_HARDENING',
        hardening: Object.fromEntries(ONLEYICI.map(k => [k, true]))
      });
      for (const anahtar of ONLEYICI) {
        const ok = r.outcome.applied.some(a => a.startsWith(anahtar)) || r.outcome.unsupported.includes(anahtar);
        assertOk(ok, `${anahtar} uygulanmali veya desteksiz bildirilmeli`);
      }
    });

    await runner.test('9.5 TEK YONLU: kapatinca IZIN VERICI deger YAZILMAZ', async () => {
      // Kritik: eskiden kapali anahtar icin de set() cagriliyor ve tum
      // girdiler invert oldugu icin TRUE yaziliyordu - yani kullanicinin
      // Chrome ayarlarindan actigi korumayi eklenti geri kapatiyordu.
      await msg({ action: 'APPLY_HARDENING', hardening: { blockThirdPartyCookies: true } });
      const r = await msg({ action: 'APPLY_HARDENING', hardening: { blockThirdPartyCookies: false } });

      assertOk(r.outcome.released.includes('blockThirdPartyCookies'),
        `kapali anahtar "released" olmali (clear), applied degil: ${JSON.stringify(r.outcome)}`);
      assertOk(!r.outcome.applied.some(a => a.startsWith('blockThirdPartyCookies')),
        'kapali anahtar applied listesine girmemeli');
    });

    await runner.test('9.6 DURUM okuma tarayicinin GERCEK degerini verir', async () => {
      await msg({ action: 'APPLY_HARDENING', hardening: { disableNetworkPrediction: true } });
      const r = await msg({ action: 'APPLY_HARDENING', hardening: { disableNetworkPrediction: true } });
      assertEqual(r.state.available, true, 'durum okunabilmeli');
      assertEqual(r.state.values.disableNetworkPrediction, true, 'gercek deger okunmali');
      assertOk(typeof r.state.levels.disableNetworkPrediction === 'string',
        'levelOfControl bildirilmeli - kim kontrol ediyor gorunmeli');
    });

    await runner.test('9.7 ILISKILI SITE KUMELERI tarayiciya GERCEKTEN yazilir', async () => {
      // 3. taraf cerez engelinin RESMI kacis kapisi. Birim testi taklit bir
      // chrome.privacy uzerinde calisiyor; burada asil soru su: Chromium bu
      // anahtari GERCEKTEN kabul ediyor mu, yoksa set() sessizce yutuluyor mu?
      //
      // Kaldirilmis olabilir (M152 tasfiye takvimi) - o zaman "unsupported"
      // beklenir. Kabul edilmeyen tek sey: ne uygulandi ne desteksiz denmesi.
      const r = await msg({
        action: 'APPLY_HARDENING',
        hardening: { disableRelatedWebsiteSets: true }
      });

      const uygulandi = r.outcome.applied.some(a => a.startsWith('disableRelatedWebsiteSets'));
      const desteksiz = r.outcome.unsupported.includes('disableRelatedWebsiteSets');
      assertOk(uygulandi || desteksiz,
        'kumeler ya kapatilmali ya "tarayici kaldirdi" denmeli - sessizce yutulmamali');

      if (uygulandi) {
        // GERI OKUMA: iddia degil tarayicinin kendi cevabi.
        assertEqual(r.state.values.disableRelatedWebsiteSets, true,
          'kumeler gercekten devre disi olmali');
        const ham = await run(`
          const s = chrome.privacy.websites.relatedWebsiteSetsEnabled;
          return (await s.get({})).value;
        `);
        assertEqual(ham, false,
          'ham API degeri false olmali (kume muafiyeti kapali)');
        console.log('      -> Chromium anahtari kabul etti, kume muafiyeti kapali');
      } else {
        console.log('      -> tarayici anahtari kaldirmis, "unsupported" bildirildi');
      }
    });

    await runner.test('9.8 TARAYICI zaten sikiysa bu SOYLENIR, kutu sessizce geri donmez',
      async () => {
        // Tarayici bir ayari kendi uyguluyorsa kapatmak etkisiz kalir ve
        // kutu geri isaretlenir. Dogru davranis bunu SOYLEMEK: kilitle ve
        // sebebini yaz. Bu test o bildirimi bekci altina alir.
        await msg({ action: 'APPLY_HARDENING', hardening: {} });   // hepsini birak
        await sleep(800);
        const r = await msg({ action: 'APPLY_HARDENING' });        // yalnizca oku

        assertOk(Array.isArray(r.state.browserEnforced),
          'state.browserEnforced alani yok - arayuz sebebi gosteremez');

        // Hicbirimiz kontrol etmiyorken deger sertlestirilmis olan her anahtar
        // bu listede olmali. Ham API'den bagimsiz olarak dogruluyoruz.
        const beklenen = [];
        for (const k of Object.keys(r.state.values)) {
          if (r.state.values[k] && r.state.levels[k] === 'controllable_by_this_extension') {
            beklenen.push(k);
          }
        }
        console.log(`      -> tarayicinin kendi sikilastirdiklari: ` +
          `${r.state.browserEnforced.join(', ') || '(yok)'}`);
        assertEqual(r.state.browserEnforced.sort(), beklenen.sort(),
          'tarayicinin zaten uyguladigi anahtarlar eksiksiz bildirilmeli');

        // Bildirilen anahtarin arayuzde KILITLI olmasi ve sebebini YAZMASI
        // gerekir; aksi halde kullanici yine sebepsiz geri donen kutu gorur.
        if (r.state.browserEnforced.length) {
          const anahtar = r.state.browserEnforced[0];
          // Arayuzu TAZELE. Mesajlar dogrudan gonderildigi icin sayfa kendini
          // yeniden cizmedi; kilit durumunu tazelemeden olcmek eski ekrani
          // olcmek olurdu.
          await chrome.client.send('Page.navigate',
            { url: `chrome-extension://${extensionId}/options/options.html` }, page.sessionId);
          await sleep(3000);
          const ui = await run(`
            const k = document.querySelector('[data-hardening=${JSON.stringify(anahtar)}]');
            return { kapali: k?.disabled,
              not: k?.closest('.toggle-item')?.querySelector('.setting-warning')?.textContent || null };`);
          console.log(`      -> ${anahtar}: kilitli=${ui.kapali}, not="${ui.not || ''}"`);
          assertEqual(ui.kapali, true, `${anahtar} kutusu kilitlenmemis`);
          assertOk(ui.not && ui.not.length > 5, `${anahtar} icin aciklama yazilmamis`);
        } else {
          console.log('      -> bu tarayicida hicbir anahtari tarayici kendi sikilastirmamis');
        }
      });

    // Temizlik: birakilan gecersiz kilmalari kaldir.
    await msg({ action: 'APPLY_HARDENING', hardening: {} });
    await sleep(500);
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
