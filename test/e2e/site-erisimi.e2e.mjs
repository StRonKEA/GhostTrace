// SONDA: site erisimi KISITLANINCA eklenti sessiz kalmiyor mu?
// (kontrol listesi 6)
//
// ON KOSUL ELLE KURULUR - otomatiklestirme DENENDI ve OLMADI (Chrome 152,
// 2026-09-02). Uc yol da olculdu:
//   * `chrome.permissions.remove({origins:['<all_urls>']})` -> Chrome reddediyor:
//     "You cannot remove required permissions." (<all_urls> `host_permissions`
//     icinde, yani ZORUNLU; `optional_host_permissions` degil).
//   * `chrome://extensions/?id=...` detay gorunumunde site erisimi kontrolu
//     ARTIK YOK: `#host-access` radyo grubu bulunmuyor, izin listesi host
//     iznini hic yazmiyor. Kalan `#siteSettings` baglantisi eklentinin KENDI
//     site detayina gidiyor (chrome://settings/content/siteDetails?site=
//     chrome-extension://<id>), erisim daraltmaya degil.
//   * `chrome://settings/content/siteAccess` YOK - chrome://settings/'e duser.
// Kontrol araclara tasindi (arac cubugu menusu) ve o menu CDP ile surulemiyor.
//
// Bu yuzden bu sonda `features-incognito` / `features-hardening` ile AYNI
// sozlesmeyi kullanir: on kosul saglanmamissa OLCMEDEN CIKAR (kod 2). Yanlis
// bir yesil de, anlamsiz bir kirmizi da uretmez.
//
// ELLE KURULUM: arac cubugundaki eklenti simgesine sag tik -> "Bu siteyi
// okuyabilir ve degistirebilir" -> "Tikladiginizda". Sonra:
//   GT_PROFILE=<profil> node test/e2e/sonda-siteErisimi.mjs
//
// URUN TARAFI zaten birim testlerinde kapsanmis durumda (rozet '!':
// service-worker.test.js; NO_HOST_ACCESS: popup/options/service-worker).
// Burada olculen ek sey, o yollarin GERCEK Chrome'da gercek bir daraltmayla
// tetiklendigi.
//
// Dogrulananlar, hepsi "sessiz basarisizlik" karsiti:
//   1. hasAllSitesAccess / hasHostAccess false doner
//   2. rozet '!' gosterir
//   3. temizlik DENENMEZ ve loga ERROR duser ("Temizlendi | cerez: 0" demez)
//   4. popup uyari kartini (accessCard) acar, normal kartlari gizler
//   5. cerezler YERINDE kalir - iddia edilen silme gerceklesmemistir
import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { cerezler, okuyormusGibi } from './gercek.mjs';

const SITE = { url: 'https://github.com/', kok: 'github.com' };

const t0 = Date.now();
const not = (m) => console.log(`  ..[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}sn] ${m}`);

const PROFIL = process.env.GT_PROFILE || null;

