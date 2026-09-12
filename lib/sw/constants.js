// GhostTrace - Service Worker sabitleri

import { RuleType } from '../rules.js';

export const ALARM_PURGE_PREFIX = 'gt:purge:';
export const ALARM_WHITELIST_PREFIX = 'gt:wlclean:';
export const ALARM_PERIODIC_SWEEP = 'gt:periodicSweep';
/** Toplu temizlik butceye takilirsa kalani surduren alarm. */
export const BULK_CONTINUE_ALARM = `${ALARM_PERIODIC_SWEEP}:continue`;

/** Kisitlamaya takilan yetim supurmesini ERTELEYEN alarm. */
export const ALARM_SWEEP_RETRY = 'gt:sweepRetry';

export const ALARM_MAINTENANCE = 'gt:maintenance';

export const MAINTENANCE_INTERVAL_MIN = 30;
export const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const SWEEP_MAX_DOMAINS = 60;
export const BADGE_DEBOUNCE_MS = 300;
export const BADGE_HISTORY_CAP = 999;

// Zaman butcesine takilan bir temizligin kalanini surdurmek icin beklenecek sure. chrome.alarms 30 saniyenin altina inemedigi icin en kucuk gercekci deger budur.
export const CONTINUATION_DELAY_MS = 31_000;

export const CONTENT_SCRIPT_ID = 'ghosttrace-trace-observer';

export const MENU_ROOT = 'gt:menu:root';
export const MENU_PURGE = 'gt:menu:purge';
export const MENU_WHITELIST = 'gt:menu:whitelist';

/** Rozet renginin METIN karsiligi (renk tek basina erisilebilir degil). */
export const BADGE_TITLE_KEYS = {
  [RuleType.WHITE]: 'badge.white',
  [RuleType.GREY]: 'badge.grey',
  [RuleType.TEMP]: 'badge.temp',
  default: 'badge.default'
};

export const BADGE_COLORS = {
  // Host erisimi kisitli: sayi guvenilmez, uyari rengi.
  noAccess: '#64748b',
  [RuleType.WHITE]: '#10b981',
  [RuleType.GREY]: '#f59e0b',
  [RuleType.TEMP]: '#8b5cf6',
  [RuleType.DEFAULT]: '#ef4444'
};

export const purgeAlarmName = (host) => `${ALARM_PURGE_PREFIX}${host}`;
export const whitelistAlarmName = (host) => `${ALARM_WHITELIST_PREFIX}${host}`;
