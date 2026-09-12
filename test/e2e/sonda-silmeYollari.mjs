// SONDA: search() ile BULUNAMAYAN gecmis satirini hangi yol siler, bedeli ne?
//
// Olculdu: chrome.history.search() veritabanindaki bazi satirlari hic
// dondurmuyor (arama motoru yonlendirme zinciri). Eklenti yalnizca o API'nin
// gosterdigini silebildigi icin arama URL'si ve ona bagli arama terimi kaliyor.
//
// Iki aday yol var, ikisinin de KAZANCI ve BEDELI olculur:
//   A) browsingData.remove({origins}, {history:true})
//      Dokuman "origins yalnizca cerez/depolama/onbellek icin" diyor.
//      Ya calisir ya da TUM gecmisi siler - ikincisi beyaz listeyi goturur.
//   B) history.deleteUrl({url}) TAM URL ile
//      Eklenti sekme URL'lerini zaten goruyor; search()'e hic sormadan
//      dogrudan silebilir mi?
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, visit, evaluate, sleep
} from './harness.mjs';

const ARAMA = 'https://www.google.com/search?q=malwaretips';
const KORUMALI = 'https://www.wikipedia.org/';    // BEYAZ LISTE benzeri: silinmemeli

async function kur() {
  const profil = mkdtempSync(join(tmpdir(), 'gt-yol-'));
  const c = await launchChrome({
    live: true, headless: process.env.GT_HEADED !== '1',
    profileDir: profil, keepProfile: true, refreshExtension: false
  });
  const ek = await attachExtension(c.client);
  const s = await openExtensionPage(c.client, ek.extensionId, 'options/options.html');
  await evaluate(c.client, s.sessionId,
    'await chrome.storage.local.set({ enabled: false }); return 1;');   // eklenti karismasin
  await sleep(1000);
  // Once korunmasi gereken site, sonra arama
  await visit(c.client, KORUMALI, { settleMs: 3500 });
  await visit(c.client, ARAMA, { settleMs: 4500 });
  await sleep(2500);
  return { c, sw: ek.sessionId, profil };
}

async function say(c, profil) {
  await c.close();
  await sleep(3000);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(profil, 'Default', 'History'), { readOnly: true });
  const q = (sql) => { try { return db.prepare(sql).get().c; } catch { return -1; } };
  const r = {
    aramaUrl: q("SELECT COUNT(*) c FROM urls WHERE url LIKE '%google.com/search%'"),
    terim: q("SELECT COUNT(*) c FROM keyword_search_terms"),
    korumali: q("SELECT COUNT(*) c FROM urls WHERE url LIKE '%wikipedia%'"),
    toplam: q('SELECT COUNT(*) c FROM urls')
  };
  db.close();
  return r;
}

// --- BASLANGIC durumu ---
{
  const { c, profil } = await kur();
  const r = await say(c, profil);
  console.log('  BASLANGIC (hicbir silme yapilmadan)');
  console.log(`    arama URL=${r.aramaUrl}  terim=${r.terim}  korumali=${r.korumali}  toplam url=${r.toplam}`);
}

// --- YOL A: browsingData origins + history ---
{
  const { c, sw, profil } = await kur();
  const sonuc = await evaluate(c.client, sw, `
    try {
      await chrome.browsingData.remove(
        { origins: ['https://www.google.com'], originTypes: { unprotectedWeb: true, protectedWeb: true } },
        { history: true });
      return 'cagri BASARILI';
    } catch (e) { return 'HATA: ' + e.message; }`);
  await sleep(2500);
  const r = await say(c, profil);
  console.log('\n  YOL A: browsingData.remove({origins}, {history:true})');
  console.log(`    ${sonuc}`);
  console.log(`    arama URL=${r.aramaUrl}  terim=${r.terim}  korumali=${r.korumali}  toplam url=${r.toplam}`);
  console.log(`    -> ${r.aramaUrl === 0 ? 'arama izi GITTI' : 'arama izi KALDI'}` +
    ` | ${r.korumali === 0 ? 'KORUMALI SITE DE SILINDI (kabul edilemez)' : 'korumali site duruyor'}`);
}

// --- YOL B: tam URL ile deleteUrl ---
{
  const { c, sw, profil } = await kur();
  const sonuc = await evaluate(c.client, sw, `
    // search() bu satiri bulamiyor; TAM url ile dogrudan sil.
    const adaylar = ${JSON.stringify([ARAMA, ARAMA + '&sei=x'])};
    const gorulen = (await chrome.history.search({ text: 'google', maxResults: 100, startTime: 0 })).length;
    for (const u of adaylar) { try { await chrome.history.deleteUrl({ url: u }); } catch {} }
    return 'search() gordugu: ' + gorulen + ' | deleteUrl calisti';`);
  await sleep(2500);
  const r = await say(c, profil);
  console.log('\n  YOL B: history.deleteUrl({url}) TAM url ile');
  console.log(`    ${sonuc}`);
  console.log(`    arama URL=${r.aramaUrl}  terim=${r.terim}  korumali=${r.korumali}  toplam url=${r.toplam}`);
  console.log(`    -> ${r.aramaUrl === 0 ? 'arama izi GITTI' : 'arama izi KALDI'}` +
    ` | ${r.korumali > 0 ? 'korumali site duruyor' : 'KORUMALI SITE SILINDI'}`);
}
