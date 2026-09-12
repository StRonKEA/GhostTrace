// GhostTrace - Site kontrol / cerez modali

import { getRootDomain } from '../../lib/domain.js';
import { t } from '../../lib/i18n.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import { RuleType } from '../../lib/rules.js';
import { getRules } from '../../lib/storage.js';
import { el, h, icon } from '../ui/dom.js';
import { parseRuleSelection, ruleToSelection } from '../ui/format.js';
import { refreshViews } from '../ui/refresh.js';
import { closeConfirm, confirmModal, showToast } from '../ui/toast.js';
import { setActive } from '../../ui/segmented.js';

// Site kontrol / cerez modali

export const siteModal = {
  root: el('siteControlModal'),
  domain: el('modalSiteDomain'),
  subtext: el('modalSiteSubtext'),
  close: el('modalCloseBtn'),
  selectType: el('modalSelectRuleType'),
  checkSubdomains: el('modalCheckSubdomains'),
  btnModeAll: el('btnModalModeAll'),
  btnSuggestSession: el('btnSuggestSessionCookies'),
  btnModeCustom: el('btnModalModeCustom'),
  customArea: el('modalCustomCookieArea'),
  searchCookie: el('inputModalSearchCookie'),
  cookieList: el('modalCookieList'),
  patterns: el('inputModalCustomPatterns'),
  btnSelectAll: el('btnSelectAllCookies'),
  btnDeselectAll: el('btnDeselectAllCookies'),
  btnCancel: el('btnModalCancel'),
  btnSave: el('btnModalSave'),
  returnFocus: null
};

export const modalState = {
  // Modal acilirken gosterilen secim ve orijinal sure (bkz. openSiteModal)
  shownSelection: null,
  // Diskte kalmis eski 'session' kurali bu turda oneriye cevrilecek mi?
  migrateSession: false,
  originalDuration: null, domain: '', cookies: [], kept: new Set(), keepMode: 'all' };

export const COOKIE_TAGS = {
  session: ['tag-session', 'options.cookieBadgeSession'],
  tracker: ['tag-tracker', 'options.cookieBadgeTracker'],
  other: ['tag-default', 'options.cookieBadgeOther']
};

export function buildCookieRow(cookie) {
  const isKept = modalState.kept.has(cookie.name.toLowerCase());
  const [tagClass, tagKey] = COOKIE_TAGS[cookie.classification] || COOKIE_TAGS.other;

  const shieldButton = h('button', {
    type: 'button',
    class: `btn-cookie-shield ${isKept ? 'active' : ''}`,
    title: t(isKept ? 'options.badgeProtectedRule' : 'common.clean'),
    on: {
      click: (event) => {
        event.stopPropagation();
        const key = cookie.name.toLowerCase();
        if (modalState.kept.has(key)) modalState.kept.delete(key);
        else modalState.kept.add(key);
        syncPatternInput();
        renderCookieList();
      }
    }
  }, icon(isKept ? 'shieldCheck' : 'shield', 14));

  const metaParts = [cookie.domain, t('options.cookieLengthLabel', { count: cookie.valueLength })];
  if (cookie.partitioned) metaParts.push(t('options.cookiePartitioned'));

  return h('div', { class: 'cookie-row' }, [
    shieldButton,
    h('div', { class: 'cookie-row-main' }, [
      h('span', { class: 'cookie-row-name', text: cookie.name, title: cookie.name }),
      h('span', { class: 'cookie-row-meta', text: metaParts.join(' · ') })
    ]),
    h('span', { class: `cookie-row-tag cookie-tag ${tagClass}`, text: t(tagKey) })
  ]);
}

export function renderCookieList() {
  if (!siteModal.cookieList) return;
  siteModal.cookieList.replaceChildren();

  if (modalState.cookies.length === 0) {
    siteModal.cookieList.append(h('div', { class: 'cookie-list-empty', text: t('options.modalNoCookiesFound') }));
    return;
  }

  const query = (siteModal.searchCookie?.value || '').toLowerCase().trim();
  const visible = modalState.cookies.filter(cookie => !query || cookie.name.toLowerCase().includes(query));

  if (visible.length === 0) {
    siteModal.cookieList.append(h('div', { class: 'cookie-list-empty', text: t('options.modalNoCookiesFound') }));
    return;
  }

  siteModal.cookieList.append(h('div', { class: 'cookie-row-meta', text: t('options.cookieValueHidden') }));
  const fragment = document.createDocumentFragment();
  for (const cookie of visible) fragment.append(buildCookieRow(cookie));
  siteModal.cookieList.append(fragment);
}

export function syncPatternInput() {
  if (siteModal.patterns) siteModal.patterns.value = [...modalState.kept].join(', ');
}

