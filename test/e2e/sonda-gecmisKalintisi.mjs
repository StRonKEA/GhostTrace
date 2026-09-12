// SONDA: eklenti gecmisi silince GERIDE NE KALIYOR?
//
// Kullanici bildirdi: "eklenti siliyor, gecmis sayfasinda gorunmuyor, ama
// adres cubuguna yazinca site cikiyor. Elle silince cikmiyor."
// Yani chrome.history.deleteUrl, Chrome'un kendi 'tarama verilerini sil'
// akisiyla ayni seyi temizlemiyor olabilir. Chrome'un History veritabaninda
// urls disinda adres cubugunu besleyen tablolar var: keyword_search_terms,
// visited_links, segments, content_annotations.
//
// Olcum: siteyi ziyaret et -> eklentiye temizlet -> chrome.history.search BOS
// olsun -> tarayiciyi kapat -> veritabanini SQL ile tara. Kalinti varsa
// tam olarak hangi tabloda oldugunu yazar.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep
} from './harness.mjs';

const HEDEF = { url: 'https://malwaretips.com/', kok: 'malwaretips.com', ara: 'malwaretips' };
const profil = mkdtempSync(join(tmpdir(), 'gt-kalinti-'));

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

  const gecmisSay = () => evaluate(chrome_.client, sw,
    `const r = await chrome.history.search({ text: ${JSON.stringify(HEDEF.ara)},
       maxResults: 100, startTime: 0 });
     return r.length;`);

  // 1) Ziyaret et; ic baglantiya da git ki birden fazla kayit olussun.
  const t = await visit(chrome_.client, HEDEF.url, { settleMs: 5000 });
  await evaluate(chrome_.client, t.sessionId,
    `const a = [...document.querySelectorAll('a[href^="https://malwaretips.com"]')][3];
     if (a) location.href = a.href; return 1;`).catch(() => {});
  await sleep(6000);
  console.log(`  1) ziyaret sonrasi gecmis kaydi: ${await gecmisSay()}`);

  // 2) Eklentiye temizlet.
  await closeTarget(chrome_.client, t.targetId);
  await sleep(12000);
  const kalanApi = await gecmisSay();
  console.log(`  2) eklenti temizligi sonrasi chrome.history.search: ${kalanApi}`);

  // 3) Tarayiciyi kapat ki veritabani diske yazilsin.
  await chrome_.close();
  await sleep(4000);

  // 4) HAM VERITABANI: hangi tabloda kalinti var?
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(profil, 'Default', 'History'), { readOnly: true });
  const tablolar = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(r => r.name).filter(n => !n.startsWith('sqlite_') && n !== 'meta');
  console.log('\n  3) HAM VERITABANI TARAMASI');
  let toplam = 0;
  for (const tab of tablolar) {
    let n = 0, bulunan = 0;
    try { n = db.prepare(`SELECT COUNT(*) c FROM "${tab}"`).get().c; } catch { continue; }
    try {
      const kol = db.prepare(`PRAGMA table_info("${tab}")`).all().map(r => r.name);
      const kosul = kol.map(k => `CAST("${k}" AS TEXT) LIKE '%${HEDEF.ara}%'`).join(' OR ');
      if (kosul) bulunan = db.prepare(`SELECT COUNT(*) c FROM "${tab}" WHERE ${kosul}`).get().c;
    } catch { /* sorgulanamayan tablo */ }
    if (bulunan > 0) {
      toplam += bulunan;
      console.log(`     KALINTI -> ${tab.padEnd(26)} ${bulunan}/${n} satir`);
    }
  }
  // Yetim satirlar: urls'ten silinmis ama baska tabloda url_id ile duran kayit
  try {
    const yetim = db.prepare(`SELECT COUNT(*) c FROM keyword_search_terms k
      LEFT JOIN urls u ON u.id = k.url_id WHERE u.id IS NULL`).get().c;
    if (yetim) console.log(`     YETIM   -> keyword_search_terms: ${yetim} satir urls'te karsiligi olmayan`);
  } catch { /* tablo yok */ }
  db.close();

  console.log(toplam === 0
    ? '\n  SONUC: veritabaninda kalinti YOK - eklenti tam siliyor.'
    : `\n  SONUC: chrome.history.search BOS diyor ama veritabaninda ${toplam} kalinti VAR.`);
} finally {
  try { await chrome_.close(); } catch { /* zaten kapali */ }
  console.log(`\n  profil: ${profil}`);
}
