// SONDA: "beyaz listenin gecmisini de temizle" acikSA arama izi GERCEKTEN
// gidiyor mu, ve cerezler/oturumlar korunuyor mu?
//
// Kullanicinin bildirdigi sorun: adres cubuguna yazinca eski aramalar cikiyor.
// Kaynak olculdu - google.com/search URL'si ve ona bagli keyword_search_terms,
// chrome.history.search() bunlari HIC dondurmedigi icin secici silme ulasamiyor.
// Cozum: ayar acikSA filtresiz gecmis silme. Burada ham SQLite ile dogrulanir -
// chrome.history.search'e guvenmek ayni kore dusmek olurdu.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, visit, evaluate, sleep
} from './harness.mjs';

const ARAMA = 'https://www.google.com/search?q=malwaretips';
const KORUMALI = 'https://github.com/';   // beyaz listede: OTURUMU korunmali

async function kosum(ayarAcik) {
  const profil = mkdtempSync(join(tmpdir(), 'gt-tam-'));
  const c = await launchChrome({
    live: true, headless: process.env.GT_HEADED !== '1',
    profileDir: profil, keepProfile: true, refreshExtension: false
  });
  try {
    const ek = await attachExtension(c.client);
    const s = await openExtensionPage(c.client, ek.extensionId, 'options/options.html');
    await evaluate(c.client, s.sessionId, `
      await chrome.storage.local.set({
        enabled: true, cleanHistory: true, cleanCookies: true, cleanDelay: 0,
        whitelistCleanHistory: ${ayarAcik},
        rules: { 'github.com': { domain: 'github.com', type: 'white', subdomains: true,
          keepMode: 'all', keepCookies: [], addedAt: Date.now(), updatedAt: Date.now(),
          durationMinutes: null, expiresAt: null } }
      });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' }); return 1;`);
    await sleep(1500);

    await visit(c.client, KORUMALI, { settleMs: 4000 });
    await visit(c.client, ARAMA, { settleMs: 5000 });
    await sleep(2500);

    const cerezOnce = await evaluate(c.client, ek.sessionId,
      "return (await chrome.cookies.getAll({ domain: 'github.com' })).length;");

    // Toplu temizligi TETIKLE (periyodik supurmenin kullandigi yol).
    await evaluate(c.client, s.sessionId,
      "return await chrome.runtime.sendMessage({ action: 'PURGE_ALL_NON_WHITELIST' });");
    await sleep(9000);

    const cerezSonra = await evaluate(c.client, ek.sessionId,
      "return (await chrome.cookies.getAll({ domain: 'github.com' })).length;");

    await c.close();
    await sleep(3500);

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(profil, 'Default', 'History'), { readOnly: true });
    const q = (sql) => { try { return db.prepare(sql).get().c; } catch { return -1; } };
    const r = {
      aramaUrl: q("SELECT COUNT(*) c FROM urls WHERE url LIKE '%google.com/search%'"),
      terim: q('SELECT COUNT(*) c FROM keyword_search_terms'),
      github: q("SELECT COUNT(*) c FROM urls WHERE url LIKE '%github.com%'"),
      toplam: q('SELECT COUNT(*) c FROM urls'),
      cerezOnce, cerezSonra
    };
    db.close();
    return r;
  } finally {
    try { await c.close(); } catch { /* kapali */ }
  }
}

for (const [acik, ad] of [[false, 'KAPALI (bugunku davranis)'], [true, 'ACIK (yeni yol)']]) {
  const r = await kosum(acik);
  console.log(`\n  whitelistCleanHistory = ${ad}`);
  console.log(`    HAM urls  google.com/search : ${r.aramaUrl}`);
  console.log(`    HAM keyword_search_terms    : ${r.terim}`);
  console.log(`    HAM urls  github.com        : ${r.github}`);
  console.log(`    HAM urls  toplam            : ${r.toplam}`);
  console.log(`    github CEREZ (oturum)       : ${r.cerezOnce} -> ${r.cerezSonra}` +
    (r.cerezSonra === r.cerezOnce && r.cerezOnce > 0 ? '   KORUNDU' : ''));
  console.log(`    -> arama izi: ${(r.aramaUrl === 0 && r.terim === 0) ? 'TAMAMEN GITTI' : 'KALDI'}`);
}
