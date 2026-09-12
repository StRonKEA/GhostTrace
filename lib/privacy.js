// GhostTrace - Gizlilik Sertlestirme (Privacy Hardening)

export const PRIVACY_PERMISSION = 'privacy';
export const CONTEXT_MENUS_PERMISSION = 'contextMenus';

// Site izinleri: bir siteye verildikten sonra kalici olan izler.

/** hardening ayar anahtari -> chrome.privacy alani eslemesi. */
const HARDENING_MAP = [
  // KALICI olanlar: Chrome'un "Continue to support" listesinde.
  { key: 'blockThirdPartyCookies', group: 'websites', api: 'thirdPartyCookiesAllowed', invert: true },

  // Iliskili Site Kumeleri (RWS): Chrome'un tanidigi alan adi gruplari birbirini 3. taraf saymaz, yani 3. taraf engeli acikken bile cerez paylasabilirler - eklentinin dayandigi eTLD+1 sinirini gecersiz kilar. sunsetting: tasfiye yolunda; surume degil API'nin varligina bakariz.
  { key: 'disableRelatedWebsiteSets', group: 'websites', api: 'relatedWebsiteSetsEnabled', invert: true, sunsetting: true },

  // UZAK SUNUCUDA olusan, silinemeyen izler.

  // Chrome, siz o siteye HIC girmeden DNS cozumluyor ve TCP/SSL baglantisi aciyor: DNS onbellegi, TLS oturum bileti ve karsi sunucunun loglari.
  { key: 'disableNetworkPrediction', group: 'network', api: 'networkPredictionEnabled', invert: true },

  // Adres cubuguna yazdiklariniz oneri almak icin arama motoruna gonderilir.
  { key: 'disableSearchSuggest', group: 'services', api: 'searchSuggestEnabled', invert: true },

  // Sayfa bulunamadiginda Chrome yazdiginiz adresi Google'a gonderip 'bunu mu demek istediniz' onerisi alir.
  { key: 'disableAlternateErrorPages', group: 'services', api: 'alternateErrorPagesEnabled', invert: true }
];

/** chrome.privacy.<group>.<api> ayarina erisir; yoksa null doner. */
function resolveSetting({ group, api }) {
  return chrome.privacy?.[group]?.[api] || null;
}

/** Sertlestirme anahtarlarinin listesi (arayuz ve testler icin). */
export function hardeningKeys() {
  return HARDENING_MAP.map(entry => entry.key);
}

/** Chrome tarafindan kaldirilma yolunda olan anahtarlar. */
export function sunsettingKeys() {
  return HARDENING_MAP.filter(entry => entry.sunsetting).map(entry => entry.key);
}

/** Bu adres icin host erisimimiz var mi? */
export async function hasHostAccess(url) {
  if (!url) return true;
  let origin;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    origin = `${parsed.origin}/*`;
  } catch {
    return true;
  }

  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    // Belirleyemedik: yanlis alarm vermemek icin erisim varsayilir.
    return true;
  }
}

/** TUM sitelere erisimimiz var mi? */
export async function hasAllSitesAccess() {
  try {
    return await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    // Belirleyemedik: yanlis alarm vermemek icin erisim varsayilir.
    return true;
  }
}

/** Bir adres icin host erisimi ister. */
export async function requestHostAccess(url) {
  try {
    const parsed = new URL(url);
    return await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
  } catch {
    return false;
  }
}

/** Opsiyonel izin verilmis mi? */
export async function hasPermission(permission) {
  try {
    return await chrome.permissions.contains({ permissions: [permission] });
  } catch {
    return false;
  }
}

/** Opsiyonel izin ister. */
export async function requestPermission(permission) {
  try {
    return await chrome.permissions.request({ permissions: [permission] });
  } catch (err) {
    console.warn('[GhostTrace] Izin istegi basarisiz:', err);
    return false;
  }
}

