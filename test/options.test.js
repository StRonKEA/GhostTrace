// GhostTrace - Ayarlar paneli davranis testleri
//
// NEDEN VAR: options/options.js 1780 satirdi ve HIC davranis testi yoktu.
// Bütünlük testleri DOM kimliklerini ve ceviri anahtarlarini kontrol ediyordu
// ama bir dinleyicinin baglanmadigini hicbiri yakalamiyordu - yani panel
// sessizce bozulabilir ve testler yesil kalirdi. Modullere bolmeden ONCE bu
// ag kuruldu.
//
// DOM taklidi gercek options.html'den kuruluyor (bkz. helpers/dom-stub.js):
// HTML'de olmayan bir id'yi arayan kod testte de bulamaz.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { installChromeStub } from './helpers/chrome-stub.js';
import { installDom } from './helpers/dom-stub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let dom;

before(async () => {
  installChromeStub({ tabs: [] });
  await chrome.storage.local.set({ rules: {}, logLevel: 'off' });
  dom = installDom(join(ROOT, 'options', 'options.html'));

  // Panel yuklenirken chrome.runtime.getManifest cagiriyor
  chrome.runtime.getManifest = () => ({ version: '2.5.0' });

  await import('../options/options.js');
  // init() asenkron; mikro gorevlerin bitmesini bekle
  await new Promise(resolve => setTimeout(resolve, 60));
});

describe('DOM taklidi gercek HTML ile uyusuyor', () => {
  test('options.html ayristirildi ve id haritasi doldu', () => {
    assert.ok(dom.ids.size > 40, `beklenenden az id: ${dom.ids.size}`);
  });

  test('sekme dugmeleri ve panelleri bulunuyor', () => {
    const navItems = dom.document.querySelectorAll('.nav-item');
    const panels = dom.document.querySelectorAll('.tab-panel');
    assert.ok(navItems.length >= 4, `sekme dugmesi bulunamadi: ${navItems.length}`);
    assert.ok(panels.length >= 4, `sekme paneli bulunamadi: ${panels.length}`);
  });

  test('torun selektoru calisiyor', () => {
    // Kod bunu fiilen kullaniyor: '#logs-tab [data-log-filter]'
    const filters = dom.document.querySelectorAll('#logs-tab [data-log-filter]');
    assert.ok(filters.length > 0, 'log filtre dugmeleri bulunamadi');
    for (const f of filters) {
      assert.ok(f.hasAttribute('data-log-filter'));
    }
  });
});

describe('panel yuklendiginde dinleyiciler BAGLANIYOR', () => {
  // Bu testlerin amaci tek: bolme sonrasi bir dinleyicinin sessizce
  // baglanmamasini yakalamak.
  const EXPECTED = [
    ['formAddRule', 'submit'],
    ['inputDomain', 'input'],
    ['inputSearchRule', 'input'],
    ['btnExportRules', 'click'],
    ['btnResetStats', 'click'],
    ['btnClearLogs', 'click'],
    ['btnRefreshLogs', 'click'],
    ['selectTheme', 'change'],
    ['selectLogLevel', 'change']
  ];

  for (const [id, event] of EXPECTED) {
    test(`${id} -> ${event} dinleyicisi var`, () => {
      const node = dom.byId(id);
      assert.ok(node, `${id} options.html icinde yok`);
      assert.ok(node._listenerCount(event) > 0,
        `${id} uzerinde ${event} dinleyicisi baglanmamis`);
    });
  }

  test('sekme dugmelerinin hepsine click baglanmis', () => {
    const navItems = dom.document.querySelectorAll('.nav-item');
    for (const item of navItems) {
      assert.ok(item._listenerCount('click') > 0,
        `sekme dugmesi baglanmamis: ${item.dataset.tab}`);
    }
  });
});

describe('sekme degistirme calisiyor', () => {
  test('bir sekmeye tiklamak aktif sinifini tasir', async () => {
    const items = dom.document.querySelectorAll('.nav-item');
    const target = items.find(i => !i.classList.contains('active')) || items[1];
    assert.ok(target, 'hedef sekme bulunamadi');

    await target._fire('click');

    assert.ok(target.classList.contains('active'),
      'tiklanan sekme aktif olmali');
    const actives = items.filter(i => i.classList.contains('active'));
    assert.equal(actives.length, 1, 'yalnizca tek sekme aktif kalmali');
  });
});

describe('kural ekleme service worker uzerinden gidiyor', () => {
  test('form gonderimi SET_RULE mesaji atar, dogrudan yazmaz', async () => {
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      return { success: true, rule: { domain: 'ornek.com', type: 'white' } };
    };

    try {
      dom.byId('inputDomain').value = 'ornek.com';
      await dom.byId('formAddRule')._fire('submit');
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const setRule = sent.find(m => m?.action === 'SET_RULE');
    assert.ok(setRule, 'SET_RULE mesaji gonderilmeli');
    assert.equal(setRule.domain, 'ornek.com');
    // Mutasyon TEK KAPI: sayfa dogrudan storage'a kural yazmamali
    const stored = await chrome.storage.local.get('rules');
    assert.deepEqual(stored.rules ?? {}, {},
      'sayfa kurallari dogrudan yazmamali; service worker yazar');
  });

  test('bos alan adi mesaj GONDERMEZ', async () => {
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { success: true }; };
    try {
      dom.byId('inputDomain').value = '   ';
      await dom.byId('formAddRule')._fire('submit');
    } finally {
      chrome.runtime.sendMessage = original;
    }
    assert.equal(sent.filter(m => m?.action === 'SET_RULE').length, 0,
      'gecersiz girdi icin arka plana mesaj atilmamali');
  });
});

describe('ice aktarma: kapsam sinyali ACIK olmali (v2.7.0)', () => {
  // Kapsam kilidi kalkmadan once normalizeRule alt alan adlarini kosulsuz
  // exact'a cekiyordu, yani ice aktarmanin ne gonderdigi onemsizdi. Kilit
  // kalkinca onem kazandi: Cookie AutoDelete'in duz "mail.google.com" girdisi
  // o adresi KASTEDER, alt dallarini degil. Yanlis eslemek, kullanicinin hic
  // istemedigi veriyi tarayicida BIRAKIR.

  let extractImportableRules;
  const load = async () => {
    ({ extractImportableRules } = await import('../options/tabs/rules.js'));
  };

  test('CAD duz ALT ALAN ADI girdisi kapsam ACMAZ', async () => {
    await load();
    const [rule] = extractImportableRules({ expressionList: ['mail.google.com'] });
    assert.equal(rule.domain, 'mail.google.com');
    assert.equal(rule.subdomains, false,
      'joker olmayan alt alan adi girdisi yalnizca kendisini kapsamali');
  });

  test('CAD joker girdisi kapsam ACAR', async () => {
    await load();
    const [rule] = extractImportableRules({ expressionList: ['*.mail.google.com'] });
    assert.equal(rule.domain, 'mail.google.com');
    assert.equal(rule.subdomains, true);
  });

  test('CAD duz KOK girdisinde davranis DEGISMEDI', async () => {
    await load();
    const [rule] = extractImportableRules({ expressionList: ['google.com'] });
    assert.equal(rule.subdomains, true, 'kok alan adinda varsayilan kapsam acik kalmali');
  });

  test('acik subdomains alani her zaman kazanir', async () => {
    await load();
    const [acik] = extractImportableRules({
      expressionList: [{ expression: 'mail.google.com', subdomains: true }]
    });
    assert.equal(acik.subdomains, true);

    const [kapali] = extractImportableRules({
      expressionList: [{ expression: 'google.com', subdomains: false }]
    });
    assert.equal(kapali.subdomains, false);
  });
});

describe('kural modali alt alan adi kapsamini KORUR (v2.7.0)', () => {
  // Modal ucuncu arayuz yuzeyi. Kapsam kutusunu alt alan adinda kilitliyor VE
  // her acilista isaretsiz gosteriyordu; kaydet'e basmak subdomains:true olan
  // bir kurali sessizce false'a dusururdu - kullanicinin korumak istedigi alt
  // dallarin verisi ilk temizlikte ucardi.

  async function openModalFor(domain, storedRule) {
    await chrome.storage.local.set({ rules: { [domain]: storedRule } });
    const { openSiteModal } = await import('../options/tabs/cookie-modal.js');

    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) =>
      msg?.action === 'GET_DOMAIN_COOKIES' ? { success: true, cookies: [] } : { success: true };
    try {
      await openSiteModal(domain);
    } finally {
      chrome.runtime.sendMessage = original;
    }
  }

  async function saveModal() {
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { success: true }; };
    try {
      await dom.byId('btnModalSave')._fire('click');
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return sent.find(m => m?.action === 'SET_RULE');
  }

  test('subdomains:true olan alt alan adi kurali ISARETLI acilir', async () => {
    await openModalFor('mail.google.com', {
      domain: 'mail.google.com', type: 'white', subdomains: true, keepMode: 'all', keepCookies: []
    });
    assert.equal(dom.byId('modalCheckSubdomains').checked, true,
      'kayitli kapsam modalda gorunmeli');
  });

  test('kutu alt alan adinda KILITLI DEGIL', async () => {
    await openModalFor('mail.google.com', {
      domain: 'mail.google.com', type: 'white', subdomains: false, keepMode: 'all', keepCookies: []
    });
    assert.equal(dom.byId('modalCheckSubdomains').disabled, false);
  });

  test('dokunulmadan kaydedilen kural kapsamini KAYBETMEZ', async () => {
    await openModalFor('mail.google.com', {
      domain: 'mail.google.com', type: 'white', subdomains: true, keepMode: 'all', keepCookies: []
    });
    const msg = await saveModal();
    assert.ok(msg, 'SET_RULE gonderilmeli');
    assert.equal(msg.options.subdomains, true,
      'kullanici dokunmadan kaydettiyse kapsam korunmali');
  });

  test('kutu elle kapatilirsa subdomains:false gider', async () => {
    await openModalFor('mail.google.com', {
      domain: 'mail.google.com', type: 'white', subdomains: true, keepMode: 'all', keepCookies: []
    });
    dom.byId('modalCheckSubdomains').checked = false;
    const msg = await saveModal();
    assert.equal(msg.options.subdomains, false);
  });

  test('kok alan adinda davranis DEGISMEDI', async () => {
    await openModalFor('google.com', {
      domain: 'google.com', type: 'white', subdomains: true, keepMode: 'all', keepCookies: []
    });
    assert.equal(dom.byId('modalCheckSubdomains').checked, true);
    const msg = await saveModal();
    assert.equal(msg.options.subdomains, true);
  });
});

describe('kapsam kutusu alt alan adinda SECILEBILIR (v2.7.0)', () => {
  // Onceki surumde kutu alt alan adi girilince disabled ediliyor ve checked
  // false'a zorlaniyordu; yani "alt dallarimi da koru" demenin yolu yoktu.
  // Kapsam kararinin KENDISI degismedi - yalnizca opt-in edilebilir oldu.

  async function typeDomain(value) {
    dom.byId('inputDomain').value = value;
    await dom.byId('inputDomain')._fire('input');
  }

  async function submitAndCapture() {
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { success: true }; };
    try {
      await dom.byId('formAddRule')._fire('submit');
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return sent.find(m => m?.action === 'SET_RULE');
  }

  test('alt alan adi yazildiginda kutu KILITLENMEZ', async () => {
    await typeDomain('mail.google.com');
    assert.equal(dom.byId('checkSubdomains').disabled, false,
      'alt alan adinda kapsam kutusu secilebilir olmali');
  });

  test('alt alan adi yazildiginda kutu VARSAYILAN olarak isaretsiz gelir', async () => {
    dom.byId('checkSubdomains').checked = false;
    await typeDomain('mail.google.com');
    assert.equal(dom.byId('checkSubdomains').checked, false,
      'kapsam alt alan adinda opt-in olmali');
  });

  test('kutu isaretliyken subdomains:true gonderilir', async () => {
    await typeDomain('mail.google.com');
    dom.byId('checkSubdomains').checked = true;
    const msg = await submitAndCapture();
    assert.ok(msg, 'SET_RULE gonderilmeli');
    assert.equal(msg.domain, 'mail.google.com');
    assert.equal(msg.options.subdomains, true,
      'isaretli kutu arka plana true olarak gitmeli');
  });

  test('kutu isaretsizken subdomains:false gonderilir', async () => {
    await typeDomain('mail.google.com');
    dom.byId('checkSubdomains').checked = false;
    const msg = await submitAndCapture();
    assert.equal(msg.options.subdomains, false);
  });

  test('kok alan adinda davranis DEGISMEDI', async () => {
    await typeDomain('google.com');
    assert.equal(dom.byId('checkSubdomains').disabled, false);
    dom.byId('checkSubdomains').checked = true;
    const msg = await submitAndCapture();
    assert.equal(msg.options.subdomains, true);
  });
});

