// GhostTrace - Loglar ve sistem durumu sekmesi

import { PSL_VERSION } from '../../lib/domain.js';
import { getLocaleTag, t } from '../../lib/i18n.js';
import { formatLogTime, LOGS_STORAGE_KEY } from '../../lib/logger.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import { el, h, icon, qs, qsa } from '../ui/dom.js';
import { downloadFile, formatBytes, formatNumber, timestampForFileName } from '../ui/format.js';
import { refreshViews, registerView } from '../ui/refresh.js';
import { openConfirm, showToast } from '../ui/toast.js';
import { debounce } from '../ui/util.js';
import { selectOne } from '../../ui/segmented.js';

// Loglar ve teshis

export const logsUi = {
  tableBody: el('logsTableBody'),
  emptyState: el('emptyLogsState'),
  search: el('inputSearchLogs'),
  clearSearch: el('btnClearSearchLogs'),
  autoScroll: el('checkAutoScrollLogs'),
  btnRefresh: el('btnRefreshLogs'),
  btnCopy: el('btnCopyLogs'),
  btnExportTxt: el('btnExportLogsTxt'),
  btnExportJson: el('btnExportLogsJson'),
  btnClear: el('btnClearLogs'),
  diagnostics: el('diagnosticsList'),
  btnDiagnostics: el('btnRefreshDiagnostics'),
  counts: {
    all: el('countLogAll'),
    PURGE: el('countLogPurge'),
    COOKIE: el('countLogCookie'),
    ALARM: el('countLogAlarm'),
    TAB: el('countLogTab'),
    ERROR: el('countLogError')
  }
};

export const logsState = { list: [], filter: 'all', query: '' };

/** Silme izni durumu - HANGI turun engelli oldugunu soyler. */
export function removalPolicyLabel(history, downloads) {
  const bilinen = (value) => value === true || value === false;
  if (!bilinen(history) || !bilinen(downloads)) return t('common.unavailable');
  if (history && downloads) return t('options.diagnosticsRemovalAllowed');
  if (!history && !downloads) return t('options.diagnosticsRemovalBlocked');
  return t(history
    ? 'options.diagnosticsRemovalBlockedDownloads'
    : 'options.diagnosticsRemovalBlockedHistory');
}

/** Oturum bellegi kullanimi - biliniyorsa KOTAYLA birlikte. */
export function formatSessionMemory(used, quota) {
  if (used === null || used === undefined) return t('common.unavailable');
  const kullanim = formatBytes(used);
  return Number.isFinite(quota) && quota > 0
    ? `${kullanim} / ${formatBytes(quota)}`
    : kullanim;
}

/** Log kaydini SABIT yukseklikte tek satira cizer: seviye sol kenardaki renk cubugu, kategori sessiz on ek, ayrinti ayri satirda. */
export function buildLogRow(entry) {
  const level = entry.level || 'INFO';
  const message = entry.message || '';
  const fragment = document.createDocumentFragment();
  const row = h('tr', { class: `log-row log-row-${level}` });

  row.append(h('td', { class: 'log-time', text: formatLogTime(entry, getLocaleTag()) }));
  row.append(h('td', {}, h('span', { class: `log-level log-level-${level}`, text: level })));
  row.append(h('td', {
    // Kirpilan alan adi fareyle uzerine gelince TAM okunabilmeli.
    title: entry.domain || '',
    class: entry.domain ? 'log-domain' : 'log-domain log-domain-empty',
    // Ciplak bir tire "bu nedir?" sorusunu doguruyordu (kullanici sordu).
    text: entry.domain || t('options.logDomainNone')
  }));

  // Satir tek satirda kaldigi icin uzun mesaj kirpilir; tamami baslikta.
  row.append(h('td', { class: 'log-message', title: message }, [
    h('span', { class: 'log-cat', text: entry.category || 'SYSTEM' }),
    h('span', { class: 'log-text', text: message })
  ]));

  if (!entry.details) {
    // Hucre ayrinti OLMAYAN satirlarda da durur: yerini korumasa kolon hizasi satirdan satira kayardi.
    row.append(h('td', { class: 'log-expand-cell' }));
    fragment.append(row);
    return fragment;
  }

  const detailsRow = h('tr', { class: 'log-details-row hidden' },
    h('td', { class: 'log-details-cell', attrs: { colspan: '5' } },
      h('pre', {
        class: 'log-details-pre',
        text: typeof entry.details === 'object'
          ? JSON.stringify(entry.details, null, 2)
          : String(entry.details)
      })));

  const toggle = h('button', {
    class: 'log-expand-btn',
    type: 'button',
    title: t('options.detailsShow'),
    attrs: { 'aria-expanded': 'false', 'aria-label': t('options.detailsShow') }
  }, icon('chevron', 14));

  toggle.addEventListener('click', () => {
    const open = detailsRow.classList.toggle('hidden');
    const expanded = !open;
    const label = t(expanded ? 'options.detailsHide' : 'options.detailsShow');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(expanded));
    row.classList.toggle('is-expanded', expanded);
  });

  row.append(h('td', { class: 'log-expand-cell' }, toggle));
  fragment.append(row);
  fragment.append(detailsRow);
  return fragment;
}

