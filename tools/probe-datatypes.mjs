// GhostTrace - SILME KAPSAMI OLCUMU.
//
// Soru: Chrome'un silebildigi veri turlerinden hangilerini siliyoruz,
// hangilerini BIRAKIYORUZ? Birakilan her tur, "izin verilmeyen sitenin
// tum verisini sileriz" vaadinde bir deliktir - ya kapatilmali ya da
// bilincli bir karar olarak yazili olmali.
//
// Hafizadan cevaplanamaz: browsingData tur listesi surumden surume
// degisiyor (webSQL kaldirildi, fileSystems eklendi). Bu yuzden GERCEK
// tarayicidan okunur.
//
// Kullanim: GT_PROFILE=<yol> node tools/probe-datatypes.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR, launchChrome, attachExtension, evaluate } from '../test/e2e/harness.mjs';

// --- Eklentinin GONDERDIGI turler (kaynak dogruyu soyler) ---
const kaynak = readFileSync(join(EXTENSION_DIR, 'lib', 'purge', 'storage.js'), 'utf8');
const gonderilen = new Set();
// Iki bicim de yakalanmali; ilk deneme yalnizca satir basindakileri
// ariyordu ve KOSULLU atamalari (`if (...) types.localStorage = true;`)
// kacirip sahte bir "silmiyoruz" listesi uretti:
//     cache: true,                       (nesne alani)
//     if (...) types.localStorage = true; (kosullu atama, ayni satirda)
for (const m of kaynak.matchAll(/(\w+)\s*:\s*true/g)) gonderilen.add(m[1]);
for (const m of kaynak.matchAll(/types\.(\w+)\s*=\s*true/g)) gonderilen.add(m[1]);
// history / downloads / cookies ayri yollardan siliniyor (origins filtresine
// giremiyorlar); kapsamda sayilmalari gerekir.
for (const ayri of ['history', 'downloads', 'cookies']) gonderilen.add(ayri);

const { browser, client, close } = await launchChrome({
  sitePort: 0, headless: true,
  profileDir: process.env.GT_PROFILE || null,
  keepProfile: Boolean(process.env.GT_PROFILE)
});

try {
  const ext = await attachExtension(client);

  // Chrome'un TANIDIGI turleri kesfetmenin guvenilir yolu: her adayi tek tek
  // gonderip reddedilip reddedilmedigine bakmak. `Object.keys` ise yaramaz -
  // DataTypeSet duz bir sozluk, calisma aninda uyeleri yok.
  const ADAYLAR = [
    'appcache', 'cache', 'cacheStorage', 'cookies', 'downloads', 'fileSystems',
    'formData', 'history', 'indexedDB', 'localStorage', 'passwords',
    'pluginData', 'serverBoundCertificates', 'serviceWorkers', 'webSQL'
  ];

  const sonuc = await evaluate(client, ext.sessionId, `
    const adaylar = ${JSON.stringify(ADAYLAR)};
    const out = { taninan: [], taninmayan: [], filtrelenebilir: [], filtrelenemez: [] };
    for (const tur of adaylar) {
      // 1) Tur taniniyor mu?
      try {
        await chrome.browsingData.remove(
          { since: Date.now() }, { [tur]: true });   // since=simdi -> hicbir sey silmez
        out.taninan.push(tur);
      } catch (e) {
        out.taninmayan.push(tur + ' :: ' + (e.message || e));
        continue;
      }
      // 2) origins filtresiyle gonderilebiliyor mu? Gonderilemiyorsa o tur
      //    SITE BAZINDA silinemez - yalnizca "her sey" olarak silinebilir.
      try {
        await chrome.browsingData.remove(
          { origins: ['https://gt-probe.invalid'], originTypes: { unprotectedWeb: true } },
          { [tur]: true });
        out.filtrelenebilir.push(tur);
      } catch {
        out.filtrelenemez.push(tur);
      }
    }
    return out;
  `);

  const G = [...gonderilen].sort();
  console.log('\nGhostTrace silme kapsami olcumu');
  console.log('='.repeat(72));
  console.log('Eklentinin gonderdigi turler:', G.join(', '));
  console.log('');

  const bosluk = [];
  for (const tur of sonuc.taninan) {
    const bizde = gonderilen.has(tur);
    const siteBazinda = sonuc.filtrelenebilir.includes(tur);
    const etiket = bizde ? 'SILIYORUZ  ' : 'silmiyoruz ';
    const kapsam = siteBazinda ? 'site bazinda silinebilir' : 'YALNIZCA TOPLUCA silinebilir';
    console.log(`  ${etiket} ${tur.padEnd(24)} ${kapsam}`);
    if (!bizde) bosluk.push({ tur, siteBazinda });
  }
  if (sonuc.taninmayan.length) {
    console.log('\nChrome tanimiyor (kaldirilmis):');
    for (const t of sonuc.taninmayan) console.log('  ' + t.split(' :: ')[0]);
  }

  console.log('\n' + '='.repeat(72));
  if (!bosluk.length) {
    console.log('Chrome un site bazinda silebildigi HER turu siliyoruz.');
  } else {
    console.log('Silmedigimiz turler (her biri BILINCLI karar olmali):');
    for (const b of bosluk) {
      console.log(`  ${b.tur}  --  ${b.siteBazinda ? 'site bazinda SILINEBILIRDI' : 'zaten site bazinda silinemiyor'}`);
    }
  }
  console.log('');
} finally {
  await close?.();
  browser?.kill?.();
}