describe('gecici izin suresi: dokunulmayan ayar DEGISMEZ', () => {
  // BULGU: Acilir listede yalnizca 15/60/1440 var. Ice aktarma ile gelen
  // 30 dakikalik bir kuralda liste "1 Saat" gosteriyor; kullanici listeye
  // DOKUNMADAN kaydederse sure 30'dan 60'a cikiyor ve bitis zamani da
  // yenileniyor. Hata yonu YANLIS: veri kullanicinin istediginden UZUN
  // tutuluyor - bir gizlilik eklentisi icin kabul edilemez yon.
  //
  // normalizeRule sureyi 15/60/1440'a kisitlamiyor (lib/rules.js:61) ve
  // IMPORT_RULES dogrudan normalizeRule cagiriyor, yani bu yol ulasilabilir.

  test('standart olmayan sure, liste dokunulmadiginda korunur', async () => {
    const { openSiteModal } = await import('../options/tabs/cookie-modal.js');

    const expiresAt = Date.now() + 30 * 60_000;
    await chrome.storage.local.set({
      rules: {
        'ornek.com': {
          domain: 'ornek.com', type: 'temp',
          durationMinutes: 30, expiresAt, subdomains: false
        }
      }
    });

    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      if (msg.action === 'GET_DOMAIN_COOKIES') return { success: true, cookies: [] };
      return { success: true, rule: { domain: 'ornek.com', type: 'temp' } };
    };

    try {
      await openSiteModal('ornek.com');
      await new Promise(r => setTimeout(r, 40));

      // Kullanici listeye DOKUNMUYOR; kaydet'e basiyor.
      await dom.byId('btnModalSave')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const setRule = sent.filter(m => m?.action === 'SET_RULE').pop();
    assert.ok(setRule, `SET_RULE gonderilmeli; gonderilenler: ${sent.map(m => m.action).join(', ')}`);
    assert.equal(setRule.options.durationMinutes, 30,
      'dokunulmayan sure 30 kalmali, 60 olmamali');
    assert.equal(setRule.options.expiresAt, expiresAt,
      'bitis zamani yenilenmemeli - kullanici sureyi uzatmadi');
  });

  test('kullanici listeyi DEGISTIRIRSE yeni sure uygulanir', async () => {
    const { openSiteModal } = await import('../options/tabs/cookie-modal.js');

    await chrome.storage.local.set({
      rules: {
        'ornek.com': {
          domain: 'ornek.com', type: 'temp',
          durationMinutes: 30, expiresAt: Date.now() + 30 * 60_000, subdomains: false
        }
      }
    });

    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      if (msg.action === 'GET_DOMAIN_COOKIES') return { success: true, cookies: [] };
      return { success: true, rule: { domain: 'ornek.com', type: 'temp' } };
    };

    try {
      await openSiteModal('ornek.com');
      await new Promise(r => setTimeout(r, 40));

      // Kullanici bilincli olarak 15 dakikaya cekiyor
      dom.byId('modalSelectRuleType').value = 'temp_15';
      await dom.byId('btnModalSave')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const setRule = sent.filter(m => m?.action === 'SET_RULE').pop();
    assert.ok(setRule, 'SET_RULE gonderilmeli');
    assert.equal(setRule.options.durationMinutes, 15,
      'kullanici degistirdiyse yeni sure uygulanmali');
  });
});

describe('site verileri sekmesi: listeleme, filtre, secim', () => {
  // Olculen kapsam: options/tabs/site-data.js %29 satir, %16 fonksiyon.
  // Bu sekme kullanicinin "hangi sitede ne kadar iz var" gordugu yer ve
  // toplu temizligi buradan tetikliyor. Cizim hata verirse tablo bos kalir
  // ve hicbir sey patlamaz - sessiz bozukluk.

  const SITES = [
    {
      domain: 'dogrudan.com', category: 'direct', ruleType: 'default',
      cookieCount: 3, historyCount: 12, downloadCount: 0, requestCount: 0
    },
    {
      domain: 'beyaz.com', category: 'direct', ruleType: 'white',
      cookieCount: 5, historyCount: 2, downloadCount: 1, requestCount: 0
    },
    {
      domain: 'cdn.ucuncu.com', category: 'third_party', ruleType: 'default',
      cookieCount: 0, historyCount: 0, downloadCount: 0, requestCount: 7,
      parentSites: ['dogrudan.com']
    }
  ];

  async function loadSites(list = SITES, truncated = false) {
    const mod = await import('../options/tabs/site-data.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, domains: list, truncated };
      }
      return { success: true };
    };
    try {
      await mod.loadSiteData();
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return mod;
  }

  test('tablo her site icin bir satir cizer', async () => {
    await loadSites();
    const body = dom.byId('siteDataTableBody');
    assert.ok(body, 'tablo govdesi options.html icinde olmali');
    assert.equal(body.children.length, SITES.length,
      `${SITES.length} satir beklenir, gelen ${body.children.length}`);
  });

  test('3. taraf satiri kaynak sitesini gosterir', async () => {
    await loadSites();
    const body = dom.byId('siteDataTableBody');
    const text = body.textContent;
    assert.ok(text.includes('cdn.ucuncu.com'), '3. taraf listelenmeli');
    assert.ok(text.includes('dogrudan.com'),
      'kaynak site bilgisi gosterilmeli (kullanici nereden geldigini bilmeli)');
  });

  test('filtre yalnizca eslesen satirlari birakir', async () => {
    const mod = await loadSites();
    mod.siteState.filter = 'third_party';
    mod.renderSiteData();
    const body = dom.byId('siteDataTableBody');
    assert.equal(body.children.length, 1, 'yalnizca 3. taraf kalmali');
    assert.ok(body.textContent.includes('cdn.ucuncu.com'));
  });

  test('arama alan adina gore suzer', async () => {
    const mod = await loadSites();
    mod.siteState.filter = 'all';
    mod.siteState.query = 'beyaz';
    mod.renderSiteData();
    const body = dom.byId('siteDataTableBody');
    assert.equal(body.children.length, 1);
    assert.ok(body.textContent.includes('beyaz.com'));
  });

  test('bos liste "kayit yok" durumunu gosterir, cokmez', async () => {
    const mod = await loadSites([]);
    mod.siteState.query = '';
    mod.siteState.filter = 'all';
    assert.doesNotThrow(() => mod.renderSiteData());
  });

  test('kirpilmis liste uyarisi gorunur olur', async () => {
    await loadSites(SITES, true);
    const note = dom.byId('siteDataTruncatedNote');
    assert.ok(note, 'kirpma notu HTML icinde olmali');
    assert.ok(!note.classList.contains('hidden'),
      'liste kirpildiysa kullaniciya soylenmeli - sessiz kirpma yapmiyoruz');
  });

  test('liste yuklenmemisken cizim SESSIZCE gecer', async () => {
    // Bu kontrol bilincli olarak verinin SAHIBINDE: eskiden ayarlar modulu
    // siteState.list.length > 0 diye baska modulun ic durumuna uzaniyordu.
    const mod = await import('../options/tabs/site-data.js');
    mod.siteState.list = [];
    assert.doesNotThrow(() => mod.renderSiteData());
  });
});

describe('loglar sekmesi', () => {
  // Olculen kapsam: %36 satir, %7 fonksiyon.
  const LOGS = [
    { ts: Date.now(), level: 'SUCCESS', category: 'PURGE', message: '3 cerez silindi', domain: 'a.com' },
    { ts: Date.now(), level: 'WARN', category: 'COOKIE', message: '1 cerez silinemedi', domain: 'b.com' },
    { ts: Date.now(), level: 'ERROR', category: 'SYSTEM', message: 'Site erisimi kisitli', domain: 'c.com' }
  ];

  async function loadLogsWith(list = LOGS) {
    const mod = await import('../options/tabs/logs.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg.action === 'GET_LOGS') return { success: true, logs: list };
      if (msg.action === 'GET_DIAGNOSTICS') {
        return {
          success: true, version: '2.5.0', settings: {}, ruleCount: 0, stats: {},
          alarms: [], hardening: { available: false }, thirdPartyCount: 0,
          trackedTabs: 0, storageEstimateCount: 0, sessionBytes: 1024,
          historyRemovalPermitted: true
        };
      }
      return { success: true };
    };
    try {
      await mod.loadLogs();
      await mod.loadDiagnostics();
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return mod;
  }

  test('her log kaydi icin bir satir cizilir', async () => {
    await loadLogsWith();
    const logBody = dom.byId('logsTableBody');
    assert.ok(logBody, 'log konsolu HTML icinde olmali');
    assert.ok(logBody.textContent.includes('3 cerez silindi'));
    assert.ok(logBody.textContent.includes('Site erisimi kisitli'));
  });

  test('teshis tablosu doldurulur', async () => {
    await loadLogsWith();
    const diag = dom.byId('diagnosticsList');
    assert.ok(diag, 'teshis listesi HTML icinde olmali');
    assert.ok(diag.children.length > 0, 'teshis satirlari cizilmeli');
  });

  test('bos log listesi cokmez', async () => {
    await assert.doesNotReject(() => loadLogsWith([]));
  });
});

describe('ayarlar sekmesi', () => {
  // Olculen kapsam: %62 satir, %18 fonksiyon.
  test('ayarlar depodan okunup arayuze yazilir', async () => {
    const mod = await import('../options/tabs/settings.js');
    await chrome.storage.local.set({ cleanDelay: 120, showBadgeCount: false, trackThirdParty: true });
    await mod.loadSettings();
    await new Promise(r => setTimeout(r, 30));

    const badge = dom.byId('settingShowBadgeCount');
    assert.ok(badge, 'rozet ayari HTML icinde olmali');
    assert.equal(badge.checked, false, 'kapali ayar arayuzde kapali gorunmeli');
  });

  test('kaydetme ayarlari DEPOYA yazar ve arka plana bildirir', async () => {
    const mod = await import('../options/tabs/settings.js');
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { success: true }; };
    try {
      dom.byId('settingShowBadgeCount').checked = true;
      await mod.saveSettings({});
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const stored = await chrome.storage.local.get('showBadgeCount');
    assert.equal(stored.showBadgeCount, true, 'ayar depoya yazilmali');
    assert.ok(sent.some(m => m?.action === 'SETTINGS_CHANGED'),
      'arka plan haberdar edilmeli; yoksa alarmlar/kayit eskimis kalir');
  });
});

describe('onay modali: yikici islem onaysiz calismaz', () => {
  // Olculen kapsam: options/ui/toast.js fonksiyon %33. Onay akisi TEK yerde
  // olmasinin sebebi tam bu: eskiden her yikici islem kendi onay kodunu
  // tasiyordu ve biri unutulursa o islem onaysiz calisiyordu.

  test('acilan modal metinleri yazar ve gorunur olur', async () => {
    const toast = await import('../options/ui/toast.js');
    let calisti = false;
    toast.openConfirm({
      titleKey: 'options.modalResetStatsTitle',
      descKey: 'options.modalResetStatsDesc',
      confirmKey: 'options.modalResetStatsConfirm',
      onConfirm: () => { calisti = true; }
    });

    const root = dom.byId('customModal');
    assert.ok(root, 'onay modali HTML icinde olmali');
    assert.ok(!root.classList.contains('hidden'), 'modal gorunur olmali');
    assert.ok(dom.byId('modalTitle').textContent.length > 0, 'baslik yazilmali');
    assert.ok(dom.byId('modalDescription').textContent.length > 0, 'aciklama yazilmali');
    assert.equal(calisti, false, 'ONAYLANMADAN islem calismamali');
  });

  test('onaya basmak islemi calistirir ve modali kapatir', async () => {
    const toast = await import('../options/ui/toast.js');
    let calisti = false;
    toast.openConfirm({
      titleKey: 'options.modalResetStatsTitle',
      descKey: 'options.modalResetStatsDesc',
      onConfirm: async () => { calisti = true; }
    });

    await dom.byId('modalBtnConfirm')._fire('click');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(calisti, true, 'onaydan sonra islem calismali');
    assert.ok(dom.byId('customModal').classList.contains('hidden'), 'modal kapanmali');
  });

  test('iptal islemi CALISTIRMAZ', async () => {
    const toast = await import('../options/ui/toast.js');
    let calisti = false;
    toast.openConfirm({
      titleKey: 'options.modalResetStatsTitle',
      descKey: 'options.modalResetStatsDesc',
      onConfirm: () => { calisti = true; }
    });

    await dom.byId('modalBtnCancel')._fire('click');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(calisti, false, 'iptal edilen islem ASLA calismamali');
    assert.ok(dom.byId('customModal').classList.contains('hidden'));
  });

  test('kapatildiktan sonra onay dugmesi eski islemi TEKRAR calistirmaz', async () => {
    // callback kapatmada temizlenmezse, sonraki onay yanlis islemi calistirir.
    const toast = await import('../options/ui/toast.js');
    let sayac = 0;
    toast.openConfirm({
      titleKey: 'options.modalResetStatsTitle',
      descKey: 'options.modalResetStatsDesc',
      onConfirm: () => { sayac++; }
    });
    await dom.byId('modalBtnConfirm')._fire('click');
    await new Promise(r => setTimeout(r, 20));

    // Modal kapali; dugmeye tekrar basmak bir sey yapmamali
    await dom.byId('modalBtnConfirm')._fire('click');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(sayac, 1, 'islem yalnizca bir kez calismali');
  });

  test('bildirim seridi mesaji gosterir', async () => {
    const toast = await import('../options/ui/toast.js');
    toast.showToast('deneme mesaji');
    const node = dom.byId('optionsToast');
    assert.ok(node, 'bildirim seridi HTML icinde olmali');
    assert.ok(node.textContent.includes('deneme mesaji'));
  });
});

describe('istatistikler sekmesi', () => {
  test('degerler arayuze yazilir', async () => {
    const mod = await import('../options/tabs/stats.js');
    await chrome.storage.local.set({
      stats: {
        cookiesDeleted: 42, historyDeleted: 7, storageCleared: 3,
        downloadsCleared: 1, bytesFreed: 2048, totalCleans: 5,
        lastCleanedAt: Date.now() - 3600_000, storageBytesFreed: 0
      }
    });
    await mod.renderStats();
    await new Promise(r => setTimeout(r, 20));

    const cookies = dom.byId('statCookies');
    assert.ok(cookies, 'cerez sayaci HTML icinde olmali');
    assert.ok(cookies.textContent.includes('42'), `42 yazilmali, gelen: ${cookies.textContent}`);
  });

  test('sifirlama ONAY ister, onaysiz silmez', async () => {
    const mod = await import('../options/tabs/stats.js');
    await chrome.storage.local.set({ stats: { cookiesDeleted: 99, totalCleans: 1 } });

    await dom.byId('btnResetStats')._fire('click');
    await new Promise(r => setTimeout(r, 20));

    // Onay modali acilmali, istatistik HENUZ silinmemeli
    assert.ok(!dom.byId('customModal').classList.contains('hidden'),
      'yikici islem once onay istemeli');
    const stored = await chrome.storage.local.get('stats');
    assert.equal(stored.stats.cookiesDeleted, 99, 'onaydan once silinmemeli');

    await dom.byId('modalBtnConfirm')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    const after = await chrome.storage.local.get('stats');
    assert.equal(after.stats.cookiesDeleted, 0, 'onaydan sonra sifirlanmali');
    assert.ok(mod, 'modul yuklendi');
  });
});

describe('kurallar sekmesi: listeleme ve silme', () => {
  // Olculen kapsam: options/tabs/rules.js fonksiyon %48.
  async function renderWith(rules) {
    const mod = await import('../options/tabs/rules.js');
    await chrome.storage.local.set({ rules });
    await mod.renderRules();
    await new Promise(r => setTimeout(r, 30));
    return mod;
  }

  test('her kural icin bir satir cizilir', async () => {
    await renderWith({
      'beyaz.com': { domain: 'beyaz.com', type: 'white', addedAt: Date.now() },
      'gri.com': { domain: 'gri.com', type: 'grey', addedAt: Date.now() },
      'gecici.com': {
        domain: 'gecici.com', type: 'temp', durationMinutes: 60,
        expiresAt: Date.now() + 30 * 60_000, addedAt: Date.now()
      }
    });
    const body = dom.byId('rulesTableBody');
    assert.ok(body, 'kural tablosu HTML icinde olmali');
    assert.equal(body.children.length, 3, `3 satir beklenir, gelen ${body.children.length}`);
    const text = body.textContent;
    for (const d of ['beyaz.com', 'gri.com', 'gecici.com']) {
      assert.ok(text.includes(d), `${d} listelenmeli`);
    }
  });

  test('gecici izin satirinda KALAN SURE gosterilir', async () => {
    await renderWith({
      'gecici.com': {
        domain: 'gecici.com', type: 'temp', durationMinutes: 60,
        expiresAt: Date.now() + 45 * 60_000, addedAt: Date.now()
      }
    });
    const text = dom.byId('rulesTableBody').textContent;
    assert.ok(/4[0-9]/.test(text) || text.includes('45'),
      `kalan sure gorunmeli; satir metni: ${text.slice(0, 160)}`);
  });

  test('bos liste cokmez', async () => {
    await assert.doesNotReject(() => renderWith({}));
  });

  test('kural silme ONAY ister ve arka plana mesaj atar', async () => {
    await renderWith({ 'silinecek.com': { domain: 'silinecek.com', type: 'white', addedAt: Date.now() } });

    const body = dom.byId('rulesTableBody');
    const row = body.children[0];
    assert.ok(row, 'satir olmali');

    // Satirdaki silme dugmesini bul
    const buttons = row.querySelectorAll('button');
    assert.ok(buttons.length > 0, 'satirda dugme olmali');

    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      if (msg.action === 'GET_DOMAIN_COOKIES') return { success: true, cookies: [] };
      return { success: true };
    };
    try {
      // Son dugme silme (kaldir) olmali; hepsini deneyip onay modalini yakala
      for (const b of buttons) {
        await b._fire('click');
        await new Promise(r => setTimeout(r, 10));
        if (!dom.byId('customModal').classList.contains('hidden')) break;
      }
      assert.ok(!dom.byId('customModal').classList.contains('hidden'),
        'kural silme once onay istemeli');
      assert.equal(sent.filter(m => m?.action === 'DELETE_RULE').length, 0,
        'onaydan once silme mesaji GITMEMELI');

      await dom.byId('modalBtnConfirm')._fire('click');
      await new Promise(r => setTimeout(r, 40));

      assert.ok(sent.some(m => m?.action === 'DELETE_RULE'),
        'onaydan sonra DELETE_RULE gonderilmeli');
    } finally {
      chrome.runtime.sendMessage = original;
    }
  });
});

