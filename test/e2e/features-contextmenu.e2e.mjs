// KADEME 11: SAG TIK MENUSU (elle hazirlik gerektirir).
//
// Menu opsiyonel `contextMenus` iznine bagli ve VARSAYILAN KAPALI. Izin
// verilmemisse chrome.contextMenus tanimsiz olur; birim testler bunu bir
// taklitle kapsiyor ama taklit su hata siniflarini GOREMEZ:
//
//   * gecersiz `contexts` degeri  -> gercek Chrome atar, taklit kabul eder
//   * yinelenen menu id           -> "Cannot create item with duplicate id"
//     MV3'te service worker yeniden baslayinca syncContextMenus tekrar
//     cagrilir; removeAll atlanirsa menu SESSIZCE kurulamaz
//   * update() ile gecersiz alan  -> gercek Chrome atar
//
// Burada olculen sey bu: GERCEK API cagrilari kabul ediyor mu.
//
// ON KOSUL: `contextMenus` izni verilmis olmali. Izin yoksa bu takim
// SESSIZCE GECMEZ: acikca durur ve ne yapilacagini soyler.
//
// Elle hazirlik:
//   1) node tools/prep-profile.mjs
//   2) Ayarlar -> Bildirimler ve rozet -> "Sag tik menusune ekle" ACIN
//   3) GT_PROFILE=<profil-yolu> npm run test:e2e:contextmenu

import {
  launchChrome, attachExtension, openExtensionPage, evaluate, visit, closeTarget,
  createRunner, assertEqual, sleep
} from './harness.mjs';
import { makeMsg, makeEval, applySettings } from './features-common.mjs';

const MENU_ROOT = 'gt:menu:root';
const MENU_PURGE = 'gt:menu:purge';
const MENU_WHITELIST = 'gt:menu:whitelist';

