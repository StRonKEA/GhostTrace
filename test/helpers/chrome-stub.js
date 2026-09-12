// GhostTrace - Testler icin chrome.* API taklidi (in-memory fake)
// Gercek eklenti calisma zamanini taklit eder; hicbir harici bagimlilik yok.

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeStorageArea {
  constructor(onChanged, areaName) {
    this.data = new Map();
    this.onChanged = onChanged;
    this.areaName = areaName;
    this.writeCount = 0;
    this.readCount = 0;
    // Gercek API'de bu bir SABIT alan. Kodun dogrulugu degerin KENDISINE bagli
    // degil - isleyici alani calisma aninda okur, yoksa null doner - ama alanin
    // varligini taklit etmezsek o dal hic olculmez.
    this.QUOTA_BYTES = 10 * 1024 * 1024;
  }

  async get(keys) {
    this.readCount++;
    const out = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of this.data) out[k] = clone(v);
      return out;
    }
    if (typeof keys === 'string') {
      if (this.data.has(keys)) out[keys] = clone(this.data.get(keys));
      return out;
    }
    if (Array.isArray(keys)) {
      for (const k of keys) if (this.data.has(k)) out[k] = clone(this.data.get(k));
      return out;
    }
    for (const [k, def] of Object.entries(keys)) {
      out[k] = this.data.has(k) ? clone(this.data.get(k)) : clone(def);
    }
    return out;
  }

  async set(obj) {
    this.writeCount++;
    const changes = {};
    for (const [k, v] of Object.entries(obj)) {
      changes[k] = { oldValue: clone(this.data.get(k)), newValue: clone(v) };
      this.data.set(k, clone(v));
    }
    await this.onChanged._fire(changes, this.areaName);
  }

  async remove(keys) {
    this.writeCount++;
    const list = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of list) {
      if (this.data.has(k)) {
        changes[k] = { oldValue: clone(this.data.get(k)), newValue: undefined };
        this.data.delete(k);
      }
    }
    if (Object.keys(changes).length) await this.onChanged._fire(changes, this.areaName);
  }

  async clear() {
    this.writeCount++;
    const changes = {};
    for (const [k, v] of this.data) changes[k] = { oldValue: clone(v), newValue: undefined };
    this.data.clear();
    if (Object.keys(changes).length) await this.onChanged._fire(changes, this.areaName);
  }

  async setAccessLevel({ accessLevel }) {
    this.accessLevel = accessLevel;
  }

  async getBytesInUse() {
    let total = 0;
    for (const [key, value] of this.data) {
      total += key.length + JSON.stringify(value ?? null).length;
    }
    return total;
  }
}

class FakeEvent {
  constructor() { this.listeners = []; }
  addListener(fn) { this.listeners.push(fn); }
  removeListener(fn) { this.listeners = this.listeners.filter(l => l !== fn); }
  hasListener(fn) { return this.listeners.includes(fn); }
  async _fire(...args) {
    for (const fn of [...this.listeners]) await fn(...args);
  }
}

const cookieHostOf = (domain) => (domain.startsWith('.') ? domain.slice(1) : domain);

/**
 * chrome.cookies.getAll'un partitionKey suzgeci - GERCEK Chrome davranisi.
 *
 * Chromium `chrome/browser/extensions/api/cookies/cookies_helpers.cc` ->
 * CookiePartitionKeyCollectionFromApiPartitionKey(): topLevelSite verilmezse
 * ContainsAll() uretilir. Kaynaktaki yorum birebir:
 *   "There is an edge case where a getAll call that contains a partition key
 *    parameter but no top_level_site parameter results in a return of
 *    partitioned and non-partitioned cookies."
 *
 * Bu stub onceden `Boolean(c.partitionKey) === Boolean(filter.partitionKey)`
 * yapiyordu; yani partitionKey:{} verildiginde YALNIZCA bolumlenmis cerezleri
 * donduruyordu. Gercek Chrome'un ustkume dondurdugu yerde stub kesisim
 * donduruyordu - testleri yaniltan bir modelleme hatasi.
 */