describe('ayarlar: yikici islemler ve sertlestirme', () => {
  // Olculen kapsam: options/tabs/settings.js fonksiyon %27. Bu bolumdeki
  // yikici islemler (ayar sifirla, kural sifirla, fabrika ayarlari) geri
  // alinamaz; onaysiz calisirlarsa kullanici verisini kaybeder.

  async function clickAndConfirm(buttonId, { confirm = true } = {}) {
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { success: true }; };
    try {
      await dom.byId(buttonId)._fire('click');
      await new Promise(r => setTimeout(r, 20));
      const opened = !dom.byId('customModal').classList.contains('hidden');
      if (confirm) {
        await dom.byId('modalBtnConfirm')._fire('click');
      } else {
        await dom.byId('modalBtnCancel')._fire('click');
      }
      await new Promise(r => setTimeout(r, 40));
      return { sent, opened };
    } finally {
      chrome.runtime.sendMessage = original;
    }
  }

  test('AYARLARI sifirla: onay ister, onaydan sonra varsayilana doner', async () => {
    await import('../options/tabs/settings.js');
    await chrome.storage.local.set({ cleanDelay: 300, showBadgeCount: false });

    const { sent, opened } = await clickAndConfirm('btnResetOnlySettings');
    assert.ok(opened, 'yikici islem once onay istemeli');

    const stored = await chrome.storage.local.get(['cleanDelay']);
    assert.notEqual(stored.cleanDelay, 300, 'ayar varsayilana donmeli');
    assert.ok(sent.some(m => m?.action === 'SETTINGS_CHANGED'),
      'arka plan haberdar edilmeli; yoksa alarmlar eskimis kalir');
  });

  test('AYARLARI sifirla: IPTAL edilirse hicbir sey degismez', async () => {
    await import('../options/tabs/settings.js');
    await chrome.storage.local.set({ cleanDelay: 300 });

    const { sent } = await clickAndConfirm('btnResetOnlySettings', { confirm: false });

    const stored = await chrome.storage.local.get('cleanDelay');
    assert.equal(stored.cleanDelay, 300, 'iptal edilen sifirlama uygulanmamali');
    assert.equal(sent.filter(m => m?.action === 'SETTINGS_CHANGED').length, 0,
      'iptalde arka plana mesaj gitmemeli');
  });

  test('KURALLARI sifirla: onaydan sonra RESET_RULES gonderilir', async () => {
    await import('../options/tabs/settings.js');
    const { sent, opened } = await clickAndConfirm('btnResetOnlyRules');
    assert.ok(opened, 'onay istenmeli');
    assert.ok(sent.some(m => m?.action === 'RESET_RULES'),
      'kural silme service worker uzerinden gitmeli (mutasyon tek kapi)');
  });

  test('FABRIKA ayarlari: kurallari VE ayarlari birlikte sifirlar', async () => {
    await import('../options/tabs/settings.js');
    await chrome.storage.local.set({ cleanDelay: 300 });

    const { sent, opened } = await clickAndConfirm('btnFactoryReset');
    assert.ok(opened, 'en yikici islem kesinlikle onay istemeli');
    assert.ok(sent.some(m => m?.action === 'RESET_RULES'), 'kurallar sifirlanmali');
    assert.ok(sent.some(m => m?.action === 'SETTINGS_CHANGED'), 'arka plan bilgilendirilmeli');

    const stored = await chrome.storage.local.get('cleanDelay');
    assert.notEqual(stored.cleanDelay, 300, 'ayarlar da varsayilana donmeli');
  });

  test('SAG TIK menusu: izin verilmezse ayar GERI ALINIR', async () => {
    // Kritik: izin reddedildiginde onay isareti acik kalirsa kullanici menunun
    // acik oldugunu sanir ama menu hic kurulmaz - sessiz yanlislik.
    await import('../options/tabs/settings.js');
    const box = dom.byId('settingContextMenuEnabled');
    assert.ok(box, 'sag tik ayari HTML icinde olmali');

    const originalRequest = chrome.permissions.request;
    chrome.permissions.request = async () => false;   // kullanici REDDEDIYOR
    try {
      box.checked = true;
      await box._fire('change');
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.permissions.request = originalRequest;
    }

    assert.equal(box.checked, false,
      'izin verilmediyse onay isareti geri alinmali');
    const stored = await chrome.storage.local.get('contextMenuEnabled');
    assert.notEqual(stored.contextMenuEnabled, true,
      'izin yoksa ayar acik olarak KAYDEDILMEMELI');
  });

  test('SAG TIK menusu: izin verilirse ayar kaydedilir', async () => {
    await import('../options/tabs/settings.js');
    const box = dom.byId('settingContextMenuEnabled');

    const originalRequest = chrome.permissions.request;
    const originalSend = chrome.runtime.sendMessage;
    chrome.permissions.request = async () => true;
    chrome.runtime.sendMessage = async () => ({ success: true });
    try {
      box.checked = true;
      await box._fire('change');
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.permissions.request = originalRequest;
      chrome.runtime.sendMessage = originalSend;
    }

    const stored = await chrome.storage.local.get('contextMenuEnabled');
    assert.equal(stored.contextMenuEnabled, true, 'izin verildiyse ayar kaydedilmeli');
  });
});

describe('site verileri: BOS liste "taraniyor" durumunda kalmaz', () => {
  // BULGU (kendi geriletmem): Dongu kirarken siteState.list.length === 0
  // kontrolunu renderSiteData ICINE tasidim. Liste gercekten bos geldiginde
  // fonksiyon aninda donuyor ve tablo loadSiteData'nin yazdigi "Taraniyor..."
  // mesajinda takili kaliyor.
  //
  // Ayirt edilmesi gereken iki durum var:
  //   * HIC YUKLENMEDI -> cizme (ayarlar sekmesi dil degisiminde bunu cagirir)
  //   * YUKLENDI ve BOS -> bos durumu goster, taraniyor mesajini kaldir

  async function loadWith(domains) {
    const mod = await import('../options/tabs/site-data.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, domains, truncated: false };
      }
      return { success: true };
    };
    try {
      await mod.loadSiteData();
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return mod;
  }

  test('bos liste yuklenince "taraniyor" mesaji kalkar', async () => {
    await loadWith([]);
    const body = dom.byId('siteDataTableBody');
    assert.ok(!body.textContent.includes('Taranıyor'),
      `taraniyor mesaji kalmamali; tablo: ${body.textContent.slice(0, 80)}`);
  });

  test('bos liste yuklenince BOS DURUM gorunur olur', async () => {
    await loadWith([]);
    const empty = dom.byId('emptySiteDataState');
    assert.ok(empty, 'bos durum blogu HTML icinde olmali');
    assert.ok(!empty.classList.contains('hidden'),
      'yuklendi ve bos ise kullaniciya soylenmeli');
  });

  test('HIC yuklenmemisken cizim sessizce gecer', async () => {
    const mod = await import('../options/tabs/site-data.js');
    mod.siteState.list = [];
    mod.siteState.loaded = false;
    assert.doesNotThrow(() => mod.renderSiteData());
  });

  test('dolu liste yuklenince bos durum gizlenir', async () => {
    await loadWith([{
      domain: 'ornek.com', category: 'direct', ruleType: 'default',
      cookieCount: 1, historyCount: 0, downloadCount: 0, requestCount: 0
    }]);
    const empty = dom.byId('emptySiteDataState');
    assert.ok(empty.classList.contains('hidden'), 'kayit varken bos durum gizli olmali');
    assert.equal(dom.byId('siteDataTableBody').children.length, 1);
  });
});

