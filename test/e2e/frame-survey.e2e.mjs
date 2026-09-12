// "iframe'leri de izle" ayarinin GERCEK KAZANCINI olcer.
//
// Kullanim: npm run test:e2e:frames
//
// Soru su degil: "sitede iframe var mi?" - o kolay ve yaniltici.
// Soru su: iframe ICINDE gorulen ama UST CERCEVEDEN GORULMEYEN kac host var?
// Ust cerceve zaten goruyorsa ayar hicbir sey EKLEMIYOR demektir. Olculen
// buyukluk bu FARK.
//
// ONEMLI: bu olcum, agda reklam engelleme varsa ANLAMSIZDIR - reklam
// script'leri yuklenmez, reklam cerceveleri bos kalir ve sonuc "ozellik ise
// yaramiyor" gibi gorunur. Bu tuzaga bir kez dusuldu ve yanlis sonuc
// dokumana kadar girdi. O yuzden olcum baslamadan ONCE engelleme sinaniyor
// ve varsa KOSUM REDDEDILIYOR. Sessizce gecersiz bir sayi uretmektense hic
// uretmemek dogru.

import { launchChrome, attachExtension, visit, closeTarget, evaluate, sleep }
  from './harness.mjs';

const SITES = [
  ['MDN canli ornek',  'https://developer.mozilla.org/en-US/docs/Web/CSS/animation'],
  ['YouTube',          'https://www.youtube.com/'],
  ['Google Haritalar', 'https://www.google.com/maps'],
  ['W3Schools',        'https://www.w3schools.com/html/html_iframe.asp'],
  ['Stack Overflow',   'https://stackoverflow.com/questions'],
  ['Reddit',           'https://www.reddit.com/'],
  ['Vikipedi',         'https://en.wikipedia.org/wiki/Main_Page'],
  ['Hurriyet',         'https://www.hurriyet.com.tr/'],
  ['CNN',              'https://www.cnn.com/'],
  ['Sozcu',            'https://www.sozcu.com.tr/']
];

/** Reklam script'i gercekten yuklenebiliyor mu? Yuklenemiyorsa olcum gecersiz. */
const AD_PROBE = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

const chrome = await launchChrome({ live: true, headless: true });
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
let cikis = 0;

try {
  await attachExtension(chrome.client);

  // ---------------------------------------------------------- on kontrol
  const kontrolSekmesi = await visit(chrome.client, 'https://example.com/', { settleMs: 2500 });
  const probe = await evaluate(chrome.client, kontrolSekmesi.sessionId, [
    `try {`,
    `  const r = await fetch(${JSON.stringify(AD_PROBE)}, { cache: 'no-store' });`,
    `  const t = await r.text();`,
    `  return { ok: r.ok, boyut: t.length, engelIzi: /blocked|nextdns|pi-hole|adguard/i.test(t) };`,
    `} catch (e) { return { hata: e.message }; }`
  ].join('\n'));
  await closeTarget(chrome.client, kontrolSekmesi.targetId);

  const engelli = Boolean(probe.hata) || probe.engelIzi || !(probe.boyut > 10000);
  if (engelli) {
    console.error([
      '',
      'OLCUM YAPILAMAZ: agda reklam engelleme var.',
      '',
      `  Sinama: ${AD_PROBE}`,
      `  Sonuc : ${JSON.stringify(probe)}`,
      '',
      'Reklam script-leri yuklenmedigi icin reklam cerceveleri bos kalir ve',
      'olcum "iframe izleme ise yaramiyor" gibi YANLIS bir sonuc uretir.',
      'Bu tuzaga bir kez dusuldu; o yuzden kosum burada duruyor.',
      '',
      'Yapilacak: ag/router duzeyindeki engellemeyi (NextDNS, Pi-hole, AdGuard',
      'DNS) gecici olarak kapatip tekrar calistirin. Tarayici tarafindan',
      'baypas denendi ve olmuyor - engelleyici DoH uclarini da kapatiyor.',
      ''
    ].join('\n'));
    cikis = 2;
  } else {
    console.log(`\nOn kontrol: reklam script-i yuklenebiliyor (${probe.boyut} bayt) - olcum GECERLI.\n`);
    console.log('site                 altCerceve  httpSrc  cerceveIci  USTTE-YOK(=kazanc)');
    console.log('-'.repeat(78));

    let toplam = 0;
    for (const [ad, url] of SITES) {
      try {
        const tab = await visit(chrome.client, url, { settleMs: 0 });
        await chrome.client.send('Page.enable', {}, tab.sessionId);
        await chrome.client.send('Emulation.setDeviceMetricsOverride',
          { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
        await sleep(10000);
        for (let i = 0; i < 3; i++) {
          await chrome.client.send('Runtime.evaluate',
            { expression: 'window.scrollBy(0,1200)' }, tab.sessionId).catch(() => {});
          await sleep(2000);
        }

        const tree = await chrome.client.send('Page.getFrameTree', {}, tab.sessionId);
        const frames = []; (function w(n) { frames.push(n.frame); (n.childFrames || []).forEach(w); })(tree.frameTree);

        const oku = async (frameId) => {
          const { executionContextId } = await chrome.client.send('Page.createIsolatedWorld',
            { frameId, worldName: 'srv' + frameId }, tab.sessionId);
          const r = await chrome.client.send('Runtime.evaluate', {
            expression: `JSON.stringify(performance.getEntriesByType('resource').map(e => e.name))`,
            contextId: executionContextId, returnByValue: true
          }, tab.sessionId);
          return JSON.parse(r.result.value || '[]').map(hostOf).filter(Boolean);
        };

        const ust = new Set(await oku(frames[0].id));
        const altlar = frames.slice(1);
        const httpSrc = altlar.filter(f => (f.url || '').startsWith('http')).length;
        const icerisi = new Set();
        for (const f of altlar) {
          try { (await oku(f.id)).forEach(h => icerisi.add(h)); } catch { /* cerceve gitti */ }
        }
        const kazanc = [...icerisi].filter(h => !ust.has(h));
        toplam += kazanc.length;

        let satir = `${ad.padEnd(20)} ${String(altlar.length).padStart(10)}  ${String(httpSrc).padStart(7)}  ${String(icerisi.size).padStart(10)}  ${String(kazanc.length).padStart(8)}`;
        if (kazanc.length) satir += `  ${kazanc.slice(0, 3).join(', ')}`;
        console.log(satir);
        await closeTarget(chrome.client, tab.targetId);
        await sleep(1200);
      } catch (err) {
        console.log(`${ad.padEnd(20)}  HATA: ${err.message.slice(0, 40)}`);
      }
    }

    console.log('-'.repeat(78));
    console.log(`TOPLAM ek host (ayarin gercek kazanci): ${toplam}`);
    console.log(toplam > 0
      ? '\nAyar olculebilir bir sey EKLIYOR - korunmali.'
      : '\nAyar hicbir sey eklemedi. Kaldirilmasi degerlendirilmeli.');
  }
} catch (err) {
  console.error('HATA:', err?.stack || err?.message || err);
  cikis = 1;
} finally {
  await chrome.close();
  process.exit(cikis);
}
