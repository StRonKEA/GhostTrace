// SONDA: arama motorunun kendi izi (arama URL'si + keyword_search_terms)
// gercek kullanim desenlerinde temizleniyor mu?
//
// Kullanici bildirdi: adres cubuguna yazinca eski aramalari cikiyor. Kaynak
// olculdu - yerel keyword_search_terms tablosu, ve o tablo arama motorunun
// URL'sine bagli. Chrome politikasi SearchSuggestEnabled=0, yani oneriler
// aga gitmiyor; hepsi yerel.
//
// Iki desen olculur:
//   A) AYNI sekmede arama -> sonuc -> kapat      (navigate-away yolu)
//   B) Arama sekmesi ACIK kalirken sonuc YENI sekmede -> ikisini de kapat
// B, gercek kullanimda cok daha yaygin ve suphelendigim desen.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep
} from './harness.mjs';

const ARAMA = 'https://www.google.com/search?q=malwaretips';
const HEDEF = 'https://malwaretips.com/';

async function kosum(desen) {
  const profil = mkdtempSync(join(tmpdir(), 'gt-arama-'));
  const chrome_ = await launchChrome({
    live: true, headless: process.env.GT_HEADED !== '1',
    profileDir: profil, keepProfile: true, refreshExtension: false
  });
  try {
    const ek = await attachExtension(chrome_.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome_.client, ek.extensionId, 'options/options.html');
    await evaluate(chrome_.client, sayfa.sessionId,
      `await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
         cleanHistory: true, cleanCookies: true, logLevel: 'debug' });
       await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' }); return 1;`);
    await sleep(1500);

    const say = (p) => evaluate(chrome_.client, sw,
      `const r = await chrome.history.search({ text: ${JSON.stringify(p)}, maxResults: 100, startTime: 0 });
       return r.length;`);

    if (desen === 'A') {
      const t = await visit(chrome_.client, ARAMA, { settleMs: 4000 });
      await chrome_.client.send('Page.navigate', { url: HEDEF }, t.sessionId);
      await sleep(5000);
      await closeTarget(chrome_.client, t.targetId);
    } else {
      const a = await visit(chrome_.client, ARAMA, { settleMs: 4000 });   // arama sekmesi ACIK kalir
      const b = await visit(chrome_.client, HEDEF, { settleMs: 4000 });   // sonuc YENI sekmede
      await sleep(2000);
      await closeTarget(chrome_.client, b.targetId);   // once sonuc kapanir
      await sleep(6000);
      await closeTarget(chrome_.client, a.targetId);   // sonra arama sekmesi
    }
    await sleep(14000);

    const aramaKalan = await say('google.com/search');
    const hedefKalan = await say('malwaretips');
    await chrome_.close();
    await sleep(3000);

    // Ham veritabani: arama terimi tablosu
    const { DatabaseSync } = await import('node:sqlite');
    let terim = -1, urlSay = -1;
    try {
      const db = new DatabaseSync(join(profil, 'Default', 'History'), { readOnly: true });
      terim = db.prepare("SELECT COUNT(*) c FROM keyword_search_terms WHERE term LIKE '%malwaretips%'").get().c;
      urlSay = db.prepare("SELECT COUNT(*) c FROM urls WHERE url LIKE '%google.com/search%'").get().c;
      db.close();
    } catch (e) { console.log('   (veritabani okunamadi: ' + e.message + ')'); }

    return { aramaKalan, hedefKalan, terim, urlSay };
  } finally {
    try { await chrome_.close(); } catch { /* kapali */ }
  }
}

for (const [d, ad] of [['A', 'AYNI sekmede arama -> sonuc -> kapat'],
  ['B', 'Arama sekmesi ACIK, sonuc YENI sekmede -> ikisi de kapanir']]) {
  const r = await kosum(d);
  console.log(`\n  DESEN ${d}: ${ad}`);
  console.log(`    history.search google araması : ${r.aramaKalan}`);
  console.log(`    history.search malwaretips    : ${r.hedefKalan}`);
  console.log(`    HAM urls  (google.com/search) : ${r.urlSay}`);
  console.log(`    HAM keyword_search_terms      : ${r.terim}`);
  console.log(`    -> ${(r.urlSay === 0 && r.terim === 0) ? 'TEMIZ' : 'IZ KALDI'}`);
}
