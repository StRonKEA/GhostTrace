// GhostTrace - gercek tarayici kosum takimi (ortak altyapi).
//
// GUVENLIK: kullanicinin GERCEK profiline ASLA dokunulmaz. Bu eklenti veri
// SILIYOR; gercek profille calistirmak kullanicinin cerezlerini ve gecmisini
// yok etmek olurdu. Her kosum tek kullanimlik bir --user-data-dir kullanir.

import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, httpJson, attach, evaluate, sleep, waitFor } from './cdp.mjs';
import { findDownloadedChrome } from '../../tools/fetch-chrome.mjs';

export { evaluate, sleep, waitFor, attach };

/** Eklenti koku: test/e2e/ -> ../.. */
export const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Tarayici ikilisi. GT_CHROME ortam degiskeni her seyi ezer; yoksa bilinen
 * konumlar denenir. Bulunamazsa ACIK hata verilir - sessizce atlanan bir
 * tarayici testi, hic olmayan bir testtir.
 */
// Portable Helium BILEREK LISTEDE YOK. Bu depo bir Helium kurulumunun icinde
// yasiyor ve Helium kullanicinin ANA tarayicisi; test kosumunun onun yanina
// surec acmasi veya profiline yaklasmasi istenmiyor. Testler ayri bir
// Chrome/Chromium ister. Helium'da kosmak gerekirse GT_CHROME ile acikca
// belirtilmeli - kaza eseri secilmemeli.
//
// MARKALI GOOGLE CHROME CALISMAZ ve bu bir yapilandirma sorunu degil:
// `--load-extension` markali derlemelerde DERLEME ZAMANINDA reddediliyor.
// Chrome'un kendi logu birebir:
//   "--load-extension is not allowed in Google Chrome, ignoring."
// Hicbir bayrak bunu acmiyor (--enable-unsafe-extension-debugging ve
// --disable-features=DisableLoadExtensionCommandLineSwitch denendi).
// Bu yuzden listede yok: sessizce yanlis tarayiciyi secip "eklenti
// yuklenmedi" diye anlasilmaz bir hata vermektense hic denemiyoruz.
const CHROME_CANDIDATES = [
  process.env.GT_CHROME,
  findDownloadedChrome(),          // npm run e2e:setup ile inen markasiz derleme
  // Egik cizgi bilincli: existsSync Windows'ta da kabul eder, kacis derdi olmaz.
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

/**
 * Surec AGACINI oldurur (emniyet kemeri).
 *
 * Browser.close normalde yeter; ama tarayici asilirsa veya CDP baglantisi
 * kopmussa yetim surecler kalir. Windows'ta tek yol taskkill /T.
 */
function killTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise((done) => {
    const cmd = process.platform === 'win32'
      ? spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      : spawn('kill', ['-9', String(pid)], { stdio: 'ignore' });
    cmd.on('exit', () => done());
    cmd.on('error', () => done());
  });
}

/**
 * Gecici profili siler; Windows'ta dosya kilitleri gec birakildigi icin
 * birkac kez dener.
 *
 * Tek denemede sessizce vazgecmek her kosumda bir profil klasoru birakiyordu
 * (birkac yuz MB); temizlik "denendi" gorunup fiilen yapilmiyordu.
 */