function matchesPartitionFilter(cookie, partitionKey) {
  const isPartitioned = Boolean(cookie.partitionKey);

  // Suzgec yok -> yalnizca bolumlenmemis cerezler
  if (partitionKey === undefined || partitionKey === null) return !isPartitioned;

  // partitionKey: {} (topLevelSite anahtari YOK) -> tum cerezler
  if (!('topLevelSite' in partitionKey)) return true;

  // topLevelSite: "" -> yalnizca bolumlenmemis (tuzak: "tum bolumler" DEGIL)
  if (partitionKey.topLevelSite === '') return !isPartitioned;

  // Belirli bir ust site -> yalnizca o bolum
  return isPartitioned && cookie.partitionKey.topLevelSite === partitionKey.topLevelSite;
}

// Tek bir stub ornegi tutulur. Gercek eklentide moduller yuklenirken
// chrome.storage.onChanged'e BIR KEZ dinleyici baglar; testler arasinda stub'i
// bastan yaratmak bu dinleyicileri kopariyordu. Bu yuzden nesne kimlikleri
// korunur, yalnizca veri sifirlanir.
/**
 * chrome.permissions taklidi - gercek davranisi modeller:
 *  * origins sorgulari: manifest <all_urls> iceriyor -> varsayilan TRUE.
 *    Testler `revokedOrigins` ile kisitlamayi simule edebilir.
 *  * permissions sorgulari: opsiyonel izinler varsayilan olarak VERILMEMIS.
 *
 * Ayri bir fabrika olmasinin sebebi: testler bu metotlari eziyor
 * (`chrome.permissions.contains = async () => true`). Stub tekil oldugu icin
 * bu ezme sonraki testlere SIZIYORDU ve gercek davranisi maskeliyordu.
 * Her sifirlamada kanonik uygulamalar geri yazilir.
 */
function permissionApi(state) {
  return {
    async contains({ permissions = [], origins = [] } = {}) {
      for (const perm of permissions) {
        if (!state.grantedPermissions.has(perm)) return false;
      }
      for (const origin of origins) {
        // <all_urls>: kullanici site erisimini DARALTMISSA artik yoktur.
        // Stub bunu modellemiyordu; "tum sitelere erisimim var mi?" sorusu
        // kisitli profilde bile TRUE donuyordu.
        if (origin === '<all_urls>' || origin === '*://*/*') {
          if (state.revokedOrigins.length > 0) return false;
          continue;
        }
        if (state.revokedOrigins.some(pattern => origin.startsWith(pattern))) return false;
      }
      return true;
    },
    async request({ permissions = [], origins = [] } = {}) {
      if (!state.autoGrantPermissions) return false;
      for (const perm of permissions) state.grantedPermissions.add(perm);
      for (const origin of origins) {
        state.revokedOrigins = state.revokedOrigins.filter(pattern => !origin.startsWith(pattern));
      }
      return true;
    },
    async remove({ permissions = [] } = {}) {
      for (const perm of permissions) state.grantedPermissions.delete(perm);
      return true;
    }
  };
}

/**
 * scripting API'sini TAZE uretir.
 *
 * Testler executeScript'i kendi taklitleriyle eziyor ve geri koymuyor; ezme
 * sonraki testlere tasiniyordu. permissionApi ile ayni gerekce: sifirlama
 * kanonik metotlari geri getirmek ZORUNDA, yoksa bir testin taklidi baska bir
 * testin olctugu sey oluyor.
 */
