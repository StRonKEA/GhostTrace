// KADEME 1-2: Koruma kademeleri, kapsam kurali, cerez duzeyi koruma.
//
// Gercek sitelerde kosar. Kok/alt alan adi iliskisi olan gercek adresler
// secildi (github.com / gist.github.com) - kapsam kurali tam orada anlam
// kazaniyor ve uydurma bir alan adi bunu ayni sadakatle temsil edemiyor.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import {
  SITES, makeMsg, makeEval, cookieCountFor, cookieHosts,
  setTestCookie, resetAll, applySettings, alarmNames
} from './features-common.mjs';

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

try {
  const { extensionId } = await attachExtension(chrome.client);
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  const msg = makeMsg(chrome, page);
  const run = makeEval(chrome, page);

  const ziyaret = async (site, settleMs = 6000) => {
    const tab = await visit(chrome.client, site.url, { settleMs: 0 });
    await chrome.client.send('Page.enable', {}, tab.sessionId).catch(() => {});
    await sleep(settleMs);
    return tab;
  };

  console.log(`\nKADEME 1-2: koruma kademeleri ve kapsam (eklenti ${extensionId})\n`);
  await applySettings(msg, run, { enabled: true, cleanDelay: 0, trackThirdParty: true, logLevel: 'info' });

  // ============================================================ KADEME 1
  console.log('--- KADEME 1: koruma kademeleri ---');

  await runner.test('1.1 BEYAZ LISTE: sekme kapanisinda VE toplu temizlikte korunur', async () => {
    await resetAll(msg, run);
    // Kural ONCE yazilir: aksi halde sekme kapanisi (cleanDelay 0) veriyi
    // daha biz olcmeden siliyordu - ilk kurguda test kendi kendini bozuyordu.
    await msg({ action: 'SET_RULE', domain: 'github.com', type: 'white', options: { subdomains: true } });

    const tab = await ziyaret(SITES.githubKok);
    assertOk(await cookieCountFor(run, 'github.com') > 0, 'gercek site cerez birakmali');
    await closeTarget(chrome.client, tab.targetId);
    await sleep(3000);
    assertOk(await cookieCountFor(run, 'github.com') > 0, 'sekme kapanisinda korunmali');

    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(2000);
    assertOk(await cookieCountFor(run, 'github.com') > 0, 'toplu temizlikte de korunmali');
  });

  await runner.test('1.2 GRI LISTE: oturum boyunca korunur', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'stackoverflow.com');
    await msg({ action: 'SET_RULE', domain: 'stackoverflow.com', type: 'grey', options: { subdomains: true } });

    const sonuc = await msg({ action: 'PURGE_DOMAIN', domain: 'stackoverflow.com' });
    assertOk(sonuc.protected === true, `gri liste korumali sayilmali: ${JSON.stringify(sonuc)}`);
    assertOk(await cookieCountFor(run, 'stackoverflow.com') > 0, 'gri liste verisi durmali');
  });

  await runner.test('1.3 GECICI IZIN: sure dolmadan korur', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'bbc.com');
    await msg({
      action: 'SET_RULE', domain: 'bbc.com', type: 'temp',
      options: { subdomains: true, durationMinutes: 60, expiresAt: Date.now() + 3600000 }
    });
    const sonuc = await msg({ action: 'PURGE_DOMAIN', domain: 'bbc.com' });
    assertOk(sonuc.protected === true, 'aktif gecici izin korumali olmali');
    assertOk(await cookieCountFor(run, 'bbc.com') > 0, 'veri durmali');
  });

  await runner.test('1.4 GECICI IZIN icin snooze ALARMI kurulur', async () => {
    const alarms = await alarmNames(run);
    assertOk(alarms.includes('gt:snooze:bbc.com'),
      `snooze alarmi kurulmali; alarmlar: ${alarms.join(', ')}`);
  });

  await runner.test('1.5 SURESI DOLMUS gecici izin KORUMAZ', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'bbc.com');
    // Suresi gecmis kurali dogrudan depoya yaz: setDomainRule gecmis tarihi
    // kabul eder ama alarmi kurmaz - burada olculen matchDomainRule kararı.
    await run(`
      const s = await chrome.storage.local.get('rules');
      const rules = s.rules || {};
      rules['bbc.com'] = { domain:'bbc.com', type:'temp', subdomains:true,
        expiresAt: Date.now() - 60000, durationMinutes: 15, keepMode:'all', keepCookies:[],
        addedAt: Date.now() - 120000, updatedAt: Date.now() - 120000 };
      await chrome.storage.local.set({ rules });
      return true;
    `);
    const sonuc = await msg({ action: 'PURGE_DOMAIN', domain: 'bbc.com' });
    assertOk(sonuc.protected !== true, 'suresi dolmus izin korumamali');
    assertEqual(await cookieCountFor(run, 'bbc.com'), 0, 'veri silinmeli');
  });

  await runner.test('1.6 VARSAYILAN: sekme kapaninca temizlenir', async () => {
    await resetAll(msg, run);
    const tab = await ziyaret(SITES.soKok);
    assertOk(await cookieCountFor(run, 'stackoverflow.com') > 0, 'once cerez olusmali');
    await closeTarget(chrome.client, tab.targetId);

    let kalan = -1;
    for (let i = 0; i < 30 && kalan !== 0; i++) {
      await sleep(700);
      kalan = await cookieCountFor(run, 'stackoverflow.com');
    }
    assertEqual(kalan, 0, 'sekme kapaninca temizlenmeliydi');
  });

  // ------------------------------------------------------ kapsam kurali
  console.log('--- KADEME 1: kapsam kurali (gercek alt alan adlari) ---');

  await runner.test('1.7 KOK kural TUM alt alan adlarini kapsar', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'github.com');
    await setTestCookie(run, 'gist.github.com');
    await msg({ action: 'SET_RULE', domain: 'github.com', type: 'white', options: { subdomains: true } });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);

    assertOk(await cookieCountFor(run, 'github.com') >= 2,
      'kok ve alt alan adi birlikte korunmali');
  });

  await runner.test('1.8 KOK kural + kapsam KAPALI: alt alan adi korunmaz', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'github.com');
    await setTestCookie(run, 'gist.github.com');
    await msg({ action: 'SET_RULE', domain: 'github.com', type: 'white', options: { subdomains: false } });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);

    const hosts = await cookieHosts(run);
    assertOk(hosts.includes('github.com'), 'kok korunmali');
    assertOk(!hosts.includes('gist.github.com'),
      `kapsam kapaliyken alt alan adi silinmeliydi; kalanlar: ${hosts.join(', ')}`);
  });

  await runner.test('1.9 ALT alan adi kurali: yalnizca KENDISI', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'github.com');
    await setTestCookie(run, 'gist.github.com');
    await msg({ action: 'SET_RULE', domain: 'gist.github.com', type: 'white', options: {} });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);

    const hosts = await cookieHosts(run);
    assertOk(hosts.includes('gist.github.com'), 'kural kendisi korunmali');
    assertOk(!hosts.includes('github.com'),
      `UST alan adi korunmamaliydi; kalanlar: ${hosts.join(', ')}`);
  });

  await runner.test('1.10 ALT alan adi kurali KARDESI kapsamaz', async () => {
    await resetAll(msg, run);
    await setTestCookie(run, 'gist.github.com');
    await setTestCookie(run, 'docs.github.com');
    await msg({ action: 'SET_RULE', domain: 'gist.github.com', type: 'white', options: { subdomains: true } });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);

    const hosts = await cookieHosts(run);
    assertOk(hosts.includes('gist.github.com'), 'kural korunmali');
    assertOk(!hosts.includes('docs.github.com'),
      `kardes alan adi silinmeliydi; kalanlar: ${hosts.join(', ')}`);
  });

  await runner.test('1.11 AYNI ISIMLI cerez: alt alan adini silmek USTU goturmez', async () => {
    // Gercek tarayicida bulunan hata: chrome.cookies.remove(url, name) o
    // URL'de gorunen TUM ayni isimli cerezleri siler; alt alan adinin
    // URL'sinde ust alan adinin cerezi de gorunur. Beyaz listedeki oturum
    // cerezi korumasiz bir alt alan adi yuzunden uçuyordu.
    await resetAll(msg, run);
    await setTestCookie(run, 'github.com', 'sessionid');
    await setTestCookie(run, 'gist.github.com', 'sessionid');
    await msg({ action: 'SET_RULE', domain: 'github.com', type: 'white', options: { subdomains: false } });

    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(2000);

    const hosts = await cookieHosts(run);
    assertOk(hosts.includes('github.com'),
      `beyaz listedeki UST alan adinin cerezi korunmaliydi; kalanlar: ${hosts.join(', ')}`);
    assertOk(!hosts.includes('gist.github.com'),
      `korumasiz ALT alan adi cerezi silinmeliydi; kalanlar: ${hosts.join(', ')}`);
  });

  // ============================================================ KADEME 2
  console.log('--- KADEME 2: cerez duzeyi koruma (keepMode) ---');

  /** Beyaz listeli host'a uc tur cerez koyar: oturum, izleyici, sıradan. */
  async function ucCerez(host) {
    await resetAll(msg, run);
    await setTestCookie(run, host, 'sessionid');   // oturum gorunumlu
    await setTestCookie(run, host, '_ga');         // izleyici gorunumlu
    await setTestCookie(run, host, 'theme');       // siradan
  }
  const kalanAdlar = (host) => run(`
    const all = await chrome.cookies.getAll({});
    return all.filter(c => c.domain.replace(/^\\./,'') === ${JSON.stringify(host)})
      .map(c => c.name).sort();
  `);

  await runner.test('2.1 keepMode ALL: butun cerezler kalir', async () => {
    await ucCerez('bbc.com');
    await msg({ action: 'SET_RULE', domain: 'bbc.com', type: 'white', options: { keepMode: 'all' } });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);
    assertEqual(await kalanAdlar('bbc.com'), ['_ga', 'sessionid', 'theme'], 'hepsi kalmali');
  });

  await runner.test('2.2 keepMode SESSION: yalnizca oturum cerezi kalir', async () => {
    await ucCerez('bbc.com');
    await msg({ action: 'SET_RULE', domain: 'bbc.com', type: 'white', options: { keepMode: 'session' } });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);
    assertEqual(await kalanAdlar('bbc.com'), ['sessionid'],
      'izleyici ve siradan cerez gitmeli, oturum kalmali');
  });

  await runner.test('2.3 keepMode CUSTOM: yalnizca kalip eslesenler kalir', async () => {
    await ucCerez('bbc.com');
    await msg({
      action: 'SET_RULE', domain: 'bbc.com', type: 'white',
      options: { keepMode: 'custom', keepCookies: ['sess*', 'theme'] }
    });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);
    assertEqual(await kalanAdlar('bbc.com'), ['sessionid', 'theme'], 'yalnizca kalip eslesenler');
  });

  await runner.test('2.4 KALDIRILAN tek-cerez eylemi gercekten yok', async () => {
    // DELETE_SPECIFIC_COOKIE v2.7.0'da BILINCLI olarak kaldirildi
    // (bkz. lib/messaging.js): hicbir arayuz cagirmiyordu ve tek atimlik
    // silme, site cerezi yeniden yazinca geri geldigi icin kullaniciya
    // "sildim" sandiran bir dugmeydi. Bu test kaldirmanin kalici oldugunu
    // dogrular; eski test hala eylemi cagiriyordu ve UNKNOWN_ACTION aliyordu.
    const sonuc = await msg({ action: 'DELETE_SPECIFIC_COOKIE', cookie: { name: 'x' } });
    assertEqual(sonuc?.error, 'UNKNOWN_ACTION',
      'kaldirilan eylem sessizce geri gelmis');
  });

  await runner.test('2.5 Kalkani kaldirmak TEK cerezi korumasiz birakir', async () => {
    // Kaldirilan dugmenin yerini alan GERCEK yol: cerez modalinde kalkani
    // kaldirip kaydetmek. Cerez korumasiz kalir ve ilk temizlikte gider -
    // kalici, cunku koruma listesi kalicidir.
    await ucCerez('bbc.com');
    await msg({
      action: 'SET_RULE', domain: 'bbc.com', type: 'white',
      options: { keepMode: 'custom', keepCookies: ['sessionid', 'theme'] }
    });
    await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
    await sleep(1800);
    assertEqual(await kalanAdlar('bbc.com'), ['sessionid', 'theme'],
      'kalkani kaldirilan cerez gitmeliydi, otekiler kalmaliydi');
  });

} catch (err) {
  console.error('\nKURULUM HATASI:', err?.stack || err?.message || err);
  setupError = err;
} finally {
  const ok = runner.summary() && !setupError;
  await chrome.close();
  process.exit(ok ? 0 : 1);
}
