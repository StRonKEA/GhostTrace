// SONDA: >=30 sn ALARM YOLU gercekten temizliyor mu? (kontrol listesi 3)
//
// `test:e2e` gecikmeyi yalnizca `cleanDelay: 0` ile olcuyor - o yol alarm
// KULLANMAZ, sekme kapanisinda dogrudan temizler. Alarm yolu bambaska:
// `chrome.alarms.create({when: +30sn})` kuruluyor, service worker bu arada
// oluyor ve alarm onu diriltmek zorunda. CONTEXT.md bunu "elle test edilmeli"
// diye isaretlemisti; MV3 alarmi hizlandirilamiyor ama BEKLENEBILIR.
//
// Iddia sirasi onemli: once "HENUZ silinmedi" (alarm gercekten bekliyor),
// sonra "silindi" (alarm gercekten atesledi). Yalnizca ikincisini olcmek,
// aninda silen bir kod yolunu da yesil gosterirdi.
//
// Periyodik supurme KAPATILIR: acikken silmeyi o yapabilir ve olculen sey
// alarm yolu olmaktan cikar.
import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { cerezler, tumSekmeleriKapat, okuyormusGibi } from './gercek.mjs';

const SITE = { url: 'https://github.com/', kok: 'github.com' };
const GECIKME_SN = 30;

const t0 = Date.now();
const not = (m) => console.log(`  ..[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}sn] ${m}`);

async function main() {
  const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
  const runner = createRunner();

  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');

    const ayarla = async (a) => {
      await evaluate(chrome.client, sayfa.sessionId, `
        await chrome.storage.local.set(${JSON.stringify(a)});
        await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
      await sleep(1200);
    };
    const alarmlar = () => evaluate(chrome.client, sw,
      'const a = await chrome.alarms.getAll(); return a.map(x => x.name).sort();');
    const purgeAlarmi = async () => (await alarmlar()).filter(n => n.startsWith('gt:purge:'));

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`ALARM YOLU (cleanDelay=${GECIKME_SN}sn) - kontrol listesi 3\n`);

    await ayarla({
      rules: {}, enabled: true, cleanDelay: GECIKME_SN,
      cleanCookies: true, cleanHistory: true, cleanLocalStorage: true,
      // Supurme silerse olculen sey alarm yolu olmaz.
      periodicCleanEnabled: false,
      logLevel: 'info'
    });

    // --- TOHUM -------------------------------------------------------------
    not(`${SITE.kok} geziliyor`);
    const t = await visit(chrome.client, SITE.url, { settleMs: 4000 });
    await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
    await sleep(1500);
    const once = await cerezler(chrome.client, sw, SITE.kok);
    not(`cerez: ${once.length}`);

    await runner.test('ON KOSUL site cerez birakti', () => {
      assertOk(once.length > 0, `cerez yok - olcum yapilamaz (${once.length})`);
    });

    // --- SEKME KAPANIR: alarm kurulmali, veri DURMALI ----------------------
    const kapanis = Date.now();
    await tumSekmeleriKapat(chrome.client, SITE.kok);
    await sleep(3000);

    const alarmVar = await purgeAlarmi();
    const hemenSonra = await cerezler(chrome.client, sw, SITE.kok);
    not(`kapanis +3sn -> alarm: ${JSON.stringify(alarmVar)} | cerez: ${hemenSonra.length}`);

    // TEK alarm beklenmez: sitenin 3. taraflari (githubassets.com, ctfassets.net)
    // da yetim olarak siraya girer ve her biri kendi alarmini alir.
    const tumAlarm = await alarmlar();
    await runner.test('sekme kapaninca SITENIN purge alarmi kurulur', () => {
      assertOk(alarmVar.includes(`gt:purge:${SITE.kok}`),
        `${SITE.kok} alarmi yok: ${JSON.stringify(tumAlarm)}`);
    });
    await runner.test('gecikme icinde veri HENUZ silinmez', () => {
      assertEqual(hemenSonra.length, once.length,
        `alarm beklemeden silinmis: ${once.length} -> ${hemenSonra.length}`);
    });

    // --- YARI YOL: hala durmali -------------------------------------------
    await sleep(12000);
    const yariYol = await cerezler(chrome.client, sw, SITE.kok);
    not(`kapanis +15sn -> cerez: ${yariYol.length}`);
    await runner.test('15. saniyede veri HALA duruyor', () => {
      assertEqual(yariYol.length, once.length,
        `erken silindi: ${once.length} -> ${yariYol.length}`);
    });

    // --- ALARM ATESLENIR ---------------------------------------------------
    not('alarm bekleniyor (azami 120sn)...');
    let sonra = yariYol;
    let atesSn = null;
    const sinir = Date.now() + 120000;
    while (Date.now() < sinir) {
      await sleep(5000);
      sonra = await cerezler(chrome.client, sw, SITE.kok);
      if (sonra.length === 0) { atesSn = (Date.now() - kapanis) / 1000; break; }
    }
    not(atesSn ? `alarm atesledi: kapanistan ${atesSn.toFixed(1)}sn sonra`
      : `SURE DOLDU - cerez hala ${sonra.length}`);

    await runner.test('ALARM ATESLEDI ve veri gitti', () => {
      assertEqual(sonra.length, 0, `alarm yolu temizlemedi (kalan ${sonra.length})`);
    });
    await runner.test('atesleme >=30sn sonra oldu (aninda degil)', () => {
      assertOk(atesSn !== null && atesSn >= GECIKME_SN,
        `cok erken atesledi: ${atesSn}sn (>=${GECIKME_SN} bekleniyordu)`);
    });

    const kalanAlarm = await purgeAlarmi();
    await runner.test('atesleyen alarm KAYITTAN DUSER', () => {
      assertOk(!kalanAlarm.includes(`gt:purge:${SITE.kok}`),
        `alarm kaldi: ${JSON.stringify(kalanAlarm)}`);
    });

    const log = await evaluate(chrome.client, sw,
      "const l = await chrome.storage.session.get('gt_logs'); return (l.gt_logs || []).filter(x => x.domain === 'github.com').map(x => x.level + ': ' + x.message).slice(0, 5);");
    console.log(`\n  Ilgili log satirlari:\n${log.map(m => '    ' + m).join('\n') || '    (yok)'}`);
  } finally {
    await chrome.close();
  }

  process.exit(runner.summary() ? 0 : 1);
}

main().catch((e) => { console.error('\nSONDA PATLADI:', e); process.exit(1); });
