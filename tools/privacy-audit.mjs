// GhostTrace - GIZLILIK DENETIMI.
//
// Soru: eklenti vadettiginin disina cikan bir sey yapiyor mu?
//
// Vaad:
//   1. Disari HICBIR istek gitmez (telemetri, "phone home", harici kaynak yok)
//   2. Diske YALNIZCA kullanicinin kendi ayarlari ve kurallari yazilir;
//      gezinti gecmisi/izleyici profili yazilmaz
//   3. Cerez DEGERI hicbir zaman arayuze cikmaz
//   4. Istenen her izin FIILEN kullanilir
//   5. Icerik script'i sayfadan icerik okumaz, yalnizca olçum yapar
//
// Kullanim: node tools/privacy-audit.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ATLA = new Set(['node_modules', '.git', '.cache', 'dist', 'test', 'icons', 'docs']);

function dosyalar(uzanti) {
  const out = [];
  const gez = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const r = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!ATLA.has(e.name)) gez(r); }
      else if (e.name.endsWith(uzanti)) out.push(r);
    }
  };
  gez('');
  return out;
}

const oku = (f) => readFileSync(join(ROOT, f), 'utf8');
const yorumsuz = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let bulgu = 0;
const raporla = (baslik, sorunlar, aciklama) => {
  if (sorunlar.length === 0) {
    console.log(`  TEMIZ   ${baslik}`);
    return;
  }
  bulgu += sorunlar.length;
  console.log(`  BULGU   ${baslik}  -- ${aciklama}`);
  for (const s of sorunlar) console.log(`            ${s}`);
};

console.log('\nGhostTrace gizlilik denetimi');
console.log('='.repeat(72));

// --- 1) Disari istek ---
const AG_API = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/sendBeacon/, 'navigator.sendBeacon'],
  [/new\s+WebSocket/, 'WebSocket'],
  [/new\s+EventSource/, 'EventSource'],
  [/navigator\.connection/, 'navigator.connection'],
  [/chrome\.webRequest/, 'chrome.webRequest']
];
const agBulgular = [];
for (const f of dosyalar('.js')) {
  if (f === 'lib/psl.js') continue;          // yalnizca veri tablosu
  if (f.startsWith('tools/')) continue;      // gelistirme araclari, pakete girmez
  const src = yorumsuz(oku(f));
  for (const [desen, ad] of AG_API) {
    if (desen.test(src)) agBulgular.push(`${f}: ${ad}`);
  }
}
raporla('Disari istek atan API yok', agBulgular,
  'eklenti hicbir sunucuya baglanmamali');