export function renderLogs() {
  if (!logsUi.tableBody) return;

  const counts = {
    all: logsState.list.length,
    PURGE: 0, COOKIE: 0, ALARM: 0, TAB: 0, ERROR: 0
  };
  for (const entry of logsState.list) {
    if (counts[entry.category] !== undefined) counts[entry.category]++;
    if (entry.level === 'ERROR' || entry.level === 'WARN') counts.ERROR++;
  }
  for (const [key, node] of Object.entries(logsUi.counts)) {
    if (!node) continue;
    const value = counts[key] ?? 0;
    node.textContent = String(value);
    // Sifir gurultudur: alti cipten dordu ayni anda "0" gosterebiliyor.
    node.classList.toggle('is-zero', value === 0);
  }

  const query = logsState.query.toLowerCase();
  const visible = logsState.list.filter(entry => {
    if (logsState.filter === 'ERROR') {
      if (entry.level !== 'ERROR' && entry.level !== 'WARN') return false;
    } else if (logsState.filter !== 'all' && entry.category !== logsState.filter) {
      return false;
    }
    if (!query) return true;
    return [entry.domain, entry.message, entry.category]
      .some(field => (field || '').toLowerCase().includes(query));
  });

  logsUi.tableBody.replaceChildren();
  if (visible.length === 0) {
    logsUi.emptyState?.classList.remove('hidden');
    return;
  }
  logsUi.emptyState?.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  for (const entry of visible) fragment.append(buildLogRow(entry));
  logsUi.tableBody.append(fragment);

  if (logsUi.autoScroll?.checked) {
    const wrap = qs('.log-console-wrap');
    if (wrap) wrap.scrollTop = 0;
  }
}

export async function loadLogs() {
  const response = await sendToBackground(Action.GET_LOGS, { limit: 500 });
  // Sondaki `|| []` BILINCLI: arka uc success:true donup `logs` alanini gondermezse liste undefined kaliyor ve renderLogs ilk satirda `undefined.length` ile patliyor - Gunlukler sekmesi bos bir ekranda kaliyor, sebebi de gorunmuyor.
  logsState.list = (response?.success ? response.logs : null) || [];
  renderLogs();
}

/** Durum bayragi: DEGER onde (cip), ETIKET arkada - degerler kendiliginden hizalanir. */
/** Durum bayragi: nokta + etiket + deger; istege bagli olcer ve aciklama. */
function buildStatusFlag({ tone, label, value, meter = null, note = '' }) {
  const flag = h('div', { class: `status-flag tone-${tone}` }, [
    h('span', { class: 'status-dot' }),
    h('span', { class: 'status-flag-label', text: label }),
    h('span', { class: 'status-flag-value', text: value })
  ]);

  if (meter) {
    const [on, total] = meter;
    flag.append(h('div', { class: 'status-meter', attrs: { 'aria-hidden': 'true' } },
      Array.from({ length: total }, (unused, index) =>
        h('span', { class: index < on ? 'is-on' : '' }))));
  }
  if (note) flag.append(h('span', { class: 'status-flag-note', text: note }));
  return flag;
}

