// GhostTrace - Site verileri sekmesi

import { getRootDomain } from '../../lib/domain.js';
import { t } from '../../lib/i18n.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import { RuleType } from '../../lib/rules.js';
import { badge, el, h, icon, qsa } from '../ui/dom.js';
import { formatBytes } from '../ui/format.js';
import { refreshViews, registerView } from '../ui/refresh.js';
import { openConfirm, showToast, showToastWithUndo } from '../ui/toast.js';
import { selectOne } from '../../ui/segmented.js';

// Site verileri sekmesi

export const siteUi = {
  tableBody: el('siteDataTableBody'),
  emptyState: el('emptySiteDataState'),
  truncatedNote: el('siteDataTruncatedNote'),
  btnRefresh: el('btnRefreshSiteData'),
  btnPurgeSelected: el('btnPurgeSelected'),
  txtPurgeSelected: el('txtPurgeSelected'),
  btnPurgeAll: el('btnPurgeAllNonWhitelisted'),
  search: el('inputSearchSiteData'),
  clearSearch: el('btnClearSearchSiteData'),
  selectAll: el('checkSelectAllSites'),
  counts: {
    all: el('countSiteAll'),
    direct: el('countSiteDirect'),
    third_party: el('countSiteThirdParty'),
    default: el('countSiteDefault'),
    white: el('countSiteWhite'),
    grey: el('countSiteGrey')
  }
};

export const siteState = {
  list: [], selected: new Set(), filter: 'all', query: '', columns: 8,
  // Liste HIC yuklenmedi mi, yoksa yuklendi ve BOS mu?
  loaded: false
};

export function filteredSites() {
  const { filter, query } = siteState;
  return siteState.list
    .filter(item => {
      if (filter === 'all') return true;
      if (filter === 'direct' || filter === 'third_party') return item.category === filter;
      return item.ruleType === filter;
    })
    .filter(item => !query || item.domain.includes(query.trim().toLowerCase()));
}

export function updateSelectionUi() {
  const count = siteState.selected.size;
  if (siteUi.txtPurgeSelected) siteUi.txtPurgeSelected.textContent = t('options.btnPurgeSelected', { count });
  // IPUCU da parametre ister: data-i18n-title gecemez, ham {count} gosterirdi.
  if (siteUi.btnPurgeSelected) siteUi.btnPurgeSelected.title = t('options.btnPurgeSelected', { count });
  if (siteUi.btnPurgeSelected) siteUi.btnPurgeSelected.disabled = count === 0;

  const visible = filteredSites();
  if (siteUi.selectAll) {
    siteUi.selectAll.checked = visible.length > 0 && visible.every(item => siteState.selected.has(item.domain));
  }
}

export function traceCell(value, unitKey = null, extraClass = 'trace-active') {
  if (!value) return h('td', { class: 'cell-center' }, h('span', { class: 'trace-empty', text: '—' }));
  const label = unitKey ? `${value} ${t(unitKey)}` : String(value);
  return h('td', { class: 'cell-center' },
    h('span', { class: `trace-count-badge ${extraClass}`, text: label, title: label }));
}

/** "~1,2 KB" eki; bayt olculmediyse bos dize. */
function sizeSuffix(bytes) {
  return bytes > 0 ? `, ~${formatBytes(bytes)}` : '';
}

/** Temizlik sonrasi listeyi ve istatistigi tazeler. */
async function afterPurge() {
  await Promise.all([loadSiteData(), refreshViews('stats')]);
}

const RULE_BADGES = {
  white: ['tag-white', 'options.badgeWhiteRule'],
  grey: ['tag-grey', 'options.badgeGreyRule'],
  temp: ['tag-temp', 'options.tagTemp'],
  default: ['tag-default', 'options.badgeDefaultRule']
};

function selectionCell(item) {
  const checkbox = h('input', {
    type: 'checkbox',
    class: 'site-checkbox item-checkbox',
    checked: siteState.selected.has(item.domain),
    attrs: { 'aria-label': item.domain },
    on: {
      change: () => {
        if (checkbox.checked) siteState.selected.add(item.domain);
        else siteState.selected.delete(item.domain);
        updateSelectionUi();
      }
    }
  });
  return h('td', { class: 'cell-center' }, checkbox);
}

/** Kaynak ipucunda kac ana site YAZIYLA gosterilir. */
const GORUNEN_KAYNAK_SAYISI = 2;

