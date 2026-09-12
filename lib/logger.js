// GhostTrace - Teshis Loglari

import { getSettings, LOG_LEVELS } from './storage.js';

export const LOGS_STORAGE_KEY = 'gt_logs';
export const MAX_LOG_ENTRIES = 500;

const FLUSH_DELAY_MS = 250;
const FLUSH_THRESHOLD = 25;

// DEBUG seviyesi BILINCLI olarak yok.
export const LogLevel = Object.freeze({
  ERROR: 'ERROR',
  WARN: 'WARN',
  SUCCESS: 'SUCCESS',
  INFO: 'INFO'
});

export const LogCategory = Object.freeze({
  PURGE: 'PURGE',
  COOKIE: 'COOKIE',
  TAB: 'TAB',
  ALARM: 'ALARM',
  STORAGE: 'STORAGE',
  RULE: 'RULE',
  SYSTEM: 'SYSTEM'
});

// Hangi ayar seviyesi hangi kayitlari gecirir
const LEVEL_RANK = { off: 0, error: 1, info: 2 };
const ENTRY_RANK = {
  [LogLevel.ERROR]: 1,
  [LogLevel.WARN]: 1,
  [LogLevel.SUCCESS]: 2,
  [LogLevel.INFO]: 2
};

let buffer = [];
let flushTimer = null;
let flushChain = Promise.resolve();

let cachedLevel = null;
async function activeLevel() {
  if (cachedLevel !== null) return cachedLevel;
  try {
    const settings = await getSettings();
    cachedLevel = LOG_LEVELS.includes(settings.logLevel) ? settings.logLevel : 'info';
  } catch {
    cachedLevel = 'info';
  }
  return cachedLevel;
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && 'logLevel' in changes) cachedLevel = null;
  });
}

function scheduleFlush() {
  if (buffer.length >= FLUSH_THRESHOLD) {
    void flushLogs();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLogs();
  }, FLUSH_DELAY_MS);
}

/** Tamponu oturum depolamasina yazar. */
export async function flushLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;

  const pending = buffer;
  buffer = [];

  flushChain = flushChain.then(async () => {
    try {
      // YEDEK YOK: oturum deposu yoksa log YAZILMAZ.
      const area = chrome.storage.session;
      if (!area) return;
      const stored = await area.get(LOGS_STORAGE_KEY);
      const existing = Array.isArray(stored[LOGS_STORAGE_KEY]) ? stored[LOGS_STORAGE_KEY] : [];
      const merged = [...pending.reverse(), ...existing].slice(0, MAX_LOG_ENTRIES);
      await area.set({ [LOGS_STORAGE_KEY]: merged });
    } catch (err) {
      console.warn('[GhostTrace] Log yazilamadi:', err);
    }
  }, () => {});

  return flushChain;
}

function buildEntry(level, category, message, details, domain) {
  let safeDetails = null;
  if (details !== null && details !== undefined) {
    try {
      safeDetails = typeof details === 'object' ? structuredClone(details) : String(details);
    } catch {
      safeDetails = String(details);
    }
  }
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    level,
    category,
    domain: domain || null,
    message: String(message ?? ''),
    details: safeDetails
  };
}

/** Log kaydi ekler (seviye filtresine tabi). */
export async function addLog(level, category, message, details = null, domain = null) {
  const configured = await activeLevel();
  if (configured === 'off') return null;
  if ((ENTRY_RANK[level] || 2) > (LEVEL_RANK[configured] ?? 2)) return null;

  const entry = buildEntry(level, category, message, details, domain);
  buffer.push(entry);

  if (level === LogLevel.ERROR) {
    await flushLogs();
  } else {
    scheduleFlush();
  }
  return entry;
}

export const logInfo = (category, message, details, domain) => addLog(LogLevel.INFO, category, message, details, domain);
export const logSuccess = (category, message, details, domain) => addLog(LogLevel.SUCCESS, category, message, details, domain);
export const logWarn = (category, message, details, domain) => addLog(LogLevel.WARN, category, message, details, domain);
export const logError = (category, message, details, domain) => addLog(LogLevel.ERROR, category, message, details, domain);
/** Kayitli loglari getirir (once tamponu bosaltir). */
export async function getLogs(limit = MAX_LOG_ENTRIES) {
  await flushLogs();
  try {
    const area = chrome.storage.session;
    if (!area) return [];
    const stored = await area.get(LOGS_STORAGE_KEY);
    const logs = Array.isArray(stored[LOGS_STORAGE_KEY]) ? stored[LOGS_STORAGE_KEY] : [];
    return logs.slice(0, limit);
  } catch (err) {
    console.warn('[GhostTrace] Log okunamadi:', err);
    return [];
  }
}