async function removeProfile(dir) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!existsSync(dir)) return true;
    } catch { /* kilit henuz birakilmadi */ }
    await sleep(500);
  }
  // Sessiz kalmiyoruz: kalinti varsa kullanici bilsin.
  console.warn(`[e2e] Gecici profil silinemedi, elle temizlenmeli: ${dir}`);
  return false;
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Chrome/Chromium bulunamadi. GT_CHROME ortam degiskeniyle yolu verin.
Denenen konumlar:
  ${CHROME_CANDIDATES.join('\n  ')}`
  );
}

/** Chrome'u TEK KULLANIMLIK profil ve yuklu eklentiyle baslatir. */
/**
 * AGDAKI REKLAM ENGELLEMESI HAKKINDA (olculdu, cozulemedi)
 *
 * Test tarayicisi temiz profille acilsa da sistem DNS'ini kullanir. Ag
 * duzeyinde reklam engelleme varsa (NextDNS, Pi-hole, AdGuard DNS) reklam
 * script'leri hic yuklenmez, reklam cerceveleri bos `about:blank` kalir ve
 * olcum "iframe izleme ise yaramiyor" der. Bu tuzaga bir kez dusuldu ve
 * yanlis sonuc dokumana kadar girdi.
 *
 * Tarayici tarafindan BAYPAS DENENDI ve OLMADI: --dns-over-https-mode=secure
 * etkisiz kaldi; Node'dan dogrudan IP ile DoH (1.1.1.1, 8.8.8.8) zaman
 * asimina ugradi - engelleyici bypass yollarini da kapatiyor. Yani bu, kodla
 * cozulebilecek bir sey degil: olcum yapan kisinin AGINDA engelleme kapali
 * olmali.
 *
 * Kontrol:  curl -s https://securepubads.g.doubleclick.net/tag/js/gpt.js
 *           Gercek script yerine engel yaniti geliyorsa reklam olcumleri
 *           GECERSIZDIR.
 */

/**
 * Isletim sisteminden BOS bir port ister.
 *
 * Onceden port `9200 + rastgele(300)` ile KOR tahmin ediliyordu. Zincirli
 * kosumda (features-rules && features-purge && ...) onceki tarayici henuz
 * kapanmamissa ayni porta denk gelinebiliyor; o zaman ya DevTools portu hic
 * acilmiyor ya da /json/version ESKI tarayicidan cevap veriyor ve eklenti
 * bulunamiyor. Gozlenen sonuc: bir takim "0/0" raporlayip zinciri kesiyor.
 * Nadir ama gercek - bir kez olustu.
 *
 * listen(0) ile alinan port serbest birakilip hemen kullaniliyor; teorik bir
 * yaris payi kaliyor ama kor tahminden kat kat guvenli.
 */
function bosPortAl() {
  return new Promise((cozum, hata) => {
    const s = createTcpServer();
    s.unref();
    s.on('error', hata);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => cozum(port));
    });
  });
}

export async function launchChrome({ sitePort, headless = true, chromePath = null, live = false, profileDir: verilenProfil = null, keepProfile = false, secureOrigins = null, refreshExtension = null }) {
  const profileDir = verilenProfil || mkdtempSync(join(tmpdir(), 'gt-e2e-'));
  const debugPort = await bosPortAl();

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    // Chrome 136+ --load-extension'i uzaktan hata ayiklama acikken YOK SAYAR
    // (guvenlik kisiti). Bu bayrak olmadan eklenti sessizce yuklenmiyor ve
    // testler "service worker bulunamadi" diye patliyor.
    '--enable-unsafe-extension-debugging',
    // TUM alan adlari yerel sunucuya: disari hicbir istek cikmaz.
    //
    // CANLI KIPTE bu yonlendirme YOK: gercek siteler gercek DNS ister.
    // Ayrim acik olmali - hangi testin agi kullandigini gizlemek, bir gun
    // "neden disari istek gitti?" sorusuna cevap verememek demek.
    ...(live ? [] : [`--host-resolver-rules=MAP * 127.0.0.1:${sitePort}`]),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    // DisableLoadExtensionCommandLineSwitch: Chrome'un --load-extension'i
    // kapatan ozelligi; kapatilmadan eklenti sessizce yuklenmiyor.
    '--disable-features=OptimizationHints,Translate,DisableLoadExtensionCommandLineSwitch',
    '--no-service-autorun',
    // GUVENLI BAGLAM ZORLAMASI (yalnizca istenirse).
    //
    // Service worker GUVENLI BAGLAM ister. Yerel test siteleri
    // `http://a5.example` uzerinden servis ediliyor - localhost degil, TLS de
    // yok - ve `navigator.serviceWorker.register()` sessizce hic calismiyor.
    // Bu yuzden "cleanServiceWorkers cerezleri temizliyor mu?" sorusu
    // sorulamiyordu: kayit BASTAN olusmuyordu.
    //
    // Bu bayrak, sayilan kokenleri Chrome'a guvenli baglam saydiriyor. Ag
    // guvenligini gevsetmiyor - yalnizca bu tek kullanimlik test profilinde,
    // yalnizca ACIKCA sayilan kokenler icin gecerli.
    ...(secureOrigins?.length
      ? [`--unsafely-treat-insecure-origin-as-secure=${secureOrigins.join(',')}`]
      : []),
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new');

  const proc = spawn(chromePath || findChrome(), args, { stdio: 'ignore', detached: false });

  // DevTools portunun acilmasini bekle
  const version = await waitFor('devtools portu', async () => {
    try { return await httpJson(`http://127.0.0.1:${debugPort}/json/version`); }
    catch { return null; }
  }, { timeoutMs: 30000, intervalMs: 300 });

  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Target.setDiscoverTargets', { discover: true });

  // KALICI PROFILDE eklentiyi DISKTEN yeniden okut.
  //
  // OLCULEN TUZAK: profil bir kez kullanildiktan sonra Chrome, paketlenmemis
  // eklentinin profilde kayitli kopyasini calistiriyor; --load-extension ayni
  // yolu gostermesine ragmen diskteki DEGISIKLIKLER YANSIMIYOR.
  //
  // Sonucu agir: gizli pencere / sertlestirme / sag tik takimlari kalici
  // profille kosuyor, yani ESKI kodu test ediyorlar. Bu sessizce yesil verir.
  // Kanit: urun kodundaki bir log metni degistirildi, kosumda ESKI metin
  // gorundu; chrome.runtime.reload() sonrasi YENI metin geldi.
  //
  // Gecici profilde gerek yok (her kosum sifirdan yukluyor), o yuzden yalnizca
  // profil ACIKCA verildiginde yapiliyor.
  //
  // AMA YENI/BOS bir kalici profilde YAPILMAMALI: orada eklenti profile hic
  // kayitli degildir ve `chrome.runtime.reload()` komut satirindan yuklenen
  // eklentiyi TAMAMEN dusurur (olculdu: sonrasinda manifest.json bile
  // ERR_BLOCKED_BY_CLIENT doner). Hazirlik profilinde sorun cikmamasinin
  // sebebi eklentinin orada zaten kayitli olmasi.
  //
  // `refreshExtension: false` diyen cagirici bu adimi atlar - tarayiciyi
  // kapatip acan test tam olarak buna ihtiyac duyuyor.
  const yenilensin = refreshExtension === null ? Boolean(verilenProfil) : refreshExtension;
  if (yenilensin) {
    try {
      const { sessionId } = await attachExtension(client);
      await evaluate(client, sessionId, 'chrome.runtime.reload(); return 1;');
      // Yeniden yuklenme: eski service worker olur, yenisi ayaga kalkar.
      await new Promise(r => setTimeout(r, 2500));
    } catch {
      // Eklenti henuz yoksa (ilk kurulum) sorun degil; asil attachExtension
      // cagrisi zaten net bir hata verecek.
    }
  }

  return {
    client, proc, debugPort, profileDir,
    async close() {
      client.close();

      // Once NAZIKCE kapat: Browser.close tum alt surecleri de indirir.
      // proc.kill() YETMEZ - yalnizca ana sureci oldurur, Chrome'un renderer /
      // gpu / utility surecleri hayatta kalir. Bir kosum ~90 yetim surec
      // birakiyordu; birkac kosumdan sonra makine dolar.
      try {
        const browser = new CdpClient((await httpJson(
          `http://127.0.0.1:${debugPort}/json/version`)).webSocketDebuggerUrl);
        await browser.connect();
        await browser.send('Browser.close');
        browser.close();
      } catch { /* zaten kapanmis olabilir */ }

      await sleep(800);
      await killTree(proc.pid);
      await sleep(400);
      // keepProfile: gizli pencere testi profili yamalayip YENIDEN aciyor.
      if (!keepProfile) await removeProfile(profileDir);
    }
  };
}