function domainCell(item) {
  // Sutun darsa ad KESILIR (bkz. .domain-code); tam hali ipucunda kalmali.
  const cell = h('td', {}, h('span', { class: 'domain-code', text: item.domain, title: item.domain }));
  if (item.category === 'third_party' && item.parentSites?.length) {
    const hepsi = item.parentSites;
    const gorunen = hepsi.slice(0, GORUNEN_KAYNAK_SAYISI);
    const kalan = hepsi.length - gorunen.length;
    cell.append(h('div', {
      class: 'parent-site-hint',
      // Tam liste her zaman ipucunda: kirpma bilgi kaybettirmemeli.
      title: t('options.sourceHint', { sources: hepsi.join(', ') }),
      text: kalan > 0
        ? t('options.sourceHintMore', { sources: gorunen.join(', '), count: kalan })
        : t('options.sourceHint', { sources: gorunen.join(', ') })
    }));
  }
  return cell;
}

function categoryCell(item) {
  const third = item.category === 'third_party';
  return h('td', {}, badge(
    third ? 'tag-tracker' : 'tag-direct',
    t(third ? 'options.badgeTracker' : 'options.badgeDirect'),
    t(third ? 'options.badgeTrackerTooltip' : 'options.badgeDirectTooltip')
  ));
}

/** Yalnizca gecmisi temizle (beyaz listedeki site icin). */
function purgeHistoryButton(item) {
  return h('button', {
    class: 'btn-warning-sm btn-purge-history',
    title: t('options.purgeHistoryOnlyTooltip'),
    on: {
      click: () => openConfirm({
        titleKey: 'options.modalPurgeHistoryTitle',
        descKey: 'options.modalPurgeHistoryDesc',
        confirmKey: 'options.modalPurgeHistoryConfirm',
        params: { domain: item.domain },
        onConfirm: async () => {
          const res = await sendToBackground(Action.PURGE_DOMAIN_HISTORY_ONLY, { domain: item.domain });
          if (!res?.success) return showToast(purgeErrorText(res, item.domain), 5000);
          showToast(t('options.toastHistoryPurged', {
            domain: item.domain, count: res.history, size: sizeSuffix(res.bytes)
          }));
          // Sessiz kirpma yapmiyoruz: sayfalama sinirina takildiysa soyleriz.
          if (res.truncated) setTimeout(() => showToast(t('options.historyTruncatedNote'), 4000), 2900);
          await afterPurge();
        }
      })
    }
  }, [icon('clock'), h('span', { text: t('options.purgeHistoryOnlyBtn') })]);
}

/** Siteyi tamamen temizle. */
function purgeSiteButton(item) {
  return h('button', {
    class: 'btn-danger-sm btn-purge-site',
    title: t('options.purgeSiteTooltip'),
    on: {
      click: () => openConfirm({
        titleKey: 'options.modalPurgeDomainTitle',
        descKey: 'options.modalPurgeDomainDesc',
        confirmKey: 'options.modalPurgeDomainConfirm',
        params: { domain: item.domain },
        onConfirm: async () => {
          const res = await sendToBackground(Action.PURGE_DOMAIN, { domain: item.domain });
          if (!res?.success) return showToast(purgeErrorText(res, item.domain), 5000);
          showToast(t('options.toastDomainPurged', {
            domain: item.domain, cookies: res.cookies, history: res.history,
            size: sizeSuffix(res.bytes)
          }));
          siteState.selected.delete(item.domain);
          await afterPurge();
        }
      })
    }
  }, [icon('trash'), h('span', { text: t('options.purgeSiteBtn') })]);
}

/** Basarisiz temizligin sebebini soyler. */
function purgeErrorText(res, domain) {
  return res?.error === 'NO_HOST_ACCESS'
    ? t('options.toastPurgeNoAccess', { domain: domain || res.domain || '' })
    : t('options.toastPurgeError');
}

