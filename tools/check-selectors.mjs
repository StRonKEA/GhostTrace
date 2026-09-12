// GhostTrace - JS'in kullandigi her secici GERCEK sayfada eleman buluyor mu?
//
// NEDEN: qsa('...') hicbir sey bulamazsa dongu sifir kez doner ve dinleyici
// HIC baglanmaz. Hata olusmaz, test yesil kalir, dugme sessizce olu olur.
// Kurallar sekmesinin filtre cipleri tam olarak boyle olmustu.
//
// Kullanim: node tools/check-selectors.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, attachExtension, openExtensionPage, evaluate, sleep }
  from '../test/e2e/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function jsDosyalari(kok) {
  const out = [];
  const gez = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const r = `${d}/${e.name}`;
      if (e.isDirectory()) gez(r);
      else if (e.name.endsWith('.js')) out.push(r);
    }
  };
  gez(kok);
  return out;
}

/**
 * BEKLENEN bos sonuclar.
 *
 * Bazi seciciler "zaten var mi?" diye sorar ve ogeyi JS'in KENDISI uretir;
 * sayfa acilisinda sifir bulmalari DOGRU durumdur. Istisnayi gerekcesiyle
 * yazmak, listeyi ilerde koru koru buyutmeyi zorlastirir.
 */
const BEKLENEN_BOS = new Map([
  ['.setting-warning',
   'sertlestirme durum notu: settings.js kendi uretiyor (append), sorgu '
   + 'yalnizca "zaten var mi" kontrolu'],
]);

const secililer = [];
for (const kok of ['options', 'popup']) {
  for (const dosya of jsDosyalari(kok)) {
    const src = readFileSync(join(ROOT, dosya), 'utf8');
    for (const m of src.matchAll(/\b(?:querySelectorAll|querySelector|qsa|qs)\(\s*'([^']+)'/g)) {
      secililer.push({ dosya, secici: m[1] });
    }
  }
}
console.log(`${secililer.length} secici bulundu\n`);

const chrome = await launchChrome({ live: true, headless: true });
let hata = null;
let olu = 0;

try {
  const { extensionId } = await attachExtension(chrome.client);
  const options = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
  await sleep(1200);

  // Tum sekmeleri bir kez ac: gizli panellerdeki ogeler de sayilsin.
  for (const tab of ['rules-tab', 'site-data-tab', 'settings-tab', 'stats-tab', 'logs-tab']) {
    await evaluate(chrome.client, options.sessionId,
      `document.querySelector('[data-tab="${tab}"]').click(); return 1;`);
    await sleep(250);
  }

  for (const { dosya, secici } of secililer) {
    const oturum = dosya.startsWith('popup') ? popup.sessionId : options.sessionId;
    const n = await evaluate(chrome.client, oturum,
      `try { return document.querySelectorAll(${JSON.stringify(secici)}).length; }
       catch { return -1; }`);
    if (Number(n) === 0) {
      const gerekce = BEKLENEN_BOS.get(secici);
      if (gerekce) {
        console.log(`  bos (beklenen)  ${secici}  — ${gerekce}`);
      } else {
        olu++;
        console.log(`  OLU  ${dosya}  ->  ${secici}`);
      }
    } else if (Number(n) === -1) {
      olu++;
      console.log(`  GECERSIZ  ${dosya}  ->  ${secici}`);
    }
  }
} catch (e) {
  hata = e;
} finally {
  await chrome.close();
}

if (hata) {
  console.error('\nHATA:', hata.message);
  process.exit(1);
}
console.log(olu === 0
  ? '\nHepsi eleman buluyor.'
  : `\n${olu} secici HICBIR eleman bulmuyor - o kod yolu olu.`);
process.exit(olu === 0 ? 0 : 1);
