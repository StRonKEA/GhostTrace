// GhostTrace - CHROME WEB STORE UYGUNLUK DENETIMI.
//
// Magazaya gonderim, kodun calismasindan AYRI bir kapi: manifest ile magaza
// metni birbirinden kayarsa gonderim reddedilir ya da daha kotusu, istenmeyen
// bir izin icin gerekce yazilmis gorunur.
//
// Burada YALNIZCA depodan dogrulanabilecek seyler kontrol edilir. Panoya
// elle girilen seyler (gizlilik politikasi URL'si, veri kullanimi
// sertifikasyonu, ekran goruntuleri) kod tarafindan bilinemez; onlar
// "ELLE" basligi altinda hatirlatilir.
//
// Kullanim: node tools/store-audit.mjs

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oku = (f) => readFileSync(join(ROOT, f), 'utf8');

// Chrome Web Store sinirlari.
const MAX_AD = 75;
const MAX_ACIKLAMA = 132;

let bulgu = 0;
const raporla = (baslik, sorunlar, aciklama = '') => {
  if (sorunlar.length === 0) { console.log(`  TEMIZ   ${baslik}`); return; }
  bulgu += sorunlar.length;
  console.log(`  BULGU   ${baslik}${aciklama ? '  -- ' + aciklama : ''}`);
  for (const s of sorunlar) console.log(`            ${s}`);
};

const manifest = JSON.parse(oku('manifest.json'));
const magaza = oku('CHROMEWEBSTORE.md');

console.log('\nGhostTrace magaza uygunluk denetimi');
console.log('='.repeat(72));

