// GhostTrace - Popup davranis testleri
//
// NEDEN VAR: popup/popup.js beyaz liste kapsam menusunu kuruyor ama hic
// davranis testi yoktu. Kapsam kilidi (alt alan adinda "tum alt alan adlari"
// secenegini disabled etmek) tam burada yasiyordu ve options paneli testleri
// bu dosyaya hic dokunmuyordu - iki arayuz birbirinden sessizce sapabilirdi.
//
// DOM taklidi gercek popup.html'den kuruluyor (bkz. helpers/dom-stub.js):
// HTML'de olmayan bir id'yi arayan kod testte de bulamaz.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { installChromeStub } from './helpers/chrome-stub.js';
import { installDom } from './helpers/dom-stub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let dom;
/** Aktif sekme bilgisi: her test kendi senaryosunu buraya yazar. */
let tabInfo;
/** Popup'in arka plana attigi mesajlar. */
let sent;

function activeTabInfo(overrides = {}) {
  return {
    success: true,
    isInternal: false,
    isIncognito: false,
    domain: 'mail.google.com',
    rawHost: 'mail.google.com',
    url: 'https://mail.google.com/',
    title: 'Mail',
    isSubdomain: true,
    rootDomain: 'google.com',
    ruleType: 'default',
    rule: null,
    matchedDomain: null,
    cookieCount: 3,
    historyCount: 2,
    downloadCount: 0,
    totalTraces: 5,
    thirdPartyCount: 6,
    enabled: true,
    cleanDelay: 60,
    hasHostAccess: true,
    ...overrides
  };
}

// popup.js gercek tarayicida sayfa kapaninca temizlenen bir geri sayim
// zamanlayicisi kuruyor (startCountdown). node:test'te sayfa kapanmadigi icin
// bu zamanlayici sureci canli tutar ve kosum ASILIR. unref ederek davranisi
// degistirmeden surecin bitmesine izin veriyoruz.
const realSetInterval = globalThis.setInterval;
/** startCountdown'in geri cagrisi: canli tazeleme testleri bunu ELLE tiklatir. */
let tikFn = null;
globalThis.setInterval = (fn, ms) => {
  if (ms === 1000) tikFn = fn;
  const handle = realSetInterval(fn, ms);
  if (typeof handle?.unref === 'function') handle.unref();
  return handle;
};

/** METRIK_TIK = 2, yani sayilar iki tikta bir tazeleniyor. */
async function tikla(adet = 2) {
  for (let i = 0; i < adet; i++) tikFn?.();
  await new Promise(resolve => setTimeout(resolve, 30));
}

let instanceCounter = 0;

/**
 * Popup'i SIFIRDAN yukler.
 *
 * Modulu yeniden ice aktarmanin sebebi: popup.js durumunu modul kapsaminda
 * tutuyor ve loadActiveTab'i disari acmiyor; "sekme degisti" senaryosunu
 * taklit etmenin tek durust yolu taze bir ornek. Onceki denemede ana anahtar
 * uzerinden yeniden yukleme kurgulanmisti ama o dinleyici loadActiveTab
 * CAGIRMIYOR - test yesil gorunup aslinda ilk yuklemeyi olcuyordu.
 */
async function loadPopup(overrides = {}) {
  installChromeStub({ tabs: [] });
  dom = installDom(join(ROOT, 'popup', 'popup.html'));

  tabInfo = activeTabInfo(overrides);
  sent = [];
  chrome.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    if (msg?.action === 'GET_ACTIVE_TAB_INFO') return tabInfo;
    return { success: true };
  };

  await import(`../popup/popup.js?instance=${++instanceCounter}`);
  await new Promise(resolve => setTimeout(resolve, 40));
  return dom;
}

const SUBDOMAIN_TAB = { domain: 'mail.google.com', isSubdomain: true, rootDomain: 'google.com' };
const ROOT_TAB = { domain: 'google.com', isSubdomain: false, rootDomain: 'google.com' };

/**
 * Kapsam menusu YALNIZCA site korumaliyken gorunur (protectOpts gizli degil).
 * Kapsam testleri o durumu kurmali; korumasiz bir sitede menu zaten
 * erisilemez ve SET_RULE_SCOPE'un karsiligi olan kural yoktur.
 */
