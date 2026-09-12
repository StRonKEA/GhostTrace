// GhostTrace - kalici profildeki ELLE verilen izinleri dogrular.
//
// Test takimlari izin yoksa zaten duruyor; bu betik daha net bir mesaj verir
// ve hangi adimin eksik kaldigini tek bakista soyler.

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, attachExtension, openExtensionPage, evaluate, sleep } from '../test/e2e/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = process.env.GT_PROFILE || join(ROOT, '.cache', 'gt-manual-profile');

const chrome = await launchChrome({
  live: true, headless: true, profileDir: PROFILE, keepProfile: true
});

let hata = null;
let eksik = 0;

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  await sleep(600);

  const raw = await evaluate(chrome.client, page.sessionId, `
    return JSON.stringify({
      gizli: await chrome.extension.isAllowedIncognitoAccess(),
      privacy: await chrome.permissions.contains({ permissions: ['privacy'] }),
      contextMenus: await chrome.permissions.contains({ permissions: ['contextMenus'] }),
      privacyApi: Boolean(chrome.privacy)
    });
  `);
  const d = JSON.parse(raw);

  console.log(`\nProfil: ${PROFILE}`);
  console.log(`Eklenti: ${extensionId}\n`);
  const satir = (ad, ok, ipucu) => {
    console.log(`  ${ok ? 'VAR  ' : 'YOK  '} ${ad}${ok ? '' : '   -> ' + ipucu}`);
    if (!ok) eksik++;
  };
  satir('Gizli pencerede calistir', d.gizli,
    'chrome://extensions -> GhostTrace -> Ayrintilar -> "Gizli modda izin ver"');
  satir('privacy izni', d.privacy,
    'Eklenti Ayarlar -> Gizlilik Sertlestirme -> "Izin ver ve etkinlestir"');
  satir('chrome.privacy API erisilebilir', d.privacyApi, 'izin verilince gelir');
  satir('contextMenus izni', d.contextMenus,
    'Eklenti Ayarlar -> Bildirimler ve rozet -> "Sag tik menusune ekle" anahtarini acin');
} catch (e) {
  hata = e;
} finally {
  await chrome.close();
}

if (hata) {
  console.error('\nHATA:', hata.message);
  process.exit(1);
}
console.log(eksik === 0 ? '\nHer iki izin de VERILMIS - testler kosulabilir.\n'
  : `\n${eksik} izin eksik; yukaridaki adimlari tamamlayin.\n`);
process.exit(eksik === 0 ? 0 : 1);
