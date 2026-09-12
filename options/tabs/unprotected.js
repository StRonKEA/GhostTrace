// GhostTrace - "Korumasiz oturumlariniz" listesi (Kurallar sekmesi).

import { t } from '../../lib/i18n.js';
import { Action, sendToBackground } from '../../lib/messaging.js';
import { RuleType } from '../../lib/rules.js';
import { el, h, icon } from '../ui/dom.js';
import { showToast, showToastWithUndo } from '../ui/toast.js';
import { refreshViews, registerView } from '../ui/refresh.js';

const EN_FAZLA = 8;

const ui = {
  section: el('unprotectedLoginsSection'),
  body: el('unprotectedLoginsBody')
};

/** Tek tikla beyaz listeye alir - kapsam HER ZAMAN "yalnizca bu adres". */
function ekleDugmesi(site) {
  const button = h('button', {
    type: 'button',
    class: 'btn-success-sm',
    title: t('options.unprotectedLoginsAdd')
  }, [icon('shieldCheck'), h('span', { text: t('options.unprotectedLoginsAdd') })]);

  button.addEventListener('click', async () => {
    button.disabled = true;
    const yanit = await sendToBackground(Action.SET_RULE, {
      domain: site.domain,
      type: RuleType.WHITE,
      // Kapsam kararini KULLANICI verir; burada en dar olani seciyoruz.
      options: { subdomains: false }
    });
    if (yanit?.success) {
      // KORUYUCU eylem: onay istemiyoruz - yanlislikla bir siteyi KORUMAK veri kaybettirmez.
      showToastWithUndo(
        t('options.toastWhitelistAdded', { domain: site.domain }),
        async () => {
          // purgeAfter:false: geri almak "hic eklenmemis gibi" olmali, sitenin verisini silmek DEGIL.
          await sendToBackground(Action.DELETE_RULE,
            { domain: site.domain, purgeAfter: false });
          await refreshViews('rules', 'unprotected');
        });
      // KENDI listesini de tazele.
      await refreshViews('rules', 'unprotected');
    } else {
      button.disabled = false;
      showToast(t('options.toastPurgeError'));
    }
  });
  return button;
}

// Tazeleme kaydina KAYITLI.
export async function renderUnprotectedLogins() {
  if (!ui.body || !ui.section) return;

  const yanit = await sendToBackground(Action.GET_ALL_STORED_DOMAINS);
  const adaylar = (yanit?.domains || [])
    // Uc kosul birden: 1) oturum cerezi var 2) hicbir kural yok (gri liste ve gecici izin de KORUMA sayilir) 3) 3. TARAF DEGIL
    .filter(d => d.hasSessionCookie
      && d.ruleType === RuleType.DEFAULT
      && d.category !== 'third_party')
    .sort((a, b) => b.cookieCount - a.cookieCount)
    .slice(0, EN_FAZLA);

  ui.body.replaceChildren();
  for (const site of adaylar) {
    ui.body.append(h('tr', {}, [
      h('td', { class: 'domain-cell', text: site.domain }),
      h('td', { class: 'mono', text: String(site.cookieCount) }),
      h('td', { class: 'text-right' }, h('div', { class: 'row-actions' }, ekleDugmesi(site)))
    ]));
  }

  // Riski olmayan kullaniciya bos bir bolum gostermek gurultu.
  ui.section.classList.toggle('hidden', adaylar.length === 0);
}

registerView('unprotected', renderUnprotectedLogins);
