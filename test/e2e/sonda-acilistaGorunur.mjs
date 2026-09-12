// SONDA: search()'un GORMEDIGI gecmis satiri, tarayici YENIDEN BASLAYINCA
// gorunur hale geliyor mu?
//
// Onem: oneri "gezilen tam URL'leri oturum belleginde tut, temizlikte sil".
// Delik su - tarayici temizlik calismadan kapanirsa o kayit kaybolur ve satir
// sonsuza kadar kalir. Diske yazmak cozum degil (proje bunu bilerek reddediyor).
// Ama satir acilista API'ye gorunur oluyorsa acilis supurmesi yakalayabilir ve
// hicbir seyi diske yazmamiza gerek kalmaz.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, visit, evaluate, sleep
} from './harness.mjs';

const ARAMA = 'https://www.google.com/search?q=malwaretips';
const profil = mkdtempSync(join(tmpdir(), 'gt-acilis-'));

const ac = () => launchChrome({
  live: true, headless: process.env.GT_HEADED !== '1',
  profileDir: profil, keepProfile: true, refreshExtension: false
});

const bak = async (c, sw, etiket) => {
  const r = await evaluate(c.client, sw, `
    const hepsi = await chrome.history.search({ text: '', maxResults: 200, startTime: 0 });
    const google = await chrome.history.search({ text: 'google', maxResults: 200, startTime: 0 });
    const arama = await chrome.history.search({ text: 'malwaretips', maxResults: 200, startTime: 0 });
    return { hepsi: hepsi.map(x => x.url.slice(0, 62)), googleSay: google.length, aramaSay: arama.length };`);
  console.log(`  ${etiket}`);
  console.log(`    text=''       -> ${r.hepsi.length} sonuc`);
  for (const u of r.hepsi) console.log('        ' + u);
  console.log(`    text='google' -> ${r.googleSay} | text='malwaretips' -> ${r.aramaSay}`);
  return r;
};

let c = await ac();
try {
  let ek = await attachExtension(c.client);
  const s = await openExtensionPage(c.client, ek.extensionId, 'options/options.html');
  await evaluate(c.client, s.sessionId, 'await chrome.storage.local.set({ enabled: false }); return 1;');
  await sleep(1000);
  await visit(c.client, ARAMA, { settleMs: 5000 });
  await sleep(3000);

  await bak(c, ek.sessionId, '1) ZIYARETTEN HEMEN SONRA (ayni oturum)');

  await c.close();
  await sleep(5000);
  c = await ac();
  ek = await attachExtension(c.client);
  await sleep(3000);

  const sonra = await bak(c, ek.sessionId, '\n2) TARAYICI YENIDEN BASLADIKTAN SONRA');

  await c.close();
  await sleep(3000);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(profil, 'Default', 'History'), { readOnly: true });
  const ham = db.prepare("SELECT url, hidden FROM urls WHERE url LIKE '%google%'").all();
  db.close();
  console.log('\n  3) HAM VERITABANI');
  for (const r of ham) console.log(`     hidden=${r.hidden}  ${String(r.url).slice(0, 66)}`);

  const gorunen = sonra.googleSay;
  console.log(`\n  SONUC: ham veritabaninda ${ham.length} google satiri, ` +
    `acilistan sonra API'nin gordugu ${gorunen}`);
  console.log(gorunen >= ham.length
    ? '  -> ACILISTA GORUNUR OLUYOR: acilis supurmesi yakalayabilir, diske yazmaya gerek yok.'
    : '  -> ACILISTA DA GORUNMUYOR: API bu satirlari hicbir zaman dondurmuyor.');
} finally {
  try { await c.close(); } catch { /* kapali */ }
}
