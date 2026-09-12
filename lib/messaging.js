// GhostTrace - Mesaj Sozlesmesi (Messaging Contract)

export const Action = Object.freeze({
  // Okuma
  GET_ACTIVE_TAB_INFO: 'GET_ACTIVE_TAB_INFO',
  GET_DOMAIN_COOKIES: 'GET_DOMAIN_COOKIES',
  GET_ALL_STORED_DOMAINS: 'GET_ALL_STORED_DOMAINS',
  CLEAR_STATS_HISTORY: 'CLEAR_STATS_HISTORY',
  CLEAR_INSIGHT_LISTS: 'CLEAR_INSIGHT_LISTS',
  GET_LOGS: 'GET_LOGS',
  GET_DIAGNOSTICS: 'GET_DIAGNOSTICS',

  // Kural mutasyonlari (yalnizca service worker uygular)
  SET_RULE: 'SET_RULE',
  DELETE_RULE: 'DELETE_RULE',
  SET_RULE_SCOPE: 'SET_RULE_SCOPE',
  IMPORT_RULES: 'IMPORT_RULES',
  RESET_RULES: 'RESET_RULES',

  // Temizlik
  PURGE_DOMAIN: 'PURGE_DOMAIN',
  PURGE_DOMAIN_HISTORY_ONLY: 'PURGE_DOMAIN_HISTORY_ONLY',
  PURGE_SELECTED_DOMAINS: 'PURGE_SELECTED_DOMAINS',
  PURGE_ALL_NON_WHITELIST: 'PURGE_ALL_NON_WHITELIST',
  // DELETE_SPECIFIC_COOKIE KALDIRILDI (v2.7.0).

  // Ayarlar / sistem
  SET_AUTOMATIC_CLEANING_ENABLED: 'SET_AUTOMATIC_CLEANING_ENABLED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  // REFRESH_BADGES KALDIRILDI (v2.7.0): rozet yenilemesi zaten ic yoldan (scheduleBadgeRefresh) yapiliyor, mesaj yolunu kimse cagirmiyordu.
  CLEAR_LOGS: 'CLEAR_LOGS',
  EXPORT_LOGS: 'EXPORT_LOGS',
  APPLY_HARDENING: 'APPLY_HARDENING',

  // Icerik script'i ile iki yonlu
  REPORT_THIRD_PARTY: 'REPORT_THIRD_PARTY',
  REPORT_STORAGE_ESTIMATE: 'REPORT_STORAGE_ESTIMATE',
  STOP_THIRD_PARTY_OBSERVER: 'STOP_THIRD_PARTY_OBSERVER'
});

/** Service worker'a mesaj gonderir. chrome.runtime.sendMessage MV3'te promise doner ama alici yoksa reject eder; arayuzun cokmemesi icin burada normalize edilir. */
export async function sendToBackground(action, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ action, ...payload });
    if (response === undefined) {
      return { success: false, error: 'NO_RESPONSE' };
    }
    return response;
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`[GhostTrace] ${action} mesaji basarisiz:`, message);
    return { success: false, error: message };
  }
}
