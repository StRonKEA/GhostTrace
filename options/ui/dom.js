// GhostTrace - Ayarlar paneli: DOM yardimcilari

export const el = (id) => document.getElementById(id);

export const qs = (selector) => document.querySelector(selector);

export const qsa = (selector) => [...document.querySelectorAll(selector)];

// Kucuk DOM yardimcilari (innerHTML yerine)

/** Element uretir. props: {class, text, title, dataset, attrs, on} */
export function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = String(props.text);
  if (props.title) node.title = props.title;
  if (props.type) node.type = props.type;
  if (props.disabled) node.disabled = true;
  if (props.checked) node.checked = true;
  if (props.dataset) Object.assign(node.dataset, props.dataset);
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, value);
  }
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

// Ikon govdeleri SABIT dizelerdir (kullanici verisi icermez), bu yuzden innerHTML ile kurulmalari guvenlidir.
export const ICON_PATHS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'
};

export function icon(name, size = 12) {
  const span = h('span', { class: 'icon-wrap' });
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

/** Etiket + nokta iceren rozet. */
export function badge(className, label, title = '') {
  return h('span', { class: `badge-tag ${className}`, title }, [
    h('span', { class: 'badge-tag-dot' }),
    h('span', { text: label })
  ]);
}