/** chrome.types.LevelOfControl'un TAM enum'u. */
export const LEVEL_NOT_CONTROLLABLE = 'not_controllable';
export const LEVEL_CONTROLLED_BY_OTHER = 'controlled_by_other_extensions';
export const LEVEL_CONTROLLABLE = 'controllable_by_this_extension';
export const LEVEL_CONTROLLED_BY_US = 'controlled_by_this_extension';

/** set() cagrisinin anlamli olup olmadigini soyler. */
function canControl(levelOfControl) {
  return levelOfControl === LEVEL_CONTROLLABLE || levelOfControl === LEVEL_CONTROLLED_BY_US;
}

// Kontrolu ele alinca tarayicinin KENDI degeri gorunmez olur.
const BASELINE_KEY = 'hardeningBaseline';

async function readBaseline() {
  try {
    return (await chrome.storage.local.get(BASELINE_KEY))?.[BASELINE_KEY] || {};
  } catch {
    return {};
  }
}

/** Kontrol BIZDE DEGILKEN okunan deger, tarayicinin kendi degeridir. */
async function recordBaseline(key, current, invert) {
  if (!current || current.levelOfControl === LEVEL_CONTROLLED_BY_US) return;
  const hardened = invert ? !current.value : Boolean(current.value);
  try {
    const baseline = await readBaseline();
    if (baseline[key] === hardened) return;
    baseline[key] = hardened;
    await chrome.storage.local.set({ [BASELINE_KEY]: baseline });
  } catch {
    // Depo yazilamadi: arayuz eski davranisa duser, sessiz kalmaz.
  }
}

/** Olcum hic yapilmamissa (kontrolu onceden almis profiller) bir kez birakip tarayicinin ham degerini okur; cagiran dongu hemen ardindan geri yazar. */
async function ensureBaseline(entries) {
  const baseline = await readBaseline();
  const eksik = entries.filter(e => !(e.key in baseline));
  if (eksik.length === 0) return;

  for (const entry of eksik) {
    const setting = resolveSetting(entry);
    if (!setting?.get) continue;
    try {
      let current = await setting.get({});
      if (current?.levelOfControl === LEVEL_CONTROLLED_BY_US && setting.clear) {
        await setting.clear({});
        current = await setting.get({});
      }
      baseline[entry.key] = entry.invert ? !current.value : Boolean(current.value);
    } catch {
      // Okunamadi: bu anahtar icin olcum yok, arayuz eski davranisa duser.
    }
  }
  try { await chrome.storage.local.set({ [BASELINE_KEY]: baseline }); } catch { /* depo yok */ }
}