describe('teshis: SILME IZNI hem gecmisi hem indirmeleri bildirir', () => {
  // BULGU: lib/sw/handlers.js downloadsRemovalPermitted degerini HESAPLIYOR ve
  // donduruyor (satir 131), ama arayuz yalnizca historyRemovalPermitted'i
  // okuyordu. Kurumsal politika INDIRME silmeyi engelliyorsa kullanici bunu
  // hicbir yerden ogrenemiyordu - oysa bu blogun tek isi "eklenti isini
  // yapabiliyor mu?" sorusunu yanitlamak.
  //
  // checkRemovalPolicy() loglarda ikisini de dogru soyluyor ("gecmis ve
  // indirmeler"); eksik olan YALNIZCA Sistem Durumu gosterimi.

  async function teshisMetni(over = {}) {
    const mod = await import('../options/tabs/logs.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg.action === 'GET_LOGS') return { success: true, logs: [] };
      if (msg.action === 'GET_DIAGNOSTICS') {
        return {
          success: true, version: '2.6.0', settings: {}, ruleCount: 0, stats: {},
          alarms: [], hardening: { available: false }, thirdPartyCount: 0,
          trackedTabs: 0, storageEstimateCount: 0, sessionBytes: 1024,
          historyRemovalPermitted: true, downloadsRemovalPermitted: true,
          ...over
        };
      }
      return { success: true };
    };
    try {
      await mod.loadDiagnostics();
      await new Promise(r => setTimeout(r, 20));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return dom.byId('diagnosticsList').textContent;
  }

  test('ikisi de serbestse serbest yazar', async () => {
    const metin = await teshisMetni();
    assert.match(metin, /Serbest/, 'her sey serbestken bunu soylemeli');
  });

  test('YALNIZCA indirme engelliyse arayuz bunu SOYLER', async () => {
    const metin = await teshisMetni({ downloadsRemovalPermitted: false });
    assert.match(metin, /ndirme/,
      'indirme silme engelliyse kullanici bunu gormeli; eskiden hic soylenmiyordu');
    assert.doesNotMatch(metin, /Serbest/,
      'bir tur engelliyken "Serbest" yazmak kullaniciyi yanlis bilgilendirir');
  });

  test('yalnizca gecmis engelliyse gecmisi soyler', async () => {
    const metin = await teshisMetni({ historyRemovalPermitted: false });
    assert.match(metin, /[Gg]ec?mis|[Gg]eçmiş/, 'gecmis engelini adiyla soylemeli');
    assert.doesNotMatch(metin, /Serbest/);
  });

  test('ikisi de engelliyse IKISINI de soyler', async () => {
    const metin = await teshisMetni({
      historyRemovalPermitted: false, downloadsRemovalPermitted: false
    });
    assert.match(metin, /ndirme/, 'indirme engeli gorunmeli');
    assert.match(metin, /[Gg]ec?mis|[Gg]eçmiş/, 'gecmis engeli gorunmeli');
  });

  test('politika okunamadiysa uydurmuyor', async () => {
    const metin = await teshisMetni({
      historyRemovalPermitted: null, downloadsRemovalPermitted: null
    });
    assert.doesNotMatch(metin, /Serbest/,
      'okunamayan politikayi serbest saymak yanlis guven verir');
  });
});

describe('teshis: oturum bellegi KOTAYA GORE gosterilir', () => {
  // BULGU: handlers.js icindeki kendi yorumu diyor ki "Oturum bellegi kotasi
  // sinirlidir ... kota dolmadan once gorunur olmasi gerekir". Ama arayuz ciplak
  // bir "8 KB" yaziyordu; kota referansi HICBIR yerde yoktu. Ciplak sayi
  // dolmaya yakin olup olmadigini soylemiyor, yani gosterilen ama ise
  // yaramayan veri sinifinda.
  //
  // Kota SABIT GOMULMEZ: chrome.storage.session.QUOTA_BYTES calisma aninda
  // okunur. Yoksa eski davranisa duseriz - tarayici surumune bagli kalmayan
  // tek dogru yol bu.

  async function teshisMetni(over = {}) {
    const mod = await import('../options/tabs/logs.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg.action === 'GET_LOGS') return { success: true, logs: [] };
      if (msg.action === 'GET_DIAGNOSTICS') {
        return {
          success: true, version: '2.6.0', settings: {}, ruleCount: 0, stats: {},
          alarms: [], hardening: { available: false }, thirdPartyCount: 0,
          trackedTabs: 0, storageEstimateCount: 0,
          sessionBytes: 2 * 1024 * 1024, sessionQuota: 10 * 1024 * 1024,
          historyRemovalPermitted: true, downloadsRemovalPermitted: true,
          ...over
        };
      }
      return { success: true };
    };
    try {
      await mod.loadDiagnostics();
      await new Promise(r => setTimeout(r, 20));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return dom.byId('diagnosticsList').textContent;
  }

  test('kota biliniyorsa kullanim kotayla BIRLIKTE gosterilir', async () => {
    const metin = await teshisMetni();
    assert.match(metin, /\//,
      'kullanim/kota ciftini gostermeli; ciplak sayi dolmaya yakinligi soylemiyor');
    assert.match(metin, /MB/, 'kota bicimlenmis olarak gorunmeli');
  });

  test('kota bilinmiyorsa eski davranisa duser, uydurmaz', async () => {
    const metin = await teshisMetni({ sessionQuota: null });
    assert.match(metin, /MB|KB|B/, 'kullanim yine gosterilmeli');
    assert.doesNotMatch(metin, /\/\s*(10|10,0)\s*MB/,
      'kota bilinmiyorken kota uydurulmamali');
  });

  test('kullanim olculemediyse kota da iddia edilmez', async () => {
    const metin = await teshisMetni({ sessionBytes: null });
    assert.match(metin, /Olculemedi|Ölçülemedi/,
      'olculemeyen degeri sayi gibi gostermemeli');
  });
});

describe('iframe izleme ayari arayuze BAGLI (v2.7.0)', () => {
  // Bir ayar icin HTML'e kutu eklemek yetmez; TOGGLE_SETTINGS eslemesi de
  // gerekir. Eslemeyi unutmak sessiz bir kayiptir: kutu gorunur, tiklanir,
  // hicbir sey kaydedilmez.

  test('kutu HTML de var ve esleme tanimli', async () => {
    const { TOGGLE_SETTINGS } = await import('../options/tabs/settings.js');
    assert.ok(dom.byId('settingTrackThirdPartyFrames'), 'kutu options.html de olmali');
    assert.equal(TOGGLE_SETTINGS.trackThirdPartyFrames, 'settingTrackThirdPartyFrames');
  });

  test('varsayilan ACIK yuklenir (v2.7.0)', async () => {
    const { loadSettings } = await import('../options/tabs/settings.js');
    await chrome.storage.local.remove('trackThirdPartyFrames');
    const storage = await import('../lib/storage.js');
    storage.__resetCacheForTests();

    await loadSettings();

    assert.equal(dom.byId('settingTrackThirdPartyFrames').checked, true,
      'ayar hic yazilmamisken kutu varsayilani yansitmali');
  });

  test('kutu isaretlenince ayar KAYDEDILIR', async () => {
    const { saveSettings } = await import('../options/tabs/settings.js');
    dom.byId('settingTrackThirdPartyFrames').checked = true;

    await saveSettings();

    const stored = await chrome.storage.local.get('trackThirdPartyFrames');
    assert.equal(stored.trackThirdPartyFrames, true);
  });
});

describe('iframe secenegi UST anahtara bagli (v2.7.0)', () => {
  // "3. taraf istek takibi" kapaliyken icerik script'i HIC kaydedilmiyor
  // (observer.js: wanted = enabled && trackThirdParty). Dolayisiyla iframe
  // secenegi o durumda hicbir sey yapmiyor. Tiklanabilir birakmak, bu projenin
  // tekrar tekrar temizledigi hata sinifi: bir sey yapiyormus gibi gorunen ayar.

  async function applySettings(patch) {
    const storage = await import('../lib/storage.js');
    await chrome.storage.local.set(patch);
    storage.__resetCacheForTests();
    const { loadSettings } = await import('../options/tabs/settings.js');
    await loadSettings();
  }

  test('ust anahtar ACIKKEN alt secenek secilebilir', async () => {
    await applySettings({ trackThirdParty: true });
    assert.equal(dom.byId('settingTrackThirdPartyFrames').disabled, false);
  });

  test('ust anahtar KAPALIYKEN alt secenek kilitlenir', async () => {
    await applySettings({ trackThirdParty: false });
    assert.equal(dom.byId('settingTrackThirdPartyFrames').disabled, true,
      'islevi olmayan bir kutu tiklanabilir gorunmemeli');
  });

  test('ust anahtar YERINDE kapatilinca alt secenek aninda kilitlenir', async () => {
    await applySettings({ trackThirdParty: true });
    assert.equal(dom.byId('settingTrackThirdPartyFrames').disabled, false);

    dom.byId('settingTrackThirdParty').checked = false;
    await dom.byId('settingTrackThirdParty')._fire('change');

    assert.equal(dom.byId('settingTrackThirdPartyFrames').disabled, true,
      'kaydetmeyi beklemeden, tiklandigi anda kilitlenmeli');
  });
});

describe('tema secimi arayuzden calisir (v2.7.0)', () => {
  test('depodaki tema secicide gorunur', async () => {
    const mod = await import('../options/tabs/settings.js');
    await chrome.storage.local.set({ theme: 'dark' });
    await mod.loadSettings();
    await new Promise(r => setTimeout(r, 30));

    assert.equal(dom.byId('selectTheme')?.value, 'dark',
      'kayitli tema secicide secili gelmeli');
  });

  test('secilen tema DEPOYA yazilir', async () => {
    const mod = await import('../options/tabs/settings.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async () => ({ success: true });
    try {
      dom.byId('selectTheme').value = 'light';
      await mod.saveSettings({});
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const stored = await chrome.storage.local.get('theme');
    assert.equal(stored.theme, 'light', 'tema secimi kaydedilmeli');
  });
});

describe('temizlik sonucu SESSIZ kalmaz (v2.7.0)', () => {
  // Kullanici "Tumunu Temizle" deyip "N cerez silindi" goruyordu; acik sekme
  // yuzunden atlananlar ve erisim kisiti yuzunden GORULEMEYENLER
  // soylenmiyordu - eksik temizligi tam basari sanmasi icin bicilmis kaftan.

  const toastMetni = () => dom.byId('optionsToast').textContent;

  async function toplulukTemizle(response) {
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) =>
      (msg?.action === 'PURGE_ALL_NON_WHITELIST' ? response : { success: true });
    try {
      await dom.byId('btnPurgeAllNonWhitelisted')._fire('click');
      await new Promise(r => setTimeout(r, 20));
      await dom.byId('modalBtnConfirm')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return toastMetni();
  }

  test('ACIK sekme yuzunden atlananlar bildirilir', async () => {
    const metin = await toplulukTemizle({
      success: true, cookies: 4, history: 2, bytes: 0, skippedOpen: 3
    });
    assert.match(metin, /3/, `atlanan sayisi gorunmeli; toast: ${metin}`);
    assert.match(metin, /açık|open/i, `neden atlandigi soylenmeli; toast: ${metin}`);
  });

  test('erisim kisitliysa sonucun EKSIK olabilecegi soylenir', async () => {
    const metin = await toplulukTemizle({
      success: true, cookies: 1, history: 0, bytes: 0, limitedAccess: true
    });
    assert.match(metin, /eksik|incomplete|erişim|access/i,
      `kisitli erisim bildirilmeli; toast: ${metin}`);
  });

  test('her sey temizlendiyse fazladan uyari YOK', async () => {
    const metin = await toplulukTemizle({ success: true, cookies: 2, history: 1, bytes: 0 });
    assert.doesNotMatch(metin, /atlandı|skipped|eksik|incomplete/i,
      `gereksiz uyari eklenmemeli; toast: ${metin}`);
  });
});

describe('erisim kisiti GENEL hata olarak gosterilmez (v2.7.0)', () => {
  // Popup bu ayrimi zaten yapiyordu; ayarlar sayfasi "temizleme hatasi" deyip
  // kullaniciyi gecici bir aksilik saniyordu. Oysa yapmasi gereken belli.
  test('NO_HOST_ACCESS icin site erisimi mesaji gosterilir', async () => {
    const siteData = await import('../options/tabs/site-data.js');
    assert.ok(typeof siteData === 'object');

    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.action === 'GET_ALL_STORED_DOMAINS') {
        return {
          success: true,
          domains: [{
            domain: 'ornek.com', category: 'direct', ruleType: 'default',
            cookieCount: 1, historyCount: 0, downloadCount: 0, requestCount: 0
          }]
        };
      }
      if (msg?.action === 'PURGE_DOMAIN') {
        return { success: false, error: 'NO_HOST_ACCESS', domain: 'ornek.com' };
      }
      return { success: true };
    };
    try {
      await siteData.loadSiteData();
      await new Promise(r => setTimeout(r, 40));

      const btn = dom.document.querySelector('.btn-purge-site');
      assert.ok(btn, 'temizle dugmesi olmali');
      await btn._fire('click');
      await new Promise(r => setTimeout(r, 20));
      await dom.byId('modalBtnConfirm')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const metin = dom.byId('optionsToast').textContent;
    assert.match(metin, /erişim|access/i,
      `erisim kisiti ayrica anlatilmali, genel hata degil; toast: ${metin}`);
  });
});

describe('tek kural silme: DOGRU onay metni (v2.7.0)', () => {
  // Onceden "Tum Site Kurallarini Sifirla" metni gosteriliyordu: kullaniciya
  // butun kurallarin silinecegini soyleyip asil geri alinamaz sonucu -
  // sitenin VERISININ de temizlenecegini - hic soylemiyordu.

  async function kuralCiz() {
    // rules.js kurallari MESAJLA degil dogrudan depodan okuyor.
    const mod = await import('../options/tabs/rules.js');
    await chrome.storage.local.set({
      rules: {
        'ornek.com': {
          domain: 'ornek.com', type: 'white', subdomains: false,
          createdAt: Date.now(), keepMode: 'all'
        }
      }
    });
    await mod.renderRules();
    await new Promise(r => setTimeout(r, 30));
  }

  test('onay penceresi ALAN ADINI ve veri temizligini soyler', async () => {
    await kuralCiz();
    const sil = dom.document.querySelector('.btn-delete-rule');
    assert.ok(sil, 'silme dugmesi cizilmeli');

    await sil._fire('click');
    await new Promise(r => setTimeout(r, 20));

    const baslik = dom.byId('modalTitle').textContent;
    const aciklama = dom.byId('modalDescription').textContent;

    assert.match(baslik + aciklama, /ornek\.com/,
      `hangi kuralin silindigi yazmali; baslik: "${baslik}"`);
    assert.doesNotMatch(baslik, /Tüm|All/,
      `TEK kural silinirken "tum kurallar" denmemeli; baslik: "${baslik}"`);
    assert.match(aciklama, /veri|data/i,
      `verinin de temizlenecegi soylenmeli; aciklama: "${aciklama}"`);

    await dom.byId('modalBtnCancel')._fire('click');
  });
});

describe('istatistik: son temizlikler ve en cok temizlenenler (v2.7.0)', () => {
  // KAYNAK: gunlukler. Yeni depolama yok - hangi siteleri gezdiginiz diske
  // yazilmaz. Bu testler o sozlesmeyi de koruyor.

  const LOGLAR = [
    { id: '1', level: 'SUCCESS', category: 'PURGE', domain: 'github.com', timestamp: 1787594486591,
      message: 'Temizlendi', details: { cookies: 7, history: 2, downloads: 0, remaining: 0 } },
    { id: '2', level: 'SUCCESS', category: 'COOKIE', domain: 'github.com', timestamp: 1787594486566,
      message: '7 cerez silindi', details: { count: 7, bytes: 957 } },
    { id: '3', level: 'SUCCESS', category: 'PURGE', domain: 'deepl.com', timestamp: 1787594481430,
      message: 'Temizlendi', details: { cookies: 13, history: 1, downloads: 0, remaining: 0 } },
    { id: '4', level: 'SUCCESS', category: 'PURGE', domain: 'github.com', timestamp: 1787594400000,
      message: 'Temizlendi', details: { cookies: 3, history: 0, downloads: 1, remaining: 0 } },
    { id: '5', level: 'INFO', category: 'PURGE', domain: 'github.com', timestamp: 1787594399000,
      message: 'Temizlik basliyor', details: { reason: 'manual' } },
    { id: '6', level: 'SUCCESS', category: 'PURGE', domain: null, timestamp: 1787594395183,
      message: 'Toplu temizlik tamam', details: { cookies: 5, history: 8, downloads: 0, skippedOpen: 0 } }
  ];

  // 3. taraf listesi artik KARSILASMA SAYIMINDAN besleniyor (thirdPartySeen),
  // canli kesif haritasindan degil.
  //
  // Sebep kullanici bulgusu: canli harita her temizlikte budaniyor, bu yuzden
  // "en cok karsilasilan 3. taraflar" listesi her temizlikten sonra
  // BOSALIYORDU. Sayim budanmaz; oturumluktur, diske yazilmaz.
  const UCUNCU = {
    'fonts.googleapis.com': { count: 13, sites: ['github.com', 'deepl.com', '1337x.to'] },
    'cloudflare.com': { count: 7, sites: ['github.com'] }
  };

  /**
   * Sekme secimi MODUL DURUMU: testler arasi sizar. Her test hangi sekmeyi
   * olctugunu ACIKCA soylemeli, yoksa onceki testin secimi sonucu belirler.
   *
   * Sekmeye tiklamak yeniden cizimi TETIKLER; bu yuzden secim, sahtelemenin
   * ICINDE yapilmali. Disarida yapilinca gercek sendMessage cagriliyor ve
   * tablo bos kaliyordu.
   */
  async function ciz(logs = LOGLAR, domains = UCUNCU, sekme = null, sifirla = true) {
    const mod = await import('../options/tabs/insights.js');
    // Modul durumu testler arasi sizar; her ciz() temiz baslar.
    // `sifirla: false` yalnizca ARDISIK cizimleri olcen testte kullanilir.
    if (sifirla) mod.__resetInsightsForTests();
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.action === 'GET_LOGS') return { success: true, logs };
      if (msg?.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, domains: [], thirdPartySeen: domains };
      }
      return { success: true };
    };
    try {
      if (sekme) {
        const dugme = [...dom.document.querySelectorAll('#topCleanedSection [data-insight]')]
          .find(d => d.getAttribute('data-insight') === sekme);
        assert.ok(dugme, `sekme dugmesi bulunamadi: ${sekme}`);
        await dugme._fire('click');
        await new Promise(r => setTimeout(r, 40));
      }
      await mod.renderInsights();
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }
  }

  test('yalnizca TAMAMLANMIS temizlik ozetleri listelenir', async () => {
    await ciz();
    const body = dom.byId('recentCleanupsBody');
    // 6 kayittan yalnizca 3'u site bazli tamamlanmis ozet (1, 3, 4).
    assert.equal(body.children.length, 3,
      `ara kayitlar ve toplu ozet listelenmemeli; satir: ${body.children.length}`);
  });

  test('TOPLU temizlik ozeti (alan adsiz) listeye GIRMEZ', async () => {
    await ciz();
    const metin = dom.byId('recentCleanupsBody').textContent;
    assert.ok(!metin.includes('Toplu'), 'toplu ozet site listesine karismamali');
  });

  test('silinen turlerden SIFIR olanlar yazilmaz', async () => {
    await ciz([LOGLAR[0]]);
    const satir = dom.byId('recentCleanupsBody').textContent;
    assert.match(satir, /7/, 'cerez sayisi gorunmeli');
    assert.match(satir, /2/, 'gecmis sayisi gorunmeli');
    assert.ok(!/0\s/.test(satir.replace(/\d{2}:\d{2}:\d{2}[,.]\d+/, '')),
      `sifir olan tur yazilmamali: "${satir}"`);
  });

  test('EN COK temizlenen site en ustte ve toplami dogru', async () => {
    await ciz(LOGLAR, UCUNCU, 'cleaned');
    const body = dom.byId('topCleanedBody');
    assert.ok(body.children.length >= 2, 'en az iki site olmali');
    const ilk = body.children[0].textContent;
    assert.match(ilk, /github\.com/, `github.com iki kez temizlendi, ust sirada olmali: "${ilk}"`);
    assert.match(ilk, /2/, 'temizlik adedi 2 olmali');
    assert.match(ilk, /10/, 'cerez toplami 7+3=10 olmali');
  });

  test('TEK site temizlendiyse bile bolum GOSTERILIR', async () => {
    // SOZLESME DEGISTI. Eskiden "tek satirlik siralama bilgi vermez" diye
    // bolum gizleniyordu; ayni gerekce "hepsi birer kez temizlendiyse gizle"
    // kuralini da doguruyordu. Sonuc: normal kullanimda sekme HEP BOSTU ve
    // bozuk gorunuyordu (kullanici bildirdi).
    //
    // Bir sitenin temizlendigi bilgisi tek basina da degerlidir; ustteki
    // "Son temizlikler" listesi olaylari, bu liste site basina TOPLAMI
    // gosteriyor - ayni sey degiller.
    await ciz([LOGLAR[0]], {}, 'cleaned');
    assert.ok(!dom.byId('topCleanedSection').classList.contains('hidden'),
      'tek site de olsa bolum gorunmeli');
    assert.ok(dom.byId('topCleanedBody').textContent.includes('github.com'),
      'temizlenen site listede olmali');
  });

  test('bir site 2+ kez temizlendiyse TOP bolumu GORUNUR', async () => {
    await ciz(LOGLAR, {}, 'cleaned');   // github 2 kez
    assert.ok(!dom.byId('topCleanedSection').classList.contains('hidden'),
      'gercek bir siralama varsa gosterilmeli');
  });

  test('VARSAYILAN sekme her zaman TEMIZLENEN SITELER', async () => {
    // KULLANICI: "Temizlenen siteler sekmesi ilk sirada ama 3. taraflar
    // sekmesi ilk aciliyor, sacma."
    //
    // Haklı: sekme sirasi bir vaattir. Otomatik gecis "acik sekme bossa dolu
    // olana atla" diye eklenmisti, ama bastirma kurali kalkinca temizlenen
    // listesi zaten normal kullanimda dolu geliyor - gecis artik yalnizca
    // sirayi bozuyor. Kaldirildi: ilk sekme HER ZAMAN acilir.
    const YALNIZ_UCUNCU = [
      { id: 'u', level: 'SUCCESS', category: 'PURGE', domain: 'fonts.googleapis.com',
        timestamp: 1, message: 'Temizlendi',
        details: { cookies: 1, history: 0, downloads: 0, remaining: 0 } }
    ];
    // Temizlenen listesi BOS, 3. taraf DOLU - eski kodun atlamasi icin
    // gereken tam kosul.
    await ciz(YALNIZ_UCUNCU, UCUNCU);

    const dugmeler = [...dom.document.querySelectorAll('#topCleanedSection [data-insight]')];
    const temizlenenDugme = dugmeler.find(d => d.getAttribute('data-insight') === 'cleaned');
    assert.ok(temizlenenDugme.classList.contains('active'),
      'ilk sekme (Temizlenen siteler) varsayilan olarak acik olmali');
  });

  test('Siralama satirlari NUMARALI', async () => {
    // KULLANICI: "siteler numaralara gore siralansin, siralamanin yaninda
    // numara yazsin". Bu bir SIRALAMA listesi; kacinci oldugu gorunmeden
    // "en cok" basligi soyut kaliyor.
    const UC_SITE = [
      { id: 'a', level: 'SUCCESS', category: 'PURGE', domain: 'bir.com', timestamp: 3,
        message: 'Temizlendi', details: { cookies: 9, history: 0, downloads: 0, remaining: 0 } },
      { id: 'b', level: 'SUCCESS', category: 'PURGE', domain: 'bir.com', timestamp: 2,
        message: 'Temizlendi', details: { cookies: 9, history: 0, downloads: 0, remaining: 0 } },
      { id: 'c', level: 'SUCCESS', category: 'PURGE', domain: 'iki.com', timestamp: 1,
        message: 'Temizlendi', details: { cookies: 1, history: 0, downloads: 0, remaining: 0 } }
    ];
    await ciz(UC_SITE, {}, 'cleaned');

    const satirlar = [...dom.byId('topCleanedBody').children];
    assert.ok(satirlar.length >= 2, `en az iki satir olmali: ${satirlar.length}`);

    const numaralar = satirlar.map(tr => tr.children[0].textContent.trim());
    assert.deepEqual(numaralar.slice(0, 2), ['1', '2'],
      `satirlar 1'den baslayarak numaralanmali; okunan: ${JSON.stringify(numaralar)}`);

    // Numara ilk sutunda; alan adi ONDAN SONRA gelmeli.
    assert.ok(satirlar[0].children[1].textContent.includes('bir.com'),
      'en cok temizlenen site 1. sirada olmali');
  });

  test('ALAN ADSIZ gunluk satiri TEK ve OKUNUR isaret tasir', async () => {
    // KULLANICI: "alan adi — seklinde gozukuyor, bu nedir?"
    //
    // IKI kusur birden vardi:
    //
    // 1) TIRE IKI KEZ BASILIYORDU. logs.js zaten `text: entry.domain || '—'`
    //    yaziyordu; hayalet sinif duzeltmesinde CSS'e `::before { content:
    //    "—" }` eklerken JS'in ZATEN bir tire koydugunu kontrol etmedim.
    //    Sonuc ekranda "——" idi.
    //
    // 2) SEMBOL KENDINI ANLATMIYOR. Kullanicinin sormasi bunun kaniti.
    //    Bu satirlar tek bir siteye bagli olmayan olaylar: "3 yetim alan adi
    //    icin temizlik planlandi", "Periyodik temizlik 60 dakikada bir",
    //    "Kurulum/guncelleme". Okunur bir sozcuk tireden iyi.
    const mod = await import('../options/tabs/logs.js');
    const KAYIT = [
      { id: 'x', level: 'INFO', category: 'ALARM', domain: null, timestamp: 1,
        message: '3 yetim alan adi icin temizlik planlandi', details: { delay: 30 } }
    ];
    const orijinal = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.action === 'GET_LOGS') return { success: true, logs: KAYIT };
      return { success: true };
    };
    try {
      // renderLogs() SENKRON ve logsState'ten cizer; veriyi getiren
      // loadLogs(). Ilk denemede renderLogs cagrilmis, liste bos kalmisti.
      await mod.loadLogs();
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = orijinal;
    }

    const govde = dom.byId('logsTableBody');
    const satir = govde.children[0];
    assert.ok(satir, 'gunluk satiri olusmali');

    const hucre = satir.children[2];          // zaman, seviye, ALAN ADI
    const metin = hucre.textContent.trim();

    assert.equal(metin.includes('——'), false,
      `isaret iki kez basilmamali; okunan: "${metin}"`);
    assert.ok(metin.length > 1 && !/^[—-]+$/.test(metin),
      `alan adsiz satir okunur bir sozcuk tasimali, ciplak sembol degil; okunan: "${metin}"`);
  });

  test('TEMIZLENEN listesi tek temizlikte de DOLU gelir', async () => {
    // KULLANICI BULGUSU: "Temizlenen siteler listesi bos".
    //
    // Siralamanin gosterilmesi icin bir sitenin EN AZ IKI KEZ temizlenmis
    // olmasi sart kosulmustu. Gerekce "yoksa ustteki Son temizlikler
    // listesinin tekrari olur" idi - ama iki liste ayni seyi anlatmiyor:
    // ust liste son 15 OLAYI zaman sirasiyla, alt liste site basina TOPLAMI
    // gosteriyor. Normal kullanimda her site birer kez temizlenir, yani
    // sekme PRATIKTE HEP BOS kaliyordu ve bozuk gorunuyordu.
    const TEK = [
      { id: 'a', level: 'SUCCESS', category: 'PURGE', domain: 'ornek.com',
        timestamp: 2, message: 'Temizlendi',
        details: { cookies: 4, history: 1, downloads: 0, remaining: 0 } },
      { id: 'b', level: 'SUCCESS', category: 'PURGE', domain: 'baska.org',
        timestamp: 1, message: 'Temizlendi',
        details: { cookies: 2, history: 0, downloads: 0, remaining: 0 } }
    ];
    await ciz(TEK, {}, 'cleaned');

    const metin = dom.byId('topCleanedBody').textContent;
    assert.ok(metin.includes('ornek.com') && metin.includes('baska.org'),
      `birer kez temizlenmis siteler de listelenmeli; gosterilen: "${metin}"`);
  });

  test('TEMIZLENEN listesi 3. TARAFLARI ICERMEZ', async () => {
    // KULLANICI BULGUSU: "En cok temizlenen siteler'de 3. taraf siteler
    // gozukuyor". Dogru: temizlenen siralamasi TUM temizlik kayitlarini
    // topluyordu, 3. taraflar dahil (onlari da temizliyoruz).
    //
    // Ama komsu sekme artik sikica 3. taraf. Iki sekme birbirinin TAMAMLAYICI
    // yarisi olmali: ana siteler / harici siteler. Ayni alan adinin ikisinde
    // birden gorunmesi bolunmeyi anlamsizlastirir.
    const KAYIT = [
      { id: 'a', level: 'SUCCESS', category: 'PURGE', domain: 'ornek.com',
        timestamp: 2, message: 'Temizlendi',
        details: { cookies: 4, history: 1, downloads: 0, remaining: 0 } },
      { id: 'b', level: 'SUCCESS', category: 'PURGE', domain: 'izleyici.net',
        timestamp: 1, message: 'Temizlendi',
        details: { cookies: 2, history: 0, downloads: 0, remaining: 0 } }
    ];
    // izleyici.net YALNIZCA 3. taraf olarak goruldu (ziyaret edilmedi).
    const SAYIM = { 'izleyici.net': { count: 5, sites: ['haber.com'] } };

    const mod = await import('../options/tabs/insights.js');
    mod.__resetInsightsForTests();
    const orijinal = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.action === 'GET_LOGS') return { success: true, logs: KAYIT };
      if (msg?.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, domains: [], thirdPartySeen: SAYIM, visitedRoots: {} };
      }
      return { success: true };
    };
    try {
      await mod.renderInsights();
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = orijinal;
    }

    const metin = dom.byId('topCleanedBody').textContent;
    assert.ok(metin.includes('ornek.com'),
      `ana site TEMIZLENEN listesinde olmali; gosterilen: "${metin}"`);
    assert.equal(metin.includes('izleyici.net'), false,
      `3. taraf TEMIZLENEN listesinde GORUNMEMELI; gosterilen: "${metin}"`);
  });

  test('ZIYARET EDILEN site 3. taraf listesinde GOSTERILMEZ', async () => {
    // KULLANICI BULGUSU: listede google.com ve google.com.tr duruyordu -
    // kendi actigi siteler.
    //
    // Gercek senaryo bir CAKISMADIR: bir host hem baska bir sayfada 3. taraf
    // olarak gorulur, hem de kullanici onu ayrica acar. Asagidaki veri tam
    // bu cakismayi kuruyor - cakisma olmadan test hicbir sey kanitlamaz.
    const SAYIM = {
      'doubleclick.net': { count: 9, sites: ['haber.com', 'blog.org'] },
      'google.com': { count: 4, sites: ['youtube.com'] }   // ayrica ZIYARET edildi
    };
    const ZIYARET = { 'youtube.com': 1, 'google.com': 1 };

    const mod = await import('../options/tabs/insights.js');
    mod.__resetInsightsForTests();
    const orijinal = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.action === 'GET_LOGS') return { success: true, logs: LOGLAR };
      if (msg?.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, domains: [], thirdPartySeen: SAYIM, visitedRoots: ZIYARET };
      }
      return { success: true };
    };
    try {
      // 3. TARAF sekmesi acikca secilmeli: LOGLAR'da github iki kez
      // temizlendigi icin "temizlenen" listesi dolu, otomatik gecis olmuyor
      // ve varsayilan sekme okunuyordu.
      const ucuncuDugme = [...dom.document.querySelectorAll('#topCleanedSection [data-insight]')]
        .find(d => d.getAttribute('data-insight') === 'thirdparty');
      assert.ok(ucuncuDugme, '3. taraf sekmesi dugmesi olmali');
      await ucuncuDugme._fire('click');
      await new Promise(r => setTimeout(r, 40));

      await mod.renderInsights();
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = orijinal;
    }

    const metin = dom.byId('topCleanedBody').textContent;
    assert.ok(metin.includes('doubleclick.net'),
      `gercek 3. taraf listede olmali; gosterilen: "${metin}"`);
    assert.equal(metin.includes('google.com'), false,
      `ziyaret edilen site listede GORUNMEMELI; gosterilen: "${metin}"`);
  });

  test('SECILEN sekme yeniden cizimde GERI ALINMAZ', async () => {
    // KULLANICI BULGUSU: "sekmelere tiklanmiyor, 3. taraflar sabit aktif
    // duruyor". Tiklama aslinda CALISIYORDU; hemen geri aliniyordu.
    //
    // Otomatik gecis her cizimde kosuyordu: kullanici "Temizlenen siteler"e
    // tiklayinca sekme degisiyor, ardindan renderInsights() cagriliyor, o da
    // "temizlenen listesi bos, 3. taraf dolu" gorup sekmeyi GERI ceviriyordu.
    // Sonsuz geri alma. Otomatik gecis yalnizca kullanici HENUZ SECIM
    // YAPMAMISKEN calismali; acik bir tercih her zaman kazanir.
    await ciz(LOGLAR, UCUNCU, 'thirdparty');   // once 3. taraflara gec

    // Simdi kullanici acikca "Temizlenen siteler"i seciyor.
    // LOGLAR'da hicbir site 2 kez temizlenmedigi icin liste BOS kalacak -
    // eski kodun geri cevirmesini tetikleyen tam kosul bu.
    await ciz([LOGLAR[0], LOGLAR[2]], UCUNCU, 'cleaned', false);

    const dugmeler = [...dom.document.querySelectorAll('#topCleanedSection [data-insight]')];
    const temizlenenDugme = dugmeler.find(d => d.getAttribute('data-insight') === 'cleaned');
    assert.ok(temizlenenDugme.classList.contains('active'),
      'kullanicinin sectigi sekme aktif kalmali');
  });

  test('3. TARAFLAR sekmesi kac SITEDE gorunduklerini sayar', async () => {
    await ciz(LOGLAR, UCUNCU, 'thirdparty');

    const body = dom.byId('topCleanedBody');
    const ilk = body.children[0].textContent;
    assert.match(ilk, /fonts\.googleapis\.com/,
      `3 sitede gorunen en ustte olmali: "${ilk}"`);
    assert.match(ilk, /3/, 'site sayisi 3 olmali');
    // Ana site (3. taraf olmayan) bu listeye GIRMEZ.
    assert.ok(!body.textContent.includes('github.com'),
      'ana site 3. taraf listesinde olmamali');
  });

  test('BASLIK da sekmeye gore degisir', async () => {
    // "En cok temizlenen siteler" basligi altinda 3. taraf listesi gostermek
    // yaniltici olur; gercek kosumda tam olarak oyle gorunuyordu.
    await ciz(LOGLAR, UCUNCU, 'cleaned');
    const temizlenenBaslik = dom.byId('topCleanedTitle').textContent;

    await ciz(LOGLAR, UCUNCU, 'thirdparty');
    const ucuncuBaslik = dom.byId('topCleanedTitle').textContent;

    assert.notEqual(temizlenenBaslik, ucuncuBaslik,
      `iki sekme ayni basligi tasiyamaz: "${temizlenenBaslik}"`);
    assert.match(ucuncuBaslik, /taraf|third/i,
      `3. taraf sekmesinin basligi onu anlatmali: "${ucuncuBaslik}"`);
  });


  test('IKI sekme de bossa bolum gizlenir', async () => {
    await ciz([], []);
    assert.ok(dom.byId('topCleanedSection').classList.contains('hidden'),
      'gosterecek hicbir sey yoksa bolum gorunmemeli');
  });

  test('hic temizlik yoksa BOS DURUM gosterilir', async () => {
    await ciz([]);
    assert.ok(!dom.byId('recentCleanupsEmpty').classList.contains('hidden'),
      'bos durum gorunmeli');
    assert.equal(dom.byId('recentCleanupsBody').children.length, 0);
  });
});