const korumali = (tab) => ({
  ...tab,
  ruleType: 'white',
  rule: { domain: tab.domain, type: 'white', subdomains: true, keepMode: 'all', keepCookies: [] }
});

describe('popup: sayilar SAYFA YENILEMEDEN tazelenir', () => {
  // Kullanici bildirdi: 3. taraf sayisi ilk anda 0 ve dolmasi icin sayfayi
  // yenilemek gerekiyor. Sebep gozlemcinin 3 saniyelik flush penceresi;
  // cozum popup'in sayilari canli tazelemesi.

  test('yeni sayilar panel yeniden kurulmadan yansir', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    assert.equal(dom.byId('thirdPartyCount').textContent, '6');
    assert.equal(dom.byId('cookieCount').textContent, '3');

    // Sayfa bu arada yeni 3. taraf yukledi ve cerez yazdi.
    tabInfo = activeTabInfo({ ...SUBDOMAIN_TAB, thirdPartyCount: 81, cookieCount: 12 });
    await tikla();

    assert.equal(dom.byId('thirdPartyCount').textContent, '81');
    assert.equal(dom.byId('cookieCount').textContent, '12');
  });

  // ASIL KORUMA: onay metni EKRANDAKI sayilardan kuruluyor (onayiAc).
  // Sayilar onay acikken degisirse kullanici baska bir sey onaylar.
  test('ONAY ACIKKEN sayilar DONDURULUR', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    await dom.byId('btnPurgeNow')._fire('click');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.byId('confirmBox').classList.contains('hidden'), false,
      'on kosul: onay acik olmali');

    tabInfo = activeTabInfo({ ...SUBDOMAIN_TAB, thirdPartyCount: 81, cookieCount: 12 });
    await tikla();

    assert.equal(dom.byId('cookieCount').textContent, '3', 'onay acikken sayi degismemeli');
    assert.equal(dom.byId('thirdPartyCount').textContent, '6');
  });

  test('AKTIF SEKME degistiyse tum panel tazelenir', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    assert.equal(dom.byId('currentDomain').textContent, 'mail.google.com');

    tabInfo = activeTabInfo({ ...ROOT_TAB, thirdPartyCount: 2, cookieCount: 1 });
    await tikla();

    assert.equal(dom.byId('currentDomain').textContent, 'google.com',
      'yalnizca sayilar degil alan adi da guncellenmeli');
    assert.equal(dom.byId('thirdPartyCount').textContent, '2');
  });
});

describe('popup: DOM taklidi gercek popup.html ile uyusuyor', () => {
  test('kapsam seridi ogeleri bulunuyor', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    assert.ok(dom.byId('scopeSeg'), 'scopeSeg bulunmali');
    assert.ok(dom.byId('scopeExact'), 'scopeExact bulunmali');
    assert.ok(dom.byId('scopeSubs'), 'scopeSubs bulunmali');
  });

  test('aktif sekme bilgisi arayuze yansiyor', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    assert.equal(dom.byId('currentDomain').textContent, 'mail.google.com');
    assert.equal(dom.byId('cookieCount').textContent, '3');
  });
});

