// GhostTrace - Ayarlar paneli: bildirim seridi ve onay modali

import { t } from '../../lib/i18n.js';
import { el } from './dom.js';

// Toast ve onay modali

export const toastNode = el('optionsToast');
export let toastTimer = null;

export function showToast(message, duration = 2800) {
  if (!toastNode) return;
  // Onceki bildirimden kalan GERI AL dugmesi silinmeli.
  toastNode.replaceChildren();
  toastNode.textContent = message;
  toastNode.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.classList.add('hidden');
    toastTimer = null;
  }, duration);
}

/** GERI AL dugmeli bildirim. */
export function showToastWithUndo(message, onUndo, duration = 6000) {
  if (!toastNode) return;
  toastNode.replaceChildren();
  const metin = document.createElement('span');
  metin.textContent = message;
  const geri = document.createElement('button');
  geri.type = 'button';
  geri.className = 'toast__undo';
  geri.textContent = t('common.undo');
  geri.addEventListener('click', async () => {
    toastNode.classList.add('hidden');
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    await onUndo();
  });
  toastNode.append(metin, geri);
  toastNode.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.classList.add('hidden');
    toastNode.replaceChildren();
    toastTimer = null;
  }, duration);
}

export const confirmModal = {
  root: el('customModal'),
  title: el('modalTitle'),
  description: el('modalDescription'),
  cancel: el('modalBtnCancel'),
  confirm: el('modalBtnConfirm'),
  callback: null,
  returnFocus: null
};

export function openConfirm({ titleKey, descKey, confirmKey, params = {}, onConfirm }) {
  if (!confirmModal.root) return;
  confirmModal.title.textContent = t(titleKey, params);
  confirmModal.description.textContent = t(descKey, params);
  confirmModal.confirm.textContent = t(confirmKey || 'common.clean');
  confirmModal.callback = onConfirm;
  confirmModal.returnFocus = document.activeElement;
  confirmModal.root.classList.remove('hidden');
  requestAnimationFrame(() => confirmModal.confirm?.focus());
}

export function closeConfirm() {
  if (!confirmModal.root) return;
  confirmModal.root.classList.add('hidden');
  confirmModal.callback = null;
  confirmModal.returnFocus?.focus?.();
  confirmModal.returnFocus = null;
}

confirmModal.cancel?.addEventListener('click', closeConfirm);
confirmModal.root?.addEventListener('click', (event) => {
  if (event.target === confirmModal.root) closeConfirm();
});
confirmModal.confirm?.addEventListener('click', async () => {
  const callback = confirmModal.callback;
  closeConfirm();
  if (typeof callback === 'function') await callback();
});
