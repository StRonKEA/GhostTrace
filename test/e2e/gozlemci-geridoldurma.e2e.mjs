// SONDA: 3. taraf gozlemcisi ZATEN ACIK sekmelere geri doldurulup
// durdurulabiliyor mu? (kontrol listesi 5)
//
// `registerContentScripts` yalnizca SONRAKI yuklemeleri etkiler. Ayari acik
// sekmeler varken acmak/kapatmak iki AYRI kod yoluna dayanir ve ikisi de
// yalnizca gercek tarayicida gorulur:
//   ACARKEN  -> backfillObserverIntoOpenTabs (executeScript ile enjeksiyon)
//   KAPARKEN -> stopObserverInOpenTabs (kaydi silmek calisan script'i durdurmaz)
//
// Ikinci yon daha onemli: kayit silinip enjekte script yasamaya devam ederse
// "kapali" derken veri toplamaya devam eder - sessiz ve vaadin tam tersi.
//
// SEKME HIC YENILENMEZ. Yenileme yeni kayit yolunu kullanirdi ve olculmek
// istenen sey tam olarak yenilemesiz durum.
import {
  launchChrome, attachExtension, openExtensionPage, visit,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';
import { okuyormusGibi } from './gercek.mjs';

// Ust cerceveden bol 3. taraf yukleyen, engellemeye bagimli OLMAYAN site:
// CDN ve font hostlari reklam engelleyicilerden etkilenmez.
const SITE = { url: 'https://www.w3schools.com/', kok: 'w3schools.com' };

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
      await sleep(2500);
    };
    const harita = () => evaluate(chrome.client, sw,
      "return Object.keys((await chrome.storage.session.get('gt_thirdParty')).gt_thirdParty || {}).sort();");
    const haritayiSil = () => evaluate(chrome.client, sw,
      "await chrome.storage.session.remove('gt_thirdParty'); return 1;");
    const kayit = () => evaluate(chrome.client, sw,
      'const s = await chrome.scripting.getRegisteredContentScripts(); return s.map(x => x.id);')
      .catch(() => []);
    // Enjekte script'in o SEKMEDE canli olup olmadigi - haritadan bagimsiz kanit.
    //
    // IZOLE DUNYADAN okunmali. `executeScript` icerik script'ini izole dunyaya
    // koyar; CDP'nin sayfa oturumu ANA dunyayi gorur ve oradaki `window` baska
    // bir nesnedir. Ana dunyadan bakmak her zaman `false` doner - yani "kapali"
    // iddiasi da hep yesil gecerdi, olculmeden.
    const sekmeId = () => evaluate(chrome.client, sw,
      `const [t] = await chrome.tabs.query({ url: 'https://www.${SITE.kok}/*' }); return t ? t.id : null;`);
    const sekmedeCanli = async () => {
      const id = await sekmeId();
      if (id === null) return null;
      return evaluate(chrome.client, sw, `
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: ${id} }, world: 'ISOLATED',
          func: () => Boolean(window.__ghostTraceObserver) && !window.__ghostTraceObserver.stopped
        });
        return r.result;`).catch(() => null);
    };

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log('GOZLEMCI GERI DOLDURMA - acik sekme, yenileme YOK (kontrol listesi 5)\n');

    // --- 1: GOZLEMCI KAPALIYKEN SEKME ACILIR -------------------------------
    await ayarla({
      rules: {}, enabled: true, cleanDelay: 0,
      trackThirdParty: false, trackThirdPartyFrames: false,
      periodicCleanEnabled: false, logLevel: 'info'
    });
    await haritayiSil();

    not(`${SITE.kok} aciliyor (gozlemci KAPALI)`);
    const t = await visit(chrome.client, SITE.url, { settleMs: 6000 });
    await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
    await sleep(4000);

    const kapaliHarita = await harita();
    const kapaliKayit = await kayit();
    const kapaliCanli = await sekmedeCanli();
    not(`KAPALI -> kayit: ${JSON.stringify(kapaliKayit)} | sekmede canli: ${kapaliCanli} | host: ${kapaliHarita.length}`);

    await runner.test('gozlemci KAPALIYKEN icerik script-i KAYITLI DEGIL', () => {
      assertEqual(kapaliKayit.length, 0, `kayit var: ${JSON.stringify(kapaliKayit)}`);
    });
    await runner.test('gozlemci KAPALIYKEN sayfada KOD CALISMAZ', () => {
      assertEqual(kapaliCanli, false, 'sayfada gozlemci calisiyor');
    });
    await runner.test('gozlemci KAPALIYKEN 3. taraf KAYDEDILMEZ', () => {
      assertEqual(kapaliHarita.length, 0, `kayit dustu: ${JSON.stringify(kapaliHarita.slice(0, 8))}`);
    });

    // --- 2: SEKME ACIKKEN AYAR ACILIR (geri doldurma) ----------------------
    not('ayar ACILIYOR - sekme acik, yenileme yok');
    await ayarla({ trackThirdParty: true });
    await sleep(6000);   // enjeksiyon + 3sn'lik flush penceresi

    const acikHarita = await harita();
    const acikKayit = await kayit();
    const acikCanli = await sekmedeCanli();
    not(`ACIK -> kayit: ${JSON.stringify(acikKayit)} | sekmede canli: ${acikCanli} | host: ${acikHarita.length}`);
    if (acikHarita.length) console.log(`        ornek: ${acikHarita.slice(0, 6).join(', ')}`);

    await runner.test('ayar acilinca icerik script-i KAYDEDILIR', () => {
      assertOk(acikKayit.length === 1, `kayit beklenmedik: ${JSON.stringify(acikKayit)}`);
    });
    await runner.test('ACIK SEKMEYE GERI DOLDURULUR (yenileme olmadan)', () => {
      assertEqual(acikCanli, true, 'acik sekmeye enjekte edilmedi');
    });
    await runner.test('geri doldurma YUKLENMIS kaynaklari da yakalar', () => {
      assertOk(acikHarita.length > 0,
        'sekme acikken ayar acildi ama hicbir 3. taraf kaydedilmedi');
    });

    const logAcma = await evaluate(chrome.client, sw,
      "const l = await chrome.storage.session.get('gt_logs'); return (l.gt_logs || []).map(x => x.message).filter(m => /enjekte edildi/.test(m)).slice(-2);");
    console.log(`        log: ${JSON.stringify(logAcma)}`);
    await runner.test('geri doldurma LOGA yazilir', () => {
      assertOk(logAcma.length > 0, 'enjeksiyon logu yok');
    });

    // --- 3: SEKME ACIKKEN AYAR KAPATILIR (durdurma) ------------------------
    const kapatmaOncesi = await harita();
    not('ayar KAPATILIYOR - sekme hala acik');
    await ayarla({ trackThirdParty: false });
    await sleep(3000);

    const sonKayit = await kayit();
    const sonCanli = await sekmedeCanli();
    not(`KAPANDI -> kayit: ${JSON.stringify(sonKayit)} | sekmede canli: ${sonCanli}`);

    await runner.test('ayar kapaninca kayit KALDIRILIR', () => {
      assertEqual(sonKayit.length, 0, `kayit kaldi: ${JSON.stringify(sonKayit)}`);
    });
    await runner.test('ACIK SEKMEDEKI gozlemci DURDURULUR', () => {
      assertEqual(sonCanli, false, 'kayit silindi ama sayfadaki script CALISMAYA DEVAM ediyor');
    });

    // Durdurulan gozlemci YENI kaynak da bildirmemeli: sayfayi kaydirip
    // tembel yuklenen kaynaklari tetikle, harita BUYUMEMELI.
    await okuyormusGibi(chrome.client, t.sessionId, { tikla: false });
    await sleep(6000);
    const kapatmaSonrasi = await harita();
    not(`kapatmadan sonra host: ${kapatmaOncesi.length} -> ${kapatmaSonrasi.length}`);
    await runner.test('durdurulduktan sonra YENI kayit dusmez', () => {
      assertEqual(kapatmaSonrasi.length, kapatmaOncesi.length,
        `kapaliyken ${kapatmaSonrasi.length - kapatmaOncesi.length} yeni host eklendi: ` +
        JSON.stringify(kapatmaSonrasi.filter(h => !kapatmaOncesi.includes(h))));
    });
  } finally {
    await chrome.close();
  }

  process.exit(runner.summary() ? 0 : 1);
}

main().catch((e) => { console.error('\nSONDA PATLADI:', e); process.exit(1); });
