// GhostTrace - Istatistik sekmesi: "Son temizlikler" ve "En cok" listeleri.

import { t } from '../../lib/i18n.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import { el, h, qsa } from '../ui/dom.js';
import { registerView } from '../ui/refresh.js';
import { formatLogTime, isCleanupSummary } from '../../lib/logger.js';
import { setActive } from '../../ui/segmented.js';

const SON_TEMIZLIK_SAYISI = 15;
const TOP_SAYISI = 8;

const ui = {
  sonBody: el('recentCleanupsBody'),
  sonEmpty: el('recentCleanupsEmpty'),
  topSection: el('topCleanedSection'),
  topBody: el('topCleanedBody'),
  topTitle: el('topCleanedTitle'),
  topDesc: el('topCleanedDesc'),
  topEmpty: el('topCleanedEmpty'),
  topEmptyDesc: el('topCleanedEmptyDesc'),
  basSayi: el('topCleanedCountHead'),
  basNe: el('topCleanedWhatHead')
};

/** Hangi sekme acik: 'cleaned' | 'thirdparty' */
let aktifSekme = 'cleaned';
// Kalici 3. taraf gecmisi var mi? Sutun basligi buna gore degisir.
let kaliciUcuncuTaraf = false;

/** "7 Cerez, 2 Gecmis" - SIFIR olan turler yazilmaz. */
function neSilindi(details) {
  const parcalar = [];
  if (details.cookies > 0) parcalar.push(`${details.cookies} ${t('common.cookies')}`);
  if (details.history > 0) parcalar.push(`${details.history} ${t('common.history')}`);
  if (details.downloads > 0) parcalar.push(`${details.downloads} ${t('common.downloads')}`);
  return parcalar.length ? parcalar.join(', ') : '—';
}

/** Site basina temizlik toplami - YALNIZCA ANA SITELER; 3. taraflar komsu sekmede. */
function temizlenenSiralamasi(temizlikler, thirdPartySeen, visitedRoots, kalici = null) {
  const sayim = thirdPartySeen || {};
  const ziyaret = visitedRoots || {};
  const ucuncuTarafMi = (host) => Boolean(sayim[host]) && !ziyaret[host];
  const sayac = new Map();
  for (const kayit of temizlikler) {
    if (ucuncuTarafMi(kayit.domain)) continue;
    const mevcut = sayac.get(kayit.domain)
      || { adet: 0, cookies: 0, history: 0, downloads: 0 };
    mevcut.adet++;
    mevcut.cookies += kayit.details.cookies || 0;
    mevcut.history += kayit.details.history || 0;
    mevcut.downloads += kayit.details.downloads || 0;
    sayac.set(kayit.domain, mevcut);
  }
  // Kalici gecmis acikSA sayi ONDAN gelir: bu oturumu zaten iceriyor, ayrica
  // onceki oturumlarda temizlenip bu oturumda hic gorulmeyenleri de getirir.
  for (const [domain, kayit] of Object.entries(kalici || {})) {
    if (ucuncuTarafMi(domain)) continue;
    const mevcut = sayac.get(domain) || { adet: 0, cookies: 0, history: 0, downloads: 0 };
    mevcut.adet = kayit.n || mevcut.adet;
    sayac.set(domain, mevcut);
  }
  return [...sayac.entries()]
    .sort((a, b) => b[1].adet - a[1].adet
      || (b[1].cookies + b[1].history) - (a[1].cookies + a[1].history))
    .slice(0, TOP_SAYISI);
}

/** 3. taraf siralamasi KARSILASMA sayimindan (canli haritadan degil): canli harita her temizlikte budaniyor ve liste bosaliyordu. */
function ucuncuTarafSiralamasi(thirdPartySeen, visitedRoots, kalici = null) {
  const ziyaret = visitedRoots || {};
  // IKI OLCU KARISTIRILMAZ. Oturum haritasi "kac FARKLI sitede gorundu"yu
  // bilir; kalici kayit bunu bilemez (hangi sitede goruldugu gizlilik geregi
  // saklanmiyor), yalnizca KARSILASMA sayisini tutar. Kalici gecmis acikken
  // siralama karsilasmaya gecer - yoksa onceki oturumlarin kayitlari
  // "0 sitede" gorunup listenin dibine duserdi.
  const kaliciVar = Object.keys(kalici || {}).length > 0;
  const birlesik = { ...(thirdPartySeen || {}) };
  for (const [domain, kayit] of Object.entries(kalici || {})) {
    const mevcut = birlesik[domain] || { count: 0, sites: [], lastSeen: 0 };
    birlesik[domain] = { ...mevcut, kaliciSayi: kayit.n || 0 };
  }
  return Object.entries(birlesik)
    // KENDI actiginiz siteler bu listeye girmez.
    .filter(([domain]) => !ziyaret[domain])
    .map(([domain, kayit]) => [domain, {
      siteSayisi: kaliciVar
        ? (kayit.kaliciSayi || kayit.count || 0)      // karsilasma
        : (kayit.sites || []).length,                 // kac farkli sitede
      istek: kayit.count || 0
    }])
    .sort((a, b) => b[1].siteSayisi - a[1].siteSayisi || b[1].istek - a[1].istek)
    .slice(0, TOP_SAYISI);
}