/** Beyaz listeye ekle / listeden cikar. */
function whitelistToggleButton(item, isWhite) {
  return h('button', {
    class: isWhite ? 'btn-danger-sm btn-toggle-whitelist-site' : 'btn-success-sm btn-toggle-whitelist-site',
    on: {
      click: () => {
        // purgeAfter:false BILINCLI.
        const uygula = async () => {
          const res = isWhite
            ? await sendToBackground(Action.DELETE_RULE, { domain: item.domain, purgeAfter: false })
            : await sendToBackground(Action.SET_RULE, {
              domain: item.domain, type: RuleType.WHITE,
              options: { subdomains: item.domain === getRootDomain(item.domain) }
            });
          if (!res?.success) {
            showToast(t('options.toastPurgeError'));
          } else if (isWhite) {
            showToast(t('options.toastWhitelistRemoved', { domain: item.domain }));
          } else {
            // EKLEME onay istemiyor ama GERI ALINABILIR olmali: yanlislikla korumak veri kaybettirmez, yine de donus yolu acik kalsin.
            showToastWithUndo(
              t('options.toastWhitelistAdded', { domain: item.domain }),
              async () => {
                await sendToBackground(Action.DELETE_RULE,
                  { domain: item.domain, purgeAfter: false });
                await Promise.all([refreshViews('rules', 'unprotected'), loadSiteData()]);
              });
          }
          await Promise.all([refreshViews('rules', 'unprotected'), loadSiteData()]);
        };

        // KORUMAYI KALDIRMAK onay ister; EKLEMEK istemez.
        if (!isWhite) { void uygula(); return; }
        openConfirm({
          titleKey: 'options.modalUnprotectTitle',
          descKey: 'options.modalUnprotectDesc',
          params: { domain: item.domain },
          confirmKey: 'common.remove',
          onConfirm: uygula
        });
      }
    }
  }, [
    icon(isWhite ? 'close' : 'shieldCheck'),
    h('span', { text: t(isWhite ? 'options.toggleWhitelistRemove' : 'options.toggleWhitelistAdd') })
  ]);
}

export function buildSiteRow(item) {
  const row = h('tr');
  row.append(selectionCell(item));
  row.append(domainCell(item));
  row.append(categoryCell(item));
  row.append(traceCell(item.cookieCount));
  row.append(traceCell(item.historyCount));
  row.append(item.downloadCount > 0
    ? traceCell(item.downloadCount, 'common.downloads')
    : traceCell(item.requestCount, 'common.requests', 'trace-req'));

  const [ruleClass, ruleKey] = RULE_BADGES[item.ruleType] || RULE_BADGES.default;
  row.append(h('td', {}, badge(ruleClass, t(ruleKey))));

  const isWhite = item.ruleType === RuleType.WHITE;
  const isProtected = item.ruleType !== RuleType.DEFAULT;
  const actions = h('div', { class: 'btn-action-group' });

  // UC SABIT YUVA: 1) gecmis 2) temizle-veya-korumali 3) beyaz liste.
  if (isWhite && item.historyCount > 0) actions.append(purgeHistoryButton(item));
  else actions.append(h('span', { class: 'act-slot-empty' }));
  if (isProtected) {
    actions.append(badge('tag-protected', t('options.badgeProtectedRule'), t('options.badgeProtectedTooltip')));
  } else {
    actions.append(purgeSiteButton(item));
  }
  actions.append(whitelistToggleButton(item, isWhite));

  row.append(h('td', { class: 'text-right' }, actions));
  return row;
}

export function renderSiteData() {
  // HIC yuklenmediyse cizilecek bir sey yok (ornek: dil degisiminde ayarlar sekmesi tum gorunumleri tazeler ama bu sekme hic acilmamis olabilir).
  if (!siteState.loaded) return;
  if (!siteUi.tableBody) return;

  const counts = {
    all: siteState.list.length,
    direct: siteState.list.filter(item => item.category === 'direct').length,
    third_party: siteState.list.filter(item => item.category === 'third_party').length,
    default: siteState.list.filter(item => item.ruleType === RuleType.DEFAULT).length,
    white: siteState.list.filter(item => item.ruleType === RuleType.WHITE).length,
    grey: siteState.list.filter(item => item.ruleType === RuleType.GREY).length
  };
  for (const [key, node] of Object.entries(siteUi.counts)) {
    if (node) node.textContent = String(counts[key] ?? 0);
  }

  const visible = filteredSites();
  siteUi.tableBody.replaceChildren();

  if (visible.length === 0) {
    siteUi.emptyState?.classList.remove('hidden');
    updateSelectionUi();
    return;
  }
  siteUi.emptyState?.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  for (const item of visible) fragment.append(buildSiteRow(item));
  siteUi.tableBody.append(fragment);
  updateSelectionUi();
}

export function showTableMessage(body, message, isError = false) {
  if (!body) return;
  const cell = h('td', { class: 'cell-center', text: message, attrs: { colspan: String(siteState.columns) } });
  if (isError) cell.style.color = '#f87171';
  body.replaceChildren(h('tr', {}, cell));
}

