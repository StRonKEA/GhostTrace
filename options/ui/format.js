// GhostTrace - Ayarlar paneli: bicimlendirme ve donusturme

import { getLocaleTag, t } from '../../lib/i18n.js';
import { RuleType } from '../../lib/rules.js';
import { h } from './dom.js';

// Bicimlendirme

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${new Intl.NumberFormat(getLocaleTag(), { maximumFractionDigits: 1 }).format(value)} ${units[index]}`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat(getLocaleTag()).format(Number(value) || 0);
}

export function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleDateString(getLocaleTag());
}

/** Gecmis zamani "3 dakika once" gibi yazar (elle yazilmis dallanma yerine). */
export function formatRelative(timestamp) {
  if (!timestamp) return t('common.none');
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return t('common.justNow');

  const formatter = new Intl.RelativeTimeFormat(getLocaleTag(), { numeric: 'auto' });
  const units = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000]
  ];
  for (const [unit, ms] of units) {
    if (diffMs >= ms) return formatter.format(-Math.floor(diffMs / ms), unit);
  }
  return t('common.justNow');
}

/** Dakikadan yerelleştirilmis sure etiketi. */
export function formatDuration(minutes) {
  if (!minutes) return t('common.sessionScope');
  if (minutes < 60) return `${minutes} ${t('common.minutesUnit')}`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${t('common.hoursUnit')}`;
}

/** Kalan sure metni. */
export function formatRemaining(expiresAt) {
  if (!expiresAt) return '';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return t('popup.timeExpired');
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes} ${t('common.minutesUnit')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0
    ? `${hours} ${t('common.hoursUnit')} ${rest} ${t('common.minutesUnit')}`
    : `${hours} ${t('common.hoursUnit')}`;
}

/** "white" | "grey" | "temp_15" gibi secim degerini kural parametrelerine cevirir. */
export function parseRuleSelection(value) {
  if (value === 'grey') {
    return { type: RuleType.GREY, options: {} };
  }
  if (typeof value === 'string' && value.startsWith('temp_')) {
    const minutes = Number.parseInt(value.slice(5), 10) || 60;
    // Bitis zamani BURADA HESAPLANMAZ.
    return { type: RuleType.TEMP, options: { durationMinutes: minutes } };
  }
  return { type: RuleType.WHITE, options: {} };
}

/** Kural nesnesinden secim degerini geri uretir. */
export function ruleToSelection(rule) {
  if (!rule) return 'white';
  if (rule.type === RuleType.GREY) return 'grey';
  if (rule.type === RuleType.TEMP) {
    const minutes = rule.durationMinutes || 60;
    return [15, 60, 1440].includes(minutes) ? `temp_${minutes}` : 'temp_60';
  }
  return 'white';
}

/** Tek dosya indirme yardimcisi (eskiden iki farkli surumu vardi). */
export function downloadFile(content, fileName, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = h('a', { attrs: { href: url, download: fileName } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function timestampForFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}