describe('popup: alt alan adinda kapsam secenegi SECILEBILIR (v2.7.0)', () => {
  test('alt alan adinda "alt alan adlarini da kapsa" KILITLI DEGIL', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    assert.equal(dom.byId('scopeSubs').disabled, false,
      'alt alan adinda kapsam secenegi tiklanabilir olmali');
  });

  test('secenek tiklaninca subdomains:true ile SET_RULE_SCOPE gider', async () => {
    // SET_RULE degil SET_RULE_SCOPE: kapsam secimi kural TURUNU (white/grey/
    // temp) ve suresini degistirmemeli. Eskiden setRule('white', ...) idi ve
    // "1 saat" izni sessizce kalici beyaz listeye ceviriyordu.
    await loadPopup(korumali(SUBDOMAIN_TAB));
    sent = [];

    // Kural subdomains:true ile yuklendi; once DAR kapsama gec, sonra geri.
    await dom.byId('scopeExact')._fire('click');
    await new Promise(resolve => setTimeout(resolve, 20));

    const scope = sent.find(m => m?.action === 'SET_RULE_SCOPE');
    assert.ok(scope, 'SET_RULE_SCOPE mesaji gonderilmeli');
    assert.equal(scope.domain, 'mail.google.com');
    assert.equal(scope.subdomains, false);
  });

  test('ZATEN secili segmente tiklamak bos istek atmaz', async () => {
    // Kural subdomains:true; "alt siteler dahil" zaten aktif.
    await loadPopup(korumali(SUBDOMAIN_TAB));
    sent = [];

    await dom.byId('scopeSubs')._fire('click');
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(sent.find(m => m?.action === 'SET_RULE_SCOPE'), undefined,
      'degismeyen kapsam icin arka uca gitmeye gerek yok');
  });

  test('secili segment kuralin kapsamini yansitir', async () => {
    await loadPopup({
      ...SUBDOMAIN_TAB,
      ruleType: 'white',
      rule: { domain: 'mail.google.com', type: 'white', subdomains: false, keepMode: 'all' }
    });

    assert.equal(dom.byId('scopeExact').classList.contains('active'), true,
      'subdomains:false ise DAR segment aktif olmali');
    assert.equal(dom.byId('scopeSubs').classList.contains('active'), false);
  });

  test('alt alan adinda etiket KOK alan adini vaat ETMEZ', async () => {
    // Dar popup'ta etikete alan adi YAZILMIYOR (tasiyordu). Ama alt alan
    // adinda etiketin KENDISI farkli olmali: "Alt siteler dahil (*)" bir alt
    // alan adi icin yanlis vaat olurdu - kardes ve ust alan adi kapsam disi.
    await loadPopup(SUBDOMAIN_TAB);
    const label = dom.byId('scopeSubs').textContent;
    assert.ok(!label.includes('google.com'),
      `etiket alan adi tasimamali, tasidigi: ${label}`);
    assert.notEqual(label, 'Alt siteler dahil (*)',
      'alt alan adinda kok etiketi kullanilmamali');
  });

  test('kapsam ipucu kardes/ust alan adini kapsam DISI ilan eder', async () => {
    await loadPopup(SUBDOMAIN_TAB);
    const tip = dom.byId('scopeSubs').title;
    assert.ok(tip.includes('mail.google.com'),
      `ipucu kural alan adini gostermeli, gosterdigi: ${tip}`);
  });

  test('"yalnizca bu adres" secenegi subdomains:false gonderir', async () => {
    await loadPopup(korumali(SUBDOMAIN_TAB));
    sent = [];

    await dom.byId('scopeExact')._fire('click');
    await new Promise(resolve => setTimeout(resolve, 20));

    const scope = sent.find(m => m?.action === 'SET_RULE_SCOPE');
    assert.ok(scope);
    assert.equal(scope.subdomains, false);
  });

  test('kok alan adinda etiket ve davranis', async () => {
    await loadPopup({
      ...ROOT_TAB,
      ruleType: 'white',
      rule: { domain: 'google.com', type: 'white', subdomains: false, keepMode: 'all' }
    });
    assert.equal(dom.byId('scopeSubs').disabled, false);
    sent = [];

    await dom.byId('scopeSubs')._fire('click');
    await new Promise(resolve => setTimeout(resolve, 20));

    const scope = sent.find(m => m?.action === 'SET_RULE_SCOPE');
    assert.equal(scope.domain, 'google.com');
    assert.equal(scope.subdomains, true);
  });
});

