// GhostTrace - Kurallar sekmesi (+ ice/disa aktarma)

import { extractHostname, getRootDomain, normalizeDomain } from '../../lib/domain.js';
import { t } from '../../lib/i18n.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import { RuleType } from '../../lib/rules.js';
import { getRules, getSettings } from '../../lib/storage.js';
import { badge, el, h, icon, qsa } from '../ui/dom.js';
import {
  downloadFile, formatDate, formatDuration, formatRemaining, parseRuleSelection
} from '../ui/format.js';
import { refreshViews } from '../ui/refresh.js';
import { openConfirm, showToast } from '../ui/toast.js';
import { registerView } from '../ui/refresh.js';
import { openSiteModal } from './cookie-modal.js';
import { selectOne } from '../../ui/segmented.js';

// Kurallar sekmesi

export const rulesUi = {
  form: el('formAddRule'),
  inputDomain: el('inputDomain'),
  selectType: el('selectRuleType'),
  checkSubdomains: el('checkSubdomains'),
  tableBody: el('rulesTableBody'),
  emptyState: el('emptyRulesState'),
  search: el('inputSearchRule'),
  clearSearch: el('btnClearSearchRule'),
  countAll: el('countAll'),
  countWhite: el('countWhite'),
  countGrey: el('countGrey'),
  btnExport: el('btnExportRules'),
  btnImport: el('btnImportRules'),
  fileInput: el('fileImportInput')
};

export const rulesState = { filter: 'all', query: '', cache: {} };

/** Kural turune gore rozet sinifi ve metni. */
export function ruleBadge(rule) {
  if (rule.type === RuleType.TEMP) {
    const remaining = formatRemaining(rule.expiresAt);
    // Rozet kalan sureyi gosterir; ipucu ise baslangicta verilen izin suresini.
    return badge(
      'tag-temp',
      remaining ? t('options.tagTempRemaining', { time: remaining }) : t('options.tagTemp'),
      formatDuration(rule.durationMinutes)
    );
  }
  if (rule.type === RuleType.GREY) return badge('tag-grey', t('options.legendGrey'));
  return badge('tag-white', t('options.legendWhite'));
}

/** Kapsam butonu; dort durumun HEPSI tiklanabilir. */
export function scopeButton(rule) {
  const isSubdomainRule = rule.domain !== getRootDomain(rule.domain);
  const includesSubdomains = rule.subdomains !== false;

  let className;
  let label;
  let iconName;

  if (isSubdomainRule) {
    className = includesSubdomains ? 'scope-active' : 'scope-subdomain';
    label = t(includesSubdomains ? 'options.scopeSubdomainAll' : 'options.scopeSubdomain');
    iconName = 'branch';
  } else {
    className = includesSubdomains ? 'scope-active' : 'scope-inactive';
    label = t(includesSubdomains ? 'options.scopeAll' : 'options.scopeExact');
    iconName = includesSubdomains ? 'globe' : 'target';
  }

  const button = h('button', {
    type: 'button',
    class: `badge-scope-interactive ${className}`,
    title: isSubdomainRule ? t('options.scopeSubdomainTooltip') : t('options.scopeToggleTitle'),
    dataset: { domain: rule.domain }
  }, [icon(iconName), h('span', { text: label })]);

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    button.disabled = true;
    const response = await sendToBackground(Action.SET_RULE_SCOPE, {
      domain: rule.domain,
      subdomains: !includesSubdomains
    });
    if (response?.success) {
      showToast(t('options.toastRuleScopeUpdated', { domain: rule.domain }));
      await renderRules();
    } else {
      button.disabled = false;
      showToast(t('options.toastPurgeError'));
    }
  });
  return button;
}

export function buildRuleRow(rule) {
  const row = h('tr');

  // Sutun darsa ad KESILIR (bkz. .domain-code); tam hali ipucunda kalmali.
  row.append(h('td', {}, h('span', { class: 'domain-code', text: rule.domain, title: rule.domain })));

  const typeCell = h('td', {}, ruleBadge(rule));
  if (rule.keepMode === 'custom' && rule.keepCookies?.length) {
    typeCell.append(h('span', {
      class: 'badge-tag tag-blue',
      title: rule.keepCookies.join(', '),
      text: t('options.selectiveCookiesBadge', { count: rule.keepCookies.length })
    }));
  }
  row.append(typeCell);

  row.append(h('td', {}, scopeButton(rule)));
  row.append(h('td', { text: formatDate(rule.addedAt) }));

  const actions = h('div', { class: 'rule-actions-wrap' }, [
    h('button', {
      type: 'button', class: 'btn-edit-rule', title: t('common.edit'),
      on: { click: () => openSiteModal(rule.domain) }
    }, [icon('edit', 13), h('span', { text: t('common.edit') })]),
    h('button', {
      type: 'button', class: 'btn-delete-rule', title: t('common.remove'),
      on: {
        // Onceden TUM kurallari sifirlama metni gosteriliyordu: "tum siteler silinecek" diyip asil geri alinamaz sonucu - sitenin verisinin hemen temizlenecegini - hic soylemiyordu.
        click: () => openConfirm({
          titleKey: 'options.modalDeleteRuleTitle',
          descKey: 'options.modalDeleteRuleDesc',
          params: { domain: rule.domain },
          confirmKey: 'common.remove',
          onConfirm: async () => {
            const response = await sendToBackground(Action.DELETE_RULE, { domain: rule.domain });
            showToast(response?.success
              ? t('options.toastRuleDeleted', { domain: rule.domain })
              : t('options.toastPurgeError'));
            await refreshViews('rules', 'unprotected');
          }
        })
      }
    }, [icon('close'), h('span', { text: t('common.remove') })])
  ]);
  row.append(h('td', { class: 'text-right' }, actions));

  return row;
}