function scriptingApi() {
  return {
      _registered: new Map(),
      // Gercek Chrome bu cagrilari tarayici surecine IPC ile gonderir; her biri
      // olculebilir gecikme yasar. Mikro-gorevde bitiren bir taklit, es zamanli
      // cagrilarin catismasini HIC uretmez - testler yesil gorunur ama gercekte
      // "Duplicate script ID" alinir. _latencyMs bu turu taklit eder.
      _latencyMs: 0,
      _hideRegistrations: false,
      // Enjeksiyon kaydi. Bu yoktu, dolayisiyla backfillObserverIntoOpenTabs
      // uretimde en kritik yol oldugu halde `!chrome.scripting?.executeScript`
      // kontrolunden sessizce 0 dondurup HIC olculmuyordu.
      _executed: [],
      _executeFails: new Set(),
      async executeScript({ target, files } = {}) {
        await this._trip();
        // chrome://, Web Store ve erisim verilmemis sayfalarda gercek API atar.
        if (this._executeFails.has(target?.tabId)) throw new Error('Cannot access contents of the page');
        this._executed.push({ tabId: target?.tabId, allFrames: target?.allFrames, files });
        return [{ result: null }];
      },
      async _trip() {
        if (this._latencyMs > 0) await new Promise(r => setTimeout(r, this._latencyMs));
      },
      async registerContentScripts(scripts) {
        await this._trip();
        for (const script of scripts) {
          if (this._registered.has(script.id)) throw new Error('Duplicate script id: ' + script.id);
          this._registered.set(script.id, script);
        }
      },
      async unregisterContentScripts({ ids = [] } = {}) {
        await this._trip();
        for (const id of ids) this._registered.delete(id);
      },
      async getRegisteredContentScripts({ ids } = {}) {
        await this._trip();
        // persistAcrossSessions ile saklanan kayitlar, eklenti yeniden
        // yuklendiginde tarayici surecinde GERI YUKLENMEDEN once sorulursa
        // bos donebilir - ama kayit orada durur. _hideRegistrations bu
        // pencereyi taklit eder: sonraki register cagrisi Duplicate alir.
        if (this._hideRegistrations) return [];
        const all = [...this._registered.values()];
        return ids ? all.filter(s => ids.includes(s.id)) : all;
      }
    };
}

let singleton = null;

function resetState(state, options) {
  state.cookies = options.cookies ? [...options.cookies] : [];
  state.history = options.history ? [...options.history] : [];
  state.downloads = options.downloads ? [...options.downloads] : [];
  state.tabs = options.tabs ? [...options.tabs] : [];
  state.alarms.clear();
  state.notifications.length = 0;
  state.browsingDataCalls.length = 0;
  state.badge.clear();
  state.actionTitles.clear();
  state.tabMessages.length = 0;
  state.removedCookies.length = 0;
  state.deletedHistory.length = 0;
  state.erasedDownloads.length = 0;
  state.grantedPermissions.clear();
  state.revokedOrigins = options.revokedOrigins ? [...options.revokedOrigins] : [];
  state.autoGrantPermissions = options.autoGrantPermissions !== false;
  state.historyRemovalPermitted = options.historyRemovalPermitted !== false;
  for (const key of Object.keys(state.apiCalls)) state.apiCalls[key] = 0;
}

/** onMessage'i tetikleyip sendResponse yanitini bekler. */
export function sendMessage(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const listeners = globalThis.chrome?.runtime?.onMessage?.listeners || [];
    if (listeners.length === 0) {
      reject(new Error('onMessage dinleyicisi yok'));
      return;
    }
    let settled = false;
    const respond = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const listener of listeners) listener(message, sender, respond);
    setTimeout(() => {
      if (!settled) reject(new Error(`Yanit alinamadi: ${message.action}`));
    }, 5000);
  });
}

