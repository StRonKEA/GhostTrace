// GhostTrace - Istatistikler sekmesi

import { getLocaleTag, t } from '../../lib/i18n.js';
import { getStats, resetStats } from '../../lib/storage.js';
import { el } from '../ui/dom.js';
import { formatBytes, formatNumber, formatRelative } from '../ui/format.js';
import { openConfirm, showToast } from '../ui/toast.js';
import { refreshViews, registerView } from '../ui/refresh.js';
import { Action, sendToBackground } from '../../lib/messaging.js';

// Istatistikler

export const statsUi = {
  cookies: el('statCookies'),
  history: el('statHistory'),
  downloads: el('statDownloads'),
  bytes: el('statBytesFreed'),
  storageBytes: el('statStorageBytes'),
  cleans: el('statCleans'),
  lastCleaned: el('statLastCleaned'),
  lastCleanedRow: el('statLastCleanedRow'),
  btnReset: el('btnResetStats'),
  btnClearLists: el('btnClearInsightLists')
};

export async function renderStats() {
  const stats = await getStats();
  if (statsUi.cookies) statsUi.cookies.textContent = formatNumber(stats.cookiesDeleted);
  if (statsUi.history) statsUi.history.textContent = formatNumber(stats.historyDeleted);
  if (statsUi.downloads) statsUi.downloads.textContent = formatNumber(stats.downloadsDeleted);
  if (statsUi.bytes) statsUi.bytes.textContent = formatBytes(stats.bytesFreed);
  if (statsUi.storageBytes) {
    // Tarayicinin bildirdigi depolama olcumu. bytesFreed ile TOPLANMAZ: biri silme aninda birebir olculen, digeri sayfa acikken alinmis bir tahmin.
    statsUi.storageBytes.textContent = stats.storageBytesFreed > 0
      ? t('options.statStorageBytesValue', { size: formatBytes(stats.storageBytesFreed) })
      : '';
  }
  if (statsUi.cleans) statsUi.cleans.textContent = formatNumber(stats.totalCleans);
  if (statsUi.lastCleaned) {
    statsUi.lastCleaned.textContent = formatRelative(stats.lastCleanedAt);
    statsUi.lastCleaned.title = stats.lastCleanedAt
      ? new Date(stats.lastCleanedAt).toLocaleString(getLocaleTag())
      : '';
  }
  if (statsUi.lastCleanedRow) {
    // Hic temizlik yapilmadiysa "iyi" demek yanlis olur; notr kalir.
    const cleaned = Boolean(stats.lastCleanedAt);
    statsUi.lastCleanedRow.classList.toggle('tone-good', cleaned);
    statsUi.lastCleanedRow.classList.toggle('tone-idle', !cleaned);
  }
}

statsUi.btnReset?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalResetStatsTitle',
  descKey: 'options.modalResetStatsDesc',
  confirmKey: 'options.modalResetStatsConfirm',
  onConfirm: async () => {
    await resetStats();
    await renderStats();
    showToast(t('options.toastStatsReset'));
  }
}));

// Listeler SAYAC DEGIL: kendi eylemleri var. "Istatistikleri sifirla"
// yalnizca sayaclari sifirliyor ve liste ondan beslenmiyordu.
statsUi.btnClearLists?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalClearInsightListsTitle',
  descKey: 'options.modalClearInsightListsDesc',
  confirmKey: 'options.modalClearInsightListsConfirm',
  onConfirm: async () => {
    await sendToBackground(Action.CLEAR_INSIGHT_LISTS);
    await refreshViews('stats', 'insights');
    showToast(t('options.toastInsightListsCleared'));
  }
}));

registerView('stats', renderStats);
