// Ozellik dogrulama takimlarinin ortak yardimcilari.
//
// Senaryolar GERCEK sitelerde kosar; kok/alt alan adi iliskisi olan gercek
// adresler secildi (github.com / gist.github.com gibi) cunku kapsam kurali
// tam olarak orada anlam kazaniyor.

export const SITES = {
  githubKok:  { url: 'https://github.com/',                    host: 'github.com' },
  githubAlt:  { url: 'https://gist.github.com/',               host: 'gist.github.com' },
  wikiAlt:    { url: 'https://en.wikipedia.org/wiki/Cookie',   host: 'en.wikipedia.org' },
  wikiKok:    { url: 'https://www.wikipedia.org/',             host: 'wikipedia.org' },
  soKok:      { url: 'https://stackoverflow.com/',             host: 'stackoverflow.com' },
  soAlt:      { url: 'https://meta.stackoverflow.com/',        host: 'meta.stackoverflow.com' },
  bbc:        { url: 'https://www.bbc.com/news',               host: 'bbc.com' },
  hurriyet:   { url: 'https://www.hurriyet.com.tr/',           host: 'hurriyet.com.tr' }
};

/** Eklenti sayfasindan arka plana mesaj atar. */
export function makeMsg(chrome, page) {
  return (payload) => chrome.client.send('Runtime.evaluate', {
    expression: `(async () => await chrome.runtime.sendMessage(${JSON.stringify(payload)}))()`,
    awaitPromise: true, returnByValue: true
  }, page.sessionId).then(r => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'mesaj hatasi');
    return r.result.value;
  });
}

/** Eklenti sayfasi baglaminda ifade calistirir. */
export function makeEval(chrome, page) {
  return (expr) => chrome.client.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true
  }, page.sessionId).then(r => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'ifade hatasi');
    return r.result.value;
  });
}

/** Bir host'a (alt alan adlari dahil) ait cerez sayisi. */
export const cookieCountFor = (run, host) => run(`
  const all = await chrome.cookies.getAll({});
  return all.filter(c => {
    const d = c.domain.replace(/^\\./, '');
    return d === ${JSON.stringify(host)} || d.endsWith('.' + ${JSON.stringify(host)});
  }).length;
`);

/** Cerez birakan tum kayit edilebilir host'lar. */
export const cookieHosts = (run) => run(`
  const all = await chrome.cookies.getAll({});
  return [...new Set(all.map(c => c.domain.replace(/^\\./, '')))].sort();
`);

/** Bir host icin TEST cerezi olusturur - gercek siteye bagimli olmayan senaryolar icin. */
export const setTestCookie = (run, host, name = 'gt_probe', extra = '') => run(`
  await chrome.cookies.set({
    url: 'https://${host}/', name: ${JSON.stringify(name)}, value: '1',
    domain: ${JSON.stringify(host)}, path: '/', expirationDate: Math.floor(Date.now()/1000) + 3600
    ${extra ? ',' + extra : ''}
  });
  return true;
`);

/** Tum kurallari ve TUM cerezleri sifirlar - senaryolar birbirine sizmasin. */
export async function resetAll(msg, run) {
  await msg({ action: 'RESET_RULES' });
  await run(`
    const all = await chrome.cookies.getAll({});
    for (const c of all) {
      const host = c.domain.replace(/^\\./, '');
      const url = (c.secure ? 'https://' : 'http://') + host + c.path;
      try { await chrome.cookies.remove({ url, name: c.name, partitionKey: c.partitionKey }); } catch {}
    }
    await chrome.storage.session.remove('gt_thirdParty');
    return true;
  `);
}

/** Ayarlari topluca yazar ve service worker'a yeniden degerlendirtir. */
export async function applySettings(msg, run, patch) {
  await run(`await chrome.storage.local.set(${JSON.stringify(patch)}); return true;`);
  await msg({ action: 'SETTINGS_CHANGED' });
}

/** Kayitli alarm adlari. */
export const alarmNames = (run) =>
  run(`const a = await chrome.alarms.getAll(); return a.map(x => x.name).sort();`);