function sekmeCiz(temizlenen, ucuncuTaraf) {
  if (!ui.topBody) return;
  const ucuncu = aktifSekme === 'thirdparty';
  const satirlar = ucuncu ? ucuncuTaraf : temizlenen;

  // Sutun basliklari sekmeye gore degisir: iki liste FARKLI seyler sayiyor.
  if (ui.basSayi) {
    // Kalici gecmis acikken sutun KARSILASMA sayar, "kac sitede" degil.
    const ucuncuBaslik = kaliciUcuncuTaraf
      ? 'options.thirdPartyEncounters' : 'options.thirdPartySeenIn';
    ui.basSayi.textContent = t(ucuncu ? ucuncuBaslik : 'options.topCleanedCount');
  }
  if (ui.basNe) {
    ui.basNe.textContent = t(ucuncu ? 'options.thirdPartyRequests' : 'options.recentCleanupsWhat');
  }
  // BASLIK da degismeli: "En cok temizlenen siteler" basligi altinda 3. taraf listesi gostermek yaniltici olur.
  if (ui.topTitle) {
    ui.topTitle.textContent = t(ucuncu ? 'options.topThirdPartyTitle' : 'options.topCleanedTitle');
  }
  if (ui.topDesc) {
    ui.topDesc.textContent = t(ucuncu ? 'options.topThirdPartyDesc' : 'options.topCleanedDesc');
  }

  ui.topBody.replaceChildren();
  // Bu bir SIRALAMA; kacinci oldugu gorunmeden "en cok" basligi soyut kalir.
  let sira = 0;
  for (const [domain, veri] of satirlar) {
    sira++;
    ui.topBody.append(h('tr', {}, [
      h('td', { class: 'rank-cell', text: String(sira) }),
      h('td', { class: 'domain-cell', text: domain }),
      h('td', { class: 'mono', text: String(ucuncu ? veri.siteSayisi : veri.adet) }),
      h('td', ucuncu
        ? { class: 'mono', text: String(veri.istek) }
        : { text: neSilindi(veri) })
    ]));
  }

  const bos = satirlar.length === 0;
  ui.topEmpty?.classList.toggle('hidden', !bos);
  if (bos && ui.topEmptyDesc) {
    ui.topEmptyDesc.textContent = t(ucuncu
      ? 'options.topCleanedEmptyThird'
      : 'options.topCleanedEmptyCleaned');
  }
}

/** Sekme dugmelerinin gorunumunu gunceller (yeniden cizim YAPMAZ). */
function sekmeIsaretle(ad) {
  aktifSekme = ad;
  for (const dugme of qsa('#topCleanedSection [data-insight]')) {
    setActive(dugme, dugme.dataset.insight === ad);
  }
}

/** Modul durumunu sifirlar (YALNIZCA testler icin). */
export function __resetInsightsForTests() {
  aktifSekme = 'cleaned';
}

export async function renderInsights() {
  if (!ui.sonBody) return;

  const [logYanit, siteYanit] = await Promise.all([
    sendToBackground(Action.GET_LOGS, { limit: 500 }),
    sendToBackground(Action.GET_ALL_STORED_DOMAINS)
  ]);

  const temizlikler = (logYanit?.logs || []).filter(isCleanupSummary);

  // --- Son temizlikler ---
  ui.sonBody.replaceChildren();
  for (const kayit of temizlikler.slice(0, SON_TEMIZLIK_SAYISI)) {
    ui.sonBody.append(h('tr', {}, [
      h('td', { class: 'log-time', text: formatLogTime(kayit) }),
      h('td', { class: 'domain-cell', text: kayit.domain }),
      h('td', { text: neSilindi(kayit.details) })
    ]));
  }
  ui.sonEmpty?.classList.toggle('hidden', temizlikler.length > 0);

  // --- Sekmeli "en cok" listeleri --- "En az iki kez temizlenmisse goster" bastirmasi kaldirildi: normal kullanimda her site birer kez temizlenir, sekme hep bos kaliyordu.
  const temizlenen = temizlenenSiralamasi(
    temizlikler, siteYanit?.thirdPartySeen, siteYanit?.visitedRoots,
    siteYanit?.statsHistory?.sites);
  kaliciUcuncuTaraf = Object.keys(siteYanit?.statsHistory?.thirdParty || {}).length > 0;
  const ucuncuTaraf = ucuncuTarafSiralamasi(siteYanit?.thirdPartySeen, siteYanit?.visitedRoots,
    siteYanit?.statsHistory?.thirdParty);

  // Otomatik sekme gecisi YOK: kullanicinin tiklamasini geri aliyor ve acilista yanlis sekmeyi aktif yapiyordu.

  sekmeCiz(temizlenen, ucuncuTaraf);

  // Iki sekme de bossa bolumu hic gosterme.
  ui.topSection?.classList.toggle('hidden',
    temizlenen.length === 0 && ucuncuTaraf.length === 0);
}

for (const dugme of qsa('#topCleanedSection [data-insight]')) {
  dugme.addEventListener('click', () => {
    sekmeIsaretle(dugme.dataset.insight);
    void renderInsights();
  });
}

registerView('stats', renderInsights);
