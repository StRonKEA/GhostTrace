// GhostTrace - Kalici alarmlarin bakimi

import { getSettings } from '../storage.js';
import { logInfo, LogCategory } from '../logger.js';
import { ALARM_PERIODIC_SWEEP, ALARM_MAINTENANCE, MAINTENANCE_INTERVAL_MIN } from './constants.js';

/** Periyodik supurme alarmini KURULU DEGILSE kurar. */
export async function ensurePeriodicAlarm() {
  const settings = await getSettings();
  const existing = await chrome.alarms.get(ALARM_PERIODIC_SWEEP);

  if (!settings.enabled || !settings.periodicCleanEnabled) {
    if (existing) await chrome.alarms.clear(ALARM_PERIODIC_SWEEP);
    return;
  }

  const interval = Math.max(15, Number(settings.periodicCleanInterval) || 60);
  if (existing && existing.periodInMinutes === interval) return;

  if (existing) await chrome.alarms.clear(ALARM_PERIODIC_SWEEP);
  await chrome.alarms.create(ALARM_PERIODIC_SWEEP, {
    periodInMinutes: interval,
    delayInMinutes: interval
  });
  await logInfo(LogCategory.ALARM, `Periyodik temizlik ${interval} dakikada bir`, { interval });
}

/** Bakim alarmini kurulu degilse kurar. */
export async function ensureMaintenanceAlarm() {
  const existing = await chrome.alarms.get(ALARM_MAINTENANCE);
  if (existing) return;
  await chrome.alarms.create(ALARM_MAINTENANCE, {
    periodInMinutes: MAINTENANCE_INTERVAL_MIN,
    delayInMinutes: MAINTENANCE_INTERVAL_MIN
  });
}