export async function renderRules() {
  const rules = await getRules();
  rulesState.cache = rules;

  const entries = Object.values(rules);
  if (rulesUi.countAll) rulesUi.countAll.textContent = String(entries.length);
  if (rulesUi.countWhite) rulesUi.countWhite.textContent = String(entries.filter(r => r.type === RuleType.WHITE).length);
  if (rulesUi.countGrey) rulesUi.countGrey.textContent = String(entries.filter(r => r.type === RuleType.GREY).length);

  const query = rulesState.query.trim().toLowerCase();
  const visible = entries
    .filter(rule => rulesState.filter === 'all' || rule.type === rulesState.filter)
    .filter(rule => !query || rule.domain.includes(query))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  if (!rulesUi.tableBody) return;
  rulesUi.tableBody.replaceChildren();

  if (visible.length === 0) {
    rulesUi.emptyState?.classList.remove('hidden');
    return;
  }
  rulesUi.emptyState?.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  for (const rule of visible) fragment.append(buildRuleRow(rule));
  rulesUi.tableBody.append(fragment);
}

/** Girilen alan adina gore kapsam kutusunun ETIKETINI gunceller. */
export function syncSubdomainCheckbox() {
  if (!rulesUi.inputDomain || !rulesUi.checkSubdomains) return;
  const domain = normalizeDomain(rulesUi.inputDomain.value.trim());
  const label = rulesUi.checkSubdomains.parentElement?.querySelector('span');

  if (!domain) {
    if (label) label.textContent = t('options.checkSubdomainsDefaultLabel');
    return;
  }

  const isSubdomain = domain !== getRootDomain(domain);
  if (label) {
    label.textContent = isSubdomain
      ? t('options.checkSubdomainsFixedLabel', { domain })
      : t('options.checkSubdomainsLabel', { domain });
  }
}

rulesUi.inputDomain?.addEventListener('input', syncSubdomainCheckbox);

rulesUi.form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const domain = normalizeDomain(rulesUi.inputDomain.value.trim());
  if (!domain) {
    showToast(t('options.toastInvalidDomain'));
    return;
  }

  const { type, options } = parseRuleSelection(rulesUi.selectType?.value);

  // KORUMA DUSURME onay ister.
  const mevcut = rulesState.cache?.[domain];
  if (mevcut?.type === RuleType.WHITE && type === RuleType.GREY) {
    openConfirm({
      titleKey: 'options.modalDowngradeTitle',
      descKey: 'options.modalDowngradeDesc',
      params: { domain },
      confirmKey: 'common.remove',
      onConfirm: () => kuraliKaydet(domain, type, options)
    });
    return;
  }

  await kuraliKaydet(domain, type, options);
});

/** Kurali yazar ve sonucu bildirir. Onayli ve onaysiz yollar AYNI kodu kullanir. */
async function kuraliKaydet(domain, type, options) {

  // Kutunun degeri oldugu gibi gider; alt alan adi / kok ayrimini kural katmani (normalizeRule) yapar.
  const response = await sendToBackground(Action.SET_RULE, {
    domain,
    type,
    options: { ...options, subdomains: Boolean(rulesUi.checkSubdomains?.checked) }
  });

  if (response?.success) {
    showToast(t('options.toastRuleAdded', { domain }));
    rulesUi.inputDomain.value = '';
    if (rulesUi.checkSubdomains) rulesUi.checkSubdomains.checked = false;
    syncSubdomainCheckbox();
    // Korumasiz oturumlar listesi kurallardan TURETILIYOR ve bu sayfanin hemen altinda duruyor.
    await refreshViews('rules', 'unprotected');
  } else if (response?.error === 'INVALID_DOMAIN') {
    showToast(t('options.toastInvalidDomain'));
  } else {
    // Alan adi gecerliydi ama yazma basarisiz oldu (kota / profil kisiti). "Gecerli bir alan adi girin" demek kullaniciyi ayni gecerli adi tekrar yazmaya gonderir; sebep hicbir yerde gorunmez.
    showToast(t('options.toastSaveFailed'), 5000);
  }
}