// --- 2) Harici kaynak (font, script, gorsel) ---
const hariciBulgular = [];
for (const f of [...dosyalar('.html'), ...dosyalar('.css')]) {
  const src = oku(f);
  for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    if (/^https?:|^\/\//.test(m[1])) hariciBulgular.push(`${f}: ${m[1]}`);
  }
  for (const m of src.matchAll(/url\(\s*["']?(https?:[^)"']+)/g)) {
    hariciBulgular.push(`${f}: ${m[1]}`);
  }
  if (/@import\s+url\(\s*["']?https?:/.test(src)) hariciBulgular.push(`${f}: @import`);
}
raporla('Harici kaynak yuklenmiyor', hariciBulgular,
  'CDN/font/analytics adresi bulundu');

// --- 3) DISKE ne yaziliyor? ---
const diskAnahtar = new Set();
for (const f of dosyalar('.js')) {
  if (f.startsWith('tools/')) continue;
  const src = yorumsuz(oku(f));
  for (const m of src.matchAll(/storage\.local\.set\(\s*\{?\s*([^)]*)\)/g)) {
    for (const a of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) diskAnahtar.add(a[1]);
    for (const a of m[1].matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) diskAnahtar.add(`[${a[1]}]`);
  }
}
// Beklenen: yalnizca ayarlar + kurallar + istatistik toplamlari + sertlestirme temel durumu.
const BEKLENEN_DISK = new Set([
  'schemaVersion', 'rules', 'stats', 'enabled', 'cleanDelay', 'theme', 'language',
  'logLevel', 'hardening', 'statsHistory', '[LOGS_STORAGE_KEY]', '[key]', '[STORAGE_KEY]',
  '[BASELINE_KEY]'
]);
const supheliDisk = [...diskAnahtar].filter(k => !BEKLENEN_DISK.has(k) && !/^clean|^track|^notify|^show|^periodic|^whitelist|^context|^strip/.test(k));
raporla('Diske yalnizca ayar/kural yaziliyor', supheliDisk,
  'gezinti izi diske yazilmis olabilir');

// --- 4) Loglar diske yaziliyor mu? ---
const logger = yorumsuz(oku('lib/logger.js'));
const logBulgu = [];
// `storage.local`in HER izi: `.set()` kadar `session || local` yedegi de
// gunlugu diske dusurur. Once yalnizca .set() araniyordu ve yedek kacmisti.
if (/storage\.local\b/.test(logger)) {
  logBulgu.push('lib/logger.js: storage.local (DISK) referansi var');
}
if (!/chrome\.storage\.session/.test(logger)) {
  logBulgu.push('lib/logger.js: storage.session kullanilmiyor');
}
raporla('Loglar yalnizca oturumda (diske yazilmiyor)', logBulgu,
  'log kaydi kalici hale gelmis');

// --- 5) 3. taraf haritasi kalici mi? ---
const sess = yorumsuz(oku('lib/session-state.js'));
const sessBulgu = [];
if (/storage\.local/.test(sess)) {
  sessBulgu.push('lib/session-state.js: storage.local kullaniliyor (kalici)');
}
raporla('3. taraf haritasi yalnizca oturumda', sessBulgu,
  'izleyici profili diske yazilmis olabilir');

// --- 6) Cerez DEGERI arayuze cikiyor mu? ---
const degerBulgu = [];
for (const f of dosyalar('.js')) {
  if (f.startsWith('tools/') || f === 'lib/cookies.js') continue;
  const src = yorumsuz(oku(f));
  // Arayuze giden yollarda cerez DEGERI okunuyor mu?
  //
  // `\b` sart: onceden `cookie.valueLength` (yalnizca bir SAYI, degerin
  // kendisi degil) de eslesip yanlis pozitif uretiyordu. Ayni sekilde DOM
  // form alanlarinin `.value`si (searchCookie.value gibi) cerezle ilgisiz.
  if (/cookie\.value\b|\.value\s*:\s*cookie\b/.test(src) && /options\/|popup\//.test(f)) {
    degerBulgu.push(`${f}: cookie.value okunuyor`);
  }
}
// Site-data yanitinda value alani var mi?
const siteData = yorumsuz(oku('lib/sw/site-data.js'));
if (/value\s*:/.test(siteData)) degerBulgu.push('lib/sw/site-data.js: yanitta value alani');
raporla('Cerez degeri arayuze cikmiyor', degerBulgu,
  'cerez degeri sizabilir');

// --- 7) Istenen her izin kullaniliyor mu? ---
const manifest = JSON.parse(oku('manifest.json'));
const tumKaynak = dosyalar('.js').filter(f => !f.startsWith('tools/')).map(oku).join('\n');
const IZIN_API = {
  cookies: /chrome\.cookies\./, history: /chrome\.history\./,
  downloads: /chrome\.downloads\./, browsingData: /chrome\.browsingData\./,
  storage: /chrome\.storage\./, alarms: /chrome\.alarms\./,
  tabs: /chrome\.tabs\./, tabGroups: /chrome\.tabGroups\./,
  notifications: /chrome\.notifications\./, scripting: /chrome\.scripting\./,
  privacy: /chrome\.privacy\./, contextMenus: /chrome\.contextMenus\./
};
const kullanilmayan = [];
for (const izin of [...(manifest.permissions || []), ...(manifest.optional_permissions || [])]) {
  const desen = IZIN_API[izin];
  if (desen && !desen.test(tumKaynak)) kullanilmayan.push(`${izin}: hicbir yerde kullanilmiyor`);
}
raporla('Istenen her izin fiilen kullaniliyor', kullanilmayan,
  'kullanilmayan izin istenmis');

// --- 8) Icerik script'i sayfadan ne okuyor? ---
const icerik = yorumsuz(oku('content/trace-observer.js'));
const icerikBulgu = [];
const YASAK = [
  [/document\.cookie/, 'document.cookie okuyor'],
  [/localStorage\.getItem|localStorage\[/, 'localStorage ICERIGI okuyor'],
  [/\.innerText|\.textContent\s*(?!=)/, 'sayfa metnini okuyor'],
  [/querySelectorAll\(\s*['"]input/, 'form alanlarini okuyor'],
  [/\bfetch\s*\(|XMLHttpRequest/, 'disari istek atiyor']
];
for (const [desen, ad] of YASAK) {
  if (desen.test(icerik)) icerikBulgu.push(`content/trace-observer.js: ${ad}`);
}
raporla('Icerik script i sayfa ICERIGINI okumuyor', icerikBulgu,
  'sayfa icerigi okunuyor olabilir');

// --- 9) host_permissions kapsami ---
const hostBulgu = [];
const hosts = manifest.host_permissions || [];
if (hosts.length && !hosts.every(h => h === '<all_urls>')) {
  hostBulgu.push(`beklenmeyen host izni: ${hosts.join(', ')}`);
}
raporla('Host izni yalnizca <all_urls> (temizlik icin zorunlu)', hostBulgu, '');

// --- 10) CSP / uzaktan kod ---
const uzakBulgu = [];
if (/eval\s*\(|new\s+Function\s*\(/.test(tumKaynak)) uzakBulgu.push('eval/new Function kullanimi');
for (const f of dosyalar('.js')) {
  if (f.startsWith('tools/')) continue;
  if (/import\s*\(\s*['"`]https?:/.test(oku(f))) uzakBulgu.push(`${f}: uzaktan modul`);
}
raporla('Uzaktan kod calistirilmiyor', uzakBulgu, 'uzaktan kod riski');

console.log('='.repeat(72));
console.log(bulgu === 0
  ? 'Vaadin disina cikan bir sey BULUNAMADI.\n'
  : `${bulgu} bulgu var - yukariya bakin.\n`);
process.exit(bulgu === 0 ? 0 : 1);
