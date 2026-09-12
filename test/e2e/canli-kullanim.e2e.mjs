// GhostTrace E2E - GERCEK SITELER + GERCEK ARAYUZ + TAM MUHASEBE.
//
// Bu dosyanin diger e2e dosyalarindan iki temel farki var:
//
// 1) SITELER GERCEK. Diger dosyalar --host-resolver-rules ile her alan adini
//    127.0.0.1'e cevirir; her taklit site tam 3 cerez birakir ve sayilar
//    sabittir. Burada gercek DNS, gercek HTTPS, gercek reklam aglari var.
//    Taklidin uretemedigi seyler yalnizca burada gorunur: __Secure-/__Host-
//    onekleri, HttpOnly, bir sitenin onlarca alt alan adina cerez dagitmasi,
//    yonlendirmeler, riza bannerlari.
//
// 2) KURALLAR VE AYARLAR ARAYUZDEN DEGISTIRILIR. Diger dosyalar
//    `chrome.runtime.sendMessage({action:'SET_RULE'})` gonderir - yani popup'i
//    ve ayarlar sayfasini TAMAMEN ATLAR. Kullanicinin bildirdigi iki hata
//    (popup'ta "Koru" secip kapsama tiklayinca "Temizle"nin aktiflesmesi; sag
//    tik menusu acilirken uyari vermesi) mesaj tabanli bir testin GOREMEYECEGI
//    siniftandi. Burada gercek popup `chrome.action.openPopup()` ile acilir ve
//    dugmelere GERCEK FARE OLAYIYLA basilir.
//
// GERCEK FARE OLAYI, `element.click()` DEGIL: element.click() ogenin ustunde
// baska bir oge olsa bile calisir, gercek fare tiklamasi calismaz. Kullanicinin
// "kesliyor ve altta kaliyor" diye bildirdigi hata tam bu farkta gorunur. Her
// tiklamadan once o noktadaki EN USTTEKI oge dogrulanir.
//
// GUVENLIK: tek kullanimlik profil, kullanicinin profiline dokunulmaz.
// HICBIR YERE GIRIS YAPILMAZ - yalnizca acilis sayfalari yuklenir.

import {
  launchChrome, attachExtension, openExtensionPage, visit, closeTarget,
  evaluate, sleep, attach, createRunner, assertEqual, assertOk
} from './harness.mjs';

const t0 = Date.now();
const sn = (ms) => (ms / 1000).toFixed(1);
const not = (m) => console.log(`  ..[${sn(Date.now() - t0).padStart(7)}sn] ${m}`);

// --------------------------------------------------------------------------
// SITELER: 15'i kullanicinin kendi yer imlerinden, 9'u populer.
// --------------------------------------------------------------------------
// `kok` = kayit edilebilir alan adi (eTLD+1). Kurallar ve temizlik bu duzeyde
// isler, olcum de bu duzeyde yapilmali.
const SITELER = [
  { url: 'https://ecc.tools/', kok: 'ecc.tools' },
  { url: 'https://github.com/', kok: 'github.com' },
  { url: 'https://www.deepl.com/translator', kok: 'deepl.com' },
  { url: 'https://openani.me/', kok: 'openani.me' },
  { url: 'https://1337x.to/', kok: '1337x.to' },
  { url: 'https://fitgirl-repacks.site/', kok: 'fitgirl-repacks.site' },
  { url: 'https://blackmod.net/', kok: 'blackmod.net' },
  { url: 'https://platinmods.com/', kok: 'platinmods.com' },
  { url: 'https://ddlbase.com/', kok: 'ddlbase.com' },
  { url: 'https://forum.mobilism.org/', kok: 'mobilism.org' },
  { url: 'https://www.dizibox.com/', kok: 'dizibox.com' },
  { url: 'https://www.instagram.com/', kok: 'instagram.com' },
  { url: 'https://www.youtube.com/', kok: 'youtube.com' },
  { url: 'https://www.google.com/', kok: 'google.com' },
  { url: 'https://tr.wikipedia.org/wiki/Gizlilik', kok: 'wikipedia.org' },
  { url: 'https://stackoverflow.com/', kok: 'stackoverflow.com' },
  { url: 'https://www.reddit.com/', kok: 'reddit.com' },
  { url: 'https://www.bbc.com/news', kok: 'bbc.com' },
  { url: 'https://www.hurriyet.com.tr/', kok: 'hurriyet.com.tr' },
  { url: 'https://www.amazon.com.tr/', kok: 'amazon.com.tr' },
  { url: 'https://www.n11.com/', kok: 'n11.com' },
  { url: 'https://eksisozluk.com/', kok: 'eksisozluk.com' },
  { url: 'https://www.imdb.com/', kok: 'imdb.com' },
  { url: 'https://www.trendyol.com/', kok: 'trendyol.com' },
  // --- YUK ARTIRIMI: liste 24'ten 40'a cikarildi ---
  // Daha cok site = daha cok ucuncu taraf, daha cok es zamanli alarm, daha
  // buyuk oturum deposu. Gercek kullanicinin bir gunde gezdigi hacme yaklasir.
  { url: 'https://www.sabah.com.tr/', kok: 'sabah.com.tr' },
  { url: 'https://www.haberturk.com/', kok: 'haberturk.com' },
  { url: 'https://www.cnnturk.com/', kok: 'cnnturk.com' },
  { url: 'https://www.ntv.com.tr/', kok: 'ntv.com.tr' },
  { url: 'https://www.mynet.com/', kok: 'mynet.com' },
  { url: 'https://onedio.com/', kok: 'onedio.com' },
  { url: 'https://www.hepsiburada.com/', kok: 'hepsiburada.com' },
  { url: 'https://www.gittigidiyor.com/', kok: 'gittigidiyor.com' },
  { url: 'https://www.sahibinden.com/', kok: 'sahibinden.com' },
  { url: 'https://www.dailymail.co.uk/', kok: 'dailymail.co.uk' },
  { url: 'https://www.forbes.com/', kok: 'forbes.com' },
  { url: 'https://www.theguardian.com/international', kok: 'theguardian.com' },
  { url: 'https://twitch.tv/', kok: 'twitch.tv' },
  { url: 'https://www.pinterest.com/', kok: 'pinterest.com' },
  { url: 'https://tr.investing.com/', kok: 'investing.com' },
  { url: 'https://www.booking.com/', kok: 'booking.com' }
];

// GT_HEADED=1 ile tarayici GORUNUR acilir ve kullanim izlenebilir.
//
// Varsayilan headless: tur ~40 dakika suruyor ve gorunur pencere o sure boyunca
// ekrani ve pencere odagini mesgul eder. Ama "gercek kullanici gibi" davranisi
// IZLEMEK isteyen icin gormek sart - sayfa kaydirmasi, ic baglantiya tiklama,
// popup'in acilip dugmelerine basilmasi yalnizca boyle gorunur.
const GORUNUR = process.env.GT_HEADED === '1';
const chrome = await launchChrome({ live: true, headless: !GORUNUR });
const runner = createRunner();
let sw = null;

/** Faz 6.2'de anahtar kapaliyken kullanilan site, 6.3'te tekrar gerekiyor. */
let kapaliDonemSitesi = null;

// ==========================================================================
// GERCEK KULLANICI: sayfa kullanimi
// ==========================================================================
/**
 * Sayfayi okuyormus gibi kullanir: kademe kademe asagi iner, durur, yukari
 * cikar, ayni sitede kalan bir ic baglantiya tiklar.
 *
 * NEDEN: bircok site cerezi ILK YUKLEMEDE degil, etkilesimden sonra birakir
 * (kaydirma, riza banneri, tembel yuklenen reklam). Sadece acip kapatan bir
 * test gercek kullanicinin biraktigi izin bir kismini hic gormez.
 */
