// GhostTrace - Chrome for Testing indirici
//
// Kullanim: npm run e2e:setup
//
// NEDEN AYRI BIR TARAYICI: Markali Google Chrome `--load-extension` bayragini
// DERLEME ZAMANINDA reddediyor ("--load-extension is not allowed in Google
// Chrome, ignoring." - extension_service.cc). Yani sistem Chrome'unda
// paketlenmemis eklenti hicbir bayrakla yuklenemez. Chrome for Testing,
// Google'in tam bu is icin yayinladigi MARKASIZ derleme; ayni surumu verir ve
// kisitlamayi tasimaz.
//
// Indirilen tarayici .cache/ altina gider ve .gitignore'dadir.

import { mkdirSync, existsSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache');
const VERSIONS_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

/** Bu makine icin Chrome for Testing platform anahtari. */
function platformKey() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'x64' ? 'win64' : 'win32';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return 'linux64';
  throw new Error(`Desteklenmeyen platform: ${platform}/${arch}`);
}

/** Indirilen tarayicinin calistirilabilir dosyasini bulur. */
export function findDownloadedChrome() {
  if (!existsSync(CACHE)) return null;
  const names = new Set(['chrome.exe', 'chrome', 'Google Chrome for Testing']);
  const stack = [CACHE];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (names.has(entry.name)) return full;
    }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? done() : fail(new Error(`${cmd} cikis kodu ${code}`)));
    child.on('error', fail);
  });
}

async function unzip(zipPath, target) {
  if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${target}' -Force`]);
  } else {
    await run('unzip', ['-q', '-o', zipPath, '-d', target]);
  }
}

async function main() {
  const existing = findDownloadedChrome();
  if (existing && !process.argv.includes('--force')) {
    console.log(`Zaten kurulu: ${existing}`);
    console.log('Yeniden indirmek icin: npm run e2e:setup -- --force');
    return;
  }

  console.log('Surum listesi aliniyor...');
  const res = await fetch(VERSIONS_URL);
  if (!res.ok) throw new Error(`Surum listesi alinamadi: HTTP ${res.status}`);
  const data = await res.json();

  const channel = data.channels?.Stable;
  if (!channel) throw new Error('Stable kanali bulunamadi');
  const key = platformKey();
  const entry = channel.downloads?.chrome?.find(d => d.platform === key);
  if (!entry) throw new Error(`Bu platform icin indirme yok: ${key}`);

  console.log(`Chrome for Testing ${channel.version} (${key})`);
  console.log(`Indiriliyor: ${entry.url}`);

  const zipRes = await fetch(entry.url);
  if (!zipRes.ok) throw new Error(`Indirme basarisiz: HTTP ${zipRes.status}`);
  const bytes = Buffer.from(await zipRes.arrayBuffer());

  mkdirSync(CACHE, { recursive: true });
  const zipPath = join(CACHE, 'chrome-for-testing.zip');
  writeFileSync(zipPath, bytes);
  console.log(`Indirildi: ${(bytes.length / 1024 / 1024).toFixed(1)} MB, aciliyor...`);

  await unzip(zipPath, CACHE);
  rmSync(zipPath, { force: true });

  const found = findDownloadedChrome();
  if (!found) throw new Error('Arsiv acildi ama calistirilabilir dosya bulunamadi');
  console.log(`Hazir: ${found} (${(statSync(found).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log('Artik `npm run test:e2e` calistirilabilir.');
}

// Yalnizca dogrudan calistirildiginda indir; harness bu dosyayi
// findDownloadedChrome icin import ediyor.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(err => {
    console.error('HATA:', err.message);
    process.exit(1);
  });
}
