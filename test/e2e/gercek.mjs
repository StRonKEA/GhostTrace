// GhostTrace E2E - GERCEK SITE olcum modulu.
//
// TAKLIT SITE YOK. Bu depoda uzun sure yerel bir HTTP sunucusu kullanildi:
// her "site" tam 3 cerez birakiyor, localStorage anahtari biliniyor, sayilar
// sabit. Tekrarlanabilirligi yuksekti ama gercekligi yoktu ve gercek sitelerde
// bulunan uc hatanin ucu de taklitte GORUNMUYORDU.
//
// Buradaki her olcum GERCEK sitelere karsi yapilir. Sabit sayi iddia edilemez,
// o yuzden yontem farkli:
//
//   ENVANTER YONTEMI: sekme kapanmadan hemen once TAM LISTE cikarilir (hangi
//   cerez, hangi alan adinda; kac gecmis kaydi; kac bayt depolama). Temizlikten
//   sonra AYNI listenin sifirlandigi dogrulanir. Sayi degisken, muhasebe birebir.
//
// DEPOLAMA GERCEK SITEDE NASIL OLCULUR: sayfayi yeniden ziyaret etmek veriyi
// yeniden yaratir, yani "silindi mi?" sorusunu bozar. Cozum olculdu:
// `navigator.storage.estimate().usage` sayfa acilir acilmaz okunur. Gercek
// ornek - bbc.com: ziyaret sonrasi 229376 bayt, temizlik sonrasi 0. Sitenin
// kendi betikleri ilk saniyede birkac anahtar yazsa bile 229376 ile 0
// arasindaki fark tartismasizdir.

import { visit, closeTarget, evaluate, sleep } from './harness.mjs';

// --------------------------------------------------------------------------
// SITE KATALOGU - hepsi gercek
// --------------------------------------------------------------------------
/** Kullanicinin kendi yer imleri. */
export const YER_IMLERI = [
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
  { url: 'https://www.google.com/', kok: 'google.com' }
];

/** Reklam yuku agir siteler - ucuncu taraf ve depolama uretimi en yuksek. */
export const REKLAM_YOGUN = [
  { url: 'https://www.bbc.com/news', kok: 'bbc.com' },
  { url: 'https://www.cnn.com/', kok: 'cnn.com' },
  { url: 'https://www.hurriyet.com.tr/', kok: 'hurriyet.com.tr' },
  { url: 'https://www.milliyet.com.tr/', kok: 'milliyet.com.tr' },
  { url: 'https://www.sozcu.com.tr/', kok: 'sozcu.com.tr' },
  { url: 'https://www.sabah.com.tr/', kok: 'sabah.com.tr' },
  { url: 'https://www.haberturk.com/', kok: 'haberturk.com' },
  { url: 'https://www.cnnturk.com/', kok: 'cnnturk.com' },
  { url: 'https://www.ntv.com.tr/', kok: 'ntv.com.tr' },
  { url: 'https://www.ensonhaber.com/', kok: 'ensonhaber.com' },
  { url: 'https://www.mynet.com/', kok: 'mynet.com' },
  { url: 'https://onedio.com/', kok: 'onedio.com' },
  { url: 'https://www.dailymail.co.uk/', kok: 'dailymail.co.uk' },
  { url: 'https://www.forbes.com/', kok: 'forbes.com' }
];

/** E-ticaret - yeniden hedefleme pikselleri yogun. */
export const ETICARET = [
  { url: 'https://www.hepsiburada.com/', kok: 'hepsiburada.com' },
  { url: 'https://www.trendyol.com/', kok: 'trendyol.com' },
  { url: 'https://www.n11.com/', kok: 'n11.com' },
  { url: 'https://www.amazon.com.tr/', kok: 'amazon.com.tr' },
  { url: 'https://www.gittigidiyor.com/', kok: 'gittigidiyor.com' },
  { url: 'https://www.sahibinden.com/', kok: 'sahibinden.com' },
  { url: 'https://www.booking.com/', kok: 'booking.com' }
];

/** Genel/populer. */
export const POPULER = [
  { url: 'https://tr.wikipedia.org/wiki/Gizlilik', kok: 'wikipedia.org' },
  { url: 'https://stackoverflow.com/', kok: 'stackoverflow.com' },
  { url: 'https://www.reddit.com/', kok: 'reddit.com' },
  { url: 'https://eksisozluk.com/', kok: 'eksisozluk.com' },
  { url: 'https://www.imdb.com/', kok: 'imdb.com' },
  { url: 'https://www.theguardian.com/international', kok: 'theguardian.com' },
  { url: 'https://twitch.tv/', kok: 'twitch.tv' },
  { url: 'https://www.pinterest.com/', kok: 'pinterest.com' },
  { url: 'https://tr.investing.com/', kok: 'investing.com' }
];

