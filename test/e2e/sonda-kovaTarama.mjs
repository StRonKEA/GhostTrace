// SONDA: GERCEK siteler Storage Bucket kullaniyor mu?
// SINIR: yalnizca ana cercevedeki ve ilk ziyarette olusan kovalari gorur;
// bulunmamasi "kimse kullanmiyor" degil "bu 40 sitede kullanan yok" demektir.
import { launchChrome, visit, closeTarget, evaluate, sleep } from './harness.mjs';

const SITELER = [
  'https://www.google.com/', 'https://www.youtube.com/', 'https://www.facebook.com/',
  'https://www.instagram.com/', 'https://x.com/', 'https://www.reddit.com/',
  'https://www.amazon.com/', 'https://www.amazon.com.tr/', 'https://www.ebay.com/',
  'https://www.netflix.com/', 'https://www.spotify.com/', 'https://www.twitch.tv/',
  'https://www.linkedin.com/', 'https://www.pinterest.com/', 'https://www.tiktok.com/',
  'https://www.bbc.com/news', 'https://www.cnn.com/', 'https://www.nytimes.com/',
  'https://www.theguardian.com/', 'https://www.dailymail.co.uk/',
  'https://www.hurriyet.com.tr/', 'https://www.sabah.com.tr/', 'https://www.milliyet.com.tr/',
  'https://www.sozcu.com.tr/', 'https://www.haberturk.com/', 'https://www.cnnturk.com/',
  'https://www.ntv.com.tr/', 'https://www.mynet.com/', 'https://onedio.com/',
  'https://www.trendyol.com/', 'https://www.hepsiburada.com/', 'https://www.n11.com/',
  'https://www.sahibinden.com/', 'https://www.booking.com/', 'https://www.airbnb.com/',
  'https://stackoverflow.com/', 'https://github.com/', 'https://www.wikipedia.org/',
  'https://www.imdb.com/', 'https://www.aliexpress.com/',
];

// Kovalar sayfa yuklendikten sonra da acilabilir; bu yuzden hem erken hem
// gec ornek aliyoruz. Tek ornek "kullanmiyor" yanilgisi uretebilirdi.
const OKU = `
  if (!navigator.storageBuckets) return { destek: false };
  return { destek: true, adlar: await navigator.storageBuckets.keys() };
`;

const chrome_ = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
const bulgular = [];
try {
  await sleep(1500);
  for (const url of SITELER) {
    const ad = new URL(url).hostname.replace(/^www\./, '');
    try {
      const t = await visit(chrome_.client, url, { settleMs: 4000 });
      const erken = await evaluate(chrome_.client, t.sessionId, OKU);
      await sleep(6000);                       // sayfa kendi isini bitirsin
      const gec = await evaluate(chrome_.client, t.sessionId, OKU).catch(() => erken);
      await closeTarget(chrome_.client, t.targetId);
      const adlar = [...new Set([...(erken.adlar || []), ...(gec.adlar || [])])];
      if (!erken.destek) { console.log(`  ${ad.padEnd(24)} destek yok`); continue; }
      console.log(`  ${ad.padEnd(24)} kova: ${adlar.length ? JSON.stringify(adlar) : '-'}`);
      if (adlar.length) bulgular.push({ ad, adlar });
    } catch (e) {
      console.log(`  ${ad.padEnd(24)} ACILAMADI (${String(e.message).slice(0, 40)})`);
    }
  }
} finally {
  await chrome_.close();
}

console.log('');
console.log(`  Taranan site   : ${SITELER.length}`);
console.log(`  Kova kullanan  : ${bulgular.length}`);
for (const b of bulgular) console.log(`    ${b.ad}: ${JSON.stringify(b.adlar)}`);
console.log(bulgular.length
  ? '\n  SONUC: gercek sitelerde Storage Bucket KULLANIMI VAR.'
  : '\n  SONUC: bu 40 sitenin hicbiri ilk ziyarette Storage Bucket ACMIYOR.');