/** Tum loglari siler. */
export async function clearLogs() {
  buffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const area = chrome.storage.session;
    if (!area) return true;
    await area.set({ [LOGS_STORAGE_KEY]: [] });
    return true;
  } catch (err) {
    console.error('[GhostTrace] Loglar silinemedi:', err);
    return false;
  }
}

/**
 * Kayit TAMAMLANMIS bir temizlik ozeti mi?
 *
 * BURADA duruyor, arayuzde degil: Istatistik sekmesindeki iki liste bu
 * yuklemle SUZULUYOR ve "Listeleri temizle" ayni yuklemle SILIYOR. Iki yerde
 * iki kopya olsa biri degisince liste ile silme birbirinden sapardi - bu
 * projede ayni kavramin iki adi daha once sapma uretmisti.
 */
export function isCleanupSummary(entry) {
  const d = entry?.details;
  if (!entry?.domain || !d || entry.level !== LogLevel.SUCCESS) return false;
  return typeof d.downloads === 'number'
    && (typeof d.cookies === 'number' || typeof d.history === 'number');
}

/**
 * YALNIZCA temizlik ozetlerini siler; diger teshis kayitlari kalir.
 *
 * Neden secici: Istatistik sekmesindeki listeler bu kayitlardan turetiliyor,
 * ama gunlukler ayni zamanda tek teshis aracimiz ("butceye takildi -> devam
 * alarmi" zinciri orada goruluyor). Listeleri temizlemek icin hepsini silmek
 * o zinciri de goturur.
 */
export async function clearCleanupSummaries() {
  buffer = buffer.filter(entry => !isCleanupSummary(entry));
  try {
    const area = chrome.storage.session;
    if (!area) return true;
    const stored = await area.get(LOGS_STORAGE_KEY);
    const existing = Array.isArray(stored[LOGS_STORAGE_KEY]) ? stored[LOGS_STORAGE_KEY] : [];
    await area.set({ [LOGS_STORAGE_KEY]: existing.filter(entry => !isCleanupSummary(entry)) });
    return true;
  } catch (err) {
    console.error('[GhostTrace] Temizlik ozetleri silinemedi:', err);
    return false;
  }
}

/** Kayit zamanini yerelleştirilmis saat dizesine cevirir. */
export function formatLogTime(entry, locale = 'tr-TR') {
  const date = new Date(entry?.timestamp || Date.now());
  return date.toLocaleTimeString(locale, {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
  });
}

/** Loglari duz metne cevirir. Basliklar cagiran tarafindan yerelleştirilir. */
export function formatLogsAsText(logs, { title = 'GhostTrace diagnostics', locale = 'tr-TR' } = {}) {
  const line = '='.repeat(78);
  const header = [
    line,
    title,
    `${new Date().toLocaleString(locale)}  |  ${logs.length} kayit / entries`,
    line,
    ''
  ].join('\n');

  const rows = logs.map(entry => {
    const time = formatLogTime(entry, locale);
    const level = (entry.level || 'INFO').padEnd(7);
    const category = (entry.category || 'SYSTEM').padEnd(8);
    const domain = entry.domain ? `[${entry.domain}] ` : '';
    let text = `[${time}] [${level}] [${category}] ${domain}${entry.message}`;
    if (entry.details) {
      const detail = typeof entry.details === 'object'
        ? JSON.stringify(entry.details, null, 2)
        : String(entry.details);
      text += `\n    ${detail.replace(/\n/g, '\n    ')}`;
    }
    return text;
  });

  return header + rows.join('\n') + '\n';
}

/** Loglari JSON'a cevirir. */
export function formatLogsAsJSON(logs) {
  return JSON.stringify({
    app: 'GhostTrace',
    exportedAt: new Date().toISOString(),
    totalEntries: logs.length,
    logs
  }, null, 2);
}

/** Testler icin dahili durumu sifirlar. */
export function __resetLoggerForTests() {
  buffer = [];
  cachedLevel = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