const chrome = await launchChrome({
  live: true, headless: true,
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

  /** Service worker baglaminda calistirir - menu API'si orada kullaniliyor. */
  const inSw = (expr) => evaluate(chrome.client, sw, expr, { timeoutMs: 10000 });

  const izin = await inSw('return Boolean(chrome.contextMenus?.create);');
  if (!izin) {
    console.error([
      '',
      'ATLANMADI - DURDURULDU: `contextMenus` izni verilmemis.',
      '',
      'chrome.permissions.request kullanici jesti istiyor; CDP ile verilemiyor.',
      'Elle hazirlik:',
      '  1) node tools/prep-profile.mjs',
      '  2) Ayarlar -> Bildirimler ve rozet -> "Sag tik menusune ekle" ACIN',
      '  3) GT_PROFILE=<profil-yolu> npm run test:e2e:contextmenu',
      ''
    ].join('\n'));
    process.exit(1);
  }

  /**
   * Bir menu ogesi GERCEKTEN var mi?
   *
   * chrome.contextMenus listeleme API'si vermiyor. Varlik su sekilde
   * olculuyor: ayni id ile create denenir. Oge varsa Chrome "duplicate id"
   * atar (yani VAR), yoksa olusur ve hemen silinir (yani YOKTU).
   */
  const ogeVarMi = (id) => inSw(`
    try {
      await new Promise((coz, hata) => {
        chrome.contextMenus.create({ id: ${JSON.stringify(id)}, title: 'sonda', contexts: ['page'] },
          () => chrome.runtime.lastError ? hata(new Error(chrome.runtime.lastError.message)) : coz());
      });
      // Olustu demek ki YOKTU; sondayi temizle.
      await chrome.contextMenus.remove(${JSON.stringify(id)});
      return false;
    } catch (e) {
      return String(e.message || e).includes('duplicate');
    }
  `);

  console.log(`\nKADEME 11: sag tik menusu (eklenti ${extensionId})\n`);

  await runner.test('11.1 Izin VAR: chrome.contextMenus erisilebilir', async () => {
    assertEqual(await inSw('return Boolean(chrome.contextMenus?.create);'), true,
      'on kosul: izin verilmis olmali');
  });

  await runner.test('11.2 Ayar ACIK: uc menu ogesi GERCEKTEN kurulur', async () => {
    await applySettings(msg, run, { contextMenuEnabled: true });
    await sleep(900);

    for (const [id, ad] of [[MENU_ROOT, 'kok'], [MENU_PURGE, 'temizle'], [MENU_WHITELIST, 'beyaz liste']]) {
      assertEqual(await ogeVarMi(id), true, `${ad} ogesi kurulmus olmali (${id})`);
    }
  });

  await runner.test('11.3 Kok id ZATEN VARKEN yeniden kurulum menuyu bozmaz', async () => {
    // MV3'te service worker olup olup dirilir ve syncContextMenus tekrar
    // cagrilir. removeAll atlanirsa ilk create "duplicate id" ile duser ve
    // ALT OGELER HIC olusmaz: kullanici sag tikliyor, menu yarim.
    //
    // Olcum loga bakmiyor (SETTINGS_CHANGED basarili yolda log uretmiyor,
    // yani "uyari yok" iddiasi her zaman dogru olurdu). Yerine: kok id'yi
    // ELLE dikip yeniden kurulumu tetikliyoruz ve UC OGENIN de var oldugunu
    // dogruluyoruz. removeAll kaldirilirsa alt ogeler kaybolur.
    // Once HEPSINI kaldir, sonra YALNIZCA kok id'yi tuzak olarak dik.
    // Alt ogeleri de silmek SART: onceki testten kalirlarsa "var" cikar ve
    // olcum ayirt edemez (bir kez tam olarak bu oldu).
    await inSw(`
      await chrome.contextMenus.removeAll();
      await new Promise(c => chrome.contextMenus.create(
        { id: ${JSON.stringify(MENU_ROOT)}, title: 'tuzak', contexts: ['page'] }, () => c()));
      return true;
    `);

    await msg({ action: 'SETTINGS_CHANGED' });
    await sleep(1000);

    for (const [id, ad] of [[MENU_ROOT, 'kok'], [MENU_PURGE, 'temizle'], [MENU_WHITELIST, 'beyaz liste']]) {
      assertEqual(await ogeVarMi(id), true,
        `tuzak ogeye ragmen ${ad} kurulmus olmali (${id})`);
    }
  });

  await runner.test('11.4 Ayar KAPALI: ogeler GERCEKTEN kaldirilir', async () => {
    await applySettings(msg, run, { contextMenuEnabled: false });
    await sleep(900);

    for (const id of [MENU_ROOT, MENU_PURGE, MENU_WHITELIST]) {
      assertEqual(await ogeVarMi(id), false, `ayar kapaliyken oge kalmamali: ${id}`);
    }
  });

  await runner.test('11.5 Etiket guncelleme GERCEK API tarafindan kabul edilir', async () => {
    // update() gecersiz bir alan gorurse Chrome atar; taklit gormez.
    await applySettings(msg, run, { contextMenuEnabled: true });
    await sleep(900);

    const hata = await inSw(`
      try {
        await chrome.contextMenus.update(${JSON.stringify(MENU_WHITELIST)}, { title: 'deneme' });
        await chrome.contextMenus.update(${JSON.stringify(MENU_PURGE)}, { enabled: false });
        await chrome.contextMenus.update(${JSON.stringify(MENU_PURGE)}, { enabled: true });
        return '';
      } catch (e) { return String(e.message || e); }
    `);
    assertEqual(hata, '', `etiket/durum guncellemesi kabul edilmeli: ${hata}`);
  });

  await runner.test('11.6 KORUMALI sitede etiket yenileme GERCEK yolda hatasiz', async () => {
    // refreshContextMenuLabels sekme etkinlesince cagriliyor. Beyaz listedeki
    // sitede purge ogesini kapatir; `enabled` alani yanlis yazilirsa gercek
    // Chrome atar ve menu o sekmede bozuk kalir.
    await msg({
      action: 'SET_RULE', domain: 'example.com', type: 'white', options: { subdomains: false }
    });

    const tab = await visit(chrome.client, 'https://example.com/', { settleMs: 1500 });
    await sleep(900);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(400);

    // Sekme etkinlesince refreshContextMenuLabels calisti. Gercek Chrome
    // gecersiz bir alan gorurse atar; menu ogeleri o zaman kaybolur.
    for (const id of [MENU_ROOT, MENU_PURGE, MENU_WHITELIST]) {
      assertEqual(await ogeVarMi(id), true,
        `etiket yenilemeden sonra oge durmali: ${id}`);
    }
  });

  await runner.test('11.7 Izin KALDIRILINCA menu sessizce devre disi kalir', async () => {
    // chrome.contextMenus tanimsizken her cagri sessizce gecilmeli; patlarsa
    // izinsiz kullanicida service worker her acilista hata veriyor demektir.
    // API'yi SW kapsaminda gecici olarak gizle: izinsiz kullanicinin durumu.
    await inSw(`
      globalThis.__gtGercekMenu = chrome.contextMenus;
      Object.defineProperty(chrome, 'contextMenus', { value: undefined, configurable: true });
      return true;
    `);
    let yanit = null;
    try {
      yanit = await msg({ action: 'SETTINGS_CHANGED' });
      await sleep(900);
    } finally {
      await inSw(`
        Object.defineProperty(chrome, 'contextMenus',
          { value: globalThis.__gtGercekMenu, configurable: true });
        delete globalThis.__gtGercekMenu;
        return true;
      `);
    }

    // API yokken islem SESSIZCE gecilmeli: istek basarili donmeli, patlamamali.
    assertEqual(yanit?.success, true,
      `API yokken ayar degisimi basarili donmeli, gelen: ${JSON.stringify(yanit)}`);
  });
} catch (e) {
  setupError = e;
} finally {
  await chrome.close();
}

if (setupError) {
  console.error('\nKURULUM HATASI:', setupError.message);
  process.exit(1);
}
cikis = runner.summary() ? 0 : 1;
process.exit(cikis);
