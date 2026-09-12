// SONDA: arama motoru -> sonuc sitesi zincirinde ARA DURAK temizleniyor mu?
//
// Kullanici bildirdi: adres cubuguna "m" yazinca gecmis ikonuyla eski
// aramalari cikiyor ve google.com gecmisinde "search?q=malwaretips" duruyor.
// Senaryo: tek sekmede once arama motoru, sonra sonuc sitesi aciliyor, sonra
// sekme kapaniyor. Sekme kapanisinda SON url temizlenir; ara duragin
// (arama motoru) temizligi navigate-away yoluna bagli. Olculen o.
import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep
} from './harness.mjs';

const ARAMA = 'https://www.google.com/search?q=malwaretips'; // arama motoru duragi
const HEDEF = 'https://malwaretips.com/';                    // sonuc sitesi
// Kullanicinin kurulumu: accounts.google.com BEYAZ LISTEDE, google.com degil.
const KURAL = { 'accounts.google.com': { domain: 'accounts.google.com', type: 'white',
  subdomains: false, keepMode: 'all', keepCookies: [], addedAt: Date.now(), updatedAt: Date.now(),
  durationMinutes: null, expiresAt: null } };

const chrome_ = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
try {
  const ek = await attachExtension(chrome_.client);
  const sw = ek.sessionId;
  const sayfa = await openExtensionPage(chrome_.client, ek.extensionId, 'options/options.html');
  await evaluate(chrome_.client, sayfa.sessionId,
    `await chrome.storage.local.set({ rules: ${JSON.stringify(KURAL)}, enabled: true, cleanDelay: 0,
       cleanHistory: true, cleanCookies: true, logLevel: 'debug' });
     await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' }); return 1;`);
  await sleep(1500);

  const gecmis = (parca) => evaluate(chrome_.client, sw,
    `const r = await chrome.history.search({ text: ${JSON.stringify(parca)}, maxResults: 50,
       startTime: 0 });
     return r.map(x => x.url.slice(0, 70));`);

  // --- Zincir: TEK sekmede arama -> sonuc -> kapat ---
  const t = await visit(chrome_.client, ARAMA, { settleMs: 4000 });
  console.log('  1) arama sayfasi acildi');
  await chrome_.client.send('Page.navigate', { url: HEDEF }, t.sessionId);
  await sleep(6000);
  console.log('  2) ayni sekmede sonuc sitesine gecildi');

  const araGecmis = await gecmis('google.com/search');
  const hedefGecmis = await gecmis('malwaretips');
  console.log(`     gecmiste google arama: ${araGecmis.length}, malwaretips: ${hedefGecmis.length}`);

  await closeTarget(chrome_.client, t.targetId);
  console.log('  3) sekme kapatildi, temizlik bekleniyor...');
  await sleep(15000);

  const araSonra = await gecmis('google.com/search');
  const hedefSonra = await gecmis('malwaretips');
  console.log('');
  console.log(`  ARA DURAK (arama motoru) : ${araGecmis.length} -> ${araSonra.length}` +
    (araSonra.length ? '   KALDI' : '   temizlendi'));
  console.log(`  SON DURAK (sonuc sitesi) : ${hedefGecmis.length} -> ${hedefSonra.length}` +
    (hedefSonra.length ? '   KALDI' : '   temizlendi'));

  if (araSonra.length) {
    console.log('\n  Kalan ara durak kayitlari:');
    for (const u of araSonra) console.log('    ' + u);
    const g = await evaluate(chrome_.client, sw,
      `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
         .map(x => x.level + ' ' + (x.domain ? '[' + x.domain + '] ' : '') + x.message).slice(-14);`);
    console.log('\n  Son gunluk kayitlari:');
    for (const s of g) console.log('    ' + s);
  }

  console.log(araSonra.length
    ? '\n  SONUC: ARA DURAK TEMIZLENMIYOR - arama motoru gecmisi kaliyor.'
    : '\n  SONUC: ara durak da temizlendi.');
} finally {
  await chrome_.close();
}
