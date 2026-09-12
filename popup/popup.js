// GhostTrace - Popup Denetleyicisi

import { initI18n, t, getLocaleTag } from '../lib/i18n.js';
import { watchTheme } from '../ui/apply-theme.js';
import { getSettings } from '../lib/storage.js';
import { Action, sendToBackground } from '../lib/messaging.js';
import { requestHostAccess } from '../lib/privacy.js';
import { initSegmented, setActive, selectOne } from '../ui/segmented.js';

/** Zorunlu olmayan elementler icin guvenli erisim. */
const el = (id) => document.getElementById(id);

const ui = {
  masterToggle: el('masterToggle'),
  delayBadge: el('delayBadge'),
  btnOpenOptions: el('btnOpenOptions'),

  domainCard: el('domainCard'),
  internalCard: el('internalCard'),
  accessCard: el('accessCard'),
  btnGrantAccess: el('btnGrantAccess'),
  // SINIF tabanli sorgu DEGIL, id: sinif adi yeniden tasarimda degisince sorgu sessizce null donuyordu ve eylemler Chrome'un kendi sayfalarinda gizlenmiyordu (kullanici bildirdi).
  actionsSection: el('actionsSection'),
  currentDomain: el('currentDomain'),
  statusBadge: el('statusBadge'),
  cookieCount: el('cookieCount'),
  historyCount: el('historyCount'),
  downloadCount: el('downloadCount'),
  thirdPartyCount: el('thirdPartyCount'),

  // Kapsam seridi: iki dugme, acilir menu yok.
  scopeExact: el('scopeExact'),
  scopeSubs: el('scopeSubs'),

  // Karar kartlari: TIKLANDIGI ANDA uygulanir, ayri bir "Uygula" adimi yok.
  cardProtect: el('cardProtect'),
  cardClean: el('cardClean'),
  protectOpts: el('protectOpts'),
  scopeOpts: el('scopeOpts'),
  dataLabel: el('dataLabel'),

  btnPurgeNow: el('btnPurgeNow'),
  decisionBlock: el('decisionBlock'),
  confirmBox: el('confirmBox'),
  confirmText: el('confirmText'),
  btnConfirmNo: el('btnConfirmNo'),
  btnConfirmYes: el('btnConfirmYes'),
  errorNotice: el('errorNotice')
};

const state = {
  domain: '',
  url: '',
  ruleType: 'default',
  rule: null,
  isSubdomain: false,
  busy: false,
  // Koru karti hangi sureyle uygulasin.
  selectedDur: 'white'
};

let countdownTimer = null;

// Yardimcilar

// HATA seridi.
let hataZaman = null;

function hataGoster(message, duration = 4000) {
  if (!ui.errorNotice) return;
  ui.errorNotice.textContent = message;
  ui.errorNotice.classList.remove('hidden');
  if (hataZaman) clearTimeout(hataZaman);
  hataZaman = setTimeout(() => {
    ui.errorNotice.classList.add('hidden');
    hataZaman = null;
  }, duration);
}

// Yeni bir islem baslarken onceki hata silinmeli.
function hatayiTemizle() {
  if (!ui.errorNotice) return;
  if (hataZaman) clearTimeout(hataZaman);
  hataZaman = null;
  ui.errorNotice.classList.add('hidden');
}

/** Kalan sureyi yerelleştirilmis metne cevirir. */
function formatRemaining(expiresAt) {
  if (!expiresAt) return '';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return t('popup.timeExpired');

  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return t('popup.timeRemainingMins', { mins: minutes });

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0
    ? t('popup.timeRemainingHours', { hours, mins: rest })
    : t('popup.timeRemainingHoursOnly', { hours });
}

