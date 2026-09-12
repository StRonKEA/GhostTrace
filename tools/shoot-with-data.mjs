// GhostTrace - DOLU tablolarla ekran goruntusu.
//
// Bos tablo, satir ici dugmeleri (Duzenle/Kaldir, kapsam rozeti, temizle)
// hic gostermiyor - yani en cok kusur bildirilen bolge bos ekranda
// GORUNMUYOR. Bu betik once kural ekleyip sonra cekiyor.
//
// Kullanim: node tools/shoot-with-data.mjs <cikti-dizini> [--theme=dark|light]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, evaluate, visit, closeTarget, sleep
} from '../test/e2e/harness.mjs';

const outDir = process.argv[2];
if (!outDir) {
  console.error('kullanim: node tools/shoot-with-data.mjs <cikti-dizini>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const temaArg = process.argv.find(a => a.startsWith('--theme='));
const TEMA = temaArg ? temaArg.split('=')[1] : null;

const KURALLAR = {
  'claude.ai': { domain: 'claude.ai', type: 'white', subdomains: false, keepMode: 'all' },
  'chatgpt.com': { domain: 'chatgpt.com', type: 'white', subdomains: true, keepMode: 'all' },
  'accounts.google.com': { domain: 'accounts.google.com', type: 'white', subdomains: false, keepMode: 'all' },
  'r10.net': { domain: 'r10.net', type: 'grey', subdomains: false, keepMode: 'session' },
  'ornek.com': {
    domain: 'ornek.com', type: 'white', subdomains: false,
    keepMode: 'custom', keepCookies: ['sid', 'token']
  }
};
for (const k of Object.values(KURALLAR)) k.addedAt = 1755000000000;

const chrome = await launchChrome({ live: true, headless: true });
let hata = null;

async function shoot(client, sessionId, ad) {
  const metrics = await client.send('Page.getLayoutMetrics', {}, sessionId);
  const { width, height } = metrics.cssContentSize || metrics.contentSize;
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height), scale: 1 },
    captureBeyondViewport: true
  }, sessionId);
  writeFileSync(join(outDir, `${ad}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${ad}.png`);
}

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  }, page.sessionId);
  await sleep(1000);

  await evaluate(chrome.client, page.sessionId,
    `await chrome.storage.local.set({ rules: ${JSON.stringify(KURALLAR)}, cleanDelay: 0 }); return true;`);
  if (TEMA) {
    await evaluate(chrome.client, page.sessionId,
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(TEMA)}); return 1;`);
  }

  // Kurallar sekmesini yeniden ciz
  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('[data-tab="rules-tab"]').click(); return 1;`);
  await sleep(1200);
  await shoot(chrome.client, page.sessionId, 'kurallar-dolu');

  // Site verileri sekmesi (gercek cerez yok ama kural durumu sutunu dolu)
  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('[data-tab="site-data-tab"]').click(); return 1;`);
  await sleep(1500);
  await shoot(chrome.client, page.sessionId, 'site-verileri');

  // --- YENI BOLUMLER: gercek gezinti + temizlik uret, sonra istatistige bak
  for (const url of ['https://github.com/', 'https://www.deepl.com/', 'https://1337x.to/']) {
    const tab = await visit(chrome.client, url, { settleMs: 3000 });
    await closeTarget(chrome.client, tab.targetId);
    await sleep(1200);
  }
  await sleep(4000);

  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('[data-tab="stats-tab"]').click(); return 1;`);
  await sleep(1500);
  await shoot(chrome.client, page.sessionId, 'istatistik-yeni');

  // 3. taraflar sekmesi
  await evaluate(chrome.client, page.sessionId, `
    const d = [...document.querySelectorAll('#topCleanedSection [data-insight]')]
      .find(x => x.getAttribute('data-insight') === 'thirdparty');
    if (d) d.click();
    return 1;
  `);
  await sleep(1500);
  await shoot(chrome.client, page.sessionId, 'istatistik-3taraf');

  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('[data-tab="rules-tab"]').click(); return 1;`);
  await sleep(1500);
  await shoot(chrome.client, page.sessionId, 'kurallar-yeni');
} catch (e) {
  hata = e;
} finally {
  await chrome.close();
}

if (hata) {
  console.error('\nHATA:', hata.message);
  process.exit(1);
}
console.log(`\ntamam -> ${outDir}`);