export function syncKeepModeUi() {
  const mode = modalState.keepMode;
  setActive(siteModal.btnModeAll, mode === 'all');
  setActive(siteModal.btnModeCustom, mode === 'custom');
  // "Giris cerezlerini isaretle" bir MOD DEGIL, bir kisayol: durumu yok, dolayisiyla mod grubunda DEGIL, ozel liste arac cubugunda duruyor Kalip listesi yalnizca "ozel" modda anlamlidir.
  siteModal.customArea?.classList.toggle('hidden', mode !== 'custom');
}

/** Tahmin edilen giris cerezlerini isaretler ve "Sectiklerimi koru"ya gecer. */
export function suggestSessionCookies() {
  if (modalState.cookies.length === 0) {
    showToast(t('options.keepModeNoCookies'));
    return 0;
  }
  let eklenen = 0;
  for (const cookie of modalState.cookies) {
    if (!cookie.isSession) continue;
    const key = cookie.name.toLowerCase();
    if (!modalState.kept.has(key)) eklenen++;
    modalState.kept.add(key);
  }
  modalState.keepMode = 'custom';
  syncPatternInput();
  syncKeepModeUi();
  renderCookieList();
  showToast(modalState.kept.size > 0
    ? t('options.keepModeSuggested', { count: modalState.kept.size })
    : t('options.keepModeSuggestedNone'));
  return eklenen;
}

export async function openSiteModal(domain) {
  if (!domain || !siteModal.root) return;

  const isSubdomain = domain !== getRootDomain(domain);
  const rules = await getRules();
  // Kural yoksa varsayilan, normalizeRule ile AYNI olmali: kok alan adinda kapsam acik, alt alan adinda kapali.
  const rule = rules[domain]
    || { type: RuleType.WHITE, subdomains: !isSubdomain, keepMode: 'all', keepCookies: [] };

  modalState.domain = domain;
  // ESKI 'session' KURALLARI: arayuz artik bu modu URETMIYOR ama diskte kalmis olabilir (motor geriye donuk destekliyor).
  modalState.migrateSession = rule.keepMode === 'session';
  modalState.keepMode = ['custom', 'session'].includes(rule.keepMode) ? 'custom' : 'all';
  modalState.kept = new Set((rule.keepCookies || []).map(name => name.toLowerCase()));
  modalState.cookies = [];

  if (siteModal.domain) siteModal.domain.textContent = domain;
  if (siteModal.subtext) siteModal.subtext.textContent = t('options.modalSiteControlDesc', { domain });
  // Kapsam etiketi {domain} yer tutucusu tasiyor.
  const kapsamEtiketi = el('txtModalSubdomains');
  if (kapsamEtiketi) kapsamEtiketi.textContent = t('options.modalSubdomainsLabel', { domain });
  // ORIJINALI hatirla.
  const shownSelection = ruleToSelection(rule);
  modalState.shownSelection = shownSelection;
  modalState.originalDuration = rule?.type === RuleType.TEMP
    ? { durationMinutes: rule.durationMinutes || null, expiresAt: rule.expiresAt || null }
    : null;
  if (siteModal.selectType) siteModal.selectType.value = shownSelection;

  if (siteModal.checkSubdomains) {
    // Kutu artik alt alan adinda da secilebilir ve KAYITLI degeri gosterir.
    siteModal.checkSubdomains.disabled = false;
    siteModal.checkSubdomains.checked = rule.subdomains !== false;
    siteModal.checkSubdomains.title = isSubdomain ? t('options.scopeSubdomainTooltip') : '';
  }

  syncPatternInput();
  syncKeepModeUi();

  siteModal.returnFocus = document.activeElement;
  siteModal.root.classList.remove('hidden');
  requestAnimationFrame(() => siteModal.close?.focus());

  if (siteModal.cookieList) {
    siteModal.cookieList.replaceChildren(
      h('div', { class: 'cookie-list-loading', text: t('options.modalScanningCookies') })
    );
  }

  const response = await sendToBackground(Action.GET_DOMAIN_COOKIES, { domain });
  // Sonda bos dizi bilincli: arka uc success:true dondurup cookies alanini gondermezse renderCookieList undefined.length ile patlar ve modal sonsuza kadar "taraniyor" ekraninda kalir - sessiz bozukluk.
  modalState.cookies = (response?.success ? response.cookies : null) || [];
  renderCookieList();

  // Goc: eski 'session' kurali tahmini ISARETLI olarak gosterir.
  if (modalState.migrateSession) {
    modalState.migrateSession = false;
    suggestSessionCookies();
  }
}

export function closeSiteModal() {
  siteModal.root?.classList.add('hidden');
  modalState.domain = '';
  modalState.cookies = [];
  modalState.kept.clear();
  modalState.migrateSession = false;
  siteModal.returnFocus?.focus?.();
  siteModal.returnFocus = null;
}

