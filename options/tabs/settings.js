// GhostTrace - Ayarlar sekmesi ve gizlilik sertlestirme

import { applyTranslationsToDOM, getConfiguredLanguage, setLanguage, t } from '../../lib/i18n.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import {
  CONTEXT_MENUS_PERMISSION, hasPermission, PRIVACY_PERMISSION, requestPermission
} from '../../lib/privacy.js';
import {
  clampCleanDelay, DEFAULT_SETTINGS, getSettings, resetOnlySettings, resetToFactoryDefaults, updateSettings
} from '../../lib/storage.js';
import { el, h, qsa } from '../ui/dom.js';
import { openConfirm, showToast } from '../ui/toast.js';
import { refreshViews } from '../ui/refresh.js';
import { debounce } from '../ui/util.js';

// Ayarlar sekmesi

export const settingsUi = {
  rangeDelay: el('rangeCleanDelay'),
  numDelay: el('numCleanDelay'),
  selectLanguage: el('selectLanguage'),
  selectTheme: el('selectTheme'),
  selectPeriodicInterval: el('selectPeriodicInterval'),
  selectLogLevel: el('selectLogLevel'),
  btnResetSettings: el('btnResetOnlySettings'),
  btnResetRules: el('btnResetOnlyRules'),
  btnFactoryReset: el('btnFactoryReset'),
  hardeningRow: el('hardeningPermissionRow'),
  hardeningList: el('hardeningToggleList'),
  btnRequestHardening: el('btnRequestHardeningPermission'),
  selectRetention: el('selectStatsHistoryRetention'),
  btnClearHistory: el('btnClearStatsHistory')
};

// Ayar anahtari -> checkbox id eslemesi (elle tekrar eden listeler yerine)
export const TOGGLE_SETTINGS = {
  cleanHistory: 'settingCleanHistory',
  cleanCookies: 'settingCleanCookies',
  cleanLocalStorage: 'settingCleanLocalStorage',
  cleanIndexedDB: 'settingCleanIndexedDB',
  cleanServiceWorkers: 'settingCleanServiceWorkers',
  cleanDownloads: 'settingCleanDownloads',
  cleanCacheOnPurgeAll: 'settingCleanCacheOnPurgeAll',
  cleanOnStartup: 'settingCleanOnStartup',
  periodicCleanEnabled: 'settingPeriodicCleanEnabled',
  whitelistCleanHistory: 'settingWhitelistCleanHistory',
  whitelistCleanDownloads: 'settingWhitelistCleanDownloads',
  notifyOnClean: 'settingNotifyOnClean',
  showBadgeCount: 'settingShowBadgeCount',
  trackThirdParty: 'settingTrackThirdParty',
  trackThirdPartyFrames: 'settingTrackThirdPartyFrames',
  stripTrackingParams: 'settingStripTrackingParams',
  contextMenuEnabled: 'settingContextMenuEnabled',
  keepThirdPartyHistory: 'settingKeepThirdPartyHistory',
  keepSiteHistory: 'settingKeepSiteHistory'
};

export function collectSettingsFromUi() {
  const payload = {};
  for (const [key, id] of Object.entries(TOGGLE_SETTINGS)) {
    const node = el(id);
    if (node) payload[key] = node.checked;
  }
  payload.cleanDelay = clampCleanDelay(settingsUi.numDelay?.value);
  if (settingsUi.selectPeriodicInterval) {
    payload.periodicCleanInterval = Number.parseInt(settingsUi.selectPeriodicInterval.value, 10) || 60;
  }
  if (settingsUi.selectLogLevel) payload.logLevel = settingsUi.selectLogLevel.value;
  if (settingsUi.selectLanguage) payload.language = settingsUi.selectLanguage.value;
  if (settingsUi.selectTheme) payload.theme = settingsUi.selectTheme.value;
  if (settingsUi.selectRetention) payload.statsHistoryRetention = settingsUi.selectRetention.value;
  return payload;
}

export async function saveSettings({ toast = null } = {}) {
  const payload = collectSettingsFromUi();
  const written = await updateSettings(payload);

  // Kota reddi veya yonetilen profil kisitlamasinda sessizce "kaydedildi" demek yanlis guven verir.
  if (!written?.ok) {
    showToast(t('options.toastSaveFailed'), 5000);
    await loadSettings();
    return false;
  }

  // Alarm ve icerik script'i kaydini service worker yeniden degerlendirir.
  await sendToBackground(Action.SETTINGS_CHANGED);
  if (toast) showToast(t(toast));
  // Kirpilmis degerler geri yansitilir (ornek: 17 sn -> 30 sn)
  syncDelayInputs(payload.cleanDelay);
  return true;
}

