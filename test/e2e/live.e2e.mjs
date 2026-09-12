// GhostTrace E2E - GERCEK sitelerde canli dogrulama.
//
// NEDEN AYRI BIR DOSYA: Bu test INTERNETE CIKAR. Diger e2e dosyalari
// --host-resolver-rules ile tamamen yerelde kalir ve tekrarlanabilir; bu
// dosya gercek reklam agları, gercek CDN'ler ve gercek iframe agaclariyla
// calisir. Kazanci buyuk (uydurma bir test sitesi bunlari taklit edemez),
// bedeli belirsizlik: siteler degisir, reklamlar her yuklemede farklidir.
//
// Bu yuzden iddialar ikiye ayrilir:
//   * KESIN: temizlik davranisi (ne silindi, ne korundu) - deterministik.
//   * RAPOR: kac 3. taraf gorulduu - sayilar bilgi amaclidir, esik degildir.
// Reklam sayisina esik koymak, testi siteler degistigi gun kirmizi yapardi.
//
// GUVENLIK: yine tek kullanimlik profil; kullanicinin profiline dokunulmaz.
// Hicbir yere giris yapilmaz, yalnizca acilis sayfalari yuklenir.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, waitFor, createRunner, assertOk
} from './harness.mjs';

/** Kasitli olarak karisik: temiz, orta ve reklam yogun siteler. */
const SITES = [
  { url: 'https://en.wikipedia.org/wiki/Privacy', domain: 'wikipedia.org', beklenti: 'az 3. taraf' },
  { url: 'https://github.com/', domain: 'github.com', beklenti: 'orta' },
  { url: 'https://stackoverflow.com/', domain: 'stackoverflow.com', beklenti: 'orta' },
  { url: 'https://www.bbc.com/news', domain: 'bbc.com', beklenti: 'reklam yogun' },
  { url: 'https://www.cnn.com/', domain: 'cnn.com', beklenti: 'reklam yogun' },
  { url: 'https://www.hurriyet.com.tr/', domain: 'hurriyet.com.tr', beklenti: 'reklam yogun' }
];

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

async function msg(page, payload) {
  return evaluate(chrome.client, page.sessionId,
    `return await chrome.runtime.sendMessage(${JSON.stringify(payload)});`);
}

/** Tarayicidaki TUM cerezlerin kayit edilebilir alan adlari. */
async function cookieDomains(page) {
  return evaluate(chrome.client, page.sessionId, `
    const all = await chrome.cookies.getAll({});
    return [...new Set(all.map(c => c.domain.replace(/^\\./, '')))].sort();
  `);
}

async function cookieCount(page) {
  return evaluate(chrome.client, page.sessionId,
    `return (await chrome.cookies.getAll({})).length;`);
}

/** Gorulmus 3. taraf host listesi (ham oturum haritasindan). */
async function thirdParties(swSession) {
  const map = await evaluate(chrome.client, swSession,
    `const d = await chrome.storage.session.get('gt_thirdParty'); return d.gt_thirdParty || {};`);
  return Object.keys(map).sort();
}

async function clearThirdParties(swSession) {
  await evaluate(chrome.client, swSession,
    `await chrome.storage.session.remove('gt_thirdParty'); return true;`);
}

/** Bir siteyi acar, yuklenmesini ve gozlemcinin bosaltmasini bekler. */
async function open(url, { settleMs = 9000 } = {}) {
  const tab = await visit(chrome.client, url, { settleMs: 0 });
  await chrome.client.send('Page.enable', {}, tab.sessionId).catch(() => {});
  await sleep(settleMs);
  return tab;
}

/** Bir alan adina ait cerez var mi? (alt alan adlari dahil) */
const has = (domains, root) =>
  domains.some(d => d === root || d.endsWith(`.${root}`));