describe('kurallar: korumasiz oturumlar (v2.7.0)', () => {
  const SITELER = [
    { domain: 'github.com', category: 'direct', ruleType: 'default', hasSessionCookie: true,
      cookieCount: 7, historyCount: 3, downloadCount: 0, requestCount: 0 },
    // GERCEK KOSUMDA GORULDU: cloudflare.com "giris yapmissin" diye
    // listelendi. O bir CDN; kullanici hic ziyaret etmedi, cerezi yalnizca
    // baska sitelerin yukledigi kaynak olarak olustu. Bir gizlilik eklentisi
    // kullaniciyi CDN'i beyaz listeye almaya ITEMEZ - oneri zararli olur.
    { domain: 'cloudflare.com', category: 'third_party', ruleType: 'default', hasSessionCookie: true,
      cookieCount: 1, historyCount: 0, downloadCount: 0, requestCount: 9,
      parentSites: ['github.com'] },
    { domain: 'izleyici.com', category: 'direct', ruleType: 'default', hasSessionCookie: false,
      cookieCount: 4, historyCount: 0, downloadCount: 0, requestCount: 0 },
    { domain: 'korumali.com', category: 'direct', ruleType: 'white', hasSessionCookie: true,
      cookieCount: 9, historyCount: 0, downloadCount: 0, requestCount: 0 },
    { domain: 'gri.com', category: 'direct', ruleType: 'grey', hasSessionCookie: true,
      cookieCount: 2, historyCount: 0, downloadCount: 0, requestCount: 0 }
  ];

  async function ciz(list = SITELER) {
    const mod = await import('../options/tabs/unprotected.js');
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) =>
      (msg?.action === 'GET_ALL_STORED_DOMAINS' ? { success: true, domains: list } : { success: true });
    try {
      await mod.renderUnprotectedLogins();
      await new Promise(r => setTimeout(r, 30));
    } finally {
      chrome.runtime.sendMessage = original;
    }
    return mod;
  }

  test('YALNIZCA oturumu olan ve korumasiz siteler listelenir', async () => {
    await ciz();
    const metin = dom.byId('unprotectedLoginsBody').textContent;
    assert.match(metin, /github\.com/, 'oturumu olan korumasiz site listelenmeli');
    assert.ok(!metin.includes('izleyici.com'), 'oturum cerezi olmayan site listelenmemeli');
    assert.ok(!metin.includes('korumali.com'), 'beyaz listedeki site listelenmemeli');
    assert.ok(!metin.includes('gri.com'), 'gri listedeki site de KORUMALI sayilir');
    assert.ok(!metin.includes('cloudflare.com'),
      '3. taraf/CDN "giris yaptin" diye onerilmemeli - yaniltici ve zararli');
  });

  test('riskli site yoksa bolum GIZLENIR', async () => {
    await ciz([SITELER[1], SITELER[2]]);
    assert.ok(dom.byId('unprotectedLoginsSection').classList.contains('hidden'),
      'gosterecek bir sey yoksa bolum gorunmemeli');
  });

  test('tek tikla beyaz listeye alir', async () => {
    await ciz();
    const gonderilen = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      gonderilen.push(msg);
      if (msg?.action === 'GET_ALL_STORED_DOMAINS') return { success: true, domains: [] };
      return { success: true };
    };
    try {
      await dom.byId('unprotectedLoginsBody').children[0]
        .querySelector('.btn-success-sm')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally {
      chrome.runtime.sendMessage = original;
    }

    const kural = gonderilen.find(m => m?.action === 'SET_RULE');
    assert.ok(kural, `SET_RULE gonderilmeli; gonderilen: ${gonderilen.map(m => m.action).join(', ')}`);
    assert.equal(kural.domain, 'github.com');
    assert.equal(kural.type, 'white');
  });
});


