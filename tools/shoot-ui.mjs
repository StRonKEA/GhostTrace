// GhostTrace - arayuz ekran goruntusu alici (tasarim calismasi icin).
//
// Testleri kosmaz; yalnizca options ve popup sayfalarinin her sekmesini
// gercek tarayicida acip PNG olarak kaydeder. Tasarim degisikligini GOZLE
// degil OLCEREK karsilastirabilmek icin var.
//
// Kullanim: node tools/shoot-ui.mjs <cikti-dizini> [--theme=dark|light]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, evaluate, sleep
} from '../test/e2e/harness.mjs';

const outDir = process.argv[2];
const temaArg = process.argv.find(a => a.startsWith('--theme='));
const TEMA = temaArg ? temaArg.split('=')[1] : null;
if (!outDir) {
  console.error('kullanim: node tools/shoot-ui.mjs <cikti-dizini>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// Sekme dugmeleri options.html icindeki data-tab degerleri.
const TABS = ['rules-tab', 'site-data-tab', 'settings-tab', 'stats-tab', 'logs-tab'];

const chrome = await launchChrome({ live: true, headless: true });
let hata = null;

async function temaUygula(client, sessionId) {
  if (!TEMA) return;
  await evaluate(client, sessionId,
    `document.documentElement.setAttribute('data-theme', ${JSON.stringify(TEMA)}), 'ok'`);
  await sleep(150);
}

async function shoot(client, sessionId, ad, { fullPage = true } = {}) {
  const params = { format: 'png' };
  if (fullPage) {
    const metrics = await client.send('Page.getLayoutMetrics', {}, sessionId);
    const { width, height } = metrics.cssContentSize || metrics.contentSize;
    params.clip = { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const { data } = await client.send('Page.captureScreenshot', params, sessionId);
  const yol = join(outDir, `${ad}.png`);
  writeFileSync(yol, Buffer.from(data, 'base64'));
  const kb = Math.round(Buffer.from(data, 'base64').length / 1024);
  console.log(`  ${ad}.png (${kb} KB)`);
  return yol;
}

try {
  const { extensionId } = await attachExtension(chrome.client);
  console.log(`eklenti: ${extensionId}`);

  // --- OPTIONS: her sekme ---
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  }, page.sessionId);
  await sleep(1200);

  console.log('\noptions:');
  for (const tab of TABS) {
    const ok = await evaluate(chrome.client, page.sessionId, `
      (() => {
        const b = document.querySelector('[data-tab="${tab}"]');
        if (!b) return 'YOK';
        b.click();
        return 'ok';
      })()
    `);
    if (ok === 'YOK') { console.log(`  ${tab}: sekme dugmesi bulunamadi`); continue; }
    await sleep(900);
    await temaUygula(chrome.client, page.sessionId);
    await shoot(chrome.client, page.sessionId, `options-${tab}`);
  }

  // --- POPUP ---
  const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 400, height: 640, deviceScaleFactor: 1, mobile: false
  }, popup.sessionId);
  await sleep(1200);
  await temaUygula(chrome.client, popup.sessionId);
  console.log('\npopup:');
  await shoot(chrome.client, popup.sessionId, 'popup');
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
