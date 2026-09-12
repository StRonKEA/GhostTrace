// GhostTrace E2E - YETIM SUPURMESI, GERCEK REKLAM AGLARINA KARSI.
//
// NEDEN BU DOSYA VAR:
// `canli-kullanim` kosumunda, ag duzeyinde reklam engelleme KAPALIYKEN, tur
// sonunda 84 alan adi kaldi ve 80'i korumasizdi: 33across.com, 3lift.com,
// adroll.com, adtarget.biz, betweendigital.com, bttrack.com... Hicbiri
// ziyaret edilmemisti; hepsi UCUNCU TARAF olarak cerez birakmisti.
//
// GhostTrace temizligi ZIYARET EDILEN siteye gore yapar: sekme kapaninca o
// sitenin kokü temizlenir. Baska bir kayit edilebilir alan adina dusen cerez
// hicbir sekmeye bagli degildir - onu YETIM SUPURMESI toplar. O supurmenin
// GERCEK reklam agi cerezlerini gercekten topladigi hic olculmemisti:
// `real-session` ayni yolu taklit sitelerde olcuyor, gercekte olcmuyor.
//
// Aradaki fark onemli: taklit ortamda yetim alan adi sayisi bir elin
// parmaklarini gecmez. Gercekte 80 tane cikti ve supurmenin TEK TURDA aldigi
// ust sinir 60 (SWEEP_MAX_DOMAINS). Yani gercek yuk, taklidin hic uretmedigi
// bir kosulu tetikliyor: supurme kapasiteyi asiyor ve DEVAM ALARMIYLA
// kaldigi yerden surmek zorunda. Bu dosya tam olarak onu olcer.
//
// SUPURME KISITLI: SWEEP_MIN_INTERVAL_MS = 5 dakika. Test bu yuzden bekler
// ya da `force` yolunu kullanan gercek kullanici eylemini (ana anahtari
// kapatip acmak) tetikler.
//
// ON KOSUL: agda reklam engelleme OLMAMALI. NextDNS / Pi-hole / tarayici
// engelleyicisi acikken reklam alan adlari hic yuklenmez, yetim de olusmaz
// ve test "supurulecek bir sey yoktu" diyerek BOS gecer. Bos gecen test,
// olmayan testtir - bu yuzden asagida yetim sayisi ON KOSUL olarak sinanir.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, createRunner, assertEqual, assertOk
} from './harness.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(7)}sn] ${m}`);

// Reklam yogun siteler: yetim ureten kaynak bunlar.
//
// LISTE 5'TEN 20'YE CIKARILDI. Ilk kosumda 5 site 28 yetim uretti ve
// SWEEP_MAX_DOMAINS sinirina (60) ulasilamadi - yani supurmenin kapasiteyi
// asip DEVAM ALARMIYLA surme yolu gercek yukte hic olculmedi. O yol yalnizca
// gercekte tetikleniyor: taklit ortamda yetim sayisi bir elin parmaklarini
// gecmiyor. `canli-kullanim` 24 siteyle 80 yetim uretmisti; buradaki liste
// haber ve e-ticaret agirlikli secildi cunku ucuncu taraf yuku en yuksek
// olanlar bunlar.
const SITELER = [
  // haber - ucuncu taraf yuku en agir kategori
  'https://www.bbc.com/news',
  'https://www.cnn.com/',
  'https://www.hurriyet.com.tr/',
  'https://www.milliyet.com.tr/',
  'https://www.sozcu.com.tr/',
  'https://www.sabah.com.tr/',
  'https://www.haberturk.com/',
  'https://www.cnnturk.com/',
  'https://www.ntv.com.tr/',
  'https://www.ensonhaber.com/',
  'https://www.mynet.com/',
  'https://onedio.com/',
  'https://www.dailymail.co.uk/',
  'https://www.forbes.com/',
  // e-ticaret - yeniden hedefleme piksellleri yogun
  'https://www.hepsiburada.com/',
  'https://www.trendyol.com/',
  'https://www.n11.com/',
  'https://www.amazon.com.tr/',
  'https://www.gittigidiyor.com/',
  'https://www.imdb.com/'
];

const chrome = await launchChrome({ live: true, headless: process.env.GT_HEADED !== '1' });
const runner = createRunner();