/**
 * GERCEK alt alan adi aileleri - kapsam testleri icin.
 *
 * Taklit ortamda `alt.ornek.example` uydurulabiliyordu. Gercekte alt alan
 * adinin kendi cerezi olmasi ve ustten AYRI davranmasi sart; asagidakiler
 * bu ozelligi tasiyan gercek aileler.
 */
export const AILELER = [
  { kok: 'wikipedia.org', ust: 'https://www.wikipedia.org/',
    alt: 'https://tr.wikipedia.org/wiki/Ana_Sayfa', altKok: 'tr.wikipedia.org' },
  { kok: 'google.com', ust: 'https://www.google.com/',
    alt: 'https://news.google.com/', altKok: 'news.google.com' }
];

export const TUM_SITELER = [...YER_IMLERI, ...REKLAM_YOGUN, ...ETICARET, ...POPULER];

// --------------------------------------------------------------------------
// GERCEK KULLANICI DAVRANISI
// --------------------------------------------------------------------------
/**
 * Sayfayi okuyormus gibi kullanir: kademe kademe iner, durur, cikar, ayni
 * sitede kalan bir ic baglantiya tiklar.
 *
 * NEDEN: bircok site cerezi ILK YUKLEMEDE degil, etkilesimden sonra birakir
 * (kaydirma, riza banneri, tembel yuklenen reklam). Sadece acip kapatan bir
 * test gercek kullanicinin biraktigi izin bir kismini hic gormez. Olculdu:
 * ic baglantiya tiklayinca instagram.com 5 yerine 7 cerez birakiyor.
 */
export async function okuyormusGibi(client, sessionId, { tikla = true } = {}) {
  const calistir = (ifade) => client.send('Runtime.evaluate',
    { expression: ifade, awaitPromise: true, returnByValue: true }, sessionId)
    .catch(() => null);

  for (let i = 0; i < 4; i++) {
    await calistir('window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" }); 1');
    await sleep(1000);
  }
  await sleep(1500);                                   // "okuma" duraklamasi
  await calistir('window.scrollTo({ top: 0, behavior: "smooth" }); 1');
  await sleep(900);
  if (!tikla) return null;

  // AYNI SITEDE kalan bir baglanti: disari cikan baglanti olcumu bozardi.
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
  await sleep(2200);
  return gidilen?.result?.value || null;
}

// --------------------------------------------------------------------------
// OLCUM
// --------------------------------------------------------------------------
/** Kokun ve alt alan adlarinin cerezleri: "alanadi|isim" listesi. */
export const cerezler = (client, sw, kok) => evaluate(client, sw,
  `const l = await chrome.cookies.getAll({ domain: ${JSON.stringify(kok)} });
   return l.map(c => c.domain.replace(/^\\./, '') + '|' + c.name).sort();`);

/**
 * Envanter aninda suresi ZATEN dolmus cerez sayisi. Kendi kendine sona eren
 * cerez istatistige girmez; ayirmazsak "istatistik eksik sayiyor" saniriz.
 */
export const dogalSonaErenSayisi = async (client, sw, kok, payMs = 0) => {
  const l = await evaluate(client, sw,
    `const l = await chrome.cookies.getAll({ domain: ${JSON.stringify(kok)} });
     return l.map(c => c.expirationDate || null);`);
  // SORU "su an dolmus mu" DEGIL, "biz silmeden ONCE dolacak mi". Olculdu:
  // edition.cnn.com|wbdFch 30 saniyelik omurluydu, envanterde sagdi, cleanDelay
  // sonrasi silme sirasi geldiginde kendi kendine gitmisti - eklenti 28 sildi,
  // envanter 29 saymisti. Pay temizlik penceresi kadar verilir.
  const sinir = (Date.now() + payMs) / 1000;
  return l.filter(t => t && t <= sinir).length;
};

/** Yalnizca bu hostun cerezleri (alt alan adlari HARIC). */
export const cerezlerKesin = (client, sw, host) => evaluate(client, sw,
  `const l = await chrome.cookies.getAll({ domain: ${JSON.stringify(host)} });
   return l.filter(c => c.domain.replace(/^\\./, '') === ${JSON.stringify(host)})
           .map(c => c.name).sort();`);

export const gecmisSayisi = (client, sw, kok) => evaluate(client, sw,
  `const r = await chrome.history.search({ text: ${JSON.stringify(kok)},
     startTime: 0, maxResults: 1000 });
   return r.filter(x => { try {
     const h = new URL(x.url).hostname;
     return h === ${JSON.stringify(kok)} || h.endsWith('.' + ${JSON.stringify(kok)});
   } catch { return false; } }).length;`);

export const istatistik = (client, sw) => evaluate(client, sw,
  `return (await chrome.storage.local.get('stats')).stats || {};`);

export const kurallar = (client, sw) => evaluate(client, sw,
  `return (await chrome.storage.local.get('rules')).rules || {};`);

export const alarmlar = (client, sw) => evaluate(client, sw,
  `return (await chrome.alarms.getAll()).map(a => a.name).sort();`);