describe('popup: erisim kisitlanmissa "temizlendi" demez (v2.7.0)', () => {
  // Popup, erisim yokken temizleme dugmesini zaten gizliyor. Ama erisim
  // panel ACIKKEN de kaldirilabilir; o durumda dugme hala orada ve arka uc
  // NO_HOST_ACCESS donuyor. Genel "hata" mesaji burada yetersiz: kullanici
  // gecici bir aksilik saniyor, oysa yapmasi gereken belli bir sey var.

  test('NO_HOST_ACCESS ayri bir mesaj gosterir', async () => {
    await loadPopup(SUBDOMAIN_TAB);

    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.action === 'GET_ACTIVE_TAB_INFO') return tabInfo;
      if (msg?.action === 'PURGE_DOMAIN') {
        return { success: false, error: 'NO_HOST_ACCESS', domain: 'mail.google.com' };
      }
      return { success: true };
    };

    // Yikici eylem artik ONAYDAN geciyor: dugme dogrudan silmiyor, onay
    // acilyor. Sozlesme bilerek degisti (bkz. "YIKICI eylem once ONAY ister").
    await dom.byId('btnPurgeNow')._fire('click');
    await new Promise(r => setTimeout(r, 20));
    await dom.byId('btnConfirmYes')._fire('click');
    await new Promise(resolve => setTimeout(resolve, 20));

    // Mesaj artik AKISTAKI hata seridinde. Ustune binen bildirim kaldirildi
    // (kullanici ekran goruntusuyle bildirdi: alttaki ana anahtari
    // ortuyordu). Testin AMACI ayni: basarisizlik SESSIZ kalmamali.
    const serit = dom.byId('errorNotice');
    assert.equal(serit.classList.contains('hidden'), false,
      'hata seridi gorunur olmali');
    assert.match(serit.textContent, /erişim|access/i,
      `mesaj erisim kisitini anlatmali, gosterilen: ${serit.textContent}`);
  });
});


describe('popup: YIKICI eylem once ONAY ister (v2.7.0)', () => {
  // KULLANICI KARARI: kartlar tiklandigi anda uyguladigi icin yanlislikla
  // tiklama riski artti. Cozum buyuk bir modal DEGIL - popup 400px, ustune
  // modal acmak ya sikisir ya ayri pencere ister. Bunun yerine secenekler
  // KATLANIR ve yerine onay gelir; veri tablosu kalir ki neyi kaybedecegini
  // gorerek onaylayasin.
  //
  // Onay YALNIZCA gercekten yikici olan iki eylemde: "simdi temizle" ve
  // "korumayi kaldir ve sil". Kartlar (Koru / Temizle) onay istemez - ikisi
  // de geri alinabilir ve her seyi onaylatmak insani onaylari okumadan
  // gecmeye alistirir.

  test('temizle dugmesi ANINDA silmez, once onay gosterir', async () => {
    await loadPopup({ ruleType: 'default' });

    await dom.byId('btnPurgeNow')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    const purgeMesaji = sent.find(m => m?.action === 'PURGE_DOMAIN');
    assert.equal(purgeMesaji, undefined,
      'onay verilmeden silme mesaji GONDERILMEMELI');

    const onay = dom.byId('confirmBox');
    assert.ok(onay, 'onay bloku HTML de olmali');
    assert.equal(onay.classList.contains('hidden'), false,
      'onay bloku gorunur olmali');
  });

  test('secenekler KATLANIR: onay sirasinda kararlar gizlenir', async () => {
    await loadPopup({ ruleType: 'default' });
    await dom.byId('btnPurgeNow')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    const kararlar = dom.byId('decisionBlock');
    assert.ok(kararlar, 'karar bloku HTML de olmali');
    assert.ok(kararlar.classList.contains('hidden'),
      'onay sirasinda secenekler katlanmali - o an islevsizler');
  });

  test('VAZGEC hicbir sey silmez ve secenekleri geri getirir', async () => {
    await loadPopup({ ruleType: 'default' });
    await dom.byId('btnPurgeNow')._fire('click');
    await new Promise(r => setTimeout(r, 40));
    await dom.byId('btnConfirmNo')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(sent.find(m => m?.action === 'PURGE_DOMAIN'), undefined,
      'vazgecince silme mesaji gitmemeli');
    assert.ok(dom.byId('confirmBox').classList.contains('hidden'),
      'onay bloku kapanmali');
    assert.equal(dom.byId('decisionBlock').classList.contains('hidden'), false,
      'secenekler geri gelmeli');
  });

  test('EVET onayindan sonra silme GERCEKTEN calisir', async () => {
    await loadPopup({ ruleType: 'default' });
    await dom.byId('btnPurgeNow')._fire('click');
    await new Promise(r => setTimeout(r, 40));
    await dom.byId('btnConfirmYes')._fire('click');
    await new Promise(r => setTimeout(r, 60));

    const purgeMesaji = sent.find(m => m?.action === 'PURGE_DOMAIN');
    assert.ok(purgeMesaji, 'onaydan sonra silme mesaji gitmeli');
  });
});