async function main() {
  try {
    const ek = await attachExtension(chrome.client);
    const sw = ek.sessionId;
    const sayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');
    const msg = (y) => evaluate(chrome.client, sayfa.sessionId,
      `return await chrome.runtime.sendMessage(${JSON.stringify(y)});`);

    /** Cerezi olan TUM kayit edilebilir alan adlari. */
    const alanlar = () => evaluate(chrome.client, sw, `
      const l = await chrome.cookies.getAll({});
      const d = {};
      for (const c of l) {
        const a = c.domain.replace(/^\\./, '');
        d[a] = (d[a] || 0) + 1;
      }
      return d;`);

    const ziyaretEdilen = () => evaluate(chrome.client, sw,
      `return Object.keys((await chrome.storage.session.get('gt_visitedRoots')).gt_visitedRoots || {});`);

    const alarmlar = () => evaluate(chrome.client, sw,
      `return (await chrome.alarms.getAll()).map(a => a.name);`);

    const gunluk = () => evaluate(chrome.client, sw,
      `return ((await chrome.storage.session.get('gt_logs')).gt_logs || [])
         .map(x => ({ l: x.level, m: x.message, d: x.domain }));`);

    /** Bu kok icin acik sekme var mi? */
    async function tumSekmeleriKapat() {
      const { targetInfos } = await chrome.client.send('Target.getTargets');
      for (const t of targetInfos) {
        if (t.type !== 'page') continue;
        if (t.url.startsWith('chrome-extension://')) continue;
        await closeTarget(chrome.client, t.targetId).catch(() => {});
      }
      await sleep(1500);
    }

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log('YETIM SUPURMESI - gercek reklam aglarina karsi\n');

    await evaluate(chrome.client, sayfa.sessionId, `
      await chrome.storage.local.set({ rules: {}, enabled: true, cleanDelay: 0,
        cleanCookies: true, cleanHistory: true, cleanStorage: true,
        periodicCleanEnabled: true, trackThirdParty: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(800);

    // ================================================================
    console.log('########## 1: reklam yogun siteler geziliyor ##########');
    for (const u of SITELER) {
      const t = await visit(chrome.client, u, { settleMs: 5000 }).catch(() => null);
      if (!t) { console.log(`        ACILAMADI: ${u}`); continue; }
      // Kaydirmak tembel yuklenen reklamlari tetikler - yetim uretimi artar.
      await chrome.client.send('Runtime.evaluate', {
        expression: 'window.scrollBy({ top: window.innerHeight * 3, behavior: "smooth" }); 1',
        returnByValue: true
      }, t.sessionId).catch(() => {});
      await sleep(3500);
      console.log(`        gezildi: ${new URL(u).hostname}`);
    }

    await tumSekmeleriKapat();
    not('tum sekmeler kapatildi, ziyaret edilen sitelerin temizligi bekleniyor');
    await sleep(12000);

    // ================================================================
    console.log('\n########## 2: YETIM ENVANTERI ##########');
    let yetimler = [];
    // Devam alarmi ANLIK gorulur ve kaybolur; dongude yakalanmali.
    let devamAlarmiGorulen = 0;
    await runner.test('1.1 ON KOSUL: gercek reklam aglari YETIM cerez birakti', async () => {
      const hepsi = await alanlar();
      const gezilen = await ziyaretEdilen();
      yetimler = Object.keys(hepsi).filter(a =>
        !gezilen.some(g => a === g || a.endsWith('.' + g)));
      console.log(`        toplam alan adi ${Object.keys(hepsi).length}, ziyaret edilen kok ${gezilen.length}`);
      console.log(`        YETIM: ${yetimler.length} adet`);
      console.log(`        ornek: ${yetimler.slice(0, 12).join(', ')}`);
      // Bos gecen test olmayan testtir: yetim yoksa agda engelleme vardir.
      assertOk(yetimler.length >= 5,
        `yetim sayisi ${yetimler.length} - agda reklam engelleme acik olabilir, ` +
        'bu kosulda supurme olculemez');
    });

    await runner.test('1.2 ZIYARET EDILEN sitelerin verisi zaten gitti', async () => {
      const hepsi = await alanlar();
      const gezilen = await ziyaretEdilen();
      const kalan = gezilen.filter(g => hepsi[g]);
      console.log(`        ziyaret edilen ${gezilen.length} kokten cerezi kalan: ${kalan.join(', ') || '(yok)'}`);
      assertEqual(kalan, [], 'ziyaret edilen sitenin verisi sekme kapanisinda temizlenmedi');
    });

    // ================================================================
    console.log('\n########## 3: SUPURME TETIKLENIYOR ##########');
    await runner.test('2.1 Ana anahtari kapatip acmak YETISME SUPURMESI baslatir', async () => {
      // GERCEK KULLANICI EYLEMI: korumayi kapatip geri acmak. Bu yol
      // `force: true` ile supurmeyi kisitlamadan calistirir - kullanicinin
      // "simdi temizle" beklentisinin karsiligi.
      const once = yetimler.length;
      const bas = Date.now();
      await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: false });
      await sleep(800);
      await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });

      // cleanDelay=0 ama supurme PLANLAR; 60 alan adi ustu ise devam alarmi
      // 31 saniye sonra kalani alir. Iki tura yetecek kadar bekle.
      // BUTCE 5 DAKIKALIK KISITLAMAYI ASMALI.
      //
      // OLCULDU: devam alarmi `SWEEP_MIN_INTERVAL_MS` (5 dakika) sonrasina
      // kuruluyor - CONTINUATION_DELAY_MS (31 sn) degil. Ilk kosumda butce 4
      // dakikaydi ve test "43 yetim duruyor" diye dustu; oysa urun dogruydu,
      // ikinci tur henuz gelmemisti. Butce simdi 8 dakika: iki tur + pay.
      not('supurme calisiyor - devam turu 5 dakika sonra, 8 dakika bekleniyor');
      let kalan = once;
      let ilkTurKalan = null;
      for (let i = 0; i < 96; i++) {
        await sleep(5000);
        const hepsi = await alanlar();
        kalan = yetimler.filter(a => hepsi[a]).length;
        const a = await alarmlar();
        if (a.includes('gt:sweepRetry')) devamAlarmiGorulen++;
        // Ilk tur bittikten sonraki DURAGAN degeri yakala: kapasitenin
        // gercekte kac alan adi aldigini bu gosterir.
        if (ilkTurKalan === null && kalan < once && i >= 6) ilkTurKalan = kalan;
        if (i % 6 === 0) {
          console.log(`        ${(i + 1) * 5}sn: yetim ${once} -> ${kalan}` +
            `${a.includes('gt:sweepRetry') ? ' (devam alarmi var)' : ''}`);
        }
        if (kalan === 0) { console.log(`        ${(i + 1) * 5}sn: HEPSI TEMIZ`); break; }
      }
      const gecenSn = (Date.now() - bas) / 1000;
      console.log(`        SONUC: ${once} yetim -> ${kalan} kaldi (${gecenSn.toFixed(0)}sn)`);
      if (ilkTurKalan !== null) {
        console.log(`        ILK TUR: ${once - ilkTurKalan} alan adi aldi, ${ilkTurKalan} kaldi`);
      }
      assertOk(kalan < once, 'supurme HICBIR yetimi toplamadi');
      assertEqual(kalan, 0,
        `supurme sonrasi ${kalan} yetim alan adi duruyor (${gecenSn.toFixed(0)}sn beklendi)`);
    });

    await runner.test('2.2 KAPASITE ASIMI: 60 ustu yetimde supurme devam turu yapar', async () => {
      // SWEEP_MAX_DOMAINS = 60. Gercek yuk bunu asiyorsa supurme tek turda
      // bitiremez; kalanlari DEVAM ALARMIYLA (gt:sweepRetry) almak zorundadir.
      // Bu kosul taklit ortamda hic olusmaz - 20 gercek reklam yogun site
      // tam olarak bunun icin geziliyor.
      console.log(`        uretilen yetim: ${yetimler.length} (kapasite siniri 60)`);
      const kayitlar = await gunluk();
      // REGEX GERCEK MESAJLARA GORE. Ilk kosumda `sup|sweep|yetim` araniyordu ve
      // "Tarama ust sinira takildi: 60/119 alan adi islendi" mesajini KACIRIYORDU -
      // sonuc "supurme kaydi: 0" cikip supurme sessiz sanildi. Oysa kaydi vardi.
      const supurme = kayitlar.filter(k =>
        /tarama|butce|ust sinir|yetim|sup[uü]r|sweep/i.test(k.m || ''));
      console.log(`        supurme kaydi: ${supurme.length}`);
      for (const k of supurme.slice(-8)) console.log(`          [${k.l}] ${k.m}`);
      console.log(`        devam alarmi gorulme sayisi: ${devamAlarmiGorulen}`);

      // ON KOSUL: sinir asilmadiysa bu test bir sey OLCMEZ ve bunu soyler.
      // Sessizce gecmek, olculmemis bir yolu olculmus gostermek olurdu.
      assertOk(yetimler.length > 60,
        `yetim ${yetimler.length} <= 60 - kapasite asimi TETIKLENMEDI, bu yol ` +
        'olculemedi (ag engellemesi veya siteler beklenenden az iz birakti)');
      assertOk(devamAlarmiGorulen > 0 || supurme.length >= 2,
        'kapasite asildi ama devam turu izi yok - supurme kalanlari birakmis olabilir');
    });

    // ================================================================
    console.log('\n########## 4: SUPURME KORUMAYA SAYGI DUYUYOR MU ##########');
    await runner.test('3.1 BEYAZ LISTEDEKI ucuncu taraf supurulmez', async () => {
      // Yeniden yetim uret, ama bir tanesini KORUMAYA al.
      const t = await visit(chrome.client, SITELER[0], { settleMs: 6000 }).catch(() => null);
      assertOk(t, 'olcum icin site acilmali');
      await sleep(3000);
      const hepsi = await alanlar();
      const gezilen = await ziyaretEdilen();
      const yeniYetim = Object.keys(hepsi).filter(a =>
        !gezilen.some(g => a === g || a.endsWith('.' + g)));
      assertOk(yeniYetim.length > 0, 'ikinci turda yetim uretilemedi');

      const korunacak = yeniYetim[0];
      await msg({ action: 'SET_RULE', domain: korunacak, type: 'white', options: {} });
      console.log(`        korumaya alinan ucuncu taraf: ${korunacak}`);

      await tumSekmeleriKapat();
      await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: false });
      await sleep(600);
      await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });

      let sonHepsi = {};
      for (let i = 0; i < 36; i++) {
        await sleep(5000);
        sonHepsi = await alanlar();
        const kalanYetim = yeniYetim.filter(a => a !== korunacak && sonHepsi[a]).length;
        if (kalanYetim === 0) break;
      }
      const korumaliDuruyor = Boolean(sonHepsi[korunacak]);
      const digerleri = yeniYetim.filter(a => a !== korunacak && sonHepsi[a]);
      console.log(`        korumali ${korunacak}: ${korumaliDuruyor ? 'DURUYOR' : 'SILINDI'}`);
      console.log(`        digerlerinden kalan: ${digerleri.length}`);
      assertOk(korumaliDuruyor, 'BEYAZ LISTEDEKI ucuncu taraf supuruldu');
      await msg({ action: 'RESET_RULES' });
    });

    await runner.test('3.2 ACIK sekmenin sitesi supurulmez', async () => {
      const t = await visit(chrome.client, SITELER[0], { settleMs: 6000 }).catch(() => null);
      assertOk(t, 'olcum icin site acilmali');
      await sleep(2500);
      const host = new URL(SITELER[0]).hostname.replace(/^www\./, '');
      const once = (await alanlar())[host] || 0;
      assertOk(once > 0, 'acik sitede cerez olmali');

      await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: false });
      await sleep(600);
      await msg({ action: 'SET_AUTOMATIC_CLEANING_ENABLED', enabled: true });
      await sleep(20000);

      const sonra = (await alanlar())[host] || 0;
      console.log(`        ${host} (sekmesi ACIK): ${once} -> ${sonra} cerez`);
      assertOk(sonra > 0, 'ACIK sekmenin sitesi supurmede silindi');
      await closeTarget(chrome.client, t.targetId);
      await sleep(8000);
    });

    // ================================================================
    console.log('\n########## 5: TOPLU TEMIZLIK YOLU ##########');
    await runner.test('4.1 "Tumunu temizle" GERIYE KALAN her seyi alir', async () => {
      const t = await visit(chrome.client, SITELER[1], { settleMs: 6000 }).catch(() => null);
      if (t) { await sleep(3000); await closeTarget(chrome.client, t.targetId); await sleep(3000); }

      const once = Object.keys(await alanlar()).length;
      const y = await msg({ action: 'PURGE_ALL_NON_WHITELIST' });
      await sleep(6000);
      const sonra = Object.keys(await alanlar()).length;
      console.log(`        alan adi ${once} -> ${sonra} | rapor: cerez=${y?.cookies} gecmis=${y?.history}`);
      assertOk(y?.success, 'toplu temizlik basarisiz');
      assertOk(sonra < once || once === 0, 'toplu temizlik hicbir alan adini temizlemedi');
    });

    await runner.test('4.2 Gunlukte ERROR yok', async () => {
      const hatalar = (await gunluk()).filter(k => (k.l || '').toUpperCase() === 'ERROR');
      console.log(`        ERROR: ${hatalar.length}`);
      for (const h of hatalar.slice(0, 5)) console.log(`          ${h.m}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
    });

    const gecti = runner.summary();
    console.log(`\nToplam sure: ${((Date.now() - t0) / 60000).toFixed(1)} dakika`);
    process.exitCode = gecti ? 0 : 1;
  } catch (err) {
    console.error('\nKURULUM/AKIS HATASI:', err?.stack || err);
    process.exitCode = 1;
  } finally {
    await chrome.close();
  }
}

main();