export function syncDelayInputs(value) {
  const delay = clampCleanDelay(value);
  if (settingsUi.rangeDelay) settingsUi.rangeDelay.value = String(delay);
  if (settingsUi.numDelay) settingsUi.numDelay.value = String(delay);
}

/** Baska bir ayara BAGLI olan kutularin durumunu esler. */
export function syncDependentToggles() {
  const parent = el(TOGGLE_SETTINGS.trackThirdParty);
  const child = el(TOGGLE_SETTINGS.trackThirdPartyFrames);
  if (!parent || !child) return;
  child.disabled = !parent.checked;
  child.closest('.toggle-item')?.classList.toggle('is-locked', !parent.checked);
}

export async function loadSettings() {
  const settings = await getSettings();

  syncDelayInputs(settings.cleanDelay);
  // Varsayilan degeri DEFAULT_SETTINGS belirler; burada yeniden yorumlanmaz.
  for (const [key, id] of Object.entries(TOGGLE_SETTINGS)) {
    const node = el(id);
    if (!node) continue;
    const value = settings[key];
    node.checked = value === undefined ? Boolean(DEFAULT_SETTINGS[key]) : Boolean(value);
  }

  if (settingsUi.selectPeriodicInterval) {
    settingsUi.selectPeriodicInterval.value = String(settings.periodicCleanInterval || 60);
  }
  if (settingsUi.selectLogLevel) settingsUi.selectLogLevel.value = settings.logLevel || 'info';
  if (settingsUi.selectLanguage) settingsUi.selectLanguage.value = getConfiguredLanguage();
  if (settingsUi.selectTheme) settingsUi.selectTheme.value = settings.theme || 'system';
  if (settingsUi.selectRetention) {
    settingsUi.selectRetention.value = settings.statsHistoryRetention || 'monthly';
  }

  syncDependentToggles();
  await loadHardeningState(settings);
}

export const debouncedSave = debounce(() => saveSettings());

settingsUi.rangeDelay?.addEventListener('input', () => {
  if (settingsUi.numDelay) settingsUi.numDelay.value = settingsUi.rangeDelay.value;
  debouncedSave();
});

settingsUi.numDelay?.addEventListener('input', () => {
  if (settingsUi.rangeDelay) settingsUi.rangeDelay.value = settingsUi.numDelay.value;
  debouncedSave();
});

settingsUi.numDelay?.addEventListener('change', () => syncDelayInputs(settingsUi.numDelay.value));

settingsUi.selectTheme?.addEventListener('change', () => void saveSettings({ toast: 'options.toastSettingSaved' }));
settingsUi.selectPeriodicInterval?.addEventListener('change', () => void saveSettings());
settingsUi.selectRetention?.addEventListener('change', () => void saveSettings({ toast: 'options.toastSettingSaved' }));
settingsUi.selectLogLevel?.addEventListener('change', () => void saveSettings({ toast: 'options.toastSettingSaved' }));

for (const [key, id] of Object.entries(TOGGLE_SETTINGS)) {
  el(id)?.addEventListener('change', async () => {
    // Bagli kutular ANINDA eslenir.
    syncDependentToggles();
    // Sag tik menusu opsiyonel izin gerektirir; kullanici jesti burada.
    if (key === 'contextMenuEnabled' && el(id).checked) {
      const granted = await requestPermission(CONTEXT_MENUS_PERMISSION);
      if (!granted) {
        el(id).checked = false;
        showToast(t('options.toastPermissionsDenied'));
        return;
      }
    }
    await saveSettings({ toast: 'options.toastSettingSaved' });
  });
}


settingsUi.selectLanguage?.addEventListener('change', async (event) => {
  await setLanguage(event.target.value);
  applyTranslationsToDOM();
  showToast(t('options.toastSettingSaved'));
  // Dil degisti: KAYITLI tum gorunumler yeniden cizilir.
  await refreshViews();
});

settingsUi.btnClearHistory?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalClearStatsHistoryTitle',
  descKey: 'options.modalClearStatsHistoryDesc',
  confirmKey: 'options.clearStatsHistoryBtn',
  onConfirm: async () => {
    await sendToBackground(Action.CLEAR_STATS_HISTORY);
    await refreshViews('insights');
    showToast(t('options.toastStatsHistoryCleared'));
  }
}));

