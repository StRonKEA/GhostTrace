// GhostTrace - Kucuk DOM taklidi (yalnizca testler icin)
//
// NEDEN GERCEK HTML'DEN KURULUYOR: Uydurma bir DOM, "dinleyici baglandi" der
// ama gercek sayfada o element hic olmayabilir. O zaman test yesil, panel
// bozuk olur - tam olarak kacinmaya calistigimiz "calisiyor gibi gorunur"
// sinifi. Bu yuzden agac options.html'in kendisinden ayristiriliyor: HTML'de
// olmayan bir id'yi arayan kod testte de bulamaz.
//
// KAPSAM: options/popup sayfalarinin FIILEN kullandigi kadari. Genel amacli
// bir DOM motoru degil; desteklemedigi bir sey kullanilirsa test patlar ve
// bu dogru davranistir (sessizce yanlis sonuc vermekten iyidir).

import { readFileSync } from 'node:fs';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'source', 'track', 'wbr']);

// --------------------------------------------------------------------------
// Element
// --------------------------------------------------------------------------

class FakeElement {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._attrs = { ...attrs };
    this._listeners = new Map();
    this._text = '';
    this.value = attrs.value ?? '';
    this.checked = attrs.checked !== undefined;
    this.disabled = attrs.disabled !== undefined;
    this.title = attrs.title ?? '';
    this.placeholder = attrs.placeholder ?? '';
    this.style = {};
    this.files = [];
    this.focused = false;

