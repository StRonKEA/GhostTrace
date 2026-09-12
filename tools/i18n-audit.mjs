// GhostTrace - CEVIRI DENETIMI.
//
// Uc ayri arizayi ayirir; ucu de farkli sey demek:
//
//   OKSUZ    : ceviride var, kodda HIC kullanilmiyor -> olu agirlik, ama
//              daha kotusu: eski bir ozellikten kalmis olabilir ve okuyani
//              o ozellik hala varmis gibi yanıltir.
//   EKSIK    : kodda kullaniliyor, ceviride YOK -> arayuzde ham anahtar
//              gorunur ("options.fooTitle" yazar).
//   ESITSIZ  : bir dilde var, otekinde yok -> o dile gecince satir kaybolur.
//
// Kullanim: node tools/i18n-audit.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ATLA = new Set(['node_modules', '.git', '.cache', 'dist', 'icons', 'docs', 'tools', 'test']);

function dosyalar(uzantilar) {
  const out = [];
  const gez = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const r = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!ATLA.has(e.name)) gez(r); }
      else if (uzantilar.some(u => e.name.endsWith(u))) out.push(r);
    }
  };
  gez('');
  return out;
}
const oku = (f) => readFileSync(join(ROOT, f), 'utf8');

/** Duz anahtar kumesi: "options.hardenTopicsTitle" gibi. */
async function anahtarlar(dil) {
  const mod = await import(`../locales/${dil}.js`);
  const sozluk = mod.default || mod[dil] || Object.values(mod)[0];
  const out = new Set();
  for (const [blok, icerik] of Object.entries(sozluk)) {
    if (icerik && typeof icerik === 'object') {
      for (const k of Object.keys(icerik)) out.add(`${blok}.${k}`);
    } else out.add(blok);
  }
  return out;
}

const tr = await anahtarlar('tr');
const en = await anahtarlar('en');

// --- Kodda GECEN anahtarlar ---
//
// ILK DENEMEDE YANLISTI ve nasil yanlis oldugu ogreticiydi: yalnizca
// `t('x.y')` ve `data-i18n="x.y"` araniyordu, bu yuzden 72 yasayan anahtar
// "oksuz" raporlandi. Gercekte anahtarlar cogu zaman DOGRUDAN cagrilmiyor:
//
//   titleKey: 'options.modalPurgeAllTitle'      (nesne alani)
//   ['options.diagnosticsRules', sayi]          (dizi girdisi)
//   t(ucuncu ? 'options.badgeTracker' : ...)    (kosullu)
//   session: ['tag-session', 'options.cookieBadgeSession']
//
// Dogru yontem: cagri bicimini degil ANAHTARIN KENDISINI ara. Sozlukteki
// ust duzey bloklarla baslayan her tirnakli dizge bir kullanimdir. Bu,
// nerede/nasil yazildigindan bagimsiz calisir.
const bloklar = [...new Set([...tr].map(k => k.split('.')[0]))];
const ANAHTAR_DESENI = new RegExp(
  `['"\`](${bloklar.join('|')})\\.(\\w+)['"\`]`, 'g');