/** Sistem Durumu: UC veri turu, UC bicim. 1. Olcum bandi - gunluk bakilan dort sayac, karsilastirilabilir. 2. Durum bayragi - yanlis OLABILEN iki kalem; renk butcesi burada. 3. Teknik cekmece - oturum bellegi, depolama olcumu, PSL surumu; kapali. */
export async function loadDiagnostics() {
  if (!logsUi.diagnostics) return;
  const response = await sendToBackground(Action.GET_DIAGNOSTICS);
  logsUi.diagnostics.replaceChildren();
  if (!response?.success) return;

  // --- 1. Olcum bandi -----------------------------------------------------
  const metrics = [
    ['options.diagnosticsRules', response.ruleCount],
    ['options.diagnosticsAlarms', response.alarms?.length || 0],
    ['options.diagnosticsTrackedTabs', response.trackedTabs],
    ['options.diagnosticsThirdParty', response.thirdPartyCount]
  ];
  const strip = h('div', { class: 'metric-strip' }, metrics.map(([key, value]) =>
    h('div', { class: 'metric-cell' }, [
      h('span', { class: 'metric-label', text: t(key) }),
      h('span', { class: 'metric-num', text: formatNumber(value) })
    ])));

  // --- 2. Durum bayraklari ------------------------------------------------
  const history = response.historyRemovalPermitted;
  const downloads = response.downloadsRemovalPermitted;
  const known = (value) => value === true || value === false;
  const policyTone = !known(history) || !known(downloads)
    ? 'idle'
    : (history && downloads) ? 'good' : 'bad';

  const flags = h('div', { class: 'status-flags' }, buildStatusFlag({
    tone: policyTone,
    label: t('options.diagnosticsRemovalPolicy'),
    value: removalPolicyLabel(history, downloads)
  }));

  // Toplami ELDE EDILEN degerlerden turet; sabit toplam yazmak yeni bir sertlestirme secenegi eklendiginde sessizce yanlislasiyordu.
  const hardeningValues = Object.entries(response.hardening?.values || {});
  const hardeningOn = hardeningValues.filter(([, on]) => on).length;

  flags.append(response.hardening?.available
    ? buildStatusFlag({
      tone: hardeningValues.length === 0
        ? 'idle'
        : hardeningOn === hardeningValues.length ? 'good' : 'warn',
      label: t('options.diagnosticsHardening'),
      value: `${formatNumber(hardeningOn)} / ${formatNumber(hardeningValues.length)}`,
      meter: hardeningValues.length > 0 ? [hardeningOn, hardeningValues.length] : null
    })
    : buildStatusFlag({
      tone: 'warn',
      label: t('options.diagnosticsHardening'),
      value: t('options.diagnosticsHardeningNoPermission'),
      // Uzun cumle artik bir DEGER hucresi degil; kisa sozcuk cipte, cumle kendi satirinda serbestce sarar.
      note: t('options.hardeningPermissionMissing')
    }));

  // --- 3. Teknik cekmece --------------------------------------------------
  const technical = [
    ['options.diagnosticsSessionBytes',
      formatSessionMemory(response.sessionBytes, response.sessionQuota)],
    ['options.diagnosticsStorageEstimates', formatNumber(response.storageEstimateCount || 0)],
    ['options.diagnosticsPslVersion', PSL_VERSION]
  ];
  const drawer = h('dl', {
    class: 'tech-drawer hidden',
    attrs: { id: 'diagnosticsTech' }
  }, technical.map(([key, value]) => h('div', { class: 'tech-item' }, [
    h('dt', { text: t(key) }),
    h('dd', { text: String(value) })
  ])));

  const toggle = h('button', {
    class: 'tech-toggle',
    type: 'button',
    attrs: { 'aria-expanded': 'false', 'aria-controls': 'diagnosticsTech' }
  }, [icon('chevron', 13), h('span', { text: t('options.diagnosticsTechDetails') })]);

  toggle.addEventListener('click', () => {
    const expanded = !drawer.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.classList.toggle('is-open', expanded);
  });

  logsUi.diagnostics.append(
    strip,
    flags,
    h('div', { class: 'tech-wrap' }, [toggle, drawer])
  );
}