export const gunluk = (client, sw) => evaluate(client, sw,
  `return (await chrome.storage.session.get('gt_logs')).gt_logs || [];`);

/**
 * Bir kokenin DEPOLAMA buyuklugu - SITEYI ACMADAN.
 *
 * OLCUM TUZAGI, gercek olculdu: depolamayi okumak icin siteyi yeniden acmak
 * SONUCU BOZAR. Sayfa yuklenir yuklenmez service worker YENIDEN KAYDOLUR ve
 * IndexedDB YENIDEN YARATILIR; olcum "silinmemis" gosterir. Bu tuzaga bir kez
 * dusuldu ve neredeyse OLMAYAN bir urun hatasi bildirilecekti:
 *
 *   siteyi yeniden acarak  -> 217923 -> 217923  ("silinmedi" gibi)
 *   about:blank uzerinden  -> 217923 -> 0        (gercek: silinmis)
 *
 * Cozum: olcum ILGISIZ bir sayfa oturumundan yapilir. CDP'nin
 * `Storage.getUsageAndQuota` komutu hedef kokeni parametre alir; o kokenin
 * sayfasinin acik olmasi GEREKMEZ. Tarayici duzeyinde calismiyor, sayfa
 * oturumu sart - bu yuzden bir kerelik about:blank sekmesi tutulur.
 */
let _olcumSekmesi = null;
export async function depolamaOlc(client, url) {
  const koken = new URL(url).origin;
  if (!_olcumSekmesi) {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    _olcumSekmesi = { targetId, sessionId };
  }
  const r = await client.send('Storage.getUsageAndQuota', { origin: koken }, _olcumSekmesi.sessionId)
    .catch(() => null);
  if (!r) return { okunamadi: true, koken };
  const dokum = {};
  for (const x of r.usageBreakdown || []) if (x.usage > 0) dokum[x.storageType] = x.usage;
  return { koken, usage: r.usage, dokum };
}

/** Bu kok icin acik TUM sekmeleri kapatir; kac tane oldugunu doner. */
export async function tumSekmeleriKapat(client, kok) {
  const { targetInfos } = await client.send('Target.getTargets');
  let n = 0;
  for (const t of targetInfos) {
    if (t.type !== 'page') continue;
    if (t.url.startsWith('chrome-extension://')) continue;
    let h = '';
    try { h = new URL(t.url).hostname; } catch { continue; }
    if (h === kok || h.endsWith('.' + kok)) {
      await closeTarget(client, t.targetId).catch(() => {});
      n++;
    }
  }
  if (n) await sleep(700);
  return n;
}

/** Olcum icin TEK sekme acar: once o kokun butun sekmelerini kapatir. */
export async function olcumIcinAc(client, url, kok, { settleMs = 3000 } = {}) {
  await tumSekmeleriKapat(client, kok);
  await sleep(400);
  return visit(client, url, { settleMs });
}

/** Cerezler sifirlanana kadar bekler. */
export async function temizligiBekle(client, sw, kok, azamiMs = 120000) {
  const bas = Date.now();
  while (Date.now() - bas < azamiMs) {
    if ((await cerezler(client, sw, kok)).length === 0) {
      return { gecenMs: Date.now() - bas, tamamlandi: true };
    }
    await sleep(1000);
  }
  return { gecenMs: Date.now() - bas, tamamlandi: false };
}

/**
 * ENVANTER + TEMIZLIK + DOGRULAMA, tek cagride.
 *
 * Gercek sitede sabit sayi iddia edilemez; bu yuzden kapanistan ONCE tam
 * envanter alinir ve sonra AYNI listenin sifirlandigi dogrulanir.
 */
export async function muhasebeliTemizlik(client, sw, site, { beklenenSn = 30 } = {}) {
  await tumSekmeleriKapat(client, site.kok);
  const t = await visit(client, site.url, { settleMs: 3500 }).catch(() => null);
  if (!t) return { acilamadi: true, kok: site.kok };
  await okuyormusGibi(client, t.sessionId);

  const oncekiCerez = await cerezler(client, sw, site.kok);
  const oncekiGecmis = await gecmisSayisi(client, sw, site.kok);
  const sOnce = await istatistik(client, sw);

  const bas = Date.now();
  await tumSekmeleriKapat(client, site.kok);
  const olcum = await temizligiBekle(client, sw, site.kok, 120000);
  const sSonra = await istatistik(client, sw);

  return {
    kok: site.kok,
    sayilan: oncekiCerez.length,
    kalan: (await cerezler(client, sw, site.kok)).length,
    gecmisOnce: oncekiGecmis,
    gecmisKalan: await gecmisSayisi(client, sw, site.kok),
    istatistikFark: (sSonra.cookiesDeleted || 0) - (sOnce.cookiesDeleted || 0),
    tamamlandi: olcum.tamamlandi,
    sureSn: olcum.gecenMs / 1000,
    sapmaSn: (olcum.gecenMs - beklenenSn * 1000) / 1000,
    gecenToplamMs: Date.now() - bas
  };
}