describe('Site verileri: KORUMA KALDIRMA onay ister (v2.7.0)', () => {
  // BOSLUK BUYDU: onayi ekledim ama TESTINI yazmadim. Yani ileride biri
  // openConfirm sarmalayicisini kaldirsa 738 testin hicbiri fark etmezdi -
  // tam da bu oturumda tehlikeli oldugunu gordugumuz sessiz gerileme.
  //
  // KULLANICI BILDIRIMI: "Site verileri sayfasinda kaldir seceneginde popup
  // uyari vs hicbisi yok, aninda beyaz listeden kaldirip siliyor."

  let gonderilen = [];
  let loadSiteData;

  const satirKur = async (ruleType) => {
    gonderilen = [];
    chrome.runtime.sendMessage = async (message) => {
      gonderilen.push(message);
      if (message?.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, truncated: false, domains: [
          { domain: 'ornek.com', ruleType, category: 'direct',
            cookies: 3, localStorage: 0, indexedDb: 0, cache: 0, bytes: 1024 }
        ] };
      }
      return { success: true };
    };
    ({ loadSiteData } = await import('../options/tabs/site-data.js'));
    await loadSiteData();
    await new Promise(r => setTimeout(r, 40));
    const dugme = dom.root.querySelector('.btn-toggle-whitelist-site');
    assert.ok(dugme, 'satir cizilmeli ve kaldir/ekle dugmesi bulunmali');
    return dugme;
  };

  test('KALDIR dugmesi kurali ANINDA silmez, onay modali acar', async () => {
    const dugme = await satirKur('white');
    gonderilen = [];

    await dugme._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(gonderilen.find(m => m?.action === 'DELETE_RULE'), undefined,
      'onay verilmeden kural SILINMEMELI');
    assert.equal(dom.byId('customModal').classList.contains('hidden'), false,
      'onay modali acilmali');
    assert.match(dom.byId('modalDescription').textContent, /ornek\.com/,
      'modal metni hangi siteden bahsettigini soylemeli');
  });

  test('modaldaki onaydan SONRA kural gercekten silinir', async () => {
    const dugme = await satirKur('white');
    await dugme._fire('click');
    await new Promise(r => setTimeout(r, 40));
    gonderilen = [];

    await dom.byId('modalBtnConfirm')._fire('click');
    await new Promise(r => setTimeout(r, 60));

    const sil = gonderilen.find(m => m?.action === 'DELETE_RULE');
    assert.ok(sil, 'onaydan sonra kural silme mesaji gitmeli');
    // purgeAfter:false KORUNMALI: bu sekme bir veri tarayicisi, satir
    // yerinde kalmali ki kullanici veriyi gorup kendi karariyla temizlesin.
    assert.equal(sil.purgeAfter, false, 'veri bu sekmede hemen silinmemeli');
  });

  test('VAZGEC kurali silmez', async () => {
    const dugme = await satirKur('white');
    await dugme._fire('click');
    await new Promise(r => setTimeout(r, 40));
    // Modalin GERCEKTEN acik oldugunu once dogrula: yoksa modal hic
    // acilmadiginda iptal tiklamasi bosa gider ve test SEBEPSIZ gecer.
    assert.equal(dom.byId('customModal').classList.contains('hidden'), false,
      'iptal olculmeden once modal acik olmali');
    gonderilen = [];

    await dom.byId('modalBtnCancel')._fire('click');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(gonderilen.find(m => m?.action === 'DELETE_RULE'), undefined,
      'vazgecince kural silinmemeli');
    assert.equal(dom.byId('customModal').classList.contains('hidden'), true,
      'vazgecince modal kapanmali');
  });

  test('EKLEME onay istemez - koruyucu eylem engellenmemeli', async () => {
    // Ters yon de olculmeli: onayi her yere koymak kullaniciyi onaylari
    // okumadan gecmeye alistirir ve asil onemli onay gurultuye karisir.
    const dugme = await satirKur('default');
    gonderilen = [];

    await dugme._fire('click');
    await new Promise(r => setTimeout(r, 60));

    assert.ok(gonderilen.find(m => m?.action === 'SET_RULE'),
      'koruma ekleme tek tikla olmali');
    assert.equal(dom.byId('customModal').classList.contains('hidden'), true,
      'ekleme icin modal ACILMAMALI');
  });
});


