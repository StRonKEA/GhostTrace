// KADEME 10: Kalan ayar secenekleri.
//
// Kademe 1-7'de kapsanmayan her ayar burada. Bir ayarin "kaydediliyor"
// olmasi calistigi anlamina gelmez - olculen sey DAVRANISIN degismesi.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { makeMsg, makeEval, setTestCookie, resetAll, applySettings } from './features-common.mjs';

const SITE = { url: 'https://example.com/', host: 'example.com' };

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

try {
  const { extensionId, sessionId: sw } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  const ac = async (url, settleMs = 3500) => {
    const tab = await visit(chrome.client, url, { settleMs: 0 });
    await chrome.client.send('Page.enable', {}, tab.sessionId).catch(() => {});
    await sleep(settleMs);
    return tab;
  };

  console.log(`\nKADEME 10: kalan ayarlar (eklenti ${extensionId})\n`);

  await runner.test('10.1 showBadgeCount KAPALI: rozet gosterilmez', async () => {
    await applySettings(msg, run, { enabled: true, cleanDelay: 0, showBadgeCount: false });
    await resetAll(msg, run);
    await setTestCookie(run, SITE.host, 'r1');
    const tab = await ac(SITE.url);
    await msg({ action: 'REFRESH_BADGES' });
    await sleep(1500);

    const metin = await run(`
      const t = await chrome.tabs.query({ url: 'https://example.com/*' });
      return t.length ? await chrome.action.getBadgeText({ tabId: t[0].id }) : '(sekme yok)';
    `);
    await closeTarget(chrome.client, tab.targetId);
    assertEqual(metin, '', `kapaliyken rozet bos olmali; gelen: '${metin}'`);
    await applySettings(msg, run, { showBadgeCount: true });
  });

  await runner.test('10.2 logLevel OFF: hic log uretilmez', async () => {
    await applySettings(msg, run, { logLevel: 'off' });
    await msg({ action: 'CLEAR_LOGS' });
    await resetAll(msg, run);
    await setTestCookie(run, SITE.host, 'log_testi');
    await msg({ action: 'PURGE_DOMAIN', domain: SITE.host });
    await sleep(1500);

    const loglar = await msg({ action: 'GET_LOGS', limit: 50 });
    assertEqual(loglar.logs.length, 0, 'kapaliyken log uretilmemeli');
    await applySettings(msg, run, { logLevel: 'info' });
  });

  await runner.test('10.3 logLevel ERROR: yalnizca hata/uyari gecer', async () => {
    await applySettings(msg, run, { logLevel: 'error' });
    await msg({ action: 'CLEAR_LOGS' });
    await setTestCookie(run, SITE.host, 'seviye_testi');
    await msg({ action: 'PURGE_DOMAIN', domain: SITE.host });
    await sleep(1500);

    const loglar = await msg({ action: 'GET_LOGS', limit: 50 });
    const bilgi = loglar.logs.filter(l => l.level === 'INFO' || l.level === 'SUCCESS');
    assertEqual(bilgi.length, 0,
      `error seviyesinde INFO/SUCCESS gecmemeli; gecen: ${bilgi.map(l => l.level).join(', ')}`);
    await applySettings(msg, run, { logLevel: 'info' });
  });

  await runner.test('10.4 cleanCacheOnPurgeAll: EK filtresiz onbellek cagrisi yapar', async () => {
    // Gozetleme: browsingData.remove cagrilarini SW baglamindan yakala.
    await evaluate(chrome.client, sw, `
      globalThis.__gtBD = [];
      if (!globalThis.__gtBDOrj) {
        globalThis.__gtBDOrj = chrome.browsingData.remove;
        chrome.browsingData.remove = function (filtre, turler) {
          globalThis.__gtBD.push({ filtre: Object.keys(filtre || {}), turler: Object.keys(turler || {}) });
          return globalThis.__gtBDOrj.apply(chrome.browsingData, arguments);
        };
      }
      return true;
    `);

    await applySettings(msg, run, { cleanCacheOnPurgeAll: false });
    await evaluate(chrome.client, sw, `globalThis.__gtBD = []; return true;`);
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(2000);
    const kapali = await evaluate(chrome.client, sw, `return globalThis.__gtBD;`);
    const saltCacheKapali = kapali.filter(c => c.turler.length === 1 && c.turler[0] === 'cache');
    assertEqual(saltCacheKapali.length, 0, 'kapaliyken ek onbellek cagrisi OLMAMALI');

    await applySettings(msg, run, { cleanCacheOnPurgeAll: true });
    await evaluate(chrome.client, sw, `globalThis.__gtBD = []; return true;`);
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(2000);
    const acik = await evaluate(chrome.client, sw, `return globalThis.__gtBD;`);
    const saltCacheAcik = acik.filter(c => c.turler.length === 1 && c.turler[0] === 'cache');
    assertOk(saltCacheAcik.length > 0,
      `acikken filtresiz cache cagrisi yapilmali; cagrilar: ${JSON.stringify(acik)}`);
    await applySettings(msg, run, { cleanCacheOnPurgeAll: false });
  });

  await runner.test('10.5 whitelistCleanHistory: beyaz listede GECMIS temizlenir, cerez KALIR', async () => {
    await applySettings(msg, run, {
      enabled: true, cleanDelay: 0, cleanHistory: true, whitelistCleanHistory: true
    });
    await resetAll(msg, run);
    await msg({ action: 'SET_RULE', domain: SITE.host, type: 'white', options: { subdomains: true } });

    const tab = await ac(SITE.url);
    await setTestCookie(run, SITE.host, 'kalmali');
    await closeTarget(chrome.client, tab.targetId);
    await sleep(6000);

    const gecmis = await run(`
      const h = await chrome.history.search({ text: 'example.com', startTime: 0, maxResults: 100 });
      return h.length;`);
    const cerez = await run(`
      const c = await chrome.cookies.getAll({});
      return c.filter(x => x.domain.replace(/^\\./,'') === 'example.com').length;`);

    assertEqual(gecmis, 0, 'istisna acikken beyaz listenin GECMISI temizlenmeli');
    assertOk(cerez > 0, 'ama CEREZI korunmali - istisna yalnizca gecmis/indirme');
    await applySettings(msg, run, { whitelistCleanHistory: false });
  });

  await runner.test('10.6 whitelistCleanHistory KAPALI: gecmis de korunur', async () => {
    await resetAll(msg, run);
    await msg({ action: 'SET_RULE', domain: SITE.host, type: 'white', options: { subdomains: true } });
    const tab = await ac(SITE.url);
    await closeTarget(chrome.client, tab.targetId);
    await sleep(5000);

    const gecmis = await run(`
      const h = await chrome.history.search({ text: 'example.com', startTime: 0, maxResults: 100 });
      return h.length;`);
    assertOk(gecmis > 0, 'istisna kapaliyken beyaz listenin gecmisi de korunmali');
  });

  await runner.test('10.7 periodicCleanInterval alt sinira KIRPILIR (Chrome 15 dk)', async () => {
    await applySettings(msg, run, { periodicCleanEnabled: true, periodicCleanInterval: 1 });
    await sleep(1200);
    const alarm = await run(`
      const a = await chrome.alarms.get('gt:periodicSweep');
      return a ? a.periodInMinutes : null;`);
    assertOk(alarm !== null && alarm >= 15,
      `aralik 15 dakikanin altina inememeli; gelen: ${alarm}`);
    await applySettings(msg, run, { periodicCleanEnabled: false });
  });

  await runner.test('10.8 cleanDelay gecersiz degerde KIRPILIR', async () => {
    // ARAYUZUN kullandigi yoldan (updateSettings) gidilir. Dogrudan
    // storage.local'e yazmak kirpmayi ATLAR - ilk kurgu tam bunu yapip
    // "kirpilmiyor" diyordu; olculen sey urun degil testin kestirmesiydi.
    const sonuc = await run(`
      const m = await import(chrome.runtime.getURL('lib/storage.js'));
      await m.updateSettings({ cleanDelay: 17 });
      const dusuk = (await chrome.storage.local.get('cleanDelay')).cleanDelay;
      await m.updateSettings({ cleanDelay: 9999 });
      const yuksek = (await chrome.storage.local.get('cleanDelay')).cleanDelay;
      await m.updateSettings({ cleanDelay: 0 });
      const sifir = (await chrome.storage.local.get('cleanDelay')).cleanDelay;
      return { dusuk, yuksek, sifir };
    `);
    assertOk(sonuc.dusuk === 0 || sonuc.dusuk >= 30,
      `17 sn alt sinira kirpilmali (MV3 alarmi 30 sn altina inemez); gelen: ${sonuc.dusuk}`);
    assertOk(sonuc.yuksek <= 600, `ust sinira kirpilmali; gelen: ${sonuc.yuksek}`);
    assertEqual(sonuc.sifir, 0, '0 (aninda) gecerli bir deger olmali');
  });

  await runner.test('10.11 DIL degistirme arayuz metnini degistirir', async () => {
    const tr = await run(`
      await chrome.storage.local.set({ language: 'tr' });
      const m = await import(chrome.runtime.getURL('lib/i18n.js'));
      await m.initI18n(); return m.t('common.appName') + '|' + m.t('options.navRules');
    `);
    const en = await run(`
      await chrome.storage.local.set({ language: 'en' });
      const m = await import(chrome.runtime.getURL('lib/i18n.js'));
      await m.setLanguage('en'); return m.t('common.appName') + '|' + m.t('options.navRules');
    `);
    assertOk(tr !== en, `dil degisince metin degismeli; tr='${tr}' en='${en}'`);
    console.log(`      -> tr: ${tr.split('|')[1]} / en: ${en.split('|')[1]}`);
    await run(`await chrome.storage.local.set({ language: 'auto' }); return true;`);
  });

  await runner.test('10.12 AYARLARI SIFIRLAMA kurallari KORUR', async () => {
    await msg({ action: 'SET_RULE', domain: 'kalici.com', type: 'white', options: {} });
    await run(`
      const m = await import(chrome.runtime.getURL('lib/storage.js'));
      await m.resetOnlySettings(); return true;
    `);
    const durum = await run(`
      const s = await chrome.storage.local.get(['rules', 'cleanDelay']);
      return { kural: Object.keys(s.rules || {}), gecikme: s.cleanDelay };
    `);
    assertOk(durum.kural.includes('kalici.com'), 'ayar sifirlama kurallari silmemeli');
    assertEqual(durum.gecikme, 60, 'ayarlar varsayilana donmeli');
  });

} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  const ok = runner.summary() && !setupError;
  await chrome.close();
  process.exit(ok ? 0 : 1);
}