siteModal.close?.addEventListener('click', closeSiteModal);
siteModal.btnCancel?.addEventListener('click', closeSiteModal);
siteModal.root?.addEventListener('click', (event) => {
  if (event.target === siteModal.root) closeSiteModal();
});
siteModal.searchCookie?.addEventListener('input', renderCookieList);

siteModal.btnModeAll?.addEventListener('click', () => {
  modalState.keepMode = 'all';
  syncKeepModeUi();
});

// MOD DEGISTIRMEZ, ONERI URETIR.
siteModal.btnSuggestSession?.addEventListener('click', () => {
  suggestSessionCookies();
});

siteModal.btnModeCustom?.addEventListener('click', () => {
  modalState.keepMode = 'custom';
  syncKeepModeUi();
  renderCookieList();
  // Ilk gecişte tahmini isaretle: kullanicinin muhtemelen korumak istedigi kume budur.
  if (modalState.kept.size === 0 && modalState.cookies.length > 0) {
    suggestSessionCookies();
  }
});

siteModal.btnSelectAll?.addEventListener('click', () => {
  for (const cookie of modalState.cookies) modalState.kept.add(cookie.name.toLowerCase());
  syncPatternInput();
  renderCookieList();
});

siteModal.btnDeselectAll?.addEventListener('click', () => {
  modalState.kept.clear();
  syncPatternInput();
  renderCookieList();
});

siteModal.btnSave?.addEventListener('click', async () => {
  if (!modalState.domain) return;

  const selection = siteModal.selectType?.value;
  const { type, options } = parseRuleSelection(selection);

  // Kullanici listeye dokunmadiysa ve orijinal sure listede TEMSIL EDILEMEYEN bir degerse, orijinali geri koy.
  if (type === RuleType.TEMP
      && selection === modalState.shownSelection
      && modalState.originalDuration?.durationMinutes) {
    options.durationMinutes = modalState.originalDuration.durationMinutes;
    if (modalState.originalDuration.expiresAt) {
      options.expiresAt = modalState.originalDuration.expiresAt;
    }
  }
  let keepCookies = [];
  if (modalState.keepMode === 'custom') {
    const typed = (siteModal.patterns?.value || '')
      .split(',')
      .map(part => part.trim().toLowerCase())
      .filter(Boolean);
    keepCookies = [...new Set([...modalState.kept, ...typed])];
  }

  const response = await sendToBackground(Action.SET_RULE, {
    domain: modalState.domain,
    type,
    options: {
      ...options,
      // Kutunun degeri oldugu gibi gider; kok/alt ayrimini kural katmani yapar.
      subdomains: Boolean(siteModal.checkSubdomains?.checked),
      keepMode: modalState.keepMode,
      keepCookies
    }
  });

  if (response?.success) {
    showToast(t('options.toastRuleUpdated', { domain: modalState.domain }));
    closeSiteModal();
    await refreshViews('rules', 'unprotected');
  } else {
    showToast(t('options.toastPurgeError'));
  }
});

// KLAVYE: Escape ve odak tuzagi. Ikisi de EN USTTEKI acik modala uygulanir.
//
// Sira onemli ve bilincli: onay modali site modalinin UZERINE acilabiliyor,
// yani once o kapanmali. Handler burada yasiyor cunku iki modali birden
// goren tek modul bu.
const ODAKLANABILIR = [
  'a[href]:not([tabindex="-1"])', 'button:not([disabled]):not([tabindex="-1"])', 'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])', 'textarea:not([disabled]):not([tabindex="-1"])', '[tabindex]:not([tabindex="-1"])'
].join(',');

function acikModal() {
  const gorunur = (node) => node && !node.classList.contains('hidden');
  if (gorunur(confirmModal.root)) return { root: confirmModal.root, kapat: closeConfirm };
  if (gorunur(siteModal.root)) return { root: siteModal.root, kapat: closeSiteModal };
  return null;
}

document.addEventListener('keydown', (event) => {
  const modal = acikModal();
  if (!modal) return;

  if (event.key === 'Escape') {
    modal.kapat();
    return;
  }
  if (event.key !== 'Tab') return;

  // ODAK TUZAGI. `aria-modal="true"` ekran okuyucuya arka planin erisilemez
  // oldugunu soyluyor; Tab gercekten disari cikabiliyorsa o soz YALAN olur ve
  // klavye kullanicisi gormedigi bir sayfada gezinmeye baslar.
  const odaklar = [...modal.root.querySelectorAll(ODAKLANABILIR)]
    .filter(node => node.offsetParent !== null);
  if (odaklar.length === 0) return;

  const ilk = odaklar[0];
  const son = odaklar[odaklar.length - 1];
  const simdi = document.activeElement;
  const disarida = !modal.root.contains(simdi);

  if (event.shiftKey && (simdi === ilk || disarida)) {
    event.preventDefault();
    son.focus();
  } else if (!event.shiftKey && (simdi === son || disarida)) {
    event.preventDefault();
    ilk.focus();
  }
});