/** Sertlestirme ayarlarini uygular. */
export async function applyHardening(hardening = {}) {
  const outcome = {
    available: false,
    applied: [],
    // Kapali anahtarlar: gecersiz kilmamiz birakildi, tarayici ayari gecerli.
    released: [],
    skipped: [],
    notControllable: [],
    controlledElsewhere: [],
    unverified: [],
    // Tarayicida artik bulunmayan ayarlar: kapatilacak bir sey yok.
    unsupported: []
  };

  if (!await hasPermission(PRIVACY_PERMISSION)) {
    outcome.skipped.push('permission-missing');
    return outcome;
  }
  if (!chrome.privacy) {
    outcome.skipped.push('api-unavailable');
    return outcome;
  }
  outcome.available = true;
  // Tarayicinin kendi degeri bilinmiyorsa bir kez olc; dongu hemen ardindan istenen degerleri yazar.
  await ensureBaseline(HARDENING_MAP);

  for (const entry of HARDENING_MAP) {
    const { key, invert } = entry;
    const setting = resolveSetting(entry);
    if (!setting?.set) {
      // Yetenek tespiti: API yoksa Chrome onu kaldirmis demektir.
      outcome.unsupported.push(key);
      outcome.skipped.push(`${key}:unsupported`);
      continue;
    }

    const wanted = Boolean(hardening[key]);
    // TEK YONLU.
    const value = invert ? false : true;

    try {
      const current = await setting.get({});
      // Kontrol bizde degilken okunan deger tarayicinin KENDI degeridir.
      await recordBaseline(key, current, invert);

      // Kurumsal politika: yazma denemesi sessizce yutulur.
      if (current?.levelOfControl === LEVEL_NOT_CONTROLLABLE) {
        outcome.notControllable.push(key);
        outcome.skipped.push(`${key}:not-controllable`);
        continue;
      }
      // Baska bir eklenti ayari kilitlemis.
      if (current?.levelOfControl === LEVEL_CONTROLLED_BY_OTHER) {
        outcome.controlledElsewhere.push(key);
        outcome.skipped.push(`${key}:controlled-elsewhere`);
        continue;
      }

      if (!wanted) {
        // clear() yalnizca EKLENTININ kendi yazdigini kaldirir; karar Chrome'a kalir.
        if (setting.clear) await setting.clear({});
        outcome.released.push(key);
        continue;
      }

      await setting.set({ value });

      // TEYIT: set() basarili gorunse bile gercekten uygulandi mi?
      const after = await setting.get({});
      if (after && Boolean(after.value) === value && canControl(after.levelOfControl)) {
        outcome.applied.push(`${key}=${wanted}`);
      } else {
        outcome.unverified.push(key);
        outcome.skipped.push(`${key}:unverified`);
      }
    } catch (err) {
      outcome.skipped.push(`${key}:${err?.message || 'error'}`);
    }
  }

  return outcome;
}

/** Sertlestirme ayarlarinin tarayicidaki GERCEK durumunu okur. */
export async function readHardeningState() {
  const state = {
    available: false,
    values: {},
    levels: {},
    controlledElsewhere: [],
    notControllable: [],
    unsupported: [],
    // Tarayicinin KENDISI zaten sertlestirilmis degeri tutuyor.
    browserEnforced: []
  };

  if (!await hasPermission(PRIVACY_PERMISSION) || !chrome.privacy) return state;
  state.available = true;
  const baseline = await readBaseline();

  for (const entry of HARDENING_MAP) {
    const { key, invert } = entry;
    const setting = resolveSetting(entry);
    if (!setting?.get) {
      state.unsupported.push(key);
      continue;
    }
    try {
      const current = await setting.get({});
      await recordBaseline(key, current, invert);
      state.values[key] = invert ? !current.value : Boolean(current.value);
      state.levels[key] = current.levelOfControl || 'unknown';

      if (current.levelOfControl === LEVEL_NOT_CONTROLLABLE) state.notControllable.push(key);
      else if (current.levelOfControl === LEVEL_CONTROLLED_BY_OTHER) state.controlledElsewhere.push(key);
      // Tarayici zaten siki tutuyorsa kapatmanin etkisi olmaz; arayuz bunu soyler.
      else if (state.values[key]
        && (current.levelOfControl === LEVEL_CONTROLLABLE || baseline[key] === true)) {
        state.browserEnforced.push(key);
      }
    } catch {
      // Okunamayan ayari atla
    }
  }

  return state;
}

/** Sertlestirme ayarlarindaki DIS degisiklikleri dinler. */
export function watchHardeningChanges(onChange) {
  if (!chrome.privacy || typeof onChange !== 'function') return false;

  let attached = 0;
  for (const entry of HARDENING_MAP) {
    const { key } = entry;
    const setting = resolveSetting(entry);
    if (!setting?.onChange?.addListener) continue;
    try {
      setting.onChange.addListener(details => {
        onChange({
          key,
          value: details?.value,
          levelOfControl: details?.levelOfControl,
          controllable: canControl(details?.levelOfControl)
        });
      });
      attached++;
    } catch {
      // Dinlenemeyen ayari atla
    }
  }
  return attached > 0;
}

// NOT: resetSitePermissions() v2.5.0'da KALDIRILDI.