rulesUi.search?.addEventListener('input', () => {
  rulesState.query = rulesUi.search.value;
  rulesUi.clearSearch?.classList.toggle('hidden', !rulesState.query);
  void renderRules();
});

rulesUi.clearSearch?.addEventListener('click', () => {
  rulesUi.search.value = '';
  rulesState.query = '';
  rulesUi.clearSearch.classList.add('hidden');
  void renderRules();
});

// SINIF DEGIL OZNITELIK secilir. `.filter-pills .pill` yeniden tasarimda kayboldu.
for (const pill of qsa('#rules-tab [data-filter]')) {
  pill.addEventListener('click', () => {
    selectOne(qsa('#rules-tab [data-filter]'), pill);
    rulesState.filter = pill.dataset.filter || 'all';
    void renderRules();
  });
}

// Kural ice/disa aktarma

/** Disa aktarim YALNIZCA beyaz liste: gri liste ve gecici izin tarayici kapaninca silinir, kalici yedege konmalari anlamsiz. */
export function exportableRules(rules) {
  return Object.fromEntries(
    Object.entries(rules).filter(([, rule]) => rule?.type === RuleType.WHITE)
  );
}

rulesUi.btnExport?.addEventListener('click', async () => {
  const [rules, settings] = await Promise.all([getRules(), getSettings()]);
  const disaAktarilacak = exportableRules(rules);
  const count = Object.keys(disaAktarilacak).length;
  if (count === 0) {
    showToast(t('options.toastExportEmpty'));
    return;
  }

  const payload = {
    app: 'GhostTrace',
    schemaVersion: settings.schemaVersion,
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    // Istatistikler ve teshis verisi disa aktarilmaz; yalnizca yapilandirma.
    settings: { ...settings, rules: undefined, stats: undefined },
    rules: disaAktarilacak
  };

  downloadFile(JSON.stringify(payload, null, 2),
    `GhostTrace_Rules_${new Date().toISOString().slice(0, 10)}.json`,
    'application/json;charset=utf-8');
  showToast(t('options.toastExportSuccess', { count }));
});

rulesUi.btnImport?.addEventListener('click', () => rulesUi.fileInput?.click());

/** GhostTrace ve Cookie AutoDelete formatlarini tek listeye normalize eder. */
export function extractImportableRules(data) {
  const candidates = [];

  if (data?.rules && typeof data.rules === 'object') {
    for (const [key, rule] of Object.entries(data.rules)) {
      if (!rule || typeof rule !== 'object') continue;
      candidates.push({ ...rule, domain: rule.domain || key });
    }
    return candidates;
  }

  // Cookie AutoDelete: expressionList / whitelist / duz dizi
  const cadList = Array.isArray(data) ? data : (data?.expressionList || data?.whitelist || []);
  for (const item of cadList) {
    const expression = typeof item === 'string' ? item : (item?.expression || item?.domain);
    if (typeof expression !== 'string') continue;
    const host = extractHostname(expression.replace(/^\*\./, '').trim());
    if (!host) continue;
    candidates.push({
      domain: host,
      type: (item?.listType === 'GREY' || item?.type === 'grey') ? RuleType.GREY : RuleType.WHITE,
      // Kapsam sinyali oncelik sirasiyla: '*.' on eki (CAD), `subdomains` alani, sonra varsayilan (kok acik / alt alan kapali).
      subdomains: expression.startsWith('*.')
        || (typeof item?.subdomains === 'boolean' ? item.subdomains : host === getRootDomain(host))
    });
  }
  return candidates;
}

rulesUi.fileInput?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());
    const candidates = extractImportableRules(parsed);
    if (candidates.length === 0) {
      showToast(t('options.toastImportNoValidRules'));
      return;
    }

    const response = await sendToBackground(Action.IMPORT_RULES, { rules: candidates });
    if (!response?.success) {
      showToast(t('options.toastImportNoValidRules'));
      return;
    }

    showToast(t('options.toastImportSuccess', { count: response.imported }));
    if (response.rejected > 0) {
      setTimeout(() => showToast(t('options.toastImportRejected', { count: response.rejected })), 2900);
    }
    await refreshViews('rules', 'unprotected');
  } catch (err) {
    console.error('[GhostTrace] Ice aktarma hatasi:', err);
    showToast(t('options.toastImportInvalid'));
  }
});

// Diger sekmeler bu gorunumu ADIYLA tazeler (bkz. ui/refresh.js).
registerView('rules', renderRules);