// --- 1) Her izin icin gerekce; istenmeyen izne gerekce YOK ---
//
// Iki yonlu kontrol sart: eksik gerekce gonderimi durdurur, FAZLA gerekce
// ise kaldirilmis bir izni hala istiyormus gibi gosterir (site izinleri
// ozelligi kaldirildiginda tam olarak bu oldu).
const istenen = new Set([
  ...(manifest.permissions || []),
  ...(manifest.optional_permissions || []),
  ...(manifest.host_permissions || [])
]);
// Magaza metnindeki tablo satirlari: | `izin` | gerekce |
const gerekceli = new Set(
  [...magaza.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(m => m[1])
);
const izinSorun = [];
for (const izin of istenen) {
  if (!gerekceli.has(izin)) izinSorun.push(`${izin}: GEREKCE YOK (manifest istiyor)`);
}
for (const izin of gerekceli) {
  // "Kaldirilan izin" bolumunde anlatilanlar bilincli olarak istisna.
  if (!istenen.has(izin) && !new RegExp(`\`${izin}\`[^\\n]*\\*\\*kaldir`, 'i').test(magaza)) {
    izinSorun.push(`${izin}: gerekce var ama manifest ISTEMIYOR`);
  }
}
raporla('Izin gerekceleri manifest ile ortusuyor', izinSorun,
  'magaza metni ile manifest kaymis');

// --- 2) __MSG_*__ anahtarlari her dilde cozuluyor mu ---
//
// Cozulmeyen bir anahtar magazada ham "__MSG_extName__" olarak gorunur ve
// gonderim reddedilir.
const msgAnahtar = new Set(
  [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map(m => m[1])
);
const diller = ['tr', 'en'];
const msgSorun = [];
for (const dil of diller) {
  const yol = `_locales/${dil}/messages.json`;
  if (!existsSync(join(ROOT, yol))) { msgSorun.push(`${yol}: YOK`); continue; }
  const mesajlar = JSON.parse(oku(yol));
  for (const anahtar of msgAnahtar) {
    if (!mesajlar[anahtar]?.message) msgSorun.push(`${yol}: ${anahtar} eksik`);
  }
}
if (!diller.includes(manifest.default_locale)) {
  msgSorun.push(`default_locale "${manifest.default_locale}" _locales altinda yok`);
}
raporla('Magaza metni her dilde cozuluyor', msgSorun, 'ham __MSG__ magazada gorunur');

// --- 3) Ad ve aciklama uzunluklari ---
const uzunlukSorun = [];
for (const dil of diller) {
  const yol = `_locales/${dil}/messages.json`;
  if (!existsSync(join(ROOT, yol))) continue;
  const m = JSON.parse(oku(yol));
  const ad = m.extName?.message || '';
  const aciklama = m.extDesc?.message || '';
  if (ad.length > MAX_AD) uzunlukSorun.push(`${dil}: ad ${ad.length} > ${MAX_AD}`);
  if (aciklama.length > MAX_ACIKLAMA) {
    uzunlukSorun.push(`${dil}: aciklama ${aciklama.length} > ${MAX_ACIKLAMA}`);
  }
}
raporla(`Ad <= ${MAX_AD}, aciklama <= ${MAX_ACIKLAMA} karakter`, uzunlukSorun);

// --- 4) Bildirilen ikonlar gercekten var mi ---
const ikonSorun = [];
const ikonKumeleri = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
for (const kume of ikonKumeleri) {
  for (const [boyut, yol] of Object.entries(kume)) {
    if (!existsSync(join(ROOT, yol))) ikonSorun.push(`${boyut}px: ${yol} YOK`);
    else if (statSync(join(ROOT, yol)).size === 0) ikonSorun.push(`${boyut}px: ${yol} BOS`);
  }
}
raporla('Bildirilen tum ikonlar mevcut', ikonSorun);

// --- 5) Pakete gelistirme dosyasi sizmis mi ---
//
// Ihlal degil ama gereksiz yuzey: test ve arac dosyalari inceleme suresini
// uzatir ve pakette isi olmayan kod tasir.
const SIZMAMALI = ['test/', 'tools/', 'docs/', 'dist/', 'node_modules/',
  '.git/', '.cache/', 'package.json', 'eslint.config.js'];
const paketSorun = [];
const zipYol = join(ROOT, 'dist', `ghosttrace-${manifest.version}.zip`);
if (!existsSync(zipYol)) {
  paketSorun.push(`paket yok: dist/ghosttrace-${manifest.version}.zip (once: npm run package)`);
} else {
  // ZIP merkezi dizinindeki adlari ham olarak tara - harici arac gerektirmez.
  const ham = readFileSync(zipYol).toString('latin1');
  for (const desen of SIZMAMALI) {
    if (ham.includes(desen)) paketSorun.push(`pakette gelistirme dosyasi: ${desen}`);
  }
}
raporla('Paket yalnizca calisma zamani dosyalarini icerir', paketSorun);

// --- 6) Uzaktan kod / harici baglanti beyani ---
//
// CWS "remote code" sorusuna "hayir" diyebilmek icin sart. Ayrintili
// denetimi privacy-audit.mjs yapiyor; burada yalnizca beyanin varligi.
const beyanSorun = [];
if (!/hicbir dis adrese istek atmaz|hiçbir dış adrese istek atmaz/i.test(magaza)) {
  beyanSorun.push('CHROMEWEBSTORE.md: "dis adrese istek atmaz" beyani yok');
}
raporla('Uzaktan kod beyani magaza metninde var', beyanSorun);

// --- 7) Gizlilik politikasi metni hazir mi ---
//
// `history` + `cookies` + `browsingData` = "Web Gecmisi" hassas veri
// kategorisi. Bu kategoride gizlilik politikasi URL'si ZORUNLU; olmadan
// gonderim reddedilir. URL'nin gercekten yayimlandigini kod bilemez ama
// METNIN varligini ve doldurulmamis yer tutucu kalip kalmadigini bilebilir.
const politikaSorun = [];
if (!existsSync(join(ROOT, 'PRIVACY.md'))) {
  politikaSorun.push('PRIVACY.md YOK - hassas veri kategorisinde zorunlu');
} else {
  const politika = oku('PRIVACY.md');
  for (const yerTutucu of ['<iletişim adresi buraya>', '<contact address here>']) {
    if (politika.includes(yerTutucu)) {
      politikaSorun.push(`PRIVACY.md: doldurulmamis yer tutucu "${yerTutucu}"`);
    }
  }
  if (!/2\.7\.0|Sürüm:|Version:/.test(politika)) {
    politikaSorun.push('PRIVACY.md: surum bilgisi yok');
  }
}
raporla('Gizlilik politikasi metni hazir', politikaSorun,
  'magaza bu kategoride politika olmadan kabul etmez');

console.log('='.repeat(72));
console.log(bulgu === 0 ? 'Depodan dogrulanabilen her sey TEMIZ.' : `${bulgu} bulgu var.`);

// --- ELLE yapilacaklar: kod bunlari bilemez ---
console.log(`
ELLE (Gelistirici Panosu - kod tarafindan dogrulanamaz):
  1. GIZLILIK POLITIKASI URL'si ZORUNLU. \`history\`, \`cookies\` ve
     \`browsingData\` izinleri "Web Gecmisi" hassas veri kategorisine girer;
     bu kategoride politika URL'si olmadan gonderim REDDEDILIR.
     PRIVACY.md hazir - yayimlanmis bir adrese konup (or. GitHub Pages)
     o adres panoya girilmeli. Metnin varligi denetleniyor, YAYIMLANDIGI
     kod tarafindan bilinemez.
  2. Veri kullanimi sertifikasyonu: uc kutu da isaretlenmeli
     (satilmaz / amac disi kullanilmaz / kredi degerlendirmesinde kullanilmaz).
  3. \`<all_urls>\` genis izin gerekcesi panoya AYRICA yazilir.
  4. Ekran goruntuleri (1280x800 veya 640x400) ve 440x280 kucuk promo gorseli.
`);

process.exit(bulgu === 0 ? 0 : 1);