const kullanilan = new Set();
const KAYNAKLAR = dosyalar(['.js', '.html']).filter(f => !f.startsWith('locales/'));
for (const f of KAYNAKLAR) {
  const src = oku(f);
  for (const m of src.matchAll(ANAHTAR_DESENI)) kullanilan.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/data-i18n(?:-\w+)?\s*=\s*["']([\w.]+)["']/g)) kullanilan.add(m[1]);
}

// GERCEKTEN dinamik kurulanlar: kod anahtari hicbir yerde tam yazmaz.
// Liste DAR tutulur - genis bir desen, gercek oksuzleri de gizler.
const DINAMIK = [
  // options/tabs/settings.js hardening anahtarlarini
  // `options.harden${Ad}Title` bicimde uretiyor.
  /^options\.harden\w+(Title|Desc)$/
];
const dinamikMi = (k) => DINAMIK.some(d => d.test(k));

let bulgu = 0;
const raporla = (baslik, liste, not) => {
  if (!liste.length) { console.log(`  TEMIZ   ${baslik}`); return; }
  bulgu += liste.length;
  console.log(`  BULGU   ${baslik}  (${liste.length})  -- ${not}`);
  for (const s of liste) console.log(`            ${s}`);
};

console.log('\nGhostTrace ceviri denetimi');
console.log('='.repeat(72));

// 1) Esitlik
const trFazla = [...tr].filter(k => !en.has(k)).sort();
const enFazla = [...en].filter(k => !tr.has(k)).sort();
raporla('TR ve EN ayni anahtarlara sahip',
  [...trFazla.map(k => `${k}: yalnizca TR`), ...enFazla.map(k => `${k}: yalnizca EN`)],
  'dil degistirince satir kaybolur');

// 2) Eksik (kodda var, ceviride yok)
// Dosya adlari desene takiliyor: HTML'deki "options.css" / "popup.js"
// baglantilari da `blok.anahtar` bicimine benziyor. Uzantiyla bitenler
// ceviri anahtari degildir.
const DOSYA_ADI = /\.(css|js|mjs|html|json|png|svg|ico|woff2?)$/;
const eksik = [...kullanilan]
  .filter(k => !DOSYA_ADI.test(k))
  .filter(k => !tr.has(k) || !en.has(k)).sort();
raporla('Kodun istedigi her anahtar ceviride var', eksik,
  'arayuzde ham anahtar gorunur');

// 3) Oksuz (ceviride var, kodda yok)
const oksuz = [...tr].filter(k => !kullanilan.has(k) && !dinamikMi(k)).sort();
raporla('Oksuz ceviri yok', oksuz, 'kullanilmayan metin - eski ozellik kalintisi olabilir');

// 4) Bos metin
const bosluk = [];
for (const dil of ['tr', 'en']) {
  const mod = await import(`../locales/${dil}.js`);
  const sozluk = mod.default || Object.values(mod)[0];
  for (const [blok, icerik] of Object.entries(sozluk)) {
    if (!icerik || typeof icerik !== 'object') continue;
    for (const [k, v] of Object.entries(icerik)) {
      if (typeof v === 'string' && v.trim() === '') bosluk.push(`${dil}: ${blok}.${k} BOS`);
    }
  }
}
raporla('Bos ceviri yok', bosluk, 'arayuzde bosluk gorunur');

// 5) Yer tutucu esitligi: {domain} TR'de varsa EN'de de olmali
const modTr = (await import('../locales/tr.js'));
const modEn = (await import('../locales/en.js'));
const sTr = modTr.default || Object.values(modTr)[0];
const sEn = modEn.default || Object.values(modEn)[0];
const yerTutucu = [];
for (const [blok, icerik] of Object.entries(sTr)) {
  if (!icerik || typeof icerik !== 'object') continue;
  for (const [k, v] of Object.entries(icerik)) {
    const karsi = sEn[blok]?.[k];
    if (typeof v !== 'string' || typeof karsi !== 'string') continue;
    const al = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
    if (al(v) !== al(karsi)) {
      yerTutucu.push(`${blok}.${k}: TR{${al(v)}} != EN{${al(karsi)}}`);
    }
  }
}
raporla('Yer tutucular iki dilde ayni', yerTutucu,
  'bir dilde deger yerine ham {isim} gorunur');

// --- 6) USLUP: Title Case sizmasi ---
//
// Arayuzun "iki ayri elden cikmis" hissi vermesinin BIRINCI sebebi buydu:
// yeni metinler cumle duzenindeyken eskiler Ingilizce Title Case'teydi
// ("Kurali Ekle", "Sistem Durumu"). Turkce'de bu bicim makine cevirisi gibi
// okunur; Ingilizce'de ise eskimis gorunur.
//
// Tespit: ilk sozcukten SONRA gelen buyuk harfle baslayan sozcukler. Ozel
// adlar ve kisaltmalar dogal olarak buyuk harflidir, listelenip gecilir.
const OZEL_AD = new Set([
  'GhostTrace', 'Chrome', 'Chromium', 'Google', 'Topics', 'API', 'Protected',
  'Audience', 'FLEDGE', 'Attribution', 'Reporting', 'IndexedDB', 'LocalStorage',
  'Service', 'Worker', 'Workers', 'Public', 'Suffix', 'List', 'CHIPS', 'HSTS',
  'QUIC', 'HTTP2', 'HTTPS', 'JSON', 'TXT', 'DNS', 'CDN', 'CDN\'ler', 'URL',
  'Manifest', 'V3', 'GhostTrace\'in', 'Chrome\'un', 'Chrome\'da', 'Google\'a',
  'Türkçe', 'Turkish', 'English', 'Site', 'CAUTION', 'IndexedDB\'yi'
]);
const uslupSorun = [];
for (const [dil, sozluk] of [['tr', sTr], ['en', sEn]]) {
  for (const [blok, icerik] of Object.entries(sozluk)) {
    if (!icerik || typeof icerik !== 'object') continue;
    for (const [k, v] of Object.entries(icerik)) {
      if (typeof v !== 'string') continue;
      // Yalnizca ilk cumleye bak: sonraki cumlelerin ilk harfi zaten buyuk.
      const ilkCumle = v.split(/[.!?:\n]/)[0];
      const sozcukler = ilkCumle.split(/\s+/).filter(Boolean);
      if (sozcukler.length < 3) continue;      // kisa etiketlerde anlamsiz
      const buyuk = sozcukler.slice(1).filter(s => {
        const temiz = s.replace(/^[("'—-]+|[)"',.;]+$/g, '');
        if (!temiz || OZEL_AD.has(temiz)) return false;
        if (/^\{/.test(temiz)) return false;    // {domain} gibi yer tutucular
        if (temiz === temiz.toUpperCase()) return false;  // kisaltma
        return /^[A-ZÇĞİÖŞÜ]/.test(temiz);
      });
      // Iki veya daha fazla gereksiz buyuk harf = Title Case kaliyor.
      if (buyuk.length >= 2) {
        uslupSorun.push(`${dil}: ${blok}.${k} -> ${buyuk.join(', ')}`);
      }
    }
  }
}
raporla('Cumle duzeni korunuyor (Title Case yok)', uslupSorun,
  'Ingilizce Title Case sizmis - makine cevirisi gibi okunur');

// --- 7) USLUP: dolgu ve gereksiz tekrar ---
const YASAK = [
  [/başarıyla/i, 'tr', '"başarıyla" dolgu sozcugu'],
  [/\bsuccessfully\b/i, 'en', '"successfully" dolgu sozcugu'],
  [/Devam etmek istiyor musunuz/i, 'tr', 'onay dugmesi zaten soruyor'],
  [/Do you want to continue/i, 'en', 'onay dugmesi zaten soruyor'],
  [/[‘’“”]/, null, 'kivrik tirnak - duz tirnak kullanin']
];
const dolguSorun = [];
for (const [dil, sozluk] of [['tr', sTr], ['en', sEn]]) {
  for (const [blok, icerik] of Object.entries(sozluk)) {
    if (!icerik || typeof icerik !== 'object') continue;
    for (const [k, v] of Object.entries(icerik)) {
      if (typeof v !== 'string') continue;
      for (const [desen, hedefDil, not] of YASAK) {
        if (hedefDil && hedefDil !== dil) continue;
        if (desen.test(v)) dolguSorun.push(`${dil}: ${blok}.${k} - ${not}`);
      }
    }
  }
}
raporla('Dolgu sozcuk ve gereksiz tekrar yok', dolguSorun, 'yapay ton');

// --- 8) USLUP: terim tutarliligi ve etiket sonu ---
//
// Ayni sey iki farkli sozcukle anilirsa okuyan bunlarin FARKLI seyler
// oldugunu sanir. "Gunlukler" sekmesinde "Loglari Temizle" dugmesi tam
// olarak bunu yapiyordu.
const terimSorun = [];
const yerTutucusuz = (s) => s.replace(/\{\w+\}/g, '');
for (const [blok, icerik] of Object.entries(sTr)) {
  if (!icerik || typeof icerik !== 'object') continue;
  for (const [ham, hamV] of Object.entries(icerik)) {
    const k = ham;
    const v = typeof hamV === 'string' ? yerTutucusuz(hamV) : hamV;
    if (typeof v !== 'string') continue;
    if (/\blog(u|lar|ları|ların|a|un)?\b/i.test(v)) {
      terimSorun.push(`tr: ${blok}.${k} - "log" yerine "gunluk" kullanilmali`);
    }
    if (/\bdomain\b/i.test(v)) {
      terimSorun.push(`tr: ${blok}.${k} - "domain" yerine "alan adi" kullanilmali`);
    }
  }
}
for (const [dil, sozluk] of [['tr', sTr], ['en', sEn]]) {
  for (const [blok, icerik] of Object.entries(sozluk)) {
    if (!icerik || typeof icerik !== 'object') continue;
    for (const [k, v] of Object.entries(icerik)) {
      // Etiket sonundaki iki nokta: modern arayuzde kullanilmiyor.
      if (typeof v === 'string' && /Label$/.test(k) && v.trim().endsWith(':')) {
        terimSorun.push(`${dil}: ${blok}.${k} - etiket sonunda ":" olmamali`);
      }
    }
  }
}
raporla('Terimler tutarli, etiketlerde ":" yok', terimSorun, 'terim kaymasi');

console.log('='.repeat(72));
console.log(bulgu === 0 ? 'Ceviri yapisi TEMIZ.' : `${bulgu} bulgu var.`);
console.log(`Anahtar sayisi: TR ${tr.size}, EN ${en.size}\n`);
process.exit(bulgu === 0 ? 0 : 1);
