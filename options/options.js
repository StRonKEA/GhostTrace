// GhostTrace - Ayarlar Paneli: GIRIS NOKTASI

import { getLanguage, initI18n } from '../lib/i18n.js';
import { loadDiagnostics, loadLogs } from './tabs/logs.js';
import { renderRules, rulesUi, syncSubdomainCheckbox } from './tabs/rules.js';
import { loadSettings } from './tabs/settings.js';
import { loadSiteData } from './tabs/site-data.js';
import { renderStats } from './tabs/stats.js';
import { renderInsights } from './tabs/insights.js';
import { renderUnprotectedLogins } from './tabs/unprotected.js';
import { el, qsa } from './ui/dom.js';
import { initDisclosures } from './ui/disclosure.js';
import { initSegmented } from '../ui/segmented.js';
import { getSettings } from '../lib/storage.js';
import { watchTheme } from '../ui/apply-theme.js';

const TAB_LOADERS = {
  'rules-tab': () => Promise.all([renderRules(), renderUnprotectedLogins()]),
  'site-data-tab': () => loadSiteData(),
  'settings-tab': () => loadSettings(),
  'stats-tab': () => Promise.all([renderStats(), renderInsights()]),
  'logs-tab': () => Promise.all([loadLogs(), loadDiagnostics()]),
  // Hakkinda sekmesi TAMAMEN DURAGAN: yuklenecek veri yok, metnin tamami ceviri anahtarlarindan geliyor.
  'about-tab': () => Promise.resolve()
};

function switchTab(tabId) {
  if (!TAB_LOADERS[tabId]) return;
  for (const item of qsa('.nav-item')) {
    const isActive = item.dataset.tab === tabId;
    item.classList.toggle('active', isActive);
    // aria-current: <nav> icindeki SECILI bolum. Onceden role="tab" +
    // aria-selected yaziliyordu, ama desenin geri kalani (aria-controls,
    // role="tabpanel", ok tusu gezinmesi, roving tabindex) hic yoktu:
    // ekran okuyucu "sekme, 6'nin 1'i" diyor, ok tusu hicbir sey yapmiyordu.
    // Yarim ilan edilen bir desen, hic ilan edilmemis olandan KOTUDUR -
    // rol olmasa bunlar sade dugme olurdu ve her sey dogal calisirdi.
    if (isActive) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }
  for (const panel of qsa('.tab-panel')) {
    panel.classList.toggle('active', panel.id === tabId);
  }

  // BASA SAR. Kullanici bildirdi: "Istatistik, Gunlukler, Hakkinda sayfalari
  // acilmiyor". Panel ACILIYORDU; gorunmuyordu. Ayarlar sekmesi uzun (~2500px)
  // ve orada asagi kaydirilmisken sekme degistirmek kaydirmayi oldugu yerde
  // birakiyordu: yeni panel kisa oldugu icin tamami ekranin USTUNDE kaliyor ve
  // bombos bir ekran goruluyordu. Olculdu: kaydirma 1919px iken Istatistik'e
  // basinca panelin ekranda gorunen yuksekligi 0px.
  // `behavior` verilmiyor - anlik kaydirma, prefers-reduced-motion ile
  // catismaz ve sekme gecisi bir yolculuk degil bir yer degistirmedir.
  window.scrollTo({ top: 0, left: 0 });

  if (location.hash !== `#${tabId}`) history.replaceState(null, '', `#${tabId}`);
  void TAB_LOADERS[tabId]();
}

for (const item of qsa('.nav-item')) {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
}

// Baslangic

(async function init() {
  // Tema ILK is: ceviri yuklenirken sayfanin yanlis temada yanip sonmesi ("flash of wrong theme") kullaniciyi rahatsiz eder.
  await watchTheme(getSettings);

  await initI18n();
  document.documentElement.lang = getLanguage();

  initDisclosures();
  // Segment gruplarinin aria-pressed baslangici HTML'deki .active'ten uretilir.
  initSegmented();

  if (rulesUi.checkSubdomains) rulesUi.checkSubdomains.checked = false;
  syncSubdomainCheckbox();

  await Promise.all([
    renderRules(), loadSettings(), renderStats(),
    renderInsights(), renderUnprotectedLogins()
  ]);

  const surum = `v${chrome.runtime.getManifest().version}`;
  const versionBadge = el('versionBadge');
  if (versionBadge) versionBadge.textContent = surum;
  const aboutVersion = el('aboutVersion');
  if (aboutVersion) aboutVersion.textContent = surum;

  const requested = location.hash.replace('#', '');
  if (requested && TAB_LOADERS[requested]) switchTab(requested);
})();
