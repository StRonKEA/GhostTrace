// GhostTrace - HIC bakilmayan arayuz yuzeyleri.
//
// Sekme ekran goruntuleri kipleri, acilir menuleri, bildirim seridini ve
// acilmis aciklama panelini GOSTERMEZ. Bir tester bunlari da gormeli.
//
// Kullanim: node tools/shoot-surfaces.mjs <cikti> [--theme=dark|light]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  launchChrome, attachExtension, openExtensionPage, evaluate, sleep
} from '../test/e2e/harness.mjs';

const outDir = process.argv[2];
if (!outDir) { console.error('kullanim: node tools/shoot-surfaces.mjs <cikti>'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const temaArg = process.argv.find(a => a.startsWith('--theme='));
const TEMA = temaArg ? temaArg.split('=')[1] : null;

const KURALLAR = {
  'claude.ai': { domain: 'claude.ai', type: 'white', subdomains: false, keepMode: 'all', addedAt: 1755000000000 },
  'ornek.com': { domain: 'ornek.com', type: 'white', subdomains: false, keepMode: 'custom', keepCookies: ['sid'], addedAt: 1755000000000 }
};

const chrome = await launchChrome({ live: true, headless: true });
let hata = null;

async function shoot(sessionId, ad) {
  const m = await chrome.client.send('Page.getLayoutMetrics', {}, sessionId);
  const { width, height } = m.cssContentSize || m.contentSize;
  const { data } = await chrome.client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.min(Math.ceil(height), 1400), scale: 1 },
    captureBeyondViewport: true
  }, sessionId);
  writeFileSync(join(outDir, `${ad}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${ad}.png`);
}

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  }, page.sessionId);
  await sleep(1000);

  const uygula = async (sid) => {
    if (!TEMA) return;
    await evaluate(chrome.client, sid,
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(TEMA)}); return 1;`);
    await sleep(120);
  };
  await uygula(page.sessionId);

  await evaluate(chrome.client, page.sessionId,
    `await chrome.storage.local.set({ rules: ${JSON.stringify(KURALLAR)} }); return 1;`);

  // --- 1) Ayarlar: aciklama paneli ACIK ---
  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('[data-tab="settings-tab"]').click(); return 1;`);
  await sleep(800);
  await evaluate(chrome.client, page.sessionId, `
    const b = document.querySelectorAll('#settings-tab .row__info');
    b[2].click(); b[6].click();
    window.scrollTo(0, 0);
    return 1;
  `);
  await sleep(300);
  await shoot(page.sessionId, 'ayarlar-aciklama-acik');

  // --- 2) Onay kipi ---
  await evaluate(chrome.client, page.sessionId,
    `document.getElementById('btnFactoryReset').click(); return 1;`);
  await sleep(500);
  await shoot(page.sessionId, 'kip-onay');
  await evaluate(chrome.client, page.sessionId,
    `document.getElementById('modalBtnCancel').click(); return 1;`);
  await sleep(300);

  // --- 3) Site denetim kipi (cerez modali) ---
  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('[data-tab="rules-tab"]').click(); return 1;`);
  await sleep(900);
  await evaluate(chrome.client, page.sessionId,
    `document.querySelector('.btn-edit-rule').click(); return 1;`);
  await sleep(1200);
  await shoot(page.sessionId, 'kip-site-denetim');

  // --- 4) Bildirim seridi (toast) ---
  await evaluate(chrome.client, page.sessionId,
    `document.getElementById('modalCloseBtn').click(); return 1;`);
  await sleep(300);
  await evaluate(chrome.client, page.sessionId, `
    const { showToast } = await import('./ui/toast.js');
    showToast('Toplam 12 çerez ve 4 geçmiş kaydı silindi (~3,2 KB). 3 site açık olduğu için atlandı.', 9000);
    return 1;
  `);
  await sleep(400);
  await shoot(page.sessionId, 'bildirim-seridi');

  // --- 5) Popup: acilir menu ACIK ---
  const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 400, height: 640, deviceScaleFactor: 1, mobile: false
  }, popup.sessionId);
  await sleep(1000);
  await uygula(popup.sessionId);
  await evaluate(chrome.client, popup.sessionId, `
    document.getElementById('actionsSection').classList.remove('hidden');
    document.getElementById('internalCard').classList.add('hidden');
    document.getElementById('domainCard').classList.remove('hidden');
    document.getElementById('currentDomain').textContent = 'forum.mobilism.org';
    document.getElementById('cookieCount').textContent = '7';
    document.getElementById('historyCount').textContent = '3';
    document.getElementById('downloadCount').textContent = '1';
    document.getElementById('whitelistMenu').classList.remove('hidden');
    return 1;
  `);
  await sleep(300);
  await shoot(popup.sessionId, 'popup-menu-acik');
} catch (e) {
  hata = e;
} finally {
  await chrome.close();
}

if (hata) { console.error('\nHATA:', hata.message); process.exit(1); }
console.log(`\ntamam -> ${outDir}`);
