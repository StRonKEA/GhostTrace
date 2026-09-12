// GhostTrace - kademeli aciklama (satirdaki (i) dugmesi).

let sayac = 0;

/** Kaptaki her (i) dugmesini kendi ayrinti paneline baglar. */
export function initDisclosures(root = document) {
  for (const button of root.querySelectorAll('.row__info')) {
    const satir = button.closest('.row');
    const panel = satir?.querySelector('.row__detail');

    // Ayrintisi olmayan satirda dugme DURMAZ.
    if (!panel) {
      button.remove();
      continue;
    }

    if (!panel.id) panel.setAttribute('id', `gt-detail-${++sayac}`);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    panel.hidden = true;

    button.addEventListener('click', () => {
      const acik = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!acik));
      panel.hidden = acik;
    });
  }
}