async function main() {
  const chrome = await launchChrome({
    live: true, headless: process.env.GT_HEADED !== '1',
    profileDir: PROFIL, keepProfile: Boolean(PROFIL)
  });
  const runner = createRunner();

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');

    const ayarla = async (a) => {
      await evaluate(chrome.client, sayfa.sessionId, `
        await chrome.storage.local.set(${JSON.stringify(a)});
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
      await sleep(1200);
    };
    const erisim = () => evaluate(chrome.client, sw, `
      return {
        tumSiteler: await chrome.permissions.contains({ origins: ['<all_urls>'] }),
        github: await chrome.permissions.contains({ origins: ['https://github.com/*'] })
      };`);
    const loglar = () => evaluate(chrome.client, sw,
      "const l = await chrome.storage.session.get('gt_logs'); return (l.gt_logs || []).map(x => ({ s: x.level, m: x.message }));");

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log('SITE ERISIMI KISITLI - kontrol listesi 6\n');

    await ayarla({
      rules: {}, enabled: true, cleanDelay: 0,
      cleanCookies: true, cleanHistory: true,
      periodicCleanEnabled: false, trackThirdParty: false, logLevel: 'info'
    });

    // --- TOHUM: erisim VARKEN cerez birak --------------------------------
    const t = await visit(chrome.client, SITE.url, { settleMs: 4000 });
    await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
    await sleep(1500);
    const once = await cerezler(chrome.client, sw, SITE.kok);
    const erisimSonra = await erisim();
    not(`erisim: ${JSON.stringify(erisimSonra)} | cerez: ${once.length}`);

    // --- ON KOSUL ---------------------------------------------------------
    // Erisim daraltilmamissa olculecek bir sey yok. Son bir sans olarak
    // programatik yol denenir; Chrome 152'de reddediyor (yukaridaki not).
    if (erisimSonra.github !== false) {
      const kaldirildi = await evaluate(chrome.client, sw,
        "try { return await chrome.permissions.remove({ origins: ['<all_urls>'] }); } catch (e) { return 'HATA: ' + e.message; }");
      await sleep(2000);
      const tekrar = await erisim();
      not(`permissions.remove -> ${JSON.stringify(kaldirildi)} | erisim: ${JSON.stringify(tekrar)}`);
      if (tekrar.github !== false) {
        console.log('\n  ON KOSUL YOK: site erisimi daraltilmamis - OLCUM YAPILMADI.');
        console.log('  Arac cubugundaki eklenti simgesine sag tik -> "Bu siteyi okuyabilir');
        console.log('  ve degistirebilir" -> "Tikladiginizda" secip GT_PROFILE ile tekrar kosun.\n');
        process.exitCode = 2;   // on kosul yok: 'olcmeden cik' sozlesmesi
        return;
      }
    }
    await runner.test('ON KOSUL site cerez birakti', () => {
      assertOk(once.length > 0, `cerez yok (${once.length})`);
    });

    // --- 1: ROZET '!' -----------------------------------------------------
    // Rozet sekme olayinda guncelleniyor; sekmeyi yeniden etkinlestir.
    const sekme = await evaluate(chrome.client, sw, `
      const [tab] = await chrome.tabs.query({ url: 'https://github.com/*' });
      if (!tab) return null;
      await chrome.tabs.update(tab.id, { active: true });
      return tab.id;`);
    await sleep(2500);
    const rozet = sekme === null ? null : await evaluate(chrome.client, sw,
      `return await chrome.action.getBadgeText({ tabId: ${sekme} });`);
    not(`rozet: ${JSON.stringify(rozet)}`);
    await runner.test('rozet UYARI (!) gosterir', () => {
      assertEqual(rozet, '!', `rozet beklenen degil: ${JSON.stringify(rozet)}`);
    });

    // --- 2: TEMIZLIK DENENMEZ, LOGA ERROR DUSER ---------------------------
    // Loglar BASA eklenir (flushLogs: [...yeni, ...eski]) - yeni kayitlar dizinin BASINDA.
    const logOnce = (await loglar()).length;
    const sonuc = await evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage({ action: 'PURGE_DOMAIN', domain: '${SITE.kok}' });`);
    await sleep(2000);
    const tumLog = await loglar();
    const yeniLoglar = tumLog.slice(0, Math.max(0, tumLog.length - logOnce));
    const hatalar = yeniLoglar.filter(l => String(l.s).toLowerCase() === 'error');
    not(`PURGE_DOMAIN -> ${JSON.stringify(sonuc).slice(0, 160)}`);
    console.log(`        yeni log: ${JSON.stringify(yeniLoglar.map(l => l.s + ': ' + l.m).slice(0, 4))}`);

    await runner.test('temizlik BASARILI diye raporlanmaz', () => {
      assertOk(sonuc?.success === false && sonuc?.error === 'NO_HOST_ACCESS',
        `NO_HOST_ACCESS donmedi: ${JSON.stringify(sonuc).slice(0, 200)}`);
    });
    await runner.test('loga ERROR duser', () => {
      assertOk(hatalar.length > 0 && /erisim/i.test(hatalar.map(h => h.m).join(' ')),
        `erisim ERROR-u yok: ${JSON.stringify(yeniLoglar.slice(0, 5))}`);
    });

    const sonraCerez = await cerezler(chrome.client, sw, SITE.kok);
    await runner.test('cerezler YERINDE kalir (sessiz veri kaybi yok)', () => {
      assertEqual(sonraCerez.length, once.length,
        `erisim yokken cerez sayisi degisti: ${once.length} -> ${sonraCerez.length}`);
    });

    // --- 3: POPUP UYARI KARTI --------------------------------------------
    // Popup AKTIF sekmeyi okur. openExtensionPage yeni sekmeyi one aldigi icin
    // once github'i geri etkinlestirip popup'i YENIDEN yuklemek gerekiyor;
    // yoksa popup 'tarayici ici sayfa' kartini acar ve olcum yanlis olur.
    const popup = await openExtensionPage(chrome.client, ek.extensionId, 'popup/popup.html');
    if (sekme !== null) {
      await evaluate(chrome.client, sw, `await chrome.tabs.update(${sekme}, { active: true }); return 1;`);
      await sleep(500);
      await evaluate(chrome.client, popup.sessionId, 'location.reload(); return 1;').catch(() => {});
    }
    await sleep(3000);
    const kartlar = await evaluate(chrome.client, popup.sessionId, `
      const g = (id) => { const e = document.getElementById(id); return e ? !e.classList.contains('hidden') : null; };
      return { accessCard: g('accessCard'), domainCard: g('domainCard'), grantBtn: Boolean(document.getElementById('btnGrantAccess')) };`);
    not(`popup: ${JSON.stringify(kartlar)}`);

    await runner.test('popup ERISIM UYARI kartini acar', () => {
      assertEqual(kartlar.accessCard, true, 'accessCard gizli');
    });
    await runner.test('popup normal site kartini GIZLER', () => {
      assertEqual(kartlar.domainCard, false, 'domainCard hala gorunur - yanlis bilgi verir');
    });
    await runner.test('popup ERISIM ISTE dugmesi sunar', () => {
      assertEqual(kartlar.grantBtn, true, 'btnGrantAccess yok');
    });

    // NOT: dugmeye basip erisimi GERI ALMAK otomatiklestirilemiyor -
    // chrome.permissions.request kullanici hareketi ister ve CDP'nin urettigi
    // tik bunu karsilamiyor. Kalan tek elle adim bu.
  } finally {
    await chrome.close();
  }

  process.exit(runner.summary() ? 0 : 1);
}

main().catch((e) => { console.error('\nSONDA PATLADI:', e); process.exit(1); });