export async function loadSiteData() {
  showTableMessage(siteUi.tableBody, t('options.scanningSiteData'));
  siteUi.emptyState?.classList.add('hidden');

  const response = await sendToBackground(Action.GET_ALL_STORED_DOMAINS);
  if (!response?.success) {
    showTableMessage(siteUi.tableBody, t('options.siteDataError'), true);
    return;
  }

  siteState.list = response.domains || [];
  siteState.loaded = true;
  siteUi.truncatedNote?.classList.toggle('hidden', !response.truncated);
  renderSiteData();
}

siteUi.btnRefresh?.addEventListener('click', async () => {
  await loadSiteData();
  showToast(t('options.toastSiteDataRefreshed'));
});

siteUi.search?.addEventListener('input', () => {
  siteState.query = siteUi.search.value;
  siteUi.clearSearch?.classList.toggle('hidden', !siteState.query);
  renderSiteData();
});

siteUi.clearSearch?.addEventListener('click', () => {
  siteUi.search.value = '';
  siteState.query = '';
  siteUi.clearSearch.classList.add('hidden');
  renderSiteData();
});

for (const pill of qsa('#site-data-tab [data-site-filter]')) {
  pill.addEventListener('click', () => {
    selectOne(qsa('#site-data-tab [data-site-filter]'), pill);
    siteState.filter = pill.dataset.siteFilter || 'all';
    renderSiteData();
  });
}

siteUi.selectAll?.addEventListener('change', () => {
  const visible = filteredSites();
  for (const item of visible) {
    if (siteUi.selectAll.checked) siteState.selected.add(item.domain);
    else siteState.selected.delete(item.domain);
  }
  renderSiteData();
});

siteUi.btnPurgeSelected?.addEventListener('click', () => {
  const domains = [...siteState.selected];
  if (domains.length === 0) return;

  openConfirm({
    titleKey: 'options.modalPurgeSelectedTitle',
    descKey: 'options.modalPurgeSelectedDesc',
    confirmKey: 'options.modalPurgeSelectedConfirm',
    params: { count: domains.length },
    onConfirm: async () => {
      siteUi.btnPurgeSelected.disabled = true;
      if (siteUi.txtPurgeSelected) siteUi.txtPurgeSelected.textContent = t('common.loading');

      const response = await sendToBackground(Action.PURGE_SELECTED_DOMAINS, { domains });
      if (response?.success) {
        const size = response.bytes > 0 ? ` (~${formatBytes(response.bytes)})` : '';
        const skipped = response.skippedProtected > 0
          ? ` · ${t('options.badgeProtectedRule')}: ${response.skippedProtected}`
          : '';
        showToast(t('options.toastSelectedPurged', {
          count: response.count, cookies: response.cookies, history: response.history, skipped, size
        }));
        siteState.selected.clear();
        await Promise.all([loadSiteData(), refreshViews('stats')]);
      } else {
        showToast(t('options.toastPurgeError'));
        updateSelectionUi();
      }
    }
  });
});

siteUi.btnPurgeAll?.addEventListener('click', () => {
  openConfirm({
    titleKey: 'options.modalPurgeAllTitle',
    descKey: 'options.modalPurgeAllDesc',
    confirmKey: 'options.modalPurgeAllConfirm',
    onConfirm: async () => {
      const labelNode = siteUi.btnPurgeAll.querySelector('span');
      const originalLabel = labelNode?.textContent;
      siteUi.btnPurgeAll.disabled = true;
      if (labelNode) labelNode.textContent = t('common.loading');

      const response = await sendToBackground(Action.PURGE_ALL_NON_WHITELIST);

      siteUi.btnPurgeAll.disabled = false;
      if (labelNode && originalLabel) labelNode.textContent = originalLabel;

      if (response?.success) {
        const size = response.bytes > 0 ? ` (~${formatBytes(response.bytes)})` : '';
        // Acik sekmeli siteler atlandi; SESSIZ kalmak "her sey temizlendi" izlenimi verir.
        const skipped = (response.skippedOpen > 0
          ? t('options.toastPurgeSkippedOpen', { count: response.skippedOpen })
          : '')
          // Erisim kisitliysa gorulemeyen siteler var; "hepsi temizlendi" izlenimi vermek yaniltici olur.
          + (response.limitedAccess ? t('options.toastPurgeLimitedAccess') : '');
        showToast(t('options.toastAllPurged', {
          cookies: response.cookies, history: response.history, size, skipped
        }), skipped ? 7000 : undefined);
        siteState.selected.clear();
        await Promise.all([loadSiteData(), refreshViews('stats')]);
      } else {
        showToast(t('options.toastPurgeError'));
      }
    }
  });
});

// Diger sekmeler bu gorunumu ADIYLA tazeler (bkz. ui/refresh.js).
registerView('siteData', renderSiteData);
