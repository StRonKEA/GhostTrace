// GhostTrace - segment dugmelerinde SECILI DURUM (popup + options ortak).
//
// Secim daha once yalnizca `.active` sinifiyla tasiniyordu. Sinif yalnizca
// GORUNUR bir sinyaldir: ekran okuyucu bir gruptaki dort dugmeyi de ayni
// okuyor, kullanici hangi sureyi ya da kapsami sectigini DUYAMIYORDU.
// Bu eklentide o secim kararin kendisi (WCAG 4.1.2).
//
// Sinif ile `aria-pressed` bu dosyada BIRLIKTE degisir; ikisinin ayri
// yerlerde guncellenmesi tam da bu sapmayi uretmisti.

/** Bir segment dugmesinin secili durumunu yazar. */
export function setActive(node, on) {
  if (!node) return;
  node.classList.toggle('active', Boolean(on));
  node.setAttribute('aria-pressed', String(Boolean(on)));
}

/** Gruptaki TEK dugmeyi secer, digerlerini birakir. */
export function selectOne(nodes, chosen) {
  for (const node of nodes) setActive(node, node === chosen);
}

/**
 * Baslangic durumunu HTML'deki `.active` sinifindan uretir.
 *
 * Varsayilan secim isaretlemede duruyor; her grup icin ayrica
 * `aria-pressed="false"` yazmak yerine tek yerden esitlenir - boylece
 * sonradan eklenen bir grup da otomatik kapsanir.
 */
export function initSegmented(root = document) {
  for (const grup of root.querySelectorAll('[role="group"]')) {
    for (const dugme of grup.querySelectorAll('button')) {
      setActive(dugme, dugme.classList.contains('active'));
    }
  }
}