settingsUi.btnResetSettings?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalResetSettingsTitle',
  descKey: 'options.modalResetSettingsDesc',
  confirmKey: 'options.modalResetSettingsConfirm',
  onConfirm: async () => {
    await resetOnlySettings();
    await loadSettings();
    await sendToBackground(Action.SETTINGS_CHANGED);
    showToast(t('options.toastSettingsReset'));
  }
}));

settingsUi.btnResetRules?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalResetRulesTitle',
  descKey: 'options.modalResetRulesDesc',
  confirmKey: 'options.modalResetRulesConfirm',
  onConfirm: async () => {
    await sendToBackground(Action.RESET_RULES);
    await refreshViews('rules');
    showToast(t('options.toastRulesReset'));
  }
}));

settingsUi.btnFactoryReset?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalFactoryResetTitle',
  descKey: 'options.modalFactoryResetDesc',
  confirmKey: 'options.modalFactoryResetConfirm',
  onConfirm: async () => {
    await sendToBackground(Action.RESET_RULES);
    await resetToFactoryDefaults();
    await Promise.all([loadSettings(), refreshViews('rules', 'stats')]);
    await sendToBackground(Action.SETTINGS_CHANGED);
    showToast(t('options.toastFactoryReset'));
  }
}));

// Gizlilik sertlestirme

export const HARDENING_INPUTS = () => qsa('[data-hardening]');

export async function loadHardeningState(settings = null, appliedOutcome = null) {
  const granted = await hasPermission(PRIVACY_PERMISSION);
  settingsUi.hardeningRow?.classList.toggle('hidden', granted);
  settingsUi.hardeningList?.classList.toggle('is-locked', !granted);

  const current = settings || await getSettings();
  const response = granted ? await sendToBackground(Action.APPLY_HARDENING, {}) : null;
  const browserState = response?.state?.values || {};
  const outcome = appliedOutcome || response?.outcome;

  for (const input of HARDENING_INPUTS()) {
    const key = input.dataset.hardening;
    // Tarayicidaki gercek durum onceliklidir; okunamazsa kayitli tercih.
    input.checked = browserState[key] !== undefined ? browserState[key] : Boolean(current.hardening?.[key]);

    // Ayarin gercekten degistirilebilir olup olmadigini levelOfControl belirler. 'not_controllable' (kurumsal politika) durumunda set() sessizce yutulur; kutuyu aktif bırakmak kullanicinin korunduguna inanmasina yol acar.
    const unsupported = response?.state?.unsupported?.includes(key)
      || outcome?.unsupported?.includes(key);
    const notControllable = response?.state?.notControllable?.includes(key);
    const controlledElsewhere = response?.state?.controlledElsewhere?.includes(key);
    const unverified = outcome?.unverified?.includes(key);
    // Tarayici zaten siki tutuyorsa kapatmak bir sey degistirmez; kilitle.
    const browserEnforced = response?.state?.browserEnforced?.includes(key);
    input.disabled = !granted || unsupported || notControllable
      || controlledElsewhere || browserEnforced;

    let noteKey = null;
    // Sira onemli: "tarayici kaldirdi" en bilgilendirici durum.
    if (unsupported) noteKey = 'options.hardeningUnsupported';
    else if (notControllable) noteKey = 'options.hardeningNotControllable';
    else if (controlledElsewhere) noteKey = 'options.hardeningControlledElsewhere';
    else if (browserEnforced) noteKey = 'options.hardeningBrowserEnforced';
    else if (unverified) noteKey = 'options.hardeningUnverified';

    const meta = input.closest('.toggle-item')?.querySelector('.toggle-meta');
    const existing = meta?.querySelector('.setting-warning');
    if (noteKey && meta) {
      const text = t(noteKey);
      if (existing) existing.textContent = text;
      else meta.append(h('span', { class: 'setting-warning', text }));
    } else if (existing) {
      existing.remove();
    }
  }
}

export async function applyHardeningFromUi() {
  const hardening = { ...DEFAULT_SETTINGS.hardening };
  for (const input of HARDENING_INPUTS()) {
    hardening[input.dataset.hardening] = input.checked;
  }
  const response = await sendToBackground(Action.APPLY_HARDENING, { hardening });
  showToast(t(response?.outcome?.available ? 'options.hardeningApplied' : 'options.hardeningPermissionMissing'));
  await loadHardeningState(null, response?.outcome);
}

for (const input of HARDENING_INPUTS()) {
  input.addEventListener('change', () => void applyHardeningFromUi());
}

settingsUi.btnRequestHardening?.addEventListener('click', async () => {
  const granted = await requestPermission(PRIVACY_PERMISSION);
  if (!granted) {
    showToast(t('options.hardeningDenied'));
    return;
  }
  await applyHardeningFromUi();
});