/** Depodaki manifest surumu - dogru eklentiye baglandigimizin kaniti. */
const OWN_VERSION = JSON.parse(
  readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;

/**
 * GhostTrace'in service worker'ini bulur; ID'yi ve sessionId'yi doner.
 *
 * KIMLIK DOGRULAMASI SART: "ilk service_worker hedefi" almak yanlis eklentiye
 * baglaniyor. Tarayicinin kendi bilesen eklentilerinin de service worker'i
 * olabiliyor ve --disable-extensions-except onlari kapsamiyor. Helium'da
 * tesadufen GhostTrace ilk siradaydi, sistem Chrome'unda surum 1.0 olan baska
 * bir eklenti geldi ve testler "eklenti sayfasi acilmiyor" diye patladi -
 * gercek sebep tamamen baska bir eklentiye bakiyor olmakti.
 */
export async function attachExtension(client) {
  const seen = [];
  // Yanit vermeyen hedefler icin SAYAC (kara liste degil).
  //
  // Onceden TEK basarisiz denemede hedef kalici olarak eleniyordu. MV3
  // service worker'i o anda mesgul/uyaniyor olabilir: kendi eklentimiz ilk
  // problamada 3sn'de cevap veremeyince bir daha HIC denenmiyor ve 30
  // saniyelik dongu bosa donuyordu ("service worker bulunamadi"). Gercek
  // kosumda bir kez tam olarak bu oldu.
  //
  // Yabanci eklentiyi eleme amaci korunuyor: Chrome for Testing'in kendi
  // "Contextual Tasks" SW'si Runtime.evaluate'e hic yanit vermiyor, uc
  // problamadan sonra (~9sn) elenip butceyi yemesi engelleniyor.
  const STRIKE = 3;
  const strikes = new Map();
  const dead = { has: (id) => (strikes.get(id) || 0) >= STRIKE };

  const found = await waitFor('GhostTrace service worker', async () => {
    const { targetInfos } = await client.send('Target.getTargets');
    const candidates = targetInfos.filter(t =>
      t.type === 'service_worker' && t.url.startsWith('chrome-extension://')
      && !dead.has(t.targetId));

    for (const target of candidates) {
      try {
        const sessionId = await attach(client, target.targetId);
        // KISA zaman asimi SART: Chrome for Testing'in kendi "Contextual
        // Tasks" eklentisinin service worker'i Runtime.evaluate'e HIC yanit
        // vermiyor. Varsayilan 30 sn ile o tek hedef tum arama butcesini
        // yiyor ve GhostTrace listede hazir dururken "bulunamadi" aliniyordu.
        const version = await evaluate(client, sessionId,
          'return chrome.runtime.getManifest().version;', { timeoutMs: 3000 });
        if (version === OWN_VERSION) return { target, sessionId };
        seen.push(`${new URL(target.url).host}@${version}`);
      } catch {
        strikes.set(target.targetId, (strikes.get(target.targetId) || 0) + 1);
      }
    }
    return null;
  }, { timeoutMs: 30000 });

  if (seen.length) {
    console.log(`[e2e] Atlanan diger eklentiler: ${[...new Set(seen)].join(', ')}`);
  }
  const extensionId = new URL(found.target.url).host;
  return { extensionId, sessionId: found.sessionId, target: found.target };
}

/** Bir eklenti sayfasi acar (options gibi) ve sessionId doner. */
export async function openExtensionPage(client, extensionId, path) {
  const { targetId } = await client.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/${path}`
  });
  const sessionId = await attach(client, targetId);
  await client.send('Runtime.enable', {}, sessionId);
  await waitFor('eklenti sayfasi hazir', async () => {
    try { return await evaluate(client, sessionId, 'return typeof chrome?.runtime?.sendMessage === "function";'); }
    catch { return false; }
  });
  return { targetId, sessionId };
}

/** Normal bir web sayfasi acar ve yuklenmesini bekler. */
export async function visit(client, url, { settleMs = 900 } = {}) {
  const { targetId } = await client.send('Target.createTarget', { url });
  const sessionId = await attach(client, targetId);
  await client.send('Runtime.enable', {}, sessionId);
  await sleep(settleMs);
  return { targetId, sessionId };
}

/**
 * Sekmeyi kapatir ve GERCEKTEN kapandigini dogrular; eski hali hatayi
 * sessizce yutuyor, acik kalan sekme urun hatasi gibi gorunuyordu.
 * @returns {Promise<boolean>} sekme kapandiysa true
 */
export async function closeTarget(client, targetId) {
  for (let deneme = 0; deneme < 3; deneme++) {
    try { await client.send('Target.closeTarget', { targetId }); } catch { /* zaten kapali olabilir */ }
    try {
      const { targetInfos } = await client.send('Target.getTargets', {});
      if (!targetInfos.some(t => t.targetId === targetId)) return true;
    } catch { return true; }   // baglanti yoksa dogrulanamaz, kapandi say
    await sleep(300);
  }
  return false;
}

// --------------------------------------------------------------------------
// Kucuk test kosucusu
// --------------------------------------------------------------------------

export function createRunner() {
  const results = [];
  return {
    results,
    async test(name, fn) {
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  PASS  ${name}`);
      } catch (err) {
        results.push({ name, ok: false, error: err.message });
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
      }
    },
    summary() {
      const failed = results.filter(r => !r.ok);
      console.log(`\n${results.length - failed.length}/${results.length} gecti`);
      // SIFIR test BASARI DEGILDIR. Kurulum patladiginda (tarayici bulunamadi,
      // eklenti yuklenmedi, port kapali) hicbir test kosmaz; "0/0 gecti" deyip
      // 0 ile cikmak sessiz bir yesil uretir - tam olarak kacinilan sey.
      if (results.length === 0) {
        console.log('HIC TEST KOSMADI - kurulum basarisiz sayiliyor.');
        return false;
      }
      return failed.length === 0;
    }
  };
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n        beklenen: ${e}\n        gelen   : ${a}`);
}

export function assertOk(value, message) {
  if (!value) throw new Error(message);
}