/** Dakikadan yerelleştirilmis sure etiketi uretir (kural icinde metin saklamayiz). */
function formatDuration(minutes) {
  if (!minutes) return t('popup.snoozeSessionShort');
  if (minutes < 60) return `${minutes} ${t('common.minutesUnit')}`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${t('common.hoursUnit')}`;
}

/** Islem sirasinda butonlari kilitler (cift tiklama korumasi). */
function setBusy(busy) {
  state.busy = busy;
  for (const button of [ui.scopeExact, ui.scopeSubs, ui.btnPurgeNow,
    ui.cardProtect, ui.cardClean]) {
    if (button) button.disabled = busy;
  }
  if (!busy) applyProtectionState();
}

// Durum gosterimi

const STATUS_PRESETS = {
  white: { badge: 'badge-white', text: 'popup.statusWhite' },
  grey: { badge: 'badge-grey', text: 'popup.statusGrey' },
  temp: { badge: 'badge-temp', text: 'popup.statusTemp' },
  default: { badge: 'badge-default', text: 'popup.statusDefault' }
};

function isProtected() {
  if (state.ruleType === 'white' || state.ruleType === 'grey') return true;
  if (state.ruleType !== 'temp') return false;
  return !state.rule?.expiresAt || state.rule.expiresAt > Date.now();
}

function applyProtectionState() {
  if (!ui.btnPurgeNow) return;
  const locked = isProtected();
  ui.btnPurgeNow.disabled = locked || state.busy;
  ui.btnPurgeNow.title = locked ? t('popup.purgeProtectedTooltip') : t('popup.purgeDefaultTooltip');
  ui.btnPurgeNow.classList.toggle('disabled-protected', locked);
}

function renderStatus() {
  const preset = STATUS_PRESETS[state.ruleType] || STATUS_PRESETS.default;
  const statusText = ui.statusBadge?.querySelector('.status-text');

  // TUM className'i EZMEYIZ.
  if (ui.statusBadge) ui.statusBadge.className = `site__status ${preset.badge}`;
  if (statusText) {
    statusText.textContent = state.ruleType === 'temp'
      ? t('popup.statusTemp', { time: formatRemaining(state.rule?.expiresAt) || formatDuration(state.rule?.durationMinutes) })
      : t(preset.text);
  }

  // Iki secim birbirinin TAMAMLAYICISI: biri seciliyse oteki degil.
  const korunuyor = isProtected();
  ui.cardProtect?.classList.toggle('is-protect', korunuyor);
  ui.cardClean?.classList.toggle('is-clean', !korunuyor);

  // Sure ve kapsam yalnizca koruma acikken anlamli. "Temizle" secildiginde gosterilirse islevsiz bir kontrol olur ve belirsizlik uretir.
  // Ikisi AYRI kapsayici: kapsam sure kutusunun DISINDA duruyor ki o kutunun
  // "Ne kadar sureyle" basliginin kapsamina girmesin.
  ui.scopeOpts?.classList.toggle('hidden', !korunuyor);
  ui.protectOpts?.classList.toggle('hidden', !korunuyor);

  // Veri tablosunun basligi duruma gore degisir: korunan veri mi, silinecek veri mi?
  if (ui.dataLabel) {
    ui.dataLabel.textContent = t(korunuyor ? 'popup.dataLabelKept' : 'popup.dataLabel');
  }

  // Yikici dugmenin metni de duruma gore: korumali sitede once koruma kalkar.
  const purgeText = ui.btnPurgeNow?.querySelector('.btn-text');
  if (purgeText) {
    purgeText.textContent = t(korunuyor ? 'popup.purgeProtectedBtn' : 'popup.purgeNowBtn');
  }

  // Mevcut kuraldan secili sureyi turet; kullanici henuz secmediyse kural ne diyorsa o gosterilir.
  if (korunuyor) {
    state.selectedDur = state.ruleType === 'white' ? 'white'
      : state.ruleType === 'grey' ? 'session'
        : String(state.rule?.durationMinutes || 60);
  }
  for (const dugme of document.querySelectorAll('.durseg__b[data-dur]')) {
    setActive(dugme, dugme.dataset.dur === state.selectedDur);
  }

  // Kapsam seridinde hangi segment secili?
  const altDahil = state.rule?.subdomains !== false;
  setActive(ui.scopeExact, !altDahil);
  setActive(ui.scopeSubs, altDahil);

  applyProtectionState();
}

// Veri yukleme

// Sayilari yazan TEK yer: hem ilk yukleme hem canli tazeleme buradan geciyor.
function yazMetrikler(info) {
  // `.is-zero` CSS'te tanimliydi ama HIC uygulanmiyordu: sifir sayilar dolu
  // sayilarla ayni guclukte okunuyordu. Solukluk bu arayuzde "burada hicbir
  // sey yok" demek (options/tabs/logs.js ayni sinifi kullaniyor).
  const yaz = (node, value) => {
    if (!node) return;
    const n = Number(value ?? 0);
    node.textContent = String(n);
    node.classList.toggle('is-zero', n === 0);
  };
  yaz(ui.cookieCount, info.cookieCount);
  yaz(ui.historyCount, info.historyCount);
  yaz(ui.downloadCount, info.downloadCount);
  // Onay penceresine KATILMAZ (bkz. onayiAc): bu sayi silinecek iz sayisi degil.
  yaz(ui.thirdPartyCount, info.thirdPartyCount);
}

/**
 * Sayilari SAYFA YENILEMEDEN tazeler.
 *
 * Neden gerekli: gozlemci 3. taraflari 3 saniyelik pencerelerde bosaltiyor
 * (FLUSH_INTERVAL_MS), yani sayfa yeni acildiginda popup once 0 gosteriyordu
 * ve dolmasi icin sayfayi yenilemek gerekiyordu. Reklam yogun sayfalar
 * ayrica popup acikken yeni cerez yazmaya devam ediyor.
 *
 * YALNIZCA sayilar yazilir, panel yeniden kurulmaz: kullanicinin actigi sure
 * seridi ya da kapsam secimi altindan kaymasin.
 */
async function refreshMetrics() {
  // Onay ACIKKEN dokunulmaz. Onay metni EKRANDAKI sayilardan kuruluyor
  // (bkz. onayiAc); sayilar altindan degisirse onay yalan soyler.
  if (bekleyenEylem !== null) return;
  // `document.hidden` kontrolu YOK ve bilincli: popup yalnizca acikken yasiyor,
  // kapaninca sayfa yok ediliyor ve zamanlayici onunla gidiyor. Koruma
  // uretimde hicbir durumu karsilamiyordu; buna karsilik popup'i sekmede
  // acan dogrulama kosumunu sessizce olduruyordu (sayilar 0'da dondu).

  const info = await sendToBackground(Action.GET_ACTIVE_TAB_INFO);
  if (!info?.success || info.isInternal || info.isIncognito) return;

  // Aktif sekme degistiyse sayilari tazelemek YETMEZ: durum rozeti, kural ve
  // kapsam da degismis olabilir. Tum paneli kur.
  if (info.domain !== state.domain) {
    await loadActiveTab();
    return;
  }
  yazMetrikler(info);
}

async function loadActiveTab() {
  const info = await sendToBackground(Action.GET_ACTIVE_TAB_INFO);

  if (!info?.success) {
    if (ui.currentDomain) ui.currentDomain.textContent = t('popup.tabReadError');
    return;
  }

  if (ui.masterToggle) ui.masterToggle.checked = info.enabled !== false;
  if (ui.delayBadge) {
    // Savunma: deger gelmezse `{delay}s bekleme` HAM SABLONU kullaniciya gosterilmez. t() eksik parametrede yer tutucuyu oldugu gibi birakiyor.
    const gecikme = Number.isFinite(Number(info.cleanDelay)) ? Number(info.cleanDelay) : null;
    ui.delayBadge.textContent = gecikme === null ? ''
      : gecikme === 0 ? t('common.instant')
        : t('common.delayBadge', { delay: gecikme });
  }

  // Gizli pencere: service worker normal profilin baglaminda calisiyor, bu yuzden buradaki sayilari ve islemleri gostermek yanlis olur.
  if (info.isIncognito) {
    ui.domainCard?.classList.add('hidden');
    ui.actionsSection?.classList.add('hidden');
    ui.accessCard?.classList.add('hidden');
    ui.internalCard?.classList.remove('hidden');
    const title = ui.internalCard?.querySelector('strong');
    const desc = ui.internalCard?.querySelector('p');
    if (title) title.textContent = t('popup.incognitoTitle');
    if (desc) desc.textContent = t('popup.incognitoDesc');
    return;
  }

  if (info.isInternal) {
    ui.domainCard?.classList.add('hidden');
    ui.actionsSection?.classList.add('hidden');
    ui.accessCard?.classList.add('hidden');
    ui.internalCard?.classList.remove('hidden');
    return;
  }

  // Site erisimi kisitliysa iz sayilari GUVENILMEZ ve temizlik calismaz.
  if (info.hasHostAccess === false) {
    state.url = info.url || '';
    state.domain = info.domain || '';
    ui.domainCard?.classList.add('hidden');
    ui.actionsSection?.classList.add('hidden');
    ui.internalCard?.classList.add('hidden');
    ui.accessCard?.classList.remove('hidden');
    return;
  }

  ui.domainCard?.classList.remove('hidden');
  ui.actionsSection?.classList.remove('hidden');
  ui.internalCard?.classList.add('hidden');
  ui.accessCard?.classList.add('hidden');

  state.domain = info.domain || '';
  state.url = info.url || '';
  state.ruleType = info.ruleType || 'default';
  state.rule = info.rule || null;
  state.isSubdomain = Boolean(info.isSubdomain);

  if (ui.currentDomain) {
    ui.currentDomain.textContent = state.domain;
    ui.currentDomain.title = info.url || state.domain;
  }
  yazMetrikler(info);

  // Kapsam seridi etiketleri.
  if (ui.scopeExact) {
    ui.scopeExact.textContent = t(state.isSubdomain ? 'options.scopeSubdomain' : 'options.scopeExact');
    ui.scopeExact.title = t('popup.whitelistExactDesc');
  }
  if (ui.scopeSubs) {
    ui.scopeSubs.textContent = t(state.isSubdomain ? 'options.scopeSubdomainAll' : 'options.scopeAll');
    ui.scopeSubs.title = state.isSubdomain
      ? t('popup.whitelistSubDisabledDesc', { domain: state.domain })
      : t('popup.whitelistSubDesc', { domain: state.domain });
  }

  renderStatus();
}

// Eylemler

async function setRule(type, options) {
  hatayiTemizle();
  if (!state.domain || state.busy) return;
  setBusy(true);

  const response = await sendToBackground(Action.SET_RULE, { domain: state.domain, type, options });
  setBusy(false);

  if (response?.success) {
    await loadActiveTab();
  } else if (response?.error === 'INVALID_DOMAIN') {
    // Popup'ta alan adi aktif sekmeden geldigi icin bu neredeyse imkansiz.
    hataGoster(t('popup.toastInvalidDomain'));
  } else {
    hataGoster(t('popup.toastRuleSaveFailed'));
  }
}

/** Yalnizca kapsami degistirir; kural turunu ve suresini KORUR. */
async function setScope(subdomains) {
  hatayiTemizle();
  if (!state.domain || state.busy) return;
  setBusy(true);

  const response = await sendToBackground(Action.SET_RULE_SCOPE, { domain: state.domain, subdomains });
  setBusy(false);

  if (response?.success) {
    await loadActiveTab();
  } else {
    hataGoster(t('popup.toastRuleSaveFailed'));
  }
}

async function removeRule() {
  hatayiTemizle();
  if (!state.domain || state.busy) return;
  setBusy(true);

  const response = await sendToBackground(Action.DELETE_RULE, { domain: state.domain });
  setBusy(false);

  if (response?.success) {
    await loadActiveTab();
  } else {
    hataGoster(t('popup.toastSettingsError'));
  }
}

// Olay baglantilari

ui.masterToggle?.addEventListener('change', async () => {
  const enabled = ui.masterToggle.checked;
  const response = await sendToBackground(Action.SET_AUTOMATIC_CLEANING_ENABLED, { enabled });

  if (!response?.success) {
    ui.masterToggle.checked = !enabled;
    hataGoster(t('popup.toastSettingsError'));
    return;
  }
});

ui.btnGrantAccess?.addEventListener('click', async () => {
  if (!state.url) return;
  const granted = await requestHostAccess(state.url);
  if (granted) {
    await loadActiveTab();
  } else {
    hataGoster(t('popup.noAccessDenied'));
  }
});

ui.btnOpenOptions?.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options/options.html'));
  }
});

// Kapsam seridi YALNIZCA kapsami degistirir, kural TURUNU degil: eskiden kapsamla oynamak korumayi kaldiriyor ya da gecici izni kalici beyaz listeye ceviriyordu.
ui.scopeExact?.addEventListener('click', () => {
  if (state.rule?.subdomains === false) return; // zaten secili
  void setScope(false);
});

ui.scopeSubs?.addEventListener('click', () => {
  // Alt alan adinda da secilebilir: kapsam kuralin KENDI dallaridir (x.mail.google.com), kardes ve ust alan adi hicbir kosulda dahil degil.
  if (state.rule?.subdomains !== false) return; // zaten secili
  void setScope(true);
});

// KARAR: iki secim, tiklandigi ANDA uygulanir

/** Secili sureyi bir SET_RULE cagrisina cevirir. */
function sureyiKuralaCevir() {
  if (state.selectedDur === 'white') {
    return { type: 'white', options: {} };
  }
  if (state.selectedDur === 'session') {
    return { type: 'grey', options: {} };
  }
  const dk = Number(state.selectedDur) || 60;
  return { type: 'temp', options: { durationMinutes: dk } };
}

ui.cardProtect?.addEventListener('click', async () => {
  if (!state.domain || state.busy) return;
  const k = sureyiKuralaCevir();
  // Kapsam onceki tercihi korur.
  const options = { ...k.options, subdomains: state.rule?.subdomains };
  await setRule(k.type, options);
});

ui.cardClean?.addEventListener('click', () => {
  if (!state.domain || state.busy) return;
  // Kural yoksa zaten temizlenecek durumdadir; gereksiz cagri yapma.
  if (state.ruleType === 'default') return;
  // KORUMAYI KALDIRIYOR -> onay sart.
  onayiAc('unprotect');
});

// Sure seridi: secimi degistirir ve site ZATEN korumadaysa hemen uygular.
const durDugmeleri = document.querySelectorAll('.durseg__b[data-dur]');
for (const dugme of durDugmeleri) {
  dugme.addEventListener('click', async () => {
    if (state.busy) return;
    state.selectedDur = dugme.dataset.dur;
    selectOne(durDugmeleri, dugme);
    if (isProtected()) ui.cardProtect?.click();
  });
}

// "Yalnizca gecmisi sil" popup'tan KALDIRILDI: ayni islem
// Ayarlar > Site verileri'nde site basina duruyor. Onay akisinin 'history'
// dali da onunla birlikte gitti.

// ONAY: yikici eylem once sorar.

async function silmeyiUygula() {
  if (!state.domain || state.busy) return;
  if (isProtected()) {
    hataGoster(t('popup.toastPurgeProtectedError'));
    return;
  }

  setBusy(true);
  const response = await sendToBackground(Action.PURGE_DOMAIN, { domain: state.domain });
  setBusy(false);

  if (response?.success) {
    await loadActiveTab();
  } else if (response?.protected) {
    hataGoster(t('popup.toastPurgeProtectedError'));
  } else if (response?.error === 'NO_HOST_ACCESS') {
    // Erisim panel acikken kaldirilmis olabilir.
    hataGoster(t('popup.toastPurgeNoAccess'), 5000);
    await loadActiveTab();
  } else {
    hataGoster(t('popup.toastPurgeError'));
  }
}

function onayiKapat() {
  ui.confirmBox?.classList.add('hidden');
  ui.decisionBlock?.classList.remove('hidden');
  if (ui.decisionBlock) ui.decisionBlock.inert = false;
}

/** Onaylandiginda calisacak islem. Pencere tek, eylem degisken. */
let bekleyenEylem = null;

function onayiAc(tur) {
  if (!ui.confirmBox) return;
  bekleyenEylem = tur;
  // Sonuc metni EKRANDAKI sayilardan kurulur: bos bir "Emin misiniz?" neyi kaybedecegini soylemez.
  const parcalar = [];
  const say = (id, anahtar) => {
    const n = Number(el(id)?.textContent || 0);
    if (n > 0) parcalar.push(`${n} ${t(anahtar)}`);
  };
  say('cookieCount', 'common.cookies');
  say('historyCount', 'common.history');
  say('downloadCount', 'common.downloads');

  if (ui.confirmText) {
    // Her eylem KENDI sonucunu anlatir.
    if (tur === 'unprotect') {
      ui.confirmText.textContent = t('popup.confirmUnprotect', { domain: state.domain });
    } else {
      ui.confirmText.textContent = parcalar.length
        ? t('popup.confirmWithData', { list: parcalar.join(', '), domain: state.domain })
        : t('popup.confirmNoData', { domain: state.domain });
    }
  }
  ui.decisionBlock?.classList.add('hidden');
  if (ui.decisionBlock) ui.decisionBlock.inert = true;
  ui.confirmBox.classList.remove('hidden');
}

ui.btnPurgeNow?.addEventListener('click', () => {
  if (!state.domain || state.busy) return;
  onayiAc('purge');
});

ui.btnConfirmNo?.addEventListener('click', onayiKapat);

ui.btnConfirmYes?.addEventListener('click', async () => {
  const tur = bekleyenEylem;
  onayiKapat();
  if (tur === 'unprotect') await removeRule();
  else await silmeyiUygula();
});


// Canli geri sayim

// Sayilar her tikta degil iki tikta bir tazelenir: getTraceMetrics cerez,
// gecmis ve indirme sorgusu yapiyor, saniyede bir kosmasinin karsiligi yok.
const METRIK_TIK = 2;
let tikSayaci = 0;

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    // Sayi tazelemesi geri saymanin ONUNDE: asagidaki erken donusler yalnizca
    // gecici izin sayacini ilgilendiriyor, sayilari degil.
    tikSayaci++;
    if (tikSayaci % METRIK_TIK === 0) void refreshMetrics();

    if (state.ruleType !== 'temp' || !state.rule?.expiresAt) return;
    if (state.rule.expiresAt <= Date.now()) {
      void loadActiveTab();
      return;
    }
    renderStatus();
  }, 1000);
}

window.addEventListener('pagehide', () => {
  if (countdownTimer) clearInterval(countdownTimer);
  if (hataZaman) clearTimeout(hataZaman);
}, { once: true });

// Baslangic

(async function init() {
  // Tema ILK is: ceviri yuklenirken yanlis temada yanip sonmemeli.
  await watchTheme(getSettings);

  await initI18n();
  document.documentElement.lang = getLocaleTag().slice(0, 2);
  // renderStatus() segment dugmelerini zaten yaziyor ama HER yoldan gecmiyor:
  // dahili sayfa / gizli pencere / erisim kisitli durumlarinda loadActiveTab
  // erken donuyor ve dugmeler aria-pressed'siz kaliyordu (olculdu).
  initSegmented();
  await loadActiveTab();
  startCountdown();
})();