describe('popup: KORUMA KALDIRMA da onay ister (v2.7.0)', () => {
  // KULLANICI BULGUSU: "beyaz listede olan siteyi anlik yok ediyor, kullanici
  // fark etmeden bassa verileri gidecek". En riskli acik buydu: "Temizle"
  // karti tek tikla korumayi kaldiriyordu, uyari yoktu.
  //
  // Veri o anda silinmiyor (purgeAfter kontrol ediliyor) ama site korumasiz
  // kaliyor ve periyodik supurme - artik varsayilan ACIK - bir saat icinde
  // cerezlerini ve gecmisini siliyor. Yani sonuc ayni yere variyor.

  test('TEMIZLE karti korumayi ANINDA kaldirmaz, onay gosterir', async () => {
    await loadPopup({ ruleType: 'white', rule: { domain: 'mail.google.com', type: 'white' } });

    await dom.byId('cardClean')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(sent.find(m => m?.action === 'DELETE_RULE'), undefined,
      'onay verilmeden kural SILINMEMELI');
    assert.equal(dom.byId('confirmBox').classList.contains('hidden'), false,
      'onay bloku acilmali');
  });

  test('onaydan SONRA koruma gercekten kalkar', async () => {
    await loadPopup({ ruleType: 'white', rule: { domain: 'mail.google.com', type: 'white' } });
    await dom.byId('cardClean')._fire('click');
    await new Promise(r => setTimeout(r, 40));
    await dom.byId('btnConfirmYes')._fire('click');
    await new Promise(r => setTimeout(r, 60));

    assert.ok(sent.find(m => m?.action === 'DELETE_RULE'),
      'onaydan sonra kural silme mesaji gitmeli');
  });

  // "GECMISI SIL de onay ister" testi KALDIRILDI: dugme popup'tan
  // kalkti. Ayni islem Ayarlar > Site verileri'nde duruyor ve orada kendi
  // onayindan geciyor; popup'ta artik boyle bir yol yok.
  test('popup GECMISI SIL yolunu artik SUNMAZ', async () => {
    await loadPopup({ ruleType: 'white', rule: { domain: 'mail.google.com', type: 'white' } });
    assert.equal(dom.byId('btnPurgeHistory'), null, 'dugme kaldirildi');
    assert.equal(sent.find(m => m?.action === 'PURGE_DOMAIN_HISTORY_ONLY'), undefined,
      'popup bu mesaji hic gondermemeli');
  });

  test('VAZGEC korumayi kaldirmaz', async () => {
    await loadPopup({ ruleType: 'white', rule: { domain: 'mail.google.com', type: 'white' } });
    await dom.byId('cardClean')._fire('click');
    await new Promise(r => setTimeout(r, 40));
    await dom.byId('btnConfirmNo')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(sent.find(m => m?.action === 'DELETE_RULE'), undefined,
      'vazgecince kural silinmemeli');
  });
});

