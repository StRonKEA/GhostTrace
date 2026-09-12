// GhostTrace - SERTLESTIRME YUZEYI OLCUMU.
//
// Soru: Chrome'un sundugu gizlilik anahtarlarindan hangilerini KULLANIYORUZ,
// hangilerini kullanmiyoruz?
//
// Bu, hafizadan cevaplanacak bir soru degil: chrome.privacy uyeleri surumden
// surume degisiyor (Topics/FLEDGE emekliye ayriliyor, Related Website Sets
// yeni geldi). Bu yuzden GERCEK tarayicinin sundugu uye listesini okuyup
// lib/privacy.js'in kapsadiklariyla karsilastiriyoruz.
//
// Kullanim: node tools/probe-privacy-api.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXTENSION_DIR, launchChrome, attachExtension, evaluate
} from '../test/e2e/harness.mjs';

const GRUPLAR = ['websites', 'network', 'services'];

// --- 1) Eklentinin KAPSADIGI anahtarlar (kaynak dogruyu soyler) ---
const kaynak = readFileSync(join(EXTENSION_DIR, 'lib', 'privacy.js'), 'utf8');
const kapsanan = new Map();   // "grup.api" -> ayar anahtari
for (const m of kaynak.matchAll(
  /key:\s*'([^']+)'\s*,\s*group:\s*'([^']+)'\s*,\s*api:\s*'([^']+)'/g)) {
  kapsanan.set(`${m[2]}.${m[3]}`, m[1]);
}

// --- 2) Tarayicinin SUNDUGU anahtarlar ---
// `privacy` ISTEGE BAGLI izin: verilmediginde chrome.privacy TANIMSIZDIR ve
// olcum "API yok" der - gercekte kullanilabilir olan anahtarlari "yok"
// sanmaya yol acar. Bu yuzden izni verilmis KALICI profil sart.
const PROFIL = process.env.GT_PROFILE || null;
if (!PROFIL) {
  console.error([
    '',
    'GT_PROFILE gerekli: `privacy` izni verilmis hazir profil olmadan',
    'chrome.privacy tanimsiz gorunur ve olcum yaniltici olur.',
    '  GT_PROFILE=<yol> node tools/probe-privacy-api.mjs',
    ''
  ].join('\n'));
  process.exit(2);
}
const { browser, client, close } = await launchChrome({
  sitePort: 0, headless: true, profileDir: PROFIL, keepProfile: true
});
let ext;
try {
  ext = await attachExtension(client);
  const sunulan = await evaluate(client, ext.sessionId, `
    const out = {};
    for (const g of ${JSON.stringify(GRUPLAR)}) {
      out[g] = chrome.privacy?.[g] ? Object.keys(chrome.privacy[g]).sort() : null;
    }
    out._surum = navigator.userAgentData?.brands?.map(b => b.brand + ' ' + b.version).join(', ')
      || navigator.userAgent;
    return out;
  `);

  console.log('\nSertlestirme yuzeyi olcumu');
  console.log(`Tarayici: ${sunulan._surum}`);
  console.log('='.repeat(74));

  const eksik = [];
  for (const grup of GRUPLAR) {
    const uyeler = sunulan[grup];
    if (!uyeler) { console.log(`\n[${grup}] API YOK`); continue; }
    console.log(`\n[chrome.privacy.${grup}]`);
    for (const uye of uyeler) {
      const tam = `${grup}.${uye}`;
      const ayar = kapsanan.get(tam);
      if (ayar) console.log(`  KULLANILIYOR  ${uye}  -> ayar: ${ayar}`);
      else { console.log(`  --            ${uye}`); eksik.push(tam); }
    }
  }

  console.log('\n' + '='.repeat(74));
  console.log(`Kullanilan: ${kapsanan.size} / sunulan: ${eksik.length + kapsanan.size}`);
  console.log('\nKullanilmayanlar (her biri BILINCLI bir karar olmali):');
  for (const e of eksik) console.log(`  ${e}`);
  console.log();
} finally {
  await close?.();
  browser?.kill?.();
}
