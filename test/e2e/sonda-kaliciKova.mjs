// SONDA: KALICI (persisted) kovanin verisi temizligimizden sag cikiyor mu?
// Spec "kalici kova kullanici silmedikce temizlenmez" diyor; olculur.
// Kontrol grubu: ayni turda kalici olmayan bir kovaya da yazilir.
import { launchChrome, attachExtension, visit, closeTarget, evaluate, sleep } from './harness.mjs';

const SITE = 'https://example.com/';
const KOKEN = new URL(SITE).origin;

const YAZ = `
  const yaz = (idb, deger) => new Promise((coz, hata) => {
    const a = idb.open('gtKalici', 1);
    a.onupgradeneeded = () => a.result.createObjectStore('kv');
    a.onerror = () => hata(a.error);
    a.onsuccess = () => {
      const t = a.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put(deger, 'iz');
      t.oncomplete = () => { a.result.close(); coz(true); };
      t.onerror = () => hata(t.error);
    };
  });
  const kalici = await navigator.storageBuckets.open('kalici-kova', {
    durability: 'strict', persisted: true });
  const gecici = await navigator.storageBuckets.open('gecici-kova');
  await yaz(kalici.indexedDB, 'KALICI-IZ');
  await yaz(gecici.indexedDB, 'GECICI-IZ');
  return {
    kaliciOnaylandi: await kalici.persisted(),
    izin: (await navigator.permissions.query({ name: 'persistent-storage' })).state,
    kovalar: await navigator.storageBuckets.keys(),
  };
`;

const OKU = `
  const oku = (idb) => new Promise((coz) => {
    const a = idb.open('gtKalici', 1);
    a.onupgradeneeded = () => { a.transaction.abort(); coz(null); };
    a.onerror = () => coz(null);
    a.onsuccess = () => {
      let s;
      try { s = a.result.transaction('kv', 'readonly').objectStore('kv').get('iz'); }
      catch { a.result.close(); return coz(null); }
      s.onsuccess = () => { a.result.close(); coz(s.result ?? null); };
      s.onerror = () => { a.result.close(); coz(null); };
    };
  });
  const adlar = await navigator.storageBuckets.keys();
  const al = async (ad) => adlar.includes(ad)
    ? oku((await navigator.storageBuckets.open(ad)).indexedDB) : null;
  return { adlar, kalici: await al('kalici-kova'), gecici: await al('gecici-kova') };
`;

const chrome_ = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
try {
  const ek = await attachExtension(chrome_.client);
  const sw = ek.sessionId;
  await sleep(2000);

  // Kalicilik izni Chrome'da etkilesim gecmisine bagli olabilir; test
  // profilinde gecmis yok. CDP ile aciktan veriyoruz ki olcum "izin
  // verilmedigi icin" degil, gercek davranis yuzunden sonuc versin.
  await chrome_.client.send('Browser.grantPermissions', {
    origin: KOKEN, permissions: ['durableStorage'],
  }).catch((e) => console.log(`  (izin verilemedi: ${e.message})`));

  const t = await visit(chrome_.client, SITE, { settleMs: 2000 });
  const kurulum = await evaluate(chrome_.client, t.sessionId, YAZ);
  console.log(`  kalicilik onaylandi mi : ${kurulum.kaliciOnaylandi}`);
  console.log(`  persistent-storage izni: ${kurulum.izin}`);
  const once = await evaluate(chrome_.client, t.sessionId, OKU);
  console.log(`  SILMEDEN ONCE : ${JSON.stringify(once)}`);
  await closeTarget(chrome_.client, t.targetId);
  await sleep(1500);

  // EKLENTININ KULLANDIGI CAGRININ AYNISI.
  await evaluate(chrome_.client, sw, `
    await chrome.browsingData.remove({
      origins: [${JSON.stringify(KOKEN)}],
      originTypes: { unprotectedWeb: true, protectedWeb: true }
    }, { indexedDB: true, localStorage: true, cacheStorage: true,
         serviceWorkers: true, fileSystems: true });
    return 1;`);
  await sleep(2000);

  const t2 = await visit(chrome_.client, SITE, { settleMs: 2000 });
  const sonra = await evaluate(chrome_.client, t2.sessionId, OKU);
  console.log(`  SILDIKTEN SONRA: ${JSON.stringify(sonra)}`);
  await closeTarget(chrome_.client, t2.targetId);

  console.log('');
  console.log(`  kalici kova verisi : ${sonra.kalici === null ? 'SILINDI' : 'KALDI (' + sonra.kalici + ')'}`);
  console.log(`  gecici kova verisi : ${sonra.gecici === null ? 'SILINDI' : 'KALDI (' + sonra.gecici + ')'}`);
  if (sonra.kalici !== null && sonra.gecici === null) {
    console.log('\n  SONUC: KALICI KOVA TEMIZLIGI ATLATIYOR - veri kaybi degil, VERI KALIYOR.');
  } else if (sonra.kalici === null) {
    console.log('\n  SONUC: kalici kova da temizleniyor - bu yolla veri kalmiyor.');
  } else {
    console.log('\n  SONUC: ikisi de kaldi - sorun kalicilikta degil, cagrida.');
  }
} finally {
  await chrome_.close();
}