try {
  const { extensionId, sessionId: sw } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  console.log(`\nGhostTrace CANLI E2E - gercek siteler (eklenti ${extensionId})\n`);

  await evaluate(chrome.client, page.sessionId, `
    await chrome.storage.local.set({
      enabled: true, trackThirdParty: true, trackThirdPartyFrames: false,
      cleanDelay: 0, logLevel: 'info'
    });
    await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });
    return true;
  `);
  await msg(page, { action: 'RESET_RULES' });
  await sleep(800);

  // ================================================================
  // 1. TEK TEK: her site kendi basina acilir, izi olculur
  // ================================================================
  const perSite = [];
  await runner.test('her site TEK TEK acilir ve iz birakir', async () => {
    for (const site of SITES) {
      await clearThirdParties(sw);
      const before = await cookieCount(page);
      const tab = await open(site.url);
      const seen = await thirdParties(sw);
      const after = await cookieCount(page);
      await closeTarget(chrome.client, tab.targetId);
      // Otomatik temizlik acik (cleanDelay 0); bir sonraki siteye gecmeden once
      // bu sitenin temizlenmesini bekle ki olcumler birbirine karismasin.
      await sleep(2500);

      perSite.push({ site: site.domain, cerez: after - before, ucuncuTaraf: seen.length, ornek: seen.slice(0, 4) });
    }

    console.log('\n  --- TEK TEK ziyaret (iframe izleme KAPALI) ---');
    console.log('  site                 cerez   3.taraf   ornekler');
    for (const r of perSite) {
      console.log(`  ${r.site.padEnd(20)} ${String(r.cerez).padStart(5)}   ${String(r.ucuncuTaraf).padStart(7)}   ${r.ornek.join(', ')}`);
    }

    const toplam3P = perSite.reduce((s, r) => s + r.ucuncuTaraf, 0);
    assertOk(toplam3P > 0,
      'gercek sitelerde hic 3. taraf gorulmediyse gozlemci calismiyor demektir');
  });

  // ================================================================
  // 2. HEPSI BIRDEN acik: temizlik dogru siteyi hedefliyor mu?
  // ================================================================
  const openTabs = [];
  await runner.test('ALTI site AYNI ANDA acik tutulabiliyor', async () => {
    await clearThirdParties(sw);
    await msg(page, { action: 'RESET_RULES' });
    for (const site of SITES) openTabs.push(await open(site.url, { settleMs: 4000 }));
    await sleep(6000);

    const domains = await cookieDomains(page);
    const gorulen = SITES.filter(s => has(domains, s.domain)).map(s => s.domain);
    console.log(`\n  --- HEPSI ACIK ---`);
    console.log(`  cerez birakan site: ${gorulen.length}/${SITES.length} (${gorulen.join(', ')})`);
    console.log(`  toplam cerez      : ${await cookieCount(page)}`);
    console.log(`  gorulen 3. taraf  : ${(await thirdParties(sw)).length}`);

    assertOk(gorulen.length >= 3,
      `en az uc site cerez birakmali; birakan: ${gorulen.join(', ') || '(hicbiri)'}`);
  });

  // ================================================================
  // 3. BEYAZ LISTE gercek sitede: biri korunur, digerleri gider
  // ================================================================
  await runner.test('beyaz listedeki gercek site toplu temizlikten SAG cikar', async () => {
    const korunan = SITES.find(s => s.domain === 'github.com');
    const silinen = SITES.filter(s => s.domain !== korunan.domain);

    await msg(page, {
      action: 'SET_RULE', domain: korunan.domain, type: 'white', options: { subdomains: true }
    });
    await sleep(500);

    const oncesi = await cookieDomains(page);
    // Once sekmeler kapatilir. Ilk kurgu sekmeler ACIKKEN temizliyordu ve
    // bbc.com sag kaliyordu; olctuk: silme calisiyor, CANLI SAYFA cerezi
    // hemen yeniden yaziyor. Yani hatali olan urun degil testti. Eklentinin
    // gercek akisi zaten "sekme kapaninca temizle".
    for (const tab of openTabs) await closeTarget(chrome.client, tab.targetId);
    openTabs.length = 0;
    await sleep(3000);
    assertOk(has(oncesi, korunan.domain),
      `${korunan.domain} temizlik oncesi cerez birakmis olmali`);

    await msg(page, { action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(2500);

    const sonrasi = await cookieDomains(page);
    console.log(`\n  --- TOPLU TEMIZLIK ---`);
    console.log(`  once : ${oncesi.length} alan adi`);
    console.log(`  sonra: ${sonrasi.length} alan adi -> ${sonrasi.slice(0, 8).join(', ')}`);

    assertOk(has(sonrasi, korunan.domain),
      `beyaz listedeki ${korunan.domain} korunmaliydi; kalanlar: ${sonrasi.join(', ')}`);

    const sagKalanlar = silinen.filter(s => has(sonrasi, s.domain)).map(s => s.domain);
    assertOk(sagKalanlar.length === 0,
      `beyaz listede olmayan siteler silinmeliydi; sag kalan: ${sagKalanlar.join(', ')}`);
  });

  await runner.test('sekme ACIKKEN temizlik: canli sayfa cerezi yeniden yazabilir', async () => {
    // Bu bir HATA DEGIL, olculmus bir gercek: acik bir sayfa temizlikten
    // saniyeler sonra kendi cerezlerini yeniden kurabiliyor. Kullanicinin
    // "Tumunu Temizle"den sonra hala cerez gormesinin acikamasi bu.
    // Iddia degil GOZLEM olarak raporlaniyor - siteye gore degisir.
    const tab = await open('https://www.bbc.com/news', { settleMs: 8000 });
    const once = (await cookieDomains(page)).filter(d => d.includes('bbc')).length;
    await msg(page, { action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(3000);
    const acikken = (await cookieDomains(page)).filter(d => d.includes('bbc')).length;
    await closeTarget(chrome.client, tab.targetId);
    await sleep(3500);
    const kapaninca = (await cookieDomains(page)).filter(d => d.includes('bbc')).length;

    console.log(`
  --- canli sayfa etkisi (bbc.com) ---`);
    console.log(`  temizlikten once      : ${once} alan adi`);
    console.log(`  sekme ACIKKEN sonra   : ${acikken}`);
    console.log(`  sekme KAPANINCA sonra : ${kapaninca}`);

    assertOk(kapaninca === 0,
      `sekme kapandiktan sonra hicbir cerez kalmamali; kalan: ${kapaninca}`);
  });

  // ================================================================
  // 4. iframe izleme: GERCEK reklam agları uzerinde ACIK vs KAPALI
  // ================================================================
  await runner.test('iframe izleme gercek reklam sitelerinde EK 3. taraf yakalar', async () => {
    const hedefler = SITES.filter(s => s.beklenti === 'reklam yogun');

    async function olc(framesAcik) {
      await evaluate(chrome.client, page.sessionId, `
        await chrome.storage.local.set({ trackThirdPartyFrames: ${framesAcik} });
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });
        return true;
      `);
      await waitFor(`kayit allFrames=${framesAcik}`, async () => {
        const s = await evaluate(chrome.client, page.sessionId,
          `const r = await chrome.scripting.getRegisteredContentScripts({ids:['ghosttrace-trace-observer']}); return r[0]?.allFrames ?? null;`);
        return s === framesAcik;
      }, { timeoutMs: 15000 });

      const sonuc = {};
      for (const site of hedefler) {
        await clearThirdParties(sw);
        // Kayit degisiminin renderer'a ulasmasi bir an aliyor; ilk yukleme
        // eski kapsamla baslayabilir. Yeniden yukleyip olcuyoruz.
        const tab = await open(site.url, { settleMs: 5000 });
        await chrome.client.send('Page.reload', { ignoreCache: true }, tab.sessionId).catch(() => {});
        await sleep(9000);
        sonuc[site.domain] = (await thirdParties(sw)).length;
        await closeTarget(chrome.client, tab.targetId);
        await sleep(2000);
      }
      return sonuc;
    }

    const kapali = await olc(false);
    const acik = await olc(true);

    console.log('\n  --- iframe izleme: KAPALI vs ACIK (gorulen 3. taraf sayisi) ---');
    console.log('  site                 kapali    acik    fark');
    let artanVar = false;
    for (const site of hedefler) {
      const k = kapali[site.domain] ?? 0;
      const a = acik[site.domain] ?? 0;
      const fark = a - k;
      if (fark > 0) artanVar = true;
      console.log(`  ${site.domain.padEnd(20)} ${String(k).padStart(6)}  ${String(a).padStart(6)}  ${fark > 0 ? '+' : ''}${fark}`);
    }
    console.log('\n  NOT: bu sayilar RAPORDUR, esik degildir - reklam agları her');
    console.log('       yuklemede farkli kaynak cektigi icin dalgalanir.');
    console.log('  DIKKAT: agda DNS duzeyinde reklam engelleme (NextDNS, Pi-hole,');
    console.log('       AdGuard DNS) varsa reklam cerceveleri HIC dolmaz ve bu');
    console.log('       sayilar "ozellik ise yaramiyor" gibi gorunur. Bu tuzaga');
    console.log('       bir kez dusuldu; sonuc cikarmadan once cozumleyiciyi');
    console.log('       kontrol edin (ornek: securepubads.g.doubleclick.net).');

    // Kesin olan tek sey: ayar acikken de gozlemci CALISMALI.
    const toplamAcik = Object.values(acik).reduce((s, n) => s + n, 0);
    assertOk(toplamAcik > 0, 'iframe izleme acikken hic 3. taraf gorulmedi');
    if (!artanVar) {
      console.log('  UYARI: bu kosumda iframe izleme ek host getirmedi.');
    }
  });

} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  const ok = runner.summary() && !setupError;
  await chrome.close();
  process.exit(ok ? 0 : 1);
}
