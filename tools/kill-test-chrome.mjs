// YALNIZCA test tarayicisini oldurur.
//
// `taskkill /IM chrome.exe /T` HER Chromium surecini oldurur - kullanicinin
// kendi tarayicisi (Helium) dahil. Bir kez yapildi ve kullanicinin tarayicisi
// kapandi. Bu betik yalnizca profili `gt-e2e-` ile baslayan gecici klasorde
// olan surecleri hedefler; testin actigi tarayicinin imzasi budur.
import { execFileSync } from 'node:child_process';

const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*gt-e2e-*' } |
  Select-Object -ExpandProperty ProcessId`;

let idler = [];
try {
  idler = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    .split(/\r?\n/).map(x => x.trim()).filter(Boolean);
} catch { /* hicbiri yoksa bos doner */ }

if (!idler.length) {
  console.log('test tarayicisi yok - dokunulmadi');
} else {
  for (const pid of idler) {
    try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); } catch { /* zaten olmus */ }
  }
  console.log(`${idler.length} test tarayicisi surec agaci kapatildi (Helium'a dokunulmadi)`);
}