export function installChromeStub(options = {}) {
  if (singleton) {
    resetState(singleton._state, options);
    singleton._storage.local.data.clear();
    singleton._storage.local.readCount = 0;
    singleton._storage.local.writeCount = 0;
    singleton._storage.session.data.clear();
    singleton._storage.session.readCount = 0;
    singleton._storage.session.writeCount = 0;
    singleton.i18n.getUILanguage = () => options.uiLanguage || 'tr';
    // Testlerin ezdigi metotlari kanonik hallerine dondur (sizinti onlemi).
    Object.assign(singleton.permissions, permissionApi(singleton._state));
    delete singleton.privacy;
    delete singleton.contentSettings;
    singleton.contextMenus._items.clear();
    // scripting hic sifirlanmiyordu: kaydedilen icerik script'i, enjeksiyon
    // kayitlari ve testlerin ezdigi metotlar sonraki TUM testlere tasiniyordu.
    Object.assign(singleton.scripting, scriptingApi());
    globalThis.chrome = singleton;
    return singleton;
  }

  const onChanged = new FakeEvent();
  const local = new FakeStorageArea(onChanged, 'local');
  const session = new FakeStorageArea(onChanged, 'session');

  const state = {
    cookies: [],
    history: [],
    downloads: [],
    tabs: [],
    alarms: new Map(),
    notifications: [],
    browsingDataCalls: [],
    badge: new Map(),
    actionTitles: new Map(),
    removedCookies: [],
    deletedHistory: [],
    erasedDownloads: [],
    grantedPermissions: new Set(),
    revokedOrigins: [],
    autoGrantPermissions: true,
    // Kurumsal politika taklidi: kAllowDeletingBrowserHistory=false ise
    // chrome.history.deleteUrl REDDEDER ve settings() bunu bildirir.
    historyRemovalPermitted: true,
    tabMessages: [],
    apiCalls: { cookiesGetAll: 0, historySearch: 0, downloadsSearch: 0, tabsQuery: 0, cookiesRemove: 0 }
  };
  resetState(state, options);

  const chromeStub = {
    _state: state,
    _storage: { local, session },
    runtime: {
      id: 'ghosttrace-test',
      lastError: null,
      onMessage: new FakeEvent(),
      onInstalled: new FakeEvent(),
      onStartup: new FakeEvent(),
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'chrome-extension://ghosttrace-test/' + p,
      sendMessage: async () => ({ success: true })
    },
    storage: { local, session, onChanged },
    alarms: {
      async create(name, info) { state.alarms.set(name, { name, ...info }); },
      async get(name) { return state.alarms.get(name); },
      async getAll() { return [...state.alarms.values()]; },
      async clear(name) { return state.alarms.delete(name); },
      async clearAll() { state.alarms.clear(); return true; },
      onAlarm: new FakeEvent(),
      /**
       * Alarmi tetikler ve GERCEK Chrome gibi davranir: `periodInMinutes`
       * tasimayan (tek seferlik) alarm ateslendikten sonra KENDILIGINDEN
       * silinir. Taklit bunu modellemiyordu; urun kodu "alarm hala duruyor
       * mu?" diye baktiginda testte yanlis cevap aliyordu.
       */
      async _fire(name) {
        const alarm = state.alarms.get(name);
        if (!alarm) return false;
        if (alarm.periodInMinutes === undefined) state.alarms.delete(name);
        await singleton.alarms.onAlarm._fire(alarm);
        return true;
      }
    },
    cookies: {
      async getAll(filter = {}) {
        state.apiCalls.cookiesGetAll++;
        return state.cookies
          .filter(c => matchesPartitionFilter(c, filter.partitionKey))
          .filter(c => {
            if (!filter.domain) return true;
            const want = cookieHostOf(filter.domain);
            const have = cookieHostOf(c.domain);
            return have === want || have.endsWith('.' + want);
          })
          // `name` ve `url` suzgecleri ONCEDEN UYGULANMIYORDU: filtreli her
          // sorgu TUM cerezleri donduruyordu. Bu, "bu URL'de baska hangi ayni
          // isimli cerez var?" sorusunu soran kodu yaniltir.
          .filter(c => (filter.name === undefined ? true : c.name === filter.name))
          .filter(c => {
            if (!filter.url) return true;
            let u;
            try { u = new URL(filter.url); } catch { return false; }
            const cHost = cookieHostOf(c.domain);
            const hostGorunur = c.domain.startsWith('.')
              ? (u.hostname === cHost || u.hostname.endsWith('.' + cHost))
              : u.hostname === cHost;
            if (!hostGorunur) return false;
            if (c.secure && u.protocol !== 'https:') return false;
            const cPath = c.path || '/';
            return u.pathname === cPath
              || u.pathname.startsWith(cPath.endsWith('/') ? cPath : cPath + '/');
          })
          .map(c => clone(c));
      },

      /**
       * chrome.cookies.set - stub'da HIC YOKTU.
       *
       * Eksikligi sessiz bir kor nokta uretiyordu: cerezi silip geri koyan
       * kod, geri koyma adimi HIC CALISMADAN "gecti" gorunebilirdi.
       */
      async set(details = {}) {
        const hostOnly = details.domain === undefined;
        let host;
        try { host = new URL(details.url).hostname; } catch { return null; }
        const domain = hostOnly ? host : (details.domain.startsWith('.') ? details.domain : '.' + details.domain);

        const cookie = {
          name: details.name,
          value: details.value ?? '',
          domain,
          hostOnly,
          path: details.path || '/',
          secure: Boolean(details.secure),
          httpOnly: Boolean(details.httpOnly),
          sameSite: details.sameSite || 'unspecified',
          session: details.expirationDate === undefined,
          expirationDate: details.expirationDate,
          storeId: details.storeId || '0',
          partitionKey: details.partitionKey
        };
        // Ayni kimlikli cerez varsa uzerine yazilir (gercek davranis).
        const ayni = (c) => c.name === cookie.name && c.domain === cookie.domain
          && (c.path || '/') === cookie.path && (c.storeId || '0') === cookie.storeId
          && JSON.stringify(c.partitionKey || null) === JSON.stringify(cookie.partitionKey || null);
        state.cookies = state.cookies.filter(c => !ayni(c));
        state.cookies.push(cookie);
        return clone(cookie);
      },
      /**
       * chrome.cookies.remove - GERCEK Chrome davranisi.
       *
       * Chromium `net::CookieStore::DeleteCookieAsync` dokumantasyonu birebir:
       * *"Deletes all cookies with the specified name that match the given
       * URL."* ALL - tekil degil. Alt alan adinin URL'sinde UST alan adinin
       * ayni isimli cerezi de GORUNUR, dolayisiyla o da silinir.
       *
       * Bu stub onceden findIndex ile TEK cerez siliyordu. Gercek Chrome'dan
       * dar olan bu model, "alt alan adi temizlerken beyaz listedeki ust alan
       * adinin ayni isimli cerezi ucuyor" hatasini 573 testin tamamindan
       * gizledi; hata ancak gercek tarayicida gorunur oldu.
       */
      async remove(details) {
        state.apiCalls.cookiesRemove++;
        const host = new URL(details.url).hostname;
        const eslesir = (c) => {
          if (c.name !== details.name) return false;
          const cHost = cookieHostOf(c.domain);
          // Domain cerezi (.ornek.com) alt alan adlarinda da GORUNUR.
          const domainMatch = c.domain.startsWith('.')
            ? (host === cHost || host.endsWith('.' + cHost))
            : host === cHost;
          if (!domainMatch) return false;
          const wantPart = JSON.stringify(details.partitionKey || null);
          const havePart = JSON.stringify(c.partitionKey || null);
          return wantPart === havePart;
        };

        const silinecek = state.cookies.filter(eslesir);
        if (silinecek.length === 0) return null;
        state.cookies = state.cookies.filter(c => !eslesir(c));
        for (const c of silinecek) state.removedCookies.push(c);
        return { name: silinecek[0].name, url: details.url };
      },
      onChanged: new FakeEvent()
    },
    history: {
      async search({ text = '', maxResults = 100, startTime = 0, endTime }) {
        state.apiCalls.historySearch++;
        const q = text.toLowerCase();
        return state.history
          .filter(h => !q || h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q))
          .filter(h => h.lastVisitTime >= startTime && (endTime === undefined || h.lastVisitTime < endTime))
          .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
          .slice(0, maxResults)
          .map(h => clone(h));
      },
      async deleteUrl({ url }) {
        // Gercek Chrome: politika kapaliysa history_api.cc kDeleteProhibitedError
        // atar. Eski kod bu reddi sessizce yutuyordu.
        if (!state.historyRemovalPermitted) {
          throw new Error('Deleting history is not allowed.');
        }
        const idx = state.history.findIndex(h => h.url === url);
        if (idx >= 0) {
          state.deletedHistory.push(state.history[idx]);
          state.history.splice(idx, 1);
        }
      }
    },
    downloads: {
      // `query` GERCEKTEN uygulanir. Yoksayilsaydi, uretim kodundaki
      // daraltma filtresi testlerde hic olculmez ve yanlis bir terim
      // (ornegin scope.base yerine tam URL) sessizce tum kayitlari
      // atlatirdi - testler yine gecerdi.
      // Chrome dokumani: terimler url / finalUrl / filename icinde aranir.
      async search({ query = null } = {}) {
        state.apiCalls.downloadsSearch++;
        const terms = Array.isArray(query) ? query.filter(term => !String(term).startsWith('-')) : [];
        return state.downloads
          .filter(d => terms.every(term => {
            const hay = `${d.url || ''} ${d.finalUrl || ''} ${d.filename || ''}`.toLowerCase();
            return hay.includes(String(term).toLowerCase());
          }))
          .map(d => clone(d));
      },
      async erase({ id }) {
        const idx = state.downloads.findIndex(d => d.id === id);
        if (idx >= 0) {
          state.erasedDownloads.push(state.downloads[idx]);
          state.downloads.splice(idx, 1);
          return [id];
        }
        return [];
      }
    },
    browsingData: {
      async remove(filter, types) { state.browsingDataCalls.push({ filter: clone(filter), types: clone(types) }); },
      // Gercek davranis: IsRemovalPermitted() YALNIZCA history/downloads icin
      // politikaya bakar, digerleri her zaman true doner. Bu yuzden
      // dataRemovalPermitted.cache ile "onbellek silinemiyor" tespiti YAPILAMAZ.
      async settings() {
        return {
          options: { since: 0 },
          dataToRemove: { history: true },
          dataRemovalPermitted: {
            history: state.historyRemovalPermitted,
            downloads: state.historyRemovalPermitted,
            cookies: true,
            cache: true,
            localStorage: true
          }
        };
      }
    },
    tabs: {
      // Gercekte HER ZAMAN var (tabs izni manifest'te). Taklitte yoktu ve
      // eksikligi urun kodunda bir kirilganligi gizliyordu: cagri senkron
      // TypeError firlatiyor, `.then(ok, fail)` onu yakalamiyordu.
      // Alici yoksa Chrome REDDEDER - burada da oyle.
      async sendMessage(tabId, message) {
        state.tabMessages.push({ tabId, message: clone(message) });
        const alici = state.tabs.some(t => t.id === tabId);
        if (!alici) throw new Error('Could not establish connection. Receiving end does not exist.');
        return undefined;
      },
      async query(filter = {}) {
        state.apiCalls.tabsQuery++;
        return state.tabs
          .filter(t => (filter.active === undefined || t.active === filter.active))
          .map(t => clone(t));
      },
      async get(id) {
        const tab = state.tabs.find(t => t.id === id);
        if (!tab) throw new Error('No tab with id ' + id);
        return clone(tab);
      },
      onCreated: new FakeEvent(),
      onUpdated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      onActivated: new FakeEvent(),
      onReplaced: new FakeEvent()
    },
    windows: { onRemoved: new FakeEvent() },
    notifications: {
      async create(id, opts) { state.notifications.push({ id, ...opts }); return id; },
      onClicked: new FakeEvent()
    },
    action: {
      async setBadgeText({ text, tabId }) {
        const key = tabId ?? 'global';
        state.badge.set(key, { ...(state.badge.get(key) || {}), text });
      },
      async setBadgeBackgroundColor({ color, tabId }) {
        const key = tabId ?? 'global';
        state.badge.set(key, { ...(state.badge.get(key) || {}), color });
      },
      async setBadgeTextColor() {},
      // Rozet rengi tek basina erisilebilir bir bilgi tasimaz; durumun
      // METINDE de olmasi gerekiyor, bu yuzden kaydediyoruz.
      async setTitle({ title, tabId }) {
        state.actionTitles.set(tabId ?? 'global', title);
      }
    },
    commands: { onCommand: new FakeEvent() },
    contextMenus: {
      _items: new Map(),
      // GERCEK davranis: create() HATA ATMAZ. Sorunu chrome.runtime.lastError'a
      // yazar ve varsa geri cagirmayi cagirir. Onceki taklit geri cagirmayi
      // hic cagirmiyordu; geri cagirma bekleyen urun kodu SONSUZA KADAR
      // asiliyordu (testler zaman asimina ugradi). Ayrica yinelenen id
      // reddini de modellemiyordu - gercek Chrome'un en sik menu hatasi.
      create(props, callback) {
        const yinelenen = this._items.has(props.id);
        // GERCEK davranis: parentId var olmayan bir ogeyi gosteriyorsa Chrome
        // "Cannot find menu item with id X" yazar. Taklit bunu modellemiyordu
        // ve tam bu hata gercek kullanimda gorulduu (es zamanli iki
        // syncContextMenus birbirinin kokunu removeAll ile siliyordu).
        const yetimUst = props.parentId !== undefined && !this._items.has(props.parentId);
        if (yinelenen) {
          singleton.runtime.lastError = {
            message: `Cannot create item with duplicate id ${props.id}`
          };
        } else if (yetimUst) {
          singleton.runtime.lastError = {
            message: `Cannot find menu item with id ${props.parentId}`
          };
        } else {
          singleton.runtime.lastError = null;
          this._items.set(props.id, { ...props });
        }
        if (typeof callback === 'function') {
          callback();
          // Gercek Chrome lastError'i geri cagirmadan SONRA temizler.
          singleton.runtime.lastError = null;
        }
        return props.id;
      },
      async update(id, props) {
        if (!this._items.has(id)) throw new Error('No item with id ' + id);
        Object.assign(this._items.get(id), props);
      },
      async remove(id) { this._items.delete(id); },
      async removeAll() { this._items.clear(); },
      onClicked: new FakeEvent()
    },
    scripting: scriptingApi(),
    permissions: {
      ...permissionApi(state),
      onAdded: new FakeEvent(),
      onRemoved: new FakeEvent()
    },
    i18n: { getUILanguage: () => options.uiLanguage || 'tr' }
  };

  singleton = chromeStub;
  globalThis.chrome = chromeStub;
  return chromeStub;
}

export function uninstallChromeStub() {
  delete globalThis.chrome;
}

/** Kayitli tum dinleyicileri de atar (izole modul testleri icin). */
export function destroyChromeStub() {
  singleton = null;
  delete globalThis.chrome;
}

export function makeCookie(overrides = {}) {
  return {
    name: 'c',
    value: 'v',
    domain: 'example.com',
    path: '/',
    secure: false,
    httpOnly: false,
    session: false,
    sameSite: 'lax',
    storeId: '0',
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  };
}

export function makeHistoryItem(url, overrides = {}) {
  return { id: url, url, title: url, lastVisitTime: Date.now(), visitCount: 1, ...overrides };
}