logsUi.btnRefresh?.addEventListener('click', async () => {
  await Promise.all([loadLogs(), loadDiagnostics()]);
  showToast(t('options.toastSiteDataRefreshed'));
});

logsUi.btnDiagnostics?.addEventListener('click', () => void loadDiagnostics());

logsUi.search?.addEventListener('input', debounce(() => {
  logsState.query = logsUi.search.value.trim();
  logsUi.clearSearch?.classList.toggle('hidden', !logsState.query);
  renderLogs();
}, 200));

logsUi.clearSearch?.addEventListener('click', () => {
  logsUi.search.value = '';
  logsState.query = '';
  logsUi.clearSearch.classList.add('hidden');
  renderLogs();
  logsUi.search.focus();
});

for (const pill of qsa('#logs-tab [data-log-filter]')) {
  pill.addEventListener('click', () => {
    selectOne(qsa('#logs-tab [data-log-filter]'), pill);
    logsState.filter = pill.dataset.logFilter || 'all';
    renderLogs();
  });
}

logsUi.btnCopy?.addEventListener('click', async () => {
  const response = await sendToBackground(Action.EXPORT_LOGS, { format: 'text', locale: getLocaleTag() });
  if (!response?.success) return;
  try {
    await navigator.clipboard.writeText(response.content);
    showToast(t('options.toastLogsCopied'));
  } catch {
    showToast(t('options.toastCopyFailed'));
  }
});

logsUi.btnExportTxt?.addEventListener('click', async () => {
  const response = await sendToBackground(Action.EXPORT_LOGS, { format: 'text', locale: getLocaleTag() });
  if (!response?.success) return;
  downloadFile(response.content, `GhostTrace_Logs_${timestampForFileName()}.txt`, 'text/plain;charset=utf-8');
  showToast(t('options.toastLogsDownloaded'));
});

logsUi.btnExportJson?.addEventListener('click', async () => {
  const response = await sendToBackground(Action.EXPORT_LOGS, { format: 'json' });
  if (!response?.success) return;
  downloadFile(response.content, `GhostTrace_Logs_${timestampForFileName()}.json`, 'application/json;charset=utf-8');
  showToast(t('options.toastLogsDownloaded'));
});

logsUi.btnClear?.addEventListener('click', () => openConfirm({
  titleKey: 'options.modalClearLogsTitle',
  descKey: 'options.modalClearLogsDesc',
  confirmKey: 'options.modalClearLogsConfirm',
  onConfirm: async () => {
    const response = await sendToBackground(Action.CLEAR_LOGS);
    if (response?.success) {
      logsState.list = [];
      renderLogs();
      showToast(t('options.toastLogsCleared'));
    }
  }
}));

// Loglar artik OTURUM depolamasinda; dinleyici de o alani izler.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'session' && changes[LOGS_STORAGE_KEY]) {
    if (qs('.nav-item.active')?.dataset.tab !== 'logs-tab') return;
    logsState.list = Array.isArray(changes[LOGS_STORAGE_KEY].newValue) ? changes[LOGS_STORAGE_KEY].newValue : [];
    renderLogs();
  }
  if (areaName === 'local' && changes.rules) {
    void refreshViews('rules');
  }
});

registerView('logs', renderLogs);
registerView('diagnostics', loadDiagnostics);
