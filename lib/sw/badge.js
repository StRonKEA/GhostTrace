// GhostTrace - Rozet ve simge basligi

import { createDomainScope, extractHostname } from '../domain.js';
import { matchDomainRule, RuleType } from '../rules.js';
import { getSettings, getRules } from '../storage.js';
import { fetchCookies } from '../cookies.js';
import { countHistoryForScope } from '../history.js';
import { t } from '../i18n.js';
import { logWarn, LogCategory } from '../logger.js';
import { hasHostAccess } from '../privacy.js';
import {
  BADGE_DEBOUNCE_MS, BADGE_HISTORY_CAP, BADGE_COLORS, BADGE_TITLE_KEYS
} from './constants.js';
import { isManagedTab } from './tabs.js';

let badgeTimer = null;

/** Rozet yenilemesini toplar; hizli olay dizilerinde tek kez calisir. */
export function scheduleBadgeRefresh() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    void refreshActiveBadges();
  }, BADGE_DEBOUNCE_MS);
}

/** Bir sekmenin iz sayilarini hesaplar (rozet icin ucuz surum). */
export async function getTraceMetrics(urlOrHost) {
  const scope = createDomainScope(urlOrHost);
  if (!scope) return { cookieCount: 0, historyCount: 0, downloadCount: 0, total: 0, capped: false };

  const [cookies, history, downloads] = await Promise.all([
    fetchCookies({ domain: scope.cookieFilterDomain }),
    countHistoryForScope(scope, { cap: BADGE_HISTORY_CAP }),
    // Rozet her sekme etkinlesmesinde yenileniyor.
    chrome.downloads?.search
      ? chrome.downloads.search({ query: [scope.base] }).catch(() => [])
      : Promise.resolve([])
  ]);

  const cookieCount = cookies.filter(cookie => scope.matchesCookie(cookie)).length;
  const downloadCount = downloads.filter(item => item?.url && scope.matches(item.url)).length;

  return {
    cookieCount,
    historyCount: history.count,
    downloadCount,
    total: cookieCount + history.count + downloadCount,
    capped: history.capped
  };
}

/** Simge basligini (hover metni) durumla eslestirir. */
async function setActionTitle(tabId, key, host) {
  try {
    const label = host ? `${t(key)} - ${host}` : t(key);
    await chrome.action.setTitle({ title: `${t('common.appName')}: ${label}`, tabId });
  } catch {
    // Baslik yazilamamasi temizligi etkilemez.
  }
}

export async function updateBadgeForTab(tab) {
  if (!tab?.id) return;

  const clearBadge = () => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
  // Gizli sekmede normal profilin iz sayilarini gostermek yanlis bilgi olur.
  if (!isManagedTab(tab)) {
    await clearBadge();
    return;
  }

  const settings = await getSettings();
  if (settings.showBadgeCount === false) {
    await clearBadge();
    return;
  }

  try {
    // Host erisimi yoksa iz sayilari GUVENILMEZ (API bos doner).
    if (!await hasHostAccess(tab.url)) {
      await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
      await setActionTitle(tab.id, 'badge.noAccess', extractHostname(tab.url));
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.noAccess, tabId: tab.id });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId: tab.id });
      }
      return;
    }

    const [status, metrics] = await Promise.all([
      getRules().then(rules => matchDomainRule(tab.url, rules)),
      getTraceMetrics(tab.url)
    ]);

    const text = metrics.total > 0
      ? (metrics.capped ? `${BADGE_HISTORY_CAP}+` : String(metrics.total))
      : '';

    await chrome.action.setBadgeText({ text, tabId: tab.id });
    await setActionTitle(tab.id, BADGE_TITLE_KEYS[status.type] || BADGE_TITLE_KEYS.default,
      extractHostname(tab.url));
    await chrome.action.setBadgeBackgroundColor({
      color: BADGE_COLORS[status.type] || BADGE_COLORS[RuleType.DEFAULT],
      tabId: tab.id
    });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId: tab.id });
    }
  } catch {
    await clearBadge();
  }
}

/** Tum pencerelerdeki aktif sekmelerin rozetini yeniler. */
export async function refreshActiveBadges() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(tabs.map(tab => updateBadgeForTab(tab)));
  } catch (err) {
    await logWarn(LogCategory.SYSTEM, `Rozet yenilenemedi: ${err.message}`);
  }
}