describe('KORUMA DUSURME onay ister: white -> grey (v2.7.0)', () => {
  // GEC FARK EDILEN ACIK. Onaysiz cagri listemde bu iki yer "koruyucu"
  // diye duruyordu, cunku ikisi de SET_RULE gonderiyor. Ama
  // parseRuleSelection GREY de dondurebiliyor - GREY "her zaman temizle"
  // demek. Yani kural ekleme formu ve cerez penceresi, beyaz listedeki bir
  // siteyi tek kaydetmeyle korumasiz birakabiliyordu. Kullanicinin
  // bildirdigi hatanin AYNISI, baska kapidan.
  //
  // Eylemin ADI degil SONUCU onemli: "kural ekle" masum gorunuyor ama
  // sonuc koruma kaldirmak.

  let gonderilen = [];

  const kur = async () => {
    gonderilen = [];
    chrome.runtime.sendMessage = async (message) => {
      gonderilen.push(message);
      if (message?.action === 'GET_RULES' || message?.action === 'GET_ALL_RULES') {
        return { success: true, rules: { 'ornek.com': { domain: 'ornek.com', type: 'white' } } };
      }
      return { success: true };
    };
    const mod = await import('../options/tabs/rules.js');
    mod.rulesState.cache = { 'ornek.com': { domain: 'ornek.com', type: 'white' } };
    dom.byId('customModal').classList.add('hidden');
    return mod;
  };

  test('form: beyaz listedeki siteyi GREY yapmak onay ister', async () => {
    await kur();
    dom.byId('inputDomain').value = 'ornek.com';
    dom.byId('selectRuleType').value = 'grey';
    gonderilen = [];

    await dom.byId('formAddRule')._fire('submit');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(gonderilen.find(m => m?.action === 'SET_RULE'), undefined,
      'onay verilmeden koruma DUSURULMEMELI');
    assert.equal(dom.byId('customModal').classList.contains('hidden'), false,
      'onay modali acilmali');
  });

  test('form: YENI siteye grey kurali onay istemez', async () => {
    // Ters yon: korumasi olmayan bir siteye "temizle" demek hicbir koruma
    // kaldirmaz. Burada onay sormak gurultu olur.
    await kur();
    dom.byId('inputDomain').value = 'yeni-site.com';
    dom.byId('selectRuleType').value = 'grey';
    gonderilen = [];

    await dom.byId('formAddRule')._fire('submit');
    await new Promise(r => setTimeout(r, 50));

    assert.ok(gonderilen.find(m => m?.action === 'SET_RULE'),
      'koruma kaldirmayan islem tek adimda olmali');
    assert.equal(dom.byId('customModal').classList.contains('hidden'), true,
      'modal ACILMAMALI');
  });

  test('form: beyaz listedeki siteyi WHITE olarak kaydetmek onay istemez', async () => {
    await kur();
    dom.byId('inputDomain').value = 'ornek.com';
    dom.byId('selectRuleType').value = 'white';
    gonderilen = [];

    await dom.byId('formAddRule')._fire('submit');
    await new Promise(r => setTimeout(r, 50));

    assert.ok(gonderilen.find(m => m?.action === 'SET_RULE'),
      'koruma korunuyorsa onay gerekmez');
  });
});


describe('KORUMASIZ OTURUMLAR listesi eklemeden sonra ANINDA tazelenir', () => {
  // KULLANICI BULGUSU: "Beyaz listeye al dedim ama korumasiz oturumlardan
  // aninda kalkmadi, sayfayi yeniledim oyle kalkti."
  //
  // KOK NEDEN: bu gorunum tazeleme kaydina HIC kayitli degildi. Yani her
  // cagiranin elle renderUnprotectedLogins() cagirmasi gerekiyordu ve
  // ekleme dugmesi yalnizca refreshViews('rules') cagiriyordu.
  //
  // Asimetri kodun icinde duruyordu: GERI AL yolu listeyi yeniden ciziyor,
  // EKLEME yolu cizmiyordu.

  let gonderilen = [];
  let kurallar = {};

  const kur = async () => {
    gonderilen = [];
    kurallar = {};
    chrome.runtime.sendMessage = async (message) => {
      gonderilen.push(message);
      if (message?.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, truncated: false, domains: [
          { domain: 'youtube.com', ruleType: kurallar['youtube.com'] || 'default',
            category: 'direct', hasSessionCookie: true, cookieCount: 31 }
        ] };
      }
      if (message?.action === 'SET_RULE') {
        kurallar[message.domain] = 'white';
        return { success: true };
      }
      return { success: true };
    };
    const mod = await import('../options/tabs/unprotected.js');
    await mod.renderUnprotectedLogins();
    await new Promise(r => setTimeout(r, 40));
    return mod;
  };

  test('beyaz listeye alinan satir SAYFA YENILENMEDEN kalkar', async () => {
    await kur();
    const bolum = dom.byId('unprotectedLoginsSection');
    const govde = dom.byId('unprotectedLoginsBody');
    assert.equal(govde.children.length, 1, 'once satir gorunmeli');

    await govde.querySelector('.btn-success-sm')._fire('click');
    await new Promise(r => setTimeout(r, 80));

    assert.equal(govde.children.length, 0,
      'beyaz listeye alinan site listede KALMAMALI');
    assert.equal(bolum.classList.contains('hidden'), true,
      'aday kalmayinca bolum gizlenmeli');
  });

  test('gorunum tazeleme kaydina KAYITLI', async () => {
    // Kayitsizken her cagiranin elle hatirlamasi gerekiyordu; bu hata tam
    // olarak oradan cikti. Kayitli olunca refreshViews() de kapsiyor.
    await kur();
    const { refreshViews } = await import('../options/ui/refresh.js');
    const govde = dom.byId('unprotectedLoginsBody');

    kurallar['youtube.com'] = 'white';
    await refreshViews('unprotected');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(govde.children.length, 0,
      "refreshViews('unprotected') listeyi tazelemeli");
  });
});