    const self = this;
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
      get _set() { return classes; }
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); }
    });

    // data-* -> dataset
    this.dataset = new Proxy({}, {
      get: (_, key) => self._attrs['data-' + camelToDash(String(key))],
      set: (_, key, val) => { self._attrs['data-' + camelToDash(String(key))] = String(val); return true; },
      has: (_, key) => ('data-' + camelToDash(String(key))) in self._attrs,
      ownKeys: () => Object.keys(self._attrs).filter(k => k.startsWith('data-'))
        .map(k => dashToCamel(k.slice(5))),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
    });
  }

  get id() { return this._attrs.id || ''; }
  // Gercek DOM'da id yazilabilir; salt-okunur modellemek urun kodunun
  // calisan bir yolunu testte TypeError'a ceviriyordu.
  set id(value) { this._attrs.id = String(value); }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map(c => c.textContent ?? String(c)).join('');
  }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }

  set innerHTML(v) { this._html = String(v ?? ''); this.children = []; }
  get innerHTML() { return this._html || ''; }

  getAttribute(name) { return this._attrs[name] ?? null; }
  setAttribute(name, value) { this._attrs[name] = String(value); }
  hasAttribute(name) { return name in this._attrs; }
  removeAttribute(name) { delete this._attrs[name]; }

  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      if (typeof n === 'string' || typeof n === 'number') { this._text += String(n); continue; }
      if (n instanceof FakeFragment) { for (const c of n.children) this.append(c); continue; }
      n.parentNode = this;
      this.children.push(n);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  focus() { this.focused = true; ownerDocument.activeElement = this; }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  /** Testler icin: bu elemente kayitli dinleyici sayisi. */
  _listenerCount(type) { return (this._listeners.get(type) || []).length; }

  /** Testler icin: olayi tetikler ve dinleyicilerin donusunu bekler. */
  async _fire(type, extra = {}) {
    const handlers = [...(this._listeners.get(type) || [])];
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...extra
    };
    for (const h of handlers) await h(event);
    return handlers.length;
  }

  click() { return this._fire('click'); }

  /** En yakin ust ogeyi bulur (kendisi dahil). options.js sertlestirme
   *  bolumunde fiilen kullaniliyor. */
  closest(sel) {
    let cur = this;
    while (cur) {
      if (matchesSimple(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(sel) { return descendants(this).find(n => matches(n, sel)) || null; }
  querySelectorAll(sel) { return descendants(this).filter(n => matches(n, sel)); }
}

class FakeFragment {
  constructor() { this.children = []; }
  append(...nodes) { for (const n of nodes) if (n) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
}

const camelToDash = (s) => s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
const dashToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function descendants(node, out = []) {
  for (const c of node.children) {
    if (c instanceof FakeElement) { out.push(c); descendants(c, out); }
  }
  return out;
}

// --------------------------------------------------------------------------
// Selektor eslesmesi - YALNIZCA fiilen kullanilan alt kume
//   tag | #id | .class | [attr] | bunlarin bilesigi | bosluk = torun
// --------------------------------------------------------------------------

function matchesSimple(node, part) {
  // [attr] ve [attr="deger"] - ikincisi eskiden desteklenmiyordu ve gercek
  // tarayicida calisan bir seciciyi testte "eleman yok" durumuna dusuruyordu.
  const tokens = part.match(
    /(^[a-zA-Z][a-zA-Z0-9]*)|(#[\w-]+)|(\.[\w-]+)|(\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\])/g);
  if (!tokens) return false;
  for (const tk of tokens) {
    if (tk.startsWith('#')) { if (node.id !== tk.slice(1)) return false; }
    else if (tk.startsWith('.')) { if (!node.classList.contains(tk.slice(1))) return false; }
    else if (tk.startsWith('[')) {
      const icerik = tk.slice(1, -1);
      const esit = icerik.indexOf('=');
      if (esit === -1) {
        if (!node.hasAttribute(icerik)) return false;
      } else {
        const ad = icerik.slice(0, esit);
        const beklenen = icerik.slice(esit + 1).replace(/^["']|["']$/g, '');
        if (node.getAttribute(ad) !== beklenen) return false;
      }
    }
    else if (node.tagName !== tk.toUpperCase()) return false;
  }
  return true;
}

function matches(node, selector) {
  const parts = String(selector).trim().split(/\s+/);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  // torun zinciri: sondan basa yukari yurur
  let cur = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (cur) {
      if (matchesSimple(cur, parts[i])) { found = true; cur = cur.parentNode; break; }
      cur = cur.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// HTML ayristirma (kaba ama gercek dosyadan)
// --------------------------------------------------------------------------

function parseHtml(html) {
  const root = new FakeElement('body');
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const [, closing, tag, rawAttrs, selfClose] = m;
    const lower = tag.toLowerCase();
    if (lower === 'script' || lower === 'style' || lower === 'svg' || lower === 'path'
        || lower === 'line' || lower === 'circle' || lower === 'polyline' || lower === 'rect') {
      continue;
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (a[1]) attrs[a[1]] = a[2] ?? '';
    }
    const node = new FakeElement(tag, attrs);
    stack[stack.length - 1].append(node);
    if (!selfClose && !VOID_TAGS.has(lower)) stack.push(node);
  }
  return root;
}

// --------------------------------------------------------------------------
// Document
// --------------------------------------------------------------------------

let ownerDocument = null;

/**
 * Verilen HTML dosyasindan bir DOM kurar ve globalThis.document'e yerlestirir.
 * Doner: { document, byId(id), root }
 */
export function installDom(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const body = parseHtml(html);

  const ids = new Map();
  for (const node of descendants(body)) {
    if (node.id && !ids.has(node.id)) ids.set(node.id, node);
  }

  const documentElement = new FakeElement('html');
  const doc = {
    body,
    documentElement,
    activeElement: null,
    _listeners: new Map(),
    // Gercek DOM CANLI sorgular. Kurulum anindaki haritayi dondurmek,
    // calisma aninda id atayan kodu (kademeli aciklama panelleri) testte
    // "eleman yok" durumuna dusuruyordu - urun kodu dogru oldugu halde.
    getElementById: (id) => ids.get(id)
      || descendants(body).find(n => n._attrs.id === id)
      || null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    createElement: (tag) => new FakeElement(tag),
    createDocumentFragment: () => new FakeFragment(),
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(handler);
    },
    async _fire(type, extra = {}) {
      for (const h of [...(this._listeners.get(type) || [])]) {
        await h({ type, ...extra, preventDefault() {}, stopPropagation() {} });
      }
    }
  };

  ownerDocument = doc;
  globalThis.document = doc;
  // Modal odaklama icin kullaniliyor; testte hemen calistirmak yeterli.
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.location = { hash: '', href: 'chrome-extension://test/options.html' };
  // Panel sekme degisiminde history.replaceState ile hash yaziyor.
  globalThis.history = {
    replaceState(_state, _title, url) { globalThis.location.hash = String(url || ''); }
  };
  globalThis.URL = globalThis.URL || URL;
  globalThis.Blob = globalThis.Blob || class { constructor(parts) { this.parts = parts; } };

  // popup.js ust duzeyde window.addEventListener('pagehide') cagiriyor ve
  // chrome.runtime.openOptionsPage yoksa window.open'a dusuyor. Bu global
  // eksikti; popup hic test edilmedigi icin fark edilmemisti.
  globalThis.window = {
    _opened: null,
    _scrolledTo: null,
    addEventListener: (type, handler, opts) => doc.addEventListener(type, handler, opts),
    removeEventListener: () => {},
    open: (url) => { globalThis.window._opened = String(url); },
    // options.js sekme degistirince basa sariyor; taklit bunu KAYDEDER ki
    // test "sariyor mu" diye sorabilsin.
    scrollTo: (opts) => { globalThis.window._scrolledTo = opts; },
    get location() { return globalThis.location; }
  };

  return { document: doc, byId: (id) => ids.get(id) || null, root: body, ids };
}

export { FakeElement };
