// SONDA: document_start icerik script'i, kova adindaki kimligi sayfa
// okumadan ONCE silebiliyor mu? delete() asenkron oldugu icin bu bir yaris.
// Kayitci sayfa kodundan da once kosar - olcum bize karsi tarafli.
import { launchChrome, attachExtension, visit, closeTarget, evaluate, sleep } from './harness.mjs';

const SITE = 'https://example.com/';
const KIMLIK = 'uid-7f3a9c2b';

// Icerik script'i ayri dosyada: test/e2e/kova-silici-sonda.js
// (registerContentScripts yalnizca dosya yolu kabul eder, satir ici kod degil)

// Sayfadan da once kosar: uc anda kova adlarini ornekler.
const KAYITCI = `
  globalThis.__gtOrnek = { enErken: null, dcl: null, load: null };
  const ornekle = async (ad) => {
    try { globalThis.__gtOrnek[ad] = await navigator.storageBuckets.keys(); }
    catch { globalThis.__gtOrnek[ad] = 'hata'; }
  };
  ornekle('enErken');
  document.addEventListener('DOMContentLoaded', () => ornekle('dcl'));
  addEventListener('load', () => ornekle('load'));
`;

const chrome_ = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
try {
  const ek = await attachExtension(chrome_.client);
  const sw = ek.sessionId;
  await sleep(2000);

  // 1) Kimligi kova adina yaz.
  const t = await visit(chrome_.client, SITE, { settleMs: 2000 });
  await evaluate(chrome_.client, t.sessionId,
    `await navigator.storageBuckets.open(${JSON.stringify(KIMLIK)});
     return await navigator.storageBuckets.keys();`);
  const yazildi = await evaluate(chrome_.client, t.sessionId,
    'return await navigator.storageBuckets.keys();');
  console.log(`  1) kimlik yazildi: ${JSON.stringify(yazildi)}`);
  await closeTarget(chrome_.client, t.targetId);

  // 2) Eklentinin normal temizligi - kova adini silmedigini teyit et.
  await evaluate(chrome_.client, sw, `
    await chrome.browsingData.remove(
      { origins: ['${new URL(SITE).origin}'], originTypes: { unprotectedWeb: true, protectedWeb: true } },
      { indexedDB: true, localStorage: true, cacheStorage: true, serviceWorkers: true, fileSystems: true });
    return 1;`);
  await sleep(1000);

  // 3) document_start silici script'ini kaydet.
  const kayit = await evaluate(chrome_.client, sw, `
    try { await chrome.scripting.unregisterContentScripts({ ids: ['gtKova'] }); } catch {}
    await chrome.scripting.registerContentScripts([{
      id: 'gtKova',
      matches: ['<all_urls>'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      js: ['test/e2e/kova-silici-sonda.js'],
    }]);
    return (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id);`).catch(e => String(e));
  console.log(`  2) icerik script'i kaydi: ${JSON.stringify(kayit)}`);

  // 4) Siteyi yeniden ac; kayitci sayfadan once kosar.
  const { targetId } = await chrome_.client.send('Target.createTarget', { url: 'about:blank' });
  const sid = await chrome_.client.send('Target.attachToTarget', { targetId, flatten: true })
    .then(r => r.sessionId);
  await chrome_.client.send('Page.enable', {}, sid);
  await chrome_.client.send('Page.addScriptToEvaluateOnNewDocument', { source: KAYITCI }, sid);
  await chrome_.client.send('Page.navigate', { url: SITE }, sid);
  await sleep(5000);

  const sonuc = await evaluate(chrome_.client, sid, `
    return { ornek: globalThis.__gtOrnek,
             silme: sessionStorage.getItem('gtSilme'),
             son: await navigator.storageBuckets.keys() };`);
  console.log(`  3) silici raporu : ${sonuc.silme || '(script hic kosmadi)'}`);
  console.log(`     en erken an   : ${JSON.stringify(sonuc.ornek?.enErken)}`);
  console.log(`     DOMContentLoad: ${JSON.stringify(sonuc.ornek?.dcl)}`);
  console.log(`     load          : ${JSON.stringify(sonuc.ornek?.load)}`);
  console.log(`     en son        : ${JSON.stringify(sonuc.son)}`);

  const gorduMu = (o) => Array.isArray(o) && o.includes(KIMLIK);
  console.log('');
  if (gorduMu(sonuc.ornek?.enErken)) {
    console.log('  SONUC: YARIS KAYBEDILDI - sayfadan once kosan kod kimligi GORDU.');
    console.log('         Icerik script i "kesin cozum" degil, yalnizca azaltma.');
  } else {
    console.log('  SONUC: en erken anda kimlik GORUNMUYOR - yaris kazanildi.');
  }
} finally {
  await chrome_.close();
}