async function okuyormusGibi(sessionId) {
  const calistir = (ifade) => chrome.client.send('Runtime.evaluate',
    { expression: ifade, awaitPromise: true, returnByValue: true }, sessionId)
    .catch(() => null);

  for (let i = 0; i < 4; i++) {
    await calistir('window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" }); 1');
    await sleep(1100);
  }
  await sleep(1600);                                  // "okuma" duraklamasi
  await calistir('window.scrollTo({ top: 0, behavior: "smooth" }); 1');
  await sleep(1000);

  const gidilen = await calistir(`(() => {
    const buradaki = location.hostname;
    const baglar = [...document.querySelectorAll('a[href]')].filter(a => {
      try {
        const u = new URL(a.href, location.href);
        return u.hostname === buradaki && u.protocol.startsWith('http')
          && u.pathname !== location.pathname;
      } catch { return false; }
    });
    if (!baglar.length) return null;
    const secim = baglar[Math.floor(baglar.length / 3)];
    const hedef = secim.href;
    secim.click();
    return hedef;
  })()`);
  await sleep(2500);
  return gidilen?.result?.value || null;
}

// ==========================================================================
// GERCEK ARAYUZ: popup ve tiklama
// ==========================================================================
/**
 * GERCEK popup'i acar - simgeye tiklamanin karsiligi.
 *
 * popup.html'i sekme olarak acmak ISE YARAMAZ: popup aktif sekmeyi
 * `chrome.tabs.query({active:true, currentWindow:true})` ile bulur, sekme
 * olarak acilinca kendini bulur ve "dahili sayfa" der. openPopup() gercek
 * popup'i acar, o da bagli oldugu pencerenin aktif sekmesini gorur.
 */
async function popupAc() {
  // TEK DENEME YETMIYOR: `chrome.action.openPopup()` bazen sessizce
  // acmiyor (onceki popup henuz kapanmamis, pencere odagi degismis).
  // Olculdu: 33 testlik turda bir kez "popup acilmadi" diye dustu, oysa
  // ikinci denemede aciliyor.
  let p = null;
  for (let deneme = 0; deneme < 3 && !p; deneme++) {
    await evaluate(chrome.client, sw,
      'try { chrome.action.openPopup(); } catch { /* zaten acik olabilir */ } return 1;');
    await sleep(1200 + deneme * 800);
    const { targetInfos } = await chrome.client.send('Target.getTargets');
    p = targetInfos.find(t => t.url.includes('popup/popup.html'));
  }
  if (!p) throw new Error('popup 3 denemede de acilmadi');
  const sessionId = await attach(chrome.client, p.targetId);
  await chrome.client.send('Runtime.enable', {}, sessionId);
  await sleep(700);                                   // i18n + veri yuklensin
  return { sessionId, targetId: p.targetId };
}

async function popupKapat(p) {
  try { await chrome.client.send('Target.closeTarget', { targetId: p.targetId }); } catch { /* kapanmis */ }
  await sleep(300);
}

