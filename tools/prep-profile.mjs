// GhostTrace - gizli pencere ve sertlestirme testleri icin KALICI profil hazirligi.
//
// Neden elle: Chrome bu iki izni programatik olarak vermiyor.
//   * "Gizli pencerede calistir": Secure Preferences yamasi MAC dogrulamasi
//     tarafindan geri aliniyor.
//   * `privacy` opsiyonel izni: chrome.permissions.request kullanici jesti
//     istiyor; headless'ta istemi kimse kapatmadigi icin cagri asiliyor.
//
// Bu betik tarayiciyi GORUNUR acar, gerekli sekmeleri onceden yerlestirir ve
// ne tiklanacagini yazar. Kullanici iki anahtari acip pencereyi kapatir;
// ayarlar profilde kalir ve test takimlari GT_PROFILE ile ayni profili kullanir.
//
// GUVENLIK: kullanicinin GERCEK tarayici profiline ASLA dokunulmaz. Burada
// kullanilan profil bu depoya ait ayri bir dizindir ve indirilen
// Chrome for Testing ikilisiyle acilir.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDownloadedChrome } from './fetch-chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = process.env.GT_PROFILE || join(ROOT, '.cache', 'gt-manual-profile');
const CHROME = process.env.GT_CHROME || findDownloadedChrome();

if (!CHROME || !existsSync(CHROME)) {
  console.error('Tarayici bulunamadi. Once: npm run e2e:setup');
  process.exit(1);
}
mkdirSync(PROFILE, { recursive: true });

// Paketlenmemis eklentinin kimligi yola gore SABIT uretilir; her kosumda ayni.
const EXT_ID = 'ddmfdmeopmnomkgkpcidpalanmdbnlfj';

const args = [
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${ROOT}`,
  `--disable-extensions-except=${ROOT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  'chrome://extensions/?id=' + EXT_ID,
  `chrome-extension://${EXT_ID}/options/options.html#settings-tab`
];

console.log(`
================================================================
  ELLE HAZIRLIK - iki anahtar, sonra pencereyi kapatin
================================================================

  Profil : ${PROFILE}
  Tarayici: ${CHROME}

  Acilan IKI sekmede sunlari yapin:

  1) "Uzantilar" sekmesi (GhostTrace ayrintilari)
       -> "Gizli modda izin ver" anahtarini ACIN

  2) "GhostTrace - Ayarlar" sekmesi
       -> GIZLILIK SERTLESTIRME bolumu
       -> "Izin ver ve etkinlestir" dugmesine basin
       -> cikan Chrome istemine izin verin

  3) Pencereyi KAPATIN.

  Not: bu pencere indirilen Chrome for Testing ikilisidir ve kendi ayri
  profilini kullanir. Helium'a veya sizin Chrome profilinize dokunmaz.
================================================================
`);

const proc = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
proc.unref();
console.log(`Tarayici acildi (pid ${proc.pid}). Bitince bana haber verin.`);