describe('popup: kapsam dugmesi KORUMAYI KALDIRMAZ', () => {
  // GERCEK KULLANIMDA BULUNDU. Dugme "Alt alan adlari dahil (*.ecc.tools)"
  // yazisini gosteriyor ve tek isi kapsam menusunu acmak. Icinde eski
  // "toggle white" tasariminda kalma bir dal vardi: kural 'white' ise menuyu
  // acmak yerine removeRule() cagiriyordu. Sonuc: kullanici siteyi koruyor,
  // kapsami degistirmek icin dugmeye basiyor ve koruma sessizce kalkiyor -
  // "Temizle" karti aktif oluyordu. Gri/gecici izinde menu normal acildigi
  // icin davranis rastgele gorunuyordu.
  //
  // Korumayi kaldirmanin onayli yolu ayri (cardClean); bu dugme o kapiyi
  // arkadan dolaniyordu.
  const whiteTab = {
    ...ROOT_TAB,
    ruleType: 'white',
    rule: { domain: 'google.com', type: 'white', subdomains: true, keepMode: 'all' }
  };

  test('KORUMALI sitede kapsam seridi kurali SILMEZ', async () => {
    await loadPopup(whiteTab);
    sent = [];

    await dom.byId('scopeExact')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(sent.find(m => m?.action === 'DELETE_RULE'), undefined,
      'kapsam secimi korumayi kaldirmamali - onun yolu cardClean + onay');
    const scope = sent.find(m => m?.action === 'SET_RULE_SCOPE');
    assert.ok(scope, 'yalnizca kapsam guncellenmeli');
    assert.equal(scope.subdomains, false);
  });

  test('kapsam secenegi kural TURUNU degistirmez (SET_RULE_SCOPE)', async () => {
    // "1 saat" gibi sureli bir izinde kapsamla oynamak, kurali sessizce
    // KALICI beyaz listeye ceviriyordu: iki secenek de setRule('white', ...)
    // cagiriyordu. Arka planda tam bu is icin SET_RULE_SCOPE var ve options
    // paneli zaten onu kullaniyor.
    await loadPopup({
      ...ROOT_TAB,
      ruleType: 'temp',
      rule: { domain: 'google.com', type: 'temp', subdomains: false, expiresAt: Date.now() + 3600_000, durationMinutes: 60 }
    });
    sent = [];

    await dom.byId('scopeSubs')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(sent.find(m => m?.action === 'SET_RULE'), undefined,
      'kapsam secimi SET_RULE ile tur yazmamali');
    const scope = sent.find(m => m?.action === 'SET_RULE_SCOPE');
    assert.ok(scope, 'SET_RULE_SCOPE gonderilmeli');
    assert.equal(scope.domain, 'google.com');
    assert.equal(scope.subdomains, true);
  });
});

describe('popup: durum rozeti STILINI kaybetmez', () => {
  // GERCEK HATA. renderStatus() `className`'i KOMPLE degistiriyordu:
  //   ui.statusBadge.className = `status-badge ${preset.badge}`
  // Isaretlemede `site__status` de vardi ve rozetin BUTUN geometrisi orada:
  // inline-flex, 20px yukseklik, dolgu, kose yuvarlatmasi, punto, kalinlik.
  // Ilk cizimle birlikte o sinif siliniyor, rozet sekilsiz duz metne
  // donusuyordu - popup HER acildiginda, her durumda.
  //
  // `status-badge` sinifinin hicbir CSS karsiligi yoktu; tasinmiyor.

  for (const [ruleType, beklenenRozet] of [
    ['default', 'badge-default'],
    ['white', 'badge-white'],
    ['grey', 'badge-grey']
  ]) {
    test(`${ruleType}: site__status KORUNUR, rozet rengi ${beklenenRozet}`, async () => {
      await loadPopup({
        ...ROOT_TAB,
        ruleType,
        rule: ruleType === 'default' ? null
          : { domain: 'google.com', type: ruleType, subdomains: true, keepMode: 'all' }
      });

      const sinif = dom.byId('statusBadge').className;
      assert.ok(sinif.includes('site__status'),
        `rozetin geometrisi site__status'ta; silinmemeli. Simdiki: "${sinif}"`);
      assert.ok(sinif.includes(beklenenRozet),
        `durum rengi ${beklenenRozet} olmaliydi. Simdiki: "${sinif}"`);
    });
  }

  test('durum degisince ESKI rozet rengi birikmez', async () => {
    // className yerine sinif eklemeye gecerken kolay hata: eski badge-*
    // sinifini silmeyi unutmak. Iki renk ust uste gelir.
    await loadPopup({
      ...ROOT_TAB, ruleType: 'white',
      rule: { domain: 'google.com', type: 'white', subdomains: true, keepMode: 'all' }
    });
    const sinif = dom.byId('statusBadge').className;
    const rozetler = ['badge-default', 'badge-white', 'badge-grey', 'badge-temp']
      .filter(b => sinif.includes(b));
    assert.deepEqual(rozetler, ['badge-white'],
      `tek bir badge-* sinifi olmali, bulunan: ${rozetler.join(', ')}`);
  });
});
