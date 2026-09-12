// GhostTrace - tema kontrast denetimi.
//
// NEDEN BU TEST VAR: renk secimini GOZLE dogrulamak bu projede iki kez yanildi
// (yazi kalinligi ve kilit soluklastirmasi). Oran yanilmaz. Ustelik test
// degerleri ELLE tekrarlamaz - ui/theme.css'i okur, yani belirtec degisirse
// buradaki iddia da onunla birlikte degisir ve sessizce eskimez.
//
// Iki ESIK var ve karistirmak yanlis alarm uretir:
//   WCAG 1.4.3  Metin       -> 4.5:1 (buyuk metin 3:1)
//   WCAG 1.4.11 Metin disi  -> 3:1, yalnizca ANLAM tasiyan grafik ve
//                              KONTROL SINIRI icin.
// Satir arasi dekoratif ayirici bu kapsamda DEGILDIR; Chrome'un kendi
// ayiricisi da ~1.3:1'dir. Ona esik uygulamak, arayuzu gereksiz yere
// cizgilerle doldurmak demek olurdu.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'ui', 'theme.css'), 'utf8');

/** Bir CSS blogundaki --belirtec: deger ciftlerini toplar. */
function readTokens(blockSource) {
  const out = {};
  for (const m of blockSource.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Kaynakta bir seciciden sonra gelen ilk { ... } blogunu dondurur. */
function blockAfter(source, selector) {
  const at = source.indexOf(selector);
  assert.ok(at !== -1, `secici bulunamadi: ${selector}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`blok kapanmamis: ${selector}`);
}

const ACIK = readTokens(blockAfter(CSS, ':root {'));
const KOYU = readTokens(blockAfter(CSS, ':root[data-theme="dark"]'));

// --- kontrast matematigi (WCAG 2.x) ---
const kanal = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function parlaklik(hex) {
  const h = hex.replace('#', '').trim();
  const tam = h.length === 3 ? [...h].map(ch => ch + ch).join('') : h;
  assert.match(tam, /^[0-9a-fA-F]{6}$/, `hex bekleniyordu, gelen: ${hex}`);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(tam.slice(i, i + 2), 16));
  return 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b);
}

function oran(a, b) {
  const [x, y] = [parlaklik(a), parlaklik(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// (on, arka, esik, aciklama)
const METIN = [
  ['--text',       '--bg',      4.5, 'govde / tuval'],
  ['--text',       '--surface', 4.5, 'govde / yuzey'],
  ['--text-muted', '--surface', 4.5, 'ikincil / yuzey'],
  ['--text-muted', '--bg',      4.5, 'ikincil / tuval'],
  ['--text-faint', '--surface', 4.5, 'soluk etiket / yuzey'],
  ['--text-faint', '--bg',      4.5, 'soluk etiket / tuval'],
  // --surface-sunken UNUTULMUSTU ve tam da orada ihlal vardi: tablo basligi
  // ve segment sayaci bu zeminde duruyor, acik temada olculen oran 4.32:1'di.
  // Test yesil, arayuz ihlalliydi. Girintili zemin artik UC metin belirteci
  // icin de kontrol ediliyor.
  ['--text',       '--surface-sunken', 4.5, 'govde / girintili zemin'],
  ['--text-muted', '--surface-sunken', 4.5, 'ikincil / girintili zemin'],
  ['--text-faint', '--surface-sunken', 4.5, 'soluk etiket / girintili zemin'],
  ['--accent-text', '--surface', 4.5, 'vurgu metni / yuzey'],
  ['--danger',     '--surface', 4.5, 'tehlike metni / yuzey'],
  ['--warn',       '--surface', 4.5, 'uyari metni / yuzey'],
  ['--accent-on',  '--accent',  4.5, 'dolgu vurgu uzerindeki yazi'],
  ['--danger-on',  '--danger',  4.5, 'dolgu tehlike uzerindeki yazi'],
  ['--accent-text', '--accent-soft', 4.5, 'vurgu metni / yumusak vurgu zemini'],
  ['--danger',     '--danger-soft', 4.5, 'tehlike metni / yumusak zemin'],
  ['--warn',       '--warn-soft',   4.5, 'uyari metni / yumusak zemin'],
];

// Kontrol siniri ve odak halkasi: metin degil, ama ANLAM tasir.
const KONTROL = [
  ['--control-border', '--surface', 3.0, 'kontrol siniri / yuzey'],
  ['--control-border', '--bg',      3.0, 'kontrol siniri / tuval'],
  ['--control-border', '--surface-sunken', 3.0, 'kontrol siniri / girintili zemin'],
  ['--focus',          '--surface', 3.0, 'odak halkasi / yuzey'],
  ['--focus',          '--bg',      3.0, 'odak halkasi / tuval'],
  ['--accent',         '--surface', 3.0, 'acik anahtar dolgusu / yuzey'],
];

for (const [temaAdi, tema] of [['ACIK', ACIK], ['KOYU', KOYU]]) {
  describe(`${temaAdi} tema kontrasti`, () => {
    test('belirtecler okundu', () => {
      // Duzenek dogrulamasi: ayristirma bozulursa test bos gezip YESIL kalirdi.
      assert.ok(Object.keys(tema).length >= 20,
        `${temaAdi} temada yeterli belirtec yok: ${Object.keys(tema).length}`);
      for (const ad of ['--bg', '--surface', '--text', '--accent', '--control-border', '--focus']) {
        assert.match(tema[ad] || '', /^#[0-9a-fA-F]{3,6}$/,
          `${ad} hex olmali, gelen: ${tema[ad]}`);
      }
    });

    for (const [on, arka, esik, ne] of METIN) {
      test(`metin 1.4.3: ${ne} >= ${esik}:1`, () => {
        const r = oran(tema[on], tema[arka]);
        assert.ok(r >= esik,
          `${ne}: ${tema[on]} / ${tema[arka]} = ${r.toFixed(2)}:1, gereken ${esik}:1`);
      });
    }

    for (const [on, arka, esik, ne] of KONTROL) {
      test(`metin disi 1.4.11: ${ne} >= ${esik}:1`, () => {
        const r = oran(tema[on], tema[arka]);
        assert.ok(r >= esik,
          `${ne}: ${tema[on]} / ${tema[arka]} = ${r.toFixed(2)}:1, gereken ${esik}:1`);
      });
    }
  });
}

describe('tema butunlugu', () => {
  test('acik ve koyu tema AYNI belirtec kumesini tanimlar', () => {
    // Bir belirtec yalnizca tek temada tanimliysa, diger temada onceki
    // temanin degeri sizar ve okunamayan bir renk cikar.
    const eksikKoyu = Object.keys(ACIK).filter(k => !(k in KOYU) && !k.startsWith('--sp-')
      && !k.startsWith('--r-') && !k.startsWith('--fs-') && !k.startsWith('--lh-')
      && !k.startsWith('--icon-') && !k.startsWith('--t-')
      && !['--font', '--font-mono', '--ease'].includes(k));
    assert.deepEqual(eksikKoyu, [],
      `koyu temada tanimlanmamis renk belirtecleri: ${eksikKoyu.join(', ')}`);

    const fazlaKoyu = Object.keys(KOYU).filter(k => !(k in ACIK));
    assert.deepEqual(fazlaKoyu, [],
      `acik temada karsiligi olmayan belirtecler: ${fazlaKoyu.join(', ')}`);
  });

  test('sistem koyu tema blogu ACIK secimiyle gecersiz kilinabiliyor', () => {
    // `@media (prefers-color-scheme: dark)` blogu `:root:not([data-theme="light"])`
    // ile sinirlanmazsa, kullanicinin ACIK tercihi sistemde koyu temada calismaz.
    const medya = CSS.slice(CSS.indexOf('@media (prefers-color-scheme: dark)'));
    assert.match(medya.slice(0, 200), /:root:not\(\[data-theme="light"\]\)/,
      'medya sorgusu kullanicinin ACIK secimini disarida birakmali');
  });

  test('koyu tema sistem blogu ile sabit blok AYNI degerleri verir', () => {
    // Iki yerde tanimli: biri sistem temasi icin, biri kullanici secimi icin.
    // Ayrismalari, ayni gorunmesi gereken iki durumun farkli gorunmesi demek.
    const medyaBlok = blockAfter(
      CSS.slice(CSS.indexOf('@media (prefers-color-scheme: dark)')),
      ':root:not([data-theme="light"])'
    );
    const medya = readTokens(medyaBlok);
    for (const [ad, deger] of Object.entries(medya)) {
      assert.equal(KOYU[ad], deger,
        `${ad}: sistem blogu "${deger}", sabit blok "${KOYU[ad]}"`);
    }
  });
});