describe('KORUMASIZ liste kural degisince her yerden tazelenir', () => {
  // Ayni kusur DORT cagri yerinde daha vardi. Korumasiz liste kurallardan
  // TURETILIYOR: kural degisince liste de degismeli. Kurallar sekmesinde bu
  // liste tablonun hemen altinda duruyor, yani tutarsizlik dogrudan gorunur.

  let kurallar = {};

  const kur = async () => {
    kurallar = {};
    chrome.runtime.sendMessage = async (message) => {
      if (message?.action === 'GET_ALL_STORED_DOMAINS') {
        return { success: true, truncated: false, domains: [
          { domain: 'youtube.com', ruleType: kurallar['youtube.com'] || 'default',
            category: 'direct', hasSessionCookie: true, cookieCount: 31 }
        ] };
      }
      if (message?.action === 'SET_RULE') { kurallar[message.domain] = 'white'; return { success: true }; }
      if (message?.action === 'DELETE_RULE') { delete kurallar[message.domain]; return { success: true }; }
      if (message?.action === 'GET_RULES') return { success: true, rules: {} };
      return { success: true };
    };
    const mod = await import('../options/tabs/unprotected.js');
    await mod.renderUnprotectedLogins();
    await new Promise(r => setTimeout(r, 40));
  };

  test('KURAL FORMUNDAN beyaz listeye alinca satir kalkar', async () => {
    await kur();
    const govde = dom.byId('unprotectedLoginsBody');
    assert.equal(govde.children.length, 1);

    dom.byId('inputDomain').value = 'youtube.com';
    dom.byId('selectRuleType').value = 'white';
    await dom.byId('formAddRule')._fire('submit');
    await new Promise(r => setTimeout(r, 80));

    assert.equal(govde.children.length, 0,
      'kural formundan eklenince de korumasiz listeden kalkmali');
  });

  test('KURAL SILININCE site korumasiz listeye geri gelir', async () => {
    await kur();
    kurallar['youtube.com'] = 'white';
    const { refreshViews } = await import('../options/ui/refresh.js');
    await refreshViews('unprotected');
    await new Promise(r => setTimeout(r, 40));
    const govde = dom.byId('unprotectedLoginsBody');
    assert.equal(govde.children.length, 0, 'korumaliyken listede olmamali');

    delete kurallar['youtube.com'];
    await refreshViews('unprotected');
    await new Promise(r => setTimeout(r, 40));

    assert.equal(govde.children.length, 1,
      'koruma kalkinca site yeniden korumasiz listesinde gorunmeli');
  });
});

describe('Kural disa aktarma: YALNIZCA beyaz liste', () => {
  // Gri liste ve gecici izin GECICIDIR - ikisi de tarayici kapaninda silinir
  // (gri: runStartupCleanup, gecici: expiresAt). Dosyaya yazmak, dogasi
  // geregi bu oturumla sinirli bir seyi kalici bir yedege koymak demek:
  // ice aktarildiginda ya suresi coktan dolmus olur ya da hic yasamamis bir
  // sureyi yeniden baslatir. Beyaz liste ise gercek bir tercihtir.
  let exportableRules;

  before(async () => {
    ({ exportableRules } = await import('../options/tabs/rules.js'));
  });

  const kural = (domain, type, extra = {}) => ({
    domain, type, subdomains: true, keepMode: 'all', keepCookies: [],
    addedAt: 1, updatedAt: 1, ...extra
  });

  test('gecici izin ve gri liste disa aktarilmaz', () => {
    const disa = exportableRules({
      'github.com': kural('github.com', 'white'),
      'deepl.com': kural('deepl.com', 'white'),
      'dizibox.com': kural('dizibox.com', 'grey'),
      'ecc.tools': kural('ecc.tools', 'temp', { expiresAt: Date.now() + 900_000, durationMinutes: 15 })
    });
    assert.deepEqual(Object.keys(disa).sort(), ['deepl.com', 'github.com']);
  });

  test('beyaz listenin AYARLARI aynen tasinir', () => {
    const disa = exportableRules({
      'web.whatsapp.com': kural('web.whatsapp.com', 'white', {
        subdomains: false, keepMode: 'custom', keepCookies: ['wa_*', 'xf_session']
      })
    });
    const r = disa['web.whatsapp.com'];
    assert.equal(r.subdomains, false, 'kapsam tasinmali');
    assert.equal(r.keepMode, 'custom', 'cerez modu tasinmali');
    assert.deepEqual(r.keepCookies, ['wa_*', 'xf_session'], 'secilen kaliplar tasinmali');
  });

  test('yalnizca gecici/gri kural varsa disa aktarilacak sey YOKTUR', () => {
    const disa = exportableRules({
      'dizibox.com': kural('dizibox.com', 'grey'),
      'ecc.tools': kural('ecc.tools', 'temp', { expiresAt: Date.now() + 900_000 })
    });
    assert.deepEqual(Object.keys(disa), [], 'bos cikti "disa aktarilacak kural yok" uyarisi uretir');
  });
});

describe('Cerez modu: "giris cerezleri" bir MOD degil ONERIdir', () => {
  // Eski `keepMode: 'session'` kural olarak SAKLANIYORDU ve tahmin SILME
  // ANINDA yapiliyordu - kullanicinin hic gormedigi bir karar her temizlikte
  // yeniden veriliyordu. Tahmin cerez ADINA bakiyor ve gercek sitelerde
  // olculen dogruluk %79: `phpbb3_..._sid` / `xf_user` gibi giris cerezleri
  // taninmiyor (kullanici cikis yapiyor), `__Secure-ENID` gibi reklam
  // cerezleri oturum saniliyor (iz kaliyor - ve bu SESSIZ).
  //
  // Artik tahmin BIR KEZ calisir, sonucu kullaniciya ISARETLI gosterilir,
  // kullanici duzeltir ve kural ACIK AD LISTESI olarak saklanir.

  const gercekCerezler = [
    // mobilism.org (phpBB) - tahmin bunlari KACIRIR
    { name: 'phpbb3_8xk2p_sid', domain: 'ornek.com', valueLength: 32, classification: 'other', isSession: false, isTracker: false },
    // taninan giris cerezleri
    { name: 'user_session', domain: 'ornek.com', valueLength: 40, classification: 'session', isSession: true, isTracker: false },
    { name: 'auth_token', domain: 'ornek.com', valueLength: 64, classification: 'session', isSession: true, isTracker: false },
    // izleyici
    { name: '_ga', domain: 'ornek.com', valueLength: 26, classification: 'tracker', isSession: false, isTracker: true }
  ];

  async function modaliAc(rule, cookies = gercekCerezler) {
    const { openSiteModal } = await import('../options/tabs/cookie-modal.js');
    await chrome.storage.local.set({ rules: rule ? { 'ornek.com': rule } : {} });
    const sent = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      if (msg.action === 'GET_DOMAIN_COOKIES') return { success: true, cookies };
      return { success: true };
    };
    await openSiteModal('ornek.com');
    await new Promise(r => setTimeout(r, 40));
    return { sent, restore: () => { chrome.runtime.sendMessage = original; } };
  }

  test('dugme tahmini ISARETLER ve "ozel" moda gecer', async () => {
    const { modalState } = await import('../options/tabs/cookie-modal.js');
    const { restore } = await modaliAc(null);
    try {
      await dom.byId('btnSuggestSessionCookies')._fire('click');
      await new Promise(r => setTimeout(r, 20));

      assert.equal(modalState.keepMode, 'custom',
        '"session" artik bir mod degil; secim ozel listeye donusmeli');
      assert.deepEqual([...modalState.kept].sort(), ['auth_token', 'user_session'],
        'yalnizca TANINAN giris cerezleri isaretlenmeli');
      assert.equal(dom.byId('modalCustomCookieArea').classList.contains('hidden'), false,
        'kullanici isaretleri GORMELI ki duzeltebilsin');
    } finally { restore(); }
  });

  test('KAYDEDILEN kural her zaman acik ad listesidir, asla session degil', async () => {
    const { restore, sent } = await modaliAc(null);
    try {
      await dom.byId('btnSuggestSessionCookies')._fire('click');
      await new Promise(r => setTimeout(r, 20));
      await dom.byId('btnModalSave')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally { restore(); }

    const setRule = sent.filter(m => m?.action === 'SET_RULE').pop();
    assert.ok(setRule, 'SET_RULE gonderilmeli');
    assert.equal(setRule.options.keepMode, 'custom',
      'silme aninda tahmin YAPILMAMALI; kural acik ad listesi olmali');
    assert.deepEqual(setRule.options.keepCookies.sort(), ['auth_token', 'user_session']);
  });

  test('Tahminin KACIRDIGI cerez elle eklenebilir ve kurala girer', async () => {
    // Tam olarak %79'un digeri: phpbb3_..._sid taninmiyor. Kullanici gorup
    // isaretleyebiliyor - eski tasarimda bunu GOREMIYORDU bile.
    const { modalState } = await import('../options/tabs/cookie-modal.js');
    const { restore, sent } = await modaliAc(null);
    try {
      await dom.byId('btnSuggestSessionCookies')._fire('click');
      await new Promise(r => setTimeout(r, 20));
      modalState.kept.add('phpbb3_8xk2p_sid');
      await dom.byId('btnModalSave')._fire('click');
      await new Promise(r => setTimeout(r, 40));
    } finally { restore(); }

    const setRule = sent.filter(m => m?.action === 'SET_RULE').pop();
    assert.ok(setRule.options.keepCookies.includes('phpbb3_8xk2p_sid'),
      'kullanicinin duzeltmesi kurala gecmeli');
  });

  test('Diskteki ESKI session kurali acilinca ONERIYE cevrilir', async () => {
    const { modalState } = await import('../options/tabs/cookie-modal.js');
    const { restore } = await modaliAc({
      domain: 'ornek.com', type: 'white', subdomains: true,
      keepMode: 'session', keepCookies: []
    });
    try {
      assert.equal(modalState.keepMode, 'custom',
        'eski session kurali ozel moda gocmeli');
      assert.deepEqual([...modalState.kept].sort(), ['auth_token', 'user_session'],
        'tahmin ISARETLI gelmeli ki kullanici ilk kez NE korundugunu gorsun');
    } finally { restore(); }
  });

  test('Cerezi olmayan sitede oneri bos liste URETMEZ', async () => {
    const { modalState } = await import('../options/tabs/cookie-modal.js');
    const { restore } = await modaliAc(null, []);
    try {
      await dom.byId('btnModalModeCustom')._fire('click');
      await new Promise(r => setTimeout(r, 20));
      await dom.byId('btnSuggestSessionCookies')._fire('click');
      await new Promise(r => setTimeout(r, 20));
      assert.equal(modalState.kept.size, 0, 'uydurma bir kalip eklenmemeli');
    } finally { restore(); }
  });

  test('"Sectiklerimi koru"ya gecis ONERIYI de calistirir (tek kod yolu)', async () => {
    // Bu on secim eskiden burada AYRI bir kopya olarak duruyordu ve sessizce
    // calisiyordu: kullanici isaretlerin nereden geldigini ogrenemiyordu.
    const { modalState } = await import('../options/tabs/cookie-modal.js');
    const { restore } = await modaliAc(null);
    try {
      await dom.byId('btnModalModeCustom')._fire('click');
      await new Promise(r => setTimeout(r, 20));
      assert.deepEqual([...modalState.kept].sort(), ['auth_token', 'user_session']);
    } finally { restore(); }
  });
});

describe('HER kenar dugmesinin bir paneli VAR ve gercekten aciliyor', () => {
  // "Olu dugme" bu projede tekrar tekrar temizlenen hata sinifi. switchTab
  // bilinmeyen sekmede ERKEN DONUYOR: TAB_LOADERS'a kaydedilmemis bir sekmenin
  // dugmesi tiklaninca HICBIR SEY yapmaz - hata da vermez, sessizce olur.
  // Hakkinda sekmesi eklenirken tam bu tuzak vardi.

  test('her data-tab degeri gercek bir panele isaret ediyor', () => {
    const eksik = [...dom.document.querySelectorAll('.nav-item')]
      .map(n => n.dataset.tab)
      .filter(id => !dom.document.getElementById(id));
    assert.deepEqual(eksik, [], `paneli olmayan sekme dugmesi: ${eksik.join(', ')}`);
  });

  test('her dugme tiklaninca KENDI paneli etkinlesiyor', async () => {
    for (const nav of [...dom.document.querySelectorAll('.nav-item')]) {
      const hedef = nav.dataset.tab;
      await nav._fire('click');
      await new Promise(r => setTimeout(r, 20));

      assert.equal(dom.byId(hedef).classList.contains('active'), true,
        `"${hedef}" dugmesi tiklandi ama paneli acilmadi - TAB_LOADERS'a kayitli mi?`);
      const acikPaneller = [...dom.document.querySelectorAll('.tab-panel')]
        .filter(p => p.classList.contains('active')).map(p => p.id);
      assert.deepEqual(acikPaneller, [hedef],
        `tek panel acik olmali; acik olanlar: ${acikPaneller.join(', ')}`);
    }
  });

  test('Hakkinda sekmesi kenar cubugunda VAR', () => {
    const hakkinda = [...dom.document.querySelectorAll('.nav-item')]
      .find(n => n.dataset.tab === 'about-tab');
    assert.ok(hakkinda, 'Hakkinda dugmesi bulunamadi');
    assert.ok(dom.byId('about-tab'), 'Hakkinda paneli bulunamadi');
  });
});