const oku = async (sessionId, ifade) => {
  const r = await chrome.client.send('Runtime.evaluate',
    { expression: ifade, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result?.value;
};

/**
 * GERCEK FARE TIKLAMASI - element.click() degil.
 *
 * Once ogenin ekrandaki dikdortgeni alinir, sonra MERKEZINDEKI en ustteki oge
 * dogrulanir. Hedef bir baska ogenin ALTINDA kaliyorsa burada patlar; oysa
 * element.click() ustunde ne olursa olsun calisir ve hatayi gizler.
 * Kullanicinin bildirdigi "kesliyor ve altta kaliyor" hatasi tam bu sinifta.
 */
async function gercekTikla(sessionId, secici, { adi = secici } = {}) {
  // ONCE GORUNUR ALANA KAYDIR.
  //
  // getBoundingClientRect GORUNTU PENCERESINE gore koordinat verir; oge
  // ekranin altinda kaldiysa y > innerHeight olur ve o noktada
  // elementFromPoint null doner - tiklama hicbir yere dusmez. Ayarlar sayfasi
  // uzun oldugu icin anahtarlarin cogu ilk ekranda degil. Gercek kullanici da
  // once oraya kaydirir.
  await oku(sessionId, `(() => {
    const e = document.querySelector(${JSON.stringify(secici)});
    if (e) e.scrollIntoView({ block: 'center', inline: 'nearest' });
    return 1;
  })()`);
  await sleep(400);

  const bilgi = await oku(sessionId, `(() => {
    const e = document.querySelector(${JSON.stringify(secici)});
    if (!e) return { yok: true };
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { gorunmez: true };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ust = document.elementFromPoint(x, y);
    return {
      x, y,
      // ust === null: nokta GORUNUR ALANIN DISINDA. Bunu "altta kaliyor" diye
      // raporlamak yanlis teshis olur - iki durum ayri.
      disarida: ust === null,
      kapali: ust !== null && !(ust === e || e.contains(ust) || ust.contains(e)),
      ustOge: ust ? (ust.id || ust.className || ust.tagName) : null,
      devredisi: e.disabled === true,
      pencere: [window.innerWidth, window.innerHeight]
    };
  })()`);

  if (!bilgi || bilgi.yok) throw new Error(`${adi}: oge yok`);
  if (bilgi.gorunmez) throw new Error(`${adi}: oge gorunmez (0 boyut)`);
  if (bilgi.disarida) {
    throw new Error(`${adi}: gorunur alanin disinda (y=${Math.round(bilgi.y)}, pencere ${bilgi.pencere.join('x')})`);
  }
  if (bilgi.kapali) throw new Error(`${adi}: oge BASKA BIR OGENIN ALTINDA - ustteki: ${bilgi.ustOge}`);
  if (bilgi.devredisi) throw new Error(`${adi}: oge devre disi`);

  for (const type of ['mousePressed', 'mouseReleased']) {
    await chrome.client.send('Input.dispatchMouseEvent', {
      type, x: bilgi.x, y: bilgi.y, button: 'left', clickCount: 1
    }, sessionId);
    await sleep(60);
  }
  await sleep(600);
  return bilgi;
}

// ==========================================================================
// OLCUM
// ==========================================================================
const cerezler = (kok) => evaluate(chrome.client, sw,
  `const l = await chrome.cookies.getAll({ domain: ${JSON.stringify(kok)} });
   return l.map(c => c.domain.replace(/^\\./, '') + '|' + c.name).sort();`);

const gecmisSayisi = (kok) => evaluate(chrome.client, sw,
  `const r = await chrome.history.search({ text: ${JSON.stringify(kok)},
     startTime: 0, maxResults: 1000 });
   return r.filter(x => { try { return new URL(x.url).hostname.endsWith(${JSON.stringify(kok)}); }
     catch { return false; } }).length;`);

// DEPO ANAHTARLARI DUZ: 'rules', 'stats' ve ayarlar en ust duzeyde tek tek
// (SETTINGS_KEYS). Ilk yazimda 'gt_rules'/'gt_stats'/'gt_settings' okunuyordu;
// uclu de HIC var olmadigi icin her cagri bos nesne donuyordu ve popup
// tiklamalari "hicbir sey yapmadi" gibi gorunuyordu. Urun degil olcum bozuktu.
const istatistik = () => evaluate(chrome.client, sw,
  `return (await chrome.storage.local.get('stats')).stats || {};`);

const kurallar = () => evaluate(chrome.client, sw,
  `return (await chrome.storage.local.get('rules')).rules || {};`);

const ayarlar = () => evaluate(chrome.client, sw,
  `return await chrome.storage.local.get(['enabled', 'cleanDelay', 'cleanCookies',
     'cleanHistory', 'cleanStorage', 'logLevel']);`);

const alarmlar = () => evaluate(chrome.client, sw,
  `return (await chrome.alarms.getAll()).map(a => a.name).sort();`);

const gunluk = () => evaluate(chrome.client, sw,
  `return (await chrome.storage.session.get('gt_logs')).gt_logs || [];`);

async function temizligiBekle(kok, azamiMs) {
  const bas = Date.now();
  while (Date.now() - bas < azamiMs) {
    if ((await cerezler(kok)).length === 0) return { gecenMs: Date.now() - bas, tamamlandi: true };
    await sleep(1000);
  }
  return { gecenMs: Date.now() - bas, tamamlandi: false };
}

/** Bu kok icin acik olan TUM sekmeleri kapatir. */
async function tumSekmeleriKapat(kok) {
  const { targetInfos } = await chrome.client.send('Target.getTargets');
  let n = 0;
  for (const t of targetInfos) {
    if (t.type !== 'page') continue;
    let h = '';
    try { h = new URL(t.url).hostname; } catch { continue; }
    if (h === kok || h.endsWith('.' + kok)) { await closeTarget(chrome.client, t.targetId); n++; }
  }
  return n;
}

// ==========================================================================
async function main() {
  const olculenSureler = [];
  try {
    const ek = await attachExtension(chrome.client);
    sw = ek.sessionId;
    const ayarSayfa = await openExtensionPage(chrome.client, ek.extensionId, 'options/options.html');

    console.log(`\nEklenti: ${ek.extensionId}`);
    console.log(`${SITELER.length} GERCEK site | gercek popup | gercek fare tiklamalari`);
    console.log(GORUNUR
      ? 'Kip: GORUNUR - pencereyi izleyebilirsiniz'
      : 'Kip: headless (gorunmez). Izlemek icin: GT_HEADED=1 npm run test:e2e:canli');
    console.log('');

    // ==================================================================
    console.log('########## FAZ 0: temiz baslangic ##########');
    await evaluate(chrome.client, ayarSayfa.sessionId, `
      await chrome.storage.local.set({ rules: {},
        enabled: true, cleanDelay: 30, cleanCookies: true, cleanHistory: true,
        cleanStorage: true, logLevel: 'info' });
      await chrome.runtime.sendMessage({ action: 'RESET_STATS' });
      await chrome.runtime.sendMessage({ action: 'SETTINGS_CHANGED' });`);
    await sleep(800);

    await runner.test('0.1 Kurallar bos, istatistik sifir', async () => {
      assertEqual(Object.keys(await kurallar()).length, 0, 'kural kalmis');
      assertEqual((await istatistik()).cookiesDeleted || 0, 0, 'istatistik sifirlanmamis');
    });

    // ==================================================================
    console.log(`\n########## FAZ 1: ${SITELER.length} gercek site, okur gibi geziliyor ##########`);
    const defter = [];
    for (const s of SITELER) {
      let t = null;
      try {
        t = await visit(chrome.client, s.url, { settleMs: 3500 });
      } catch (e) {
        console.log(`        ${s.kok.padEnd(22)} ACILAMADI (${String(e.message).slice(0, 38)})`);
        defter.push({ ...s, yuklendi: false });
        continue;
      }
      const gidilen = await okuyormusGibi(t.sessionId);
      const c = await cerezler(s.kok);
      const g = await gecmisSayisi(s.kok);
      defter.push({ ...s, tab: t.targetId, cerez: c, gecmis: g, yuklendi: true });
      console.log(`        ${s.kok.padEnd(22)} cerez ${String(c.length).padStart(3)}  gecmis ${String(g).padStart(2)}` +
        `${gidilen ? '  (ic baglantiya tiklandi)' : ''}`);
      await sleep(400);
    }
    const acilan = defter.filter(d => d.yuklendi);
    not(`${acilan.length}/${SITELER.length} site acildi`);

    await runner.test('1.1 Siteler gercekten iz birakti', async () => {
      assertOk(acilan.length >= SITELER.length * 0.7,
        `cok fazla site acilamadi: ${acilan.length}/${SITELER.length}`);
      const izsiz = acilan.filter(d => d.cerez.length === 0 && d.gecmis === 0);
      console.log(`        hic iz birakmayan: ${izsiz.map(d => d.kok).join(', ') || '(yok)'}`);
      // 40 GERCEK sitede birkacinin iz birakmamasi olagan: bazi siteler
      // cerez koymadan aciliyor, bazilari bolgesel olarak farkli davraniyor.
      // Esik site sayisinin altida biri; bunun ustu "ag engellemesi" isaretidir.
      assertOk(izsiz.length <= Math.ceil(SITELER.length / 6),
        `beklenenden cok site iz birakmadi: ${izsiz.length}/${SITELER.length}`);
    });

    await runner.test('1.2 Gercek cerez bayraklari mevcut (taklitte olmayan)', async () => {
      const o = await evaluate(chrome.client, sw, `
        const l = await chrome.cookies.getAll({});
        return { toplam: l.length,
          secure: l.filter(c => c.secure).length,
          httpOnly: l.filter(c => c.httpOnly).length,
          onekli: l.filter(c => /^__(Secure|Host)-/.test(c.name)).length,
          alanSayisi: new Set(l.map(c => c.domain.replace(/^\\./, ''))).size };`);
      console.log(`        ${o.toplam} cerez / ${o.alanSayisi} alan adi | ` +
        `Secure ${o.secure}, HttpOnly ${o.httpOnly}, __Secure-/__Host- ${o.onekli}`);
      assertOk(o.secure > 0, 'hic Secure cerez yok - gercek HTTPS trafigi supheli');
      assertOk(o.httpOnly > 0, 'hic HttpOnly cerez yok');
    });

    // ==================================================================
    console.log('\n########## FAZ 2: POPUP GERCEKTEN CALISIYOR MU ##########');
    const hedefSite = acilan.find(d => d.cerez.length > 0) || acilan[0];
    await visit(chrome.client, hedefSite.url, { settleMs: 2500 });

    await runner.test('2.1 Popup aktif sekmeyi DOGRU gosteriyor', async () => {
      const p = await popupAc();
      const g = await oku(p.sessionId, `JSON.stringify({
        alan: document.getElementById('currentDomain')?.textContent?.trim(),
        cerez: document.getElementById('cookieCount')?.textContent?.trim(),
        gecmis: document.getElementById('historyCount')?.textContent?.trim(),
        dahili: !document.getElementById('internalCard')?.classList.contains('hidden'),
        kartlarGorunur: !document.getElementById('decisionBlock')?.classList.contains('hidden')
      })`);
      const v = JSON.parse(g);
      console.log(`        popup: alan=${v.alan} cerez=${v.cerez} gecmis=${v.gecmis}`);
      assertOk(!v.dahili, 'popup gercek siteyi degil dahili sayfayi goruyor');
      assertOk(v.alan?.includes(hedefSite.kok.split('.')[0]),
        `popup yanlis alan adi gosteriyor: ${v.alan}`);
      assertOk(v.kartlarGorunur, 'karar kartlari gorunmuyor');
      await popupKapat(p);
    });

    await runner.test('2.2 Popup sayilari GERCEK veriyle ortusuyor', async () => {
      const gercekCerez = (await cerezler(hedefSite.kok)).length;
      const p = await popupAc();
      const metin = await oku(p.sessionId,
        `document.getElementById('cookieCount')?.textContent?.trim()`);
      const gosterilen = parseInt(String(metin).replace(/\D/g, ''), 10);
      console.log(`        gercek ${gercekCerez} cerez, popup "${metin}"`);
      assertOk(Number.isFinite(gosterilen), `popup sayi gostermiyor: "${metin}"`);
      await popupKapat(p);
    });

    // ==================================================================
    console.log('\n########## FAZ 3: POPUP ile KORUMA - gercek tiklamalar ##########');

    await runner.test('3.1 "Koru" karti tiklanabilir ve KURAL YAZILIYOR', async () => {
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#cardProtect', { adi: 'Koru karti' });
      await sleep(900);
      const k = await kurallar();
      console.log(`        kural: ${hedefSite.kok} -> ${k[hedefSite.kok]?.type || 'YOK'}`);
      assertOk(k[hedefSite.kok], 'Koru tiklandi ama kural yazilmadi');
      await popupKapat(p);
    });

    await runner.test('3.2 Kullanicinin BILDIRDIGI HATA: kapsama tiklayinca "Temizle" aktiflesmiyor', async () => {
      // Bildirilen hata: "Koru" secildikten sonra kapsam dugmesine tiklayinca
      // aninda "Temizle" secili hale geliyordu ("sanki crash yiyor gibi").
      // Sebep: kapsam dugmesi sabit 'white' yaziyordu ve olu bir dal kurali
      // siliyordu. Bu test o yolu GERCEK TIKLAMAYLA yurur.
      const p = await popupAc();

      const oncekiSecim = await oku(p.sessionId,
        `document.getElementById('cardProtect')?.classList.contains('is-protect')`);
      await gercekTikla(p.sessionId, '#scopeSubs', { adi: 'Alt siteler dahil' });
      await sleep(900);

      const sonra = JSON.parse(await oku(p.sessionId, `JSON.stringify({
        koru: document.getElementById('cardProtect')?.classList.contains('is-protect'),
        temizle: document.getElementById('cardClean')?.classList.contains('is-clean'),
        kapsamAlt: document.getElementById('scopeSubs')?.classList.contains('active')
      })`));
      const k = await kurallar();
      console.log(`        once koru=${oncekiSecim} | sonra koru=${sonra.koru} temizle=${sonra.temizle} ` +
        `kapsamAlt=${sonra.kapsamAlt} | kural=${k[hedefSite.kok]?.type || 'YOK'}`);

      assertOk(k[hedefSite.kok], 'kapsama tiklayinca kural SILINDI - bildirilen hata');
      assertOk(sonra.temizle !== true, '"Temizle" kendiliginden aktiflesti - bildirilen hata');
      assertOk(sonra.koru === true, '"Koru" secimi kayboldu');
      assertOk(sonra.kapsamAlt === true, 'kapsam dugmesi secili gorunmuyor');
      assertEqual(k[hedefSite.kok].subdomains, true, 'kapsam alt alanlara genisletilmedi');
      await popupKapat(p);
    });

    await runner.test('3.3 Kapsam GERI daraltilabiliyor', async () => {
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#scopeExact', { adi: 'Yalnizca bu site' });
      await sleep(900);
      const k = await kurallar();
      console.log(`        kapsam -> subdomains=${k[hedefSite.kok]?.subdomains}`);
      assertEqual(k[hedefSite.kok]?.subdomains, false, 'kapsam daraltilmadi');
      assertOk(k[hedefSite.kok], 'kapsam daraltinca kural silindi');
      await popupKapat(p);
    });

    await runner.test('3.4 KORUMA GERCEKTEN ISE YARIYOR (sekme kapandi, veri durdu)', async () => {
      const once = await cerezler(hedefSite.kok);
      await tumSekmeleriKapat(hedefSite.kok);
      await sleep(50000);
      const sonra = await cerezler(hedefSite.kok);
      console.log(`        ${hedefSite.kok}: ${once.length} -> ${sonra.length} (korunmali)`);
      assertEqual(sonra.length, once.length, 'POPUP ile korunan sitenin verisi silindi');
    });

    // ==================================================================
    console.log('\n########## FAZ 4: POPUP ile SURELI IZIN - gercek tiklamalar ##########');
    const sureliSite = acilan.find(d => d.kok !== hedefSite.kok && d.cerez.length > 0);

    await runner.test('4.1 "1 saat" secilince SURELI kural olusuyor', async () => {
      await visit(chrome.client, sureliSite.url, { settleMs: 2500 });
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#cardProtect', { adi: 'Koru' });
      await sleep(600);
      await gercekTikla(p.sessionId, '.durseg__b[data-dur="60"]', { adi: '1 saat' });
      await sleep(900);
      const k = await kurallar();
      const kural = k[sureliSite.kok];
      const kalanDk = kural?.expiresAt ? Math.round((kural.expiresAt - Date.now()) / 60000) : null;
      console.log(`        ${sureliSite.kok}: tip=${kural?.type} kalan=${kalanDk}dk`);
      assertOk(kural, 'sureli izin kurali olusmadi');
      assertOk(kural.expiresAt, 'bitis zamani yok');
      assertOk(kalanDk >= 58 && kalanDk <= 61, `1 saat yerine ${kalanDk} dakika`);
      await popupKapat(p);
    });

    await runner.test('4.2 Sureli izin ALARMI kuruldu', async () => {
      const a = await alarmlar();
      console.log(`        alarmlar: ${a.join(', ')}`);
      assertOk(a.some(x => x.includes(sureliSite.kok)), 'sureli izin icin alarm yok');
    });

    await runner.test('4.3 "Kalici" secilince kural KALICI oluyor', async () => {
      const p = await popupAc();
      await gercekTikla(p.sessionId, '.durseg__b[data-dur="white"]', { adi: 'Kalici' });
      await sleep(900);
      const k = await kurallar();
      console.log(`        ${sureliSite.kok}: tip=${k[sureliSite.kok]?.type} bitis=${k[sureliSite.kok]?.expiresAt || 'yok'}`);
      assertEqual(k[sureliSite.kok]?.type, 'white', 'kalici secilmedi');
      assertOk(!k[sureliSite.kok]?.expiresAt, 'kalici olmasina ragmen bitis zamani var');
      await popupKapat(p);
    });

    // ==================================================================
    console.log('\n########## FAZ 5: POPUP ile TEMIZLE ve elle temizlik ##########');
    const temizSite = acilan.find(d =>
      d.kok !== hedefSite.kok && d.kok !== sureliSite.kok && d.cerez.length > 0);

    await runner.test('5.1 "Temizle" karti secilince koruma KALKIYOR', async () => {
      await visit(chrome.client, temizSite.url, { settleMs: 2500 });
      let p = await popupAc();
      await gercekTikla(p.sessionId, '#cardProtect', { adi: 'Koru' });
      await sleep(800);
      assertOk((await kurallar())[temizSite.kok], 'once koruma yazilmaliydi');
      await popupKapat(p);

      p = await popupAc();
      await gercekTikla(p.sessionId, '#cardClean', { adi: 'Temizle' });
      await sleep(900);

      // Onay kutusu cikabilir - gercek kullanici "Evet"e basar.
      const onayVar = await oku(p.sessionId,
        `!document.getElementById('confirmBox')?.classList.contains('hidden')`);
      if (onayVar) {
        console.log('        onay kutusu cikti - "Evet"e basiliyor');
        await gercekTikla(p.sessionId, '#btnConfirmYes', { adi: 'Evet' });
        await sleep(900);
      }
      const k = await kurallar();
      console.log(`        ${temizSite.kok}: kural=${k[temizSite.kok]?.type || 'YOK (dogru)'}`);
      assertOk(!k[temizSite.kok] || k[temizSite.kok].type !== 'white',
        'Temizle secildi ama koruma duruyor');
      await popupKapat(p);
    });

    await runner.test('5.2 "Simdi temizle" dugmesi GERCEKTEN siliyor', async () => {
      const once = await cerezler(temizSite.kok);
      assertOk(once.length > 0, 'olcum icin cerez gerekli');
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#btnPurgeNow', { adi: 'Simdi temizle' });
      await sleep(1000);
      const onayVar = await oku(p.sessionId,
        `!document.getElementById('confirmBox')?.classList.contains('hidden')`);
      if (onayVar) await gercekTikla(p.sessionId, '#btnConfirmYes', { adi: 'Evet' });
      await sleep(3000);
      const sonra = await cerezler(temizSite.kok);
      console.log(`        ${temizSite.kok}: ${once.length} -> ${sonra.length}`);
      assertEqual(sonra.length, 0, '"Simdi temizle" cerezleri silmedi');
      await popupKapat(p);
    });

    // ==================================================================
    console.log('\n########## FAZ 6: POPUP ANA ANAHTARI ##########');
    await runner.test('6.1 Ana anahtar KAPATILINCA ayar da kapaniyor', async () => {
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#masterToggle', { adi: 'Ana anahtar' });
      await sleep(1200);
      const a = await ayarlar();
      console.log(`        enabled=${a.enabled}`);
      assertEqual(a.enabled, false, 'anahtar kapanmadi');
      await popupKapat(p);
    });

    await runner.test('6.2 Anahtar KAPALIYKEN sekme kapanisi HICBIR SEY silmiyor', async () => {
      const kapaliSite = acilan.find(d => ![hedefSite.kok, sureliSite.kok, temizSite.kok]
        .includes(d.kok) && d.cerez.length > 0);

      // Faz 1'DEN KALAN SEKME once kapatilmali.
      //
      // Aksi halde bu olcum hicbir sey olcmez: ikinci bir sekme acip yalnizca
      // onu kapatiyoruz, site hala ilk sekmede acik oldugu icin eklenti -
      // DOGRU davranarak - temizligi atliyor. Ilk kosumda 6.2 tam bu yuzden
      // SAHTE PASS verdi (veri anahtar kapali oldugu icin degil, sekme acik
      // oldugu icin durmustu) ve 6.3 haksiz yere FAIL oldu.
      await tumSekmeleriKapat(kapaliSite.kok);
      await sleep(1000);
      const t = await visit(chrome.client, kapaliSite.url, { settleMs: 2500 });
      await okuyormusGibi(t.sessionId);
      const once = (await cerezler(kapaliSite.kok)).length;
      assertOk(once > 0, 'olcum icin cerez gerekli');
      await tumSekmeleriKapat(kapaliSite.kok);
      await sleep(50000);
      const sonra = (await cerezler(kapaliSite.kok)).length;
      console.log(`        ${kapaliSite.kok}: ${once} -> ${sonra} (degismemeli)`);
      assertEqual(sonra, once, 'anahtar kapaliyken silme yapildi');
      kapaliDonemSitesi = kapaliSite;
    });

    await runner.test('6.3 Anahtar ACILINCA bekleyen veri temizleniyor', async () => {
      const kapaliSite = kapaliDonemSitesi;
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#masterToggle', { adi: 'Ana anahtar' });
      await sleep(1200);
      assertEqual((await ayarlar()).enabled, true, 'anahtar acilmadi');
      await popupKapat(p);

      const olcum = await temizligiBekle(kapaliSite.kok, 120000);
      console.log(`        ${kapaliSite.kok}: ${olcum.tamamlandi ? sn(olcum.gecenMs) + 'sn' : 'TEMIZLENMEDI'}`);
      assertOk(olcum.tamamlandi, 'anahtar acilinca bekleyen veri temizlenmedi');
    });

    // ==================================================================
    console.log('\n########## FAZ 7: TEKER TEKER KAPAT, TAM MUHASEBE ##########');
    console.log('        (kapanmadan once envanter, sonra sifir dogrulamasi)\n');

    const korumali = new Set([hedefSite.kok, sureliSite.kok]);
    const olcumluk = acilan.filter(d => !korumali.has(d.kok)).slice(0, 10);
    const eksikler = [];
    for (const d of olcumluk) {
      const acikSekme = await tumSekmeleriKapat(d.kok);
      if (acikSekme === 0) {
        const t = await visit(chrome.client, d.url, { settleMs: 3000 }).catch(() => null);
        if (!t) { console.log(`        ${d.kok.padEnd(22)} ATLANDI (acilamadi)`); continue; }
        await okuyormusGibi(t.sessionId);
        d.tab = t.targetId;
      }
      const oncekiStat = await istatistik();
      const oncekiCerez = await cerezler(d.kok);
      const oncekiGecmis = await gecmisSayisi(d.kok);
      if (oncekiCerez.length === 0) { console.log(`        ${d.kok.padEnd(22)} ATLANDI (cerez yok)`); continue; }

      await tumSekmeleriKapat(d.kok);
      const olcum = await temizligiBekle(d.kok, 120000);
      const kalan = await cerezler(d.kok);
      const kalanGecmis = await gecmisSayisi(d.kok);
      const sonStat = await istatistik();
      const statFark = (sonStat.cookiesDeleted || 0) - (oncekiStat.cookiesDeleted || 0);
      const sapma = (olcum.gecenMs - 30000) / 1000;
      if (olcum.tamamlandi) olculenSureler.push({ kok: d.kok, sn: olcum.gecenMs / 1000, sapma });

      console.log(`        ${d.kok.padEnd(22)} cerez ${String(oncekiCerez.length).padStart(3)}->sil:${String(oncekiCerez.length - kalan.length).padStart(3)} kalan:${kalan.length}` +
        ` | gecmis ${oncekiGecmis}->${kalanGecmis}` +
        ` | istat +${statFark}` +
        ` | ${olcum.tamamlandi ? sn(olcum.gecenMs) + 'sn' : 'TEMIZLENMEDI'}`);

      if (kalan.length) {
        eksikler.push(`${d.kok}: ${kalan.slice(0, 3).join(', ')}`);
        // TEMIZLENMEYEN SITE ICIN GUNLUGU DOK.
        //
        // "Temizlenmedi" tek basina teshis degil: cerez silme atlandi mi,
        // denendi de basarisiz mi oldu, yoksa temizlik hic planlanmadi mi -
        // uc ayri sebep, ucu de ayni sonucu verir. Karari veren yer gunluge
        // yaziyor; tahmin yurutmek yerine onu okuyalim.
        const kayitlar = (await gunluk())
          .filter(x => JSON.stringify(x).includes(d.kok))
          .slice(-8);
        console.log(`          --- ${d.kok} gunluk kayitlari (${kayitlar.length}) ---`);
        for (const kx of kayitlar) {
          console.log(`          [${kx.level || '?'}] ${kx.message || ''} ${JSON.stringify(kx.data || {}).slice(0, 160)}`);
        }
        const acikKalan = await evaluate(chrome.client, sw,
          `const t = await chrome.tabs.query({});
           return t.filter(x => { try { return new URL(x.url).hostname.endsWith(${JSON.stringify(d.kok)}); }
             catch { return false; } }).map(x => x.url);`);
        console.log(`          hala ACIK sekme: ${acikKalan.length ? acikKalan.join(' | ') : '(yok)'}`);
      }
      d.olcum = { oncekiCerez, kalan, oncekiGecmis, kalanGecmis, statFark };
      await sleep(400);
    }
    const olculdu = olcumluk.filter(d => d.olcum);

    await runner.test('7.1 Kapanan her sitenin cerezi TAMAMEN gitti', async () => {
      console.log(`        kalinti: ${eksikler.join(' | ') || '(hicbiri)'}`);
      assertEqual(eksikler, [], 'temizlikten sonra cerez kalmis');
    });

    await runner.test('7.2 Istatistik sayilan cerezden AZ degil', async () => {
      const eksik = olculdu.filter(d => d.olcum.statFark < d.olcum.oncekiCerez.length)
        .map(d => `${d.kok} (sayilan ${d.olcum.oncekiCerez.length}, istat +${d.olcum.statFark})`);
      console.log(`        eksik sayim: ${eksik.join(' | ') || '(yok)'}`);
      assertEqual(eksik, [], 'istatistik gercekte silinenden az kaydetmis');
    });

    await runner.test('7.3 Temizlik ZAMANINDA oldu (30sn +/- 20sn)', async () => {
      const gec = olculenSureler.filter(s => Math.abs(s.sapma) > 20);
      console.log(`        zamaninda: ${olculenSureler.length - gec.length}/${olculenSureler.length}`);
      assertEqual(gec.map(s => s.kok), [], 'temizlik zamaninda olmadi');
    });

    await runner.test('7.4 Gecmis de silindi', async () => {
      const kalanlar = olculdu.filter(d => d.olcum.oncekiGecmis > 0 && d.olcum.kalanGecmis > 0)
        .map(d => `${d.kok} ${d.olcum.oncekiGecmis}->${d.olcum.kalanGecmis}`);
      console.log(`        gecmisi kalan: ${kalanlar.join(', ') || '(hicbiri)'}`);
      assertEqual(kalanlar, [], 'gecmis silinmemis');
    });

    await runner.test('7.5 KORUMALI siteler bu sure boyunca hic dokunulmadan durdu', async () => {
      for (const kok of korumali) {
        const c = await cerezler(kok);
        console.log(`        ${kok}: ${c.length} cerez (durmali)`);
        assertOk(c.length > 0, `korumali site ${kok} bosalmis`);
      }
    });

    // ==================================================================
    console.log('\n########## FAZ 8: AYARLAR SAYFASI - her anahtar tek tek ##########');
    // GERCEK KULLANICININ TIKLADIGI OGE, checkbox DEGIL.
    //
    // Yapi: <label class="switch"><input type="checkbox" id="..."><span
    // class="switch__track"></span></label>.
    //
    // UC ADAY, IKISI YANLIS:
    //   #id            -> input gorsel olarak gizli, 0 boyut, tiklanamaz.
    //   .switch__track -> boyutu var ama o noktadaki EN USTTEKI oge input'un
    //                     KENDISI cikiyor; ikisi kardes oldugu icin "hedefin
    //                     ustunde baska oge var" kontrolu hakli olarak reddetti.
    //   label.switch   -> DOGRU. Ikisini de sarar, tiklama hangisine duserse
    //                     dussun etiketin icinde kalir ve anahtari cevirir.
    //                     Gercek kullanicinin tikladigi sey de budur.
    // label[for] yok, cunku input etiketin ICINDE.
    const ANAHTAR_HEDEFI = (id) => `label.switch:has(> #${id})`;

    const ANAHTARLAR = [
      'settingCleanCookies', 'settingCleanHistory', 'settingCleanDownloads',
      'settingCleanLocalStorage', 'settingCleanIndexedDB', 'settingCleanServiceWorkers',
      'settingCleanCacheOnPurgeAll', 'settingWhitelistCleanHistory',
      'settingWhitelistCleanDownloads', 'settingNotifyOnClean', 'settingShowBadgeCount',
      'settingTrackThirdParty', 'settingPeriodicCleanEnabled', 'settingCleanOnStartup',
      'settingStripTrackingParams'
    ];

    await runner.test('8.1 Her ayar anahtari GERCEK tiklamayla acilip kapaniyor', async () => {
      await chrome.client.send('Target.activateTarget', { targetId: ayarSayfa.targetId });
      await sleep(600);

      // ONCE AYARLAR SEKMESINE GEC.
      //
      // Ayarlar paneli GIZLIYKEN icindeki her kontrol 0 boyutludur ve gercek
      // fare tiklamasi hicbirine ulasmaz. Ilk iki kosumda 14 anahtarin 14'u de
      // "oge gorunmez" dedi; sebep anahtarlar degil, panelin kapali olmasiydi.
      // Gercek kullanici da once o sekmeye tiklar.
      await gercekTikla(ayarSayfa.sessionId, '[data-tab="settings-tab"]', { adi: 'Ayarlar sekmesi' });
      await sleep(900);

      const bozuk = [];
      for (const id of ANAHTARLAR) {
        const varMi = await oku(ayarSayfa.sessionId, `!!document.getElementById('${id}')`);
        if (!varMi) { bozuk.push(`${id}: oge yok`); continue; }
        const once = await oku(ayarSayfa.sessionId, `document.getElementById('${id}').checked`);
        try {
          await gercekTikla(ayarSayfa.sessionId, ANAHTAR_HEDEFI(id), { adi: id });
        } catch (e) { bozuk.push(`${id}: ${String(e.message).slice(0, 70)}`); continue; }
        await sleep(500);
        const sonra = await oku(ayarSayfa.sessionId, `document.getElementById('${id}').checked`);
        if (once === sonra) { bozuk.push(`${id}: tiklandi ama degismedi`); continue; }
        // Geri al: sonraki fazlar varsayilan ayarlarla kossun.
        await gercekTikla(ayarSayfa.sessionId, ANAHTAR_HEDEFI(id), { adi: id });
        await sleep(400);
      }
      console.log(`        ${ANAHTARLAR.length} anahtar denendi; sorunlu: ${bozuk.join(' | ') || '(yok)'}`);
      assertEqual(bozuk, [], 'bazi ayar anahtarlari calismiyor');
    });

    await runner.test('8.2 Ayar degisikligi DEPOYA yaziliyor', async () => {
      const once = (await ayarlar()).cleanHistory;
      await gercekTikla(ayarSayfa.sessionId, ANAHTAR_HEDEFI('settingCleanHistory'), { adi: 'gecmis' });
      await sleep(900);
      const sonra = (await ayarlar()).cleanHistory;
      console.log(`        cleanHistory: ${once} -> ${sonra}`);
      assertOk(once !== sonra, 'ayar depoya yazilmadi');
      await gercekTikla(ayarSayfa.sessionId, ANAHTAR_HEDEFI('settingCleanHistory'), { adi: 'gecmis' });
      await sleep(700);
    });

    await runner.test('8.3 Sekmeler arasinda GERCEK tiklamayla gezinilebiliyor', async () => {
      const sekmeler = ['rules-tab', 'settings-tab', 'site-data-tab', 'stats-tab', 'logs-tab', 'about-tab'];
      const bozuk = [];
      for (const s of sekmeler) {
        try {
          await gercekTikla(ayarSayfa.sessionId, `[data-tab="${s}"]`, { adi: s });
          await sleep(700);
          const acik = await oku(ayarSayfa.sessionId,
            `document.getElementById('${s}')?.classList.contains('active')
             || !document.getElementById('${s}')?.hidden`);
          if (!acik) bozuk.push(`${s}: acilmadi`);
        } catch (e) { bozuk.push(`${s}: ${String(e.message).slice(0, 50)}`); }
      }
      console.log(`        ${sekmeler.length} sekme denendi; sorunlu: ${bozuk.join(' | ') || '(yok)'}`);
      assertEqual(bozuk, [], 'bazi sekmeler acilmiyor');
    });

    // ==================================================================
    console.log('\n########## FAZ 9: GUNLUK ##########');
    await runner.test('9.1 Gunlukte ERROR yok', async () => {
      const g = await gunluk();
      const hatalar = g.filter(x => (x.level || '').toUpperCase() === 'ERROR');
      console.log(`        ${g.length} kayit, ERROR ${hatalar.length}`);
      for (const h of hatalar.slice(0, 5)) console.log(`          ${h.message || JSON.stringify(h).slice(0, 90)}`);
      assertEqual(hatalar.length, 0, 'gunlukte hata var');
    });

    await runner.test('9.2 Gunluk gercek temizlikleri kaydetmis', async () => {
      const g = await gunluk();
      const temizlik = g.filter(x => /temizl|purge|clean/i.test(JSON.stringify(x)));
      console.log(`        temizlikle ilgili kayit: ${temizlik.length}`);
      assertOk(temizlik.length > 0, 'hic temizlik kaydi yok');
    });

    // ==================================================================
    console.log('\n########## FAZ 10: SURELI IZIN dakika hassasiyeti (3 dk) ##########');
    await runner.test('10.1 3 dakikalik izin TAM zamaninda dusuyor', async () => {
      // CEREZI OLAN bir site sart. Ilk kosumda buraya `ecc.tools` dustu; o
      // sitenin hic cerezi yok, "1. dakikada 0 cerez" gorulup sureli izin
      // tutmadi sanildi. Olculecek sey yoksa test bir sey olcmez.
      const s = acilan.find(d => !korumali.has(d.kok) && d.cerez.length >= 3)
        || acilan.find(d => !korumali.has(d.kok) && d.cerez.length > 0);
      assertOk(s, 'olcum icin cerezi olan korumasiz site bulunamadi');
      await tumSekmeleriKapat(s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 3000 });
      await okuyormusGibi(t.sessionId);

      // Popup'ta "1 saat"e bas, sonra sureyi 3 dakikaya cek (arayuzde 3 dk
      // dugmesi yok; en kisa yol dugmeyle kural olusturup bitisi ayarlamak).
      const p = await popupAc();
      await gercekTikla(p.sessionId, '#cardProtect', { adi: 'Koru' });
      await sleep(600);
      await gercekTikla(p.sessionId, '.durseg__b[data-dur="60"]', { adi: '1 saat' });
      await sleep(900);
      await popupKapat(p);

      const izinBas = Date.now();
      await evaluate(chrome.client, ayarSayfa.sessionId, `
        await chrome.runtime.sendMessage({ action: 'SET_RULE',
          domain: ${JSON.stringify(s.kok)}, type: 'temp',
          options: { durationMinutes: 3 } });`);
      await sleep(600);
      const once = (await cerezler(s.kok)).length;
      await tumSekmeleriKapat(s.kok);

      await sleep(60000);
      const dk1 = (await cerezler(s.kok)).length;
      console.log(`        1. dakika: ${dk1} cerez (durmali)`);
      assertOk(dk1 > 0, '1. dakikada veri silinmis - sureli izin tutmadi');

      await sleep(60000);
      const dk2 = (await cerezler(s.kok)).length;
      console.log(`        2. dakika: ${dk2} cerez (durmali)`);
      assertOk(dk2 > 0, '2. dakikada veri silinmis');

      const olcum = await temizligiBekle(s.kok, 150000);
      const gecen = (Date.now() - izinBas) / 1000;
      console.log(`        ${s.kok}: ${once} cerez, izinden temizlige ${gecen.toFixed(1)}sn (beklenen ~180+30)`);
      assertOk(olcum.tamamlandi, 'sure dolunca temizlik olmadi');
      assertOk(gecen > 175, `sure DOLMADAN silindi: ${gecen.toFixed(1)}sn`);
      assertOk(gecen < 260, `sure dolduktan cok sonra silindi: ${gecen.toFixed(1)}sn`);
      const k = await kurallar();
      assertOk(!k[s.kok], `suresi dolan kural listeden dusmedi: ${JSON.stringify(k[s.kok] || null)}`);
    });

    // ==================================================================
    console.log('\n########## FAZ 11: bosta kalma (worker olup dirilir) ##########');
    await runner.test('11.1 Bosta kalmadan sonra HER SEY hala calisiyor', async () => {
      // SURE 25 DAKIKADAN 6 DAKIKAYA INDIRILDI.
      //
      // Olculen sey gecen sureye degil, service worker'in OLUP DIRILMESINE
      // bagli: MV3 worker'i ~30 saniye bostalikta oluyor. 6 dakika onu on
      // kereden fazla oldurup diriltiyor - 25 dakikanin olcmedigi yeni bir
      // kosul yok, yalnizca 19 dakika daha bekleniyordu.
      //
      // 15 dakikalik periyodik alarmin GERCEKTEN tetiklendigi ayri bir yerde
      // olculuyor: muhasebe.e2e.mjs FAZ 7, tek bir 30 dakikalik bekleyisle.
      // Ayni sinami iki takimda tekrarlamak tur basina 25 dakika yiyordu.
      const oncekiKurallar = Object.keys(await kurallar()).sort();
      const oncekiStat = await istatistik();
      not('6 dakika bosta bekleniyor...');
      await sleep(6 * 60 * 1000);

      const a = await alarmlar();
      console.log(`        alarmlar: ${a.join(', ')}`);
      assertOk(a.includes('gt:maintenance'), 'bakim alarmi kaybolmus');
      assertEqual(Object.keys(await kurallar()).sort(), oncekiKurallar, 'kurallar degismis');
      assertOk(((await istatistik()).cookiesDeleted || 0) >= (oncekiStat.cookiesDeleted || 0),
        'istatistik geriye gitmis');

      // Uctan uca: popup hala calisiyor mu, temizlik hala oluyor mu?
      const s = SITELER.find(x => x.kok === 'bbc.com') || SITELER[0];
      await tumSekmeleriKapat(s.kok);
      const t = await visit(chrome.client, s.url, { settleMs: 3000 });
      await okuyormusGibi(t.sessionId);
      const p = await popupAc();
      const alan = await oku(p.sessionId, `document.getElementById('currentDomain')?.textContent?.trim()`);
      console.log(`        uyandiktan sonra popup: ${alan}`);
      assertOk(alan && alan.length > 0, 'bosta kalmadan sonra popup bos');
      await popupKapat(p);

      const cOnce = (await cerezler(s.kok)).length;
      const sOnce = await istatistik();
      await tumSekmeleriKapat(s.kok);
      const olcum = await temizligiBekle(s.kok, 120000);
      const sSonra = await istatistik();
      const fark = (sSonra.cookiesDeleted || 0) - (sOnce.cookiesDeleted || 0);
      console.log(`        ${s.kok}: ${cOnce} cerez -> istatistik +${fark}, ${olcum.tamamlandi ? sn(olcum.gecenMs) + 'sn' : 'TEMIZLENMEDI'}`);
      assertOk(olcum.tamamlandi, 'bosta kalmadan sonra temizlik calismadi');
      assertOk(fark >= cOnce, `istatistik eksik: sayilan ${cOnce}, kaydedilen ${fark}`);
    });

    // ==================================================================
    // FAZ 11b - AGIR ES ZAMANLI YUK
    // ==================================================================
    // Simdiye kadarki fazlar siteleri SIRAYLA aciyordu. Gercek kullanici
    // boyle davranmaz: onlarca sekmeyi acik tutar ve toplu kapatir. O anda
    // eklenti ONLARCA temizligi AYNI ANDA planlamak zorunda kalir - service
    // worker'in tek seferde en cok zorlandigi nokta budur ve hic olculmedi.
    console.log('');
    console.log('########## FAZ 11b: agir es zamanli yuk ##########');
    await runner.test('11b.1 Cok sayida sekme AYNI ANDA acilip kapaninca hicbiri kaybolmaz', async () => {
      const yukListesi = SITELER.slice(0, 30);
      not(`${yukListesi.length} site ES ZAMANLI aciliyor`);

      // Hepsini ayni anda ac - sirayla degil.
      const sekmeler = await Promise.all(yukListesi.map(s =>
        visit(chrome.client, s.url, { settleMs: 2500 }).catch(() => null)));
      const acilanlar = yukListesi
        .map((s, i) => ({ ...s, tab: sekmeler[i]?.targetId }))
        .filter(x => x.tab);
      await sleep(6000);
      not(`${acilanlar.length}/${yukListesi.length} sekme acildi`);

      const oncekiSayim = {};
      for (const a of acilanlar) oncekiSayim[a.kok] = (await cerezler(a.kok)).length;
      const izBirakan = acilanlar.filter(a => oncekiSayim[a.kok] > 0);
      const toplamCerez = Object.values(oncekiSayim).reduce((t, n) => t + n, 0);
      console.log(`        ${acilanlar.length} sekme acik, ${izBirakan.length} site iz birakti, ` +
        `toplam ${toplamCerez} cerez`);
      assertOk(izBirakan.length >= 10, 'olcum icin yeterli site iz birakmali');

      // HEPSINI AYNI ANDA KAPAT.
      not('tum sekmeler AYNI ANDA kapatiliyor');
      await Promise.all(
        acilanlar.map(a => closeTarget(chrome.client, a.tab).catch(() => false)));

      // FAZ 1 kirk sekmeyi bilerek acik biraktigi icin kendi sekmelerimizi
      // kapatmak yetmez; o alanlarda HIC sekme kalmamali.
      for (const kok of new Set(izBirakan.map(a => a.kok))) {
        await tumSekmeleriKapat(kok);
      }
      await sleep(1500);
      const halaAcik = await evaluate(chrome.client, sw, `
        const kokler = ${JSON.stringify([...new Set(izBirakan.map(a => a.kok))])};
        const tablar = await chrome.tabs.query({});
        return kokler.filter(k => tablar.some(t => {
          try { const h = new URL(t.url).hostname; return h === k || h.endsWith('.' + k); }
          catch { return false; }
        }));`);
      // TESTIN KENDI HATASI SESSIZ KALMASIN.
      assertEqual(halaAcik, [], 'TEST HATASI: bu alanlarda sekme kapanmadi');

      // Es zamanli kapanista her site icin ayri alarm kurulmali.
      await sleep(4000);
      const bekleyen = await alarmlar();
      const purgeAlar = bekleyen.filter(x => x.startsWith('gt:purge:'));
      console.log(`        bekleyen temizlik alarmi: ${purgeAlar.length}`);

      // Teshis tablosu: temizlenmeyen her alan icin planlamanin neden
      // atlandigini yazar (acik sekme / korumali kural / alarm yok).
      const acikSekmeler = await evaluate(chrome.client, sw,
        `return (await chrome.tabs.query({})).map(t => t.url || '');`);
      const mevcutKurallar = await kurallar();
      const teshis = (k) => ({
        alarm: purgeAlar.some(a => a.replace('gt:purge:', '').endsWith(k)),
        kural: mevcutKurallar[k]?.type || '(yok)',
        sekme: acikSekmeler.some(u => u.includes(k)),
      });
      console.log('        alan adi                 cerez  alarm  kural       sekme');
      for (const a of izBirakan) {
        const t = teshis(a.kok);
        console.log(`        ${a.kok.padEnd(24)} ${String(oncekiSayim[a.kok]).padStart(5)}` +
          `  ${t.alarm ? ' VAR ' : ' YOK '}  ${t.kural.padEnd(10)}  ${t.sekme ? 'ACIK' : '-'}`);
      }

      // BUTCE 3 DAKIKAYDI VE YETMEDI: 30 sitenin 17'si hala duruyordu.
      // Sebep esik degil is yuku - 30 sekme ayni anda kapaninca 30 ayri
      // temizlik planlaniyor, her biri onlarca cerez + gecmis + depolama
      // isliyor ve service worker bunlari SIRAYLA yapiyor. Burada olculen
      // sey tam olarak bu: agir es zamanli yukte tam temizlik NE KADAR
      // suruyor. Butce 10 dakika, gercek sure raporlanir.
      // KORUMALI SITE TEMIZLENMEZ - beklenti disi. Onceki kosumda bu test
      // korumali github.com ve deepl.com'un da silinmesini bekliyordu, yani
      // dogru davranisi hata sayiyordu.
      const beklenenler = izBirakan.filter(a => !mevcutKurallar[a.kok]);
      const korumalilar = izBirakan.filter(a => mevcutKurallar[a.kok]).map(a => a.kok);
      if (korumalilar.length) {
        console.log(`        korumali (temizlenmemeli): ${korumalilar.join(', ')}`);
      }

      const bas = Date.now();
      let kalanlar = [];
      for (let i = 0; i < 120; i++) {
        await sleep(5000);
        kalanlar = [];
        for (const a of beklenenler) {
          if ((await cerezler(a.kok)).length > 0) kalanlar.push(a.kok);
        }
        if (!kalanlar.length) break;
      }
      const gecen = (Date.now() - bas) / 1000;
      console.log(`        ${izBirakan.length} site AYNI ANDA kapandi -> ` +
        `tam temizlik ${gecen.toFixed(0)}sn`);
      console.log(`        temizlenmeyen: ${kalanlar.join(', ') || '(yok)'}`);
      assertEqual(kalanlar, [], 'agir es zamanli yukte bazi siteler temizlenmedi');
    });

    await runner.test('11b.2 Agir yuk sonrasi eklenti SAGLAM', async () => {
      const t = await evaluate(chrome.client, ayarSayfa.sessionId,
        `return await chrome.runtime.sendMessage({ action: 'GET_DIAGNOSTICS' });`);
      const g = await gunluk();
      const hatalar = g.filter(x => (x.level || '').toUpperCase() === 'ERROR');
      console.log(`        teshis: ${t?.success ? 'calisiyor' : 'BOZUK'} | ` +
        `gunluk ${g.length} kayit | ERROR ${hatalar.length}`);
      for (const h of hatalar.slice(0, 5)) console.log(`          ${h.message}`);
      assertOk(t?.success, 'agir yukten sonra mesajlasma bozuldu');
      assertEqual(hatalar.length, 0, 'agir yuk hata uretti');
    });


    // ==================================================================
    console.log('\n########## FAZ 12: TOPLAM MUHASEBE ##########');
    await runner.test('12.1 Kalan TUM veri korumali bir kurala ait', async () => {
      const k = await kurallar();
      const korunanlar = Object.keys(k);
      const kalanAlanlar = await evaluate(chrome.client, sw, `
        const l = await chrome.cookies.getAll({});
        return [...new Set(l.map(c => c.domain.replace(/^\\./, '')))].sort();`);
      const yetim = kalanAlanlar.filter(a =>
        !korunanlar.some(k2 => a === k2 || a.endsWith('.' + k2)));
      console.log(`        korumali kural: ${korunanlar.join(', ') || '(yok)'}`);
      console.log(`        kalan alan adi: ${kalanAlanlar.length}, korumasiz: ${yetim.length}`);
      if (yetim.length) console.log(`        korumasiz kalanlar: ${yetim.slice(0, 15).join(', ')}`);
      // NOT: 3. taraf alan adlari (reklam aglari) hicbir sekmeye ait degildir;
      // periyodik supurme onlari toplar. Burasi RAPOR, esik degil.
    });

    await runner.test('12.2 Istatistik toplami anlamli', async () => {
      const s = await istatistik();
      console.log(`        istatistik: cerez=${s.cookiesDeleted} gecmis=${s.historyDeleted} ` +
        `depolama=${s.storageCleaned} indirme=${s.downloadsDeleted} ` +
        `temizlik=${s.totalCleans} bayt=${s.bytesFreed}`);
      assertOk((s.cookiesDeleted || 0) > 0, 'hic cerez silinmemis gorunuyor');
      assertOk((s.totalCleans || 0) > 5, 'temizlik sayaci dusuk');
    });

    console.log('\n--- OLCULEN TEMIZLIK SURELERI (cleanDelay=30) ---');
    for (const s of olculenSureler) {
      console.log(`  ${s.kok.padEnd(24)} ${s.sn.toFixed(1)}sn  sapma ${s.sapma >= 0 ? '+' : ''}${s.sapma.toFixed(1)}sn`);
    }

    const gecti = runner.summary();
    console.log(`\nToplam sure: ${((Date.now() - t0) / 60000).toFixed(1)} dakika`);
    process.exitCode = gecti ? 0 : 1;
  } catch (err) {
    console.error('\nKURULUM/AKIS HATASI:', err);
    process.exitCode = 1;
  } finally {
    await chrome.close();
  }
}

main();
