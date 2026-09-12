// Proje butunluk testleri: DOM id'leri, i18n anahtarlari, olu kod ve manifest.
// Bu testler v1.1.0'da elle yakalanan sinif hatalarin geri donmesini engeller:
// HTML'de olmayan id'ye baglanmak, tanimsiz ceviri anahtari kullanmak,
// kullanilmayan import/anahtar birakmak, kaldirilan API'ye geri donmek.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
/**
 * Bir <section id="..."> blogunu IC ICE section'lari sayarak cikarir.
 *
 * NEDEN: duz `indexOf('</section>')` ilk kapanisi bulur. Panelin icine bir
 * alt bolum eklendigi anda dilim erken kesilir ve o noktadan sonraki her sey
 * testlerden gizlenir - koruma sessizce yariya iner.
 */
function sectionById(html, id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at !== -1, `bolum bulunamadi: ${id}`);
  const start = html.lastIndexOf('<section', at);
  let depth = 0;
  const tag = /<(\/?)section\b/g;
  tag.lastIndex = start;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + '</section>'.length);
  }
  throw new Error(`kapanmamis bolum: ${id}`);
}

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const tr = (await import('../locales/tr.js')).default;
const en = (await import('../locales/en.js')).default;

const flattenKeys = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) =>
  (value && typeof value === 'object') ? flattenKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]);

function collectSourceFiles() {
  const files = [];
  // .cache: e2e testleri icin indirilen tarayici (npm run e2e:setup). Kendi
  // kaynaklarinda innerHTML vb. var; bunlar URUN KODU DEGIL. Taramaya girerse
  // butunluk testleri baska bir projenin kodu hakkinda hukum verir.
  // dist: paketlenmis cikti - ayni gerekce.
  const skipDirs = new Set(['node_modules', 'icons', '_locales', 'test', '.git', '.cache', 'dist']);
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(relative);
      } else if (entry.name.endsWith('.js') && entry.name !== 'psl.js') {
        files.push(relative);
      }
    }
  };
  walk('');
  return files;
}

/**
 * Verilen metni ICEREN kaynak dosyayi bulur.
 *
 * NEDEN: Korumalari dosya adina baglamak, kod tasindigi anda onlari sessizce
 * korumasiz birakiyor. lib/cleaner.js lib/purge/* altina bolundugunde tam bu
 * oldu. Artik "hangi dosyada" degil "hangi kod" sorusunu soruyoruz.
 */
function readFileContaining(needle) {
  const file = collectSourceFiles().find(f => read(f).includes(needle));
  assert.ok(file, `su kodu iceren dosya bulunamadi: ${needle}`);
  return stripComments(read(file));
}

/**
 * Bir sayfanin TUM kaynak dosyalarini birlestirir.
 *
 * NEDEN: options/options.js 1780 satirdan 47 satirlik bir giris noktasina
 * indi ve is mantigi options/ui/*, options/tabs/* altina tasindi. Korumalari
 * tek bir dosya adina baglamak, tasima aninda onlari sessizce korumasiz
 * birakiyor - bu oturumda ayni tuzaga uc kez dusuldu.
 */
function pageSources(dir) {
  return collectSourceFiles().filter(f => f.startsWith(dir + '/'));
}
function readPage(dir) {
  return pageSources(dir).map(f => read(f)).join('\n');
}

const PAGES = [
  { html: 'options/options.html', dir: 'options' },
  { html: 'popup/popup.html', dir: 'popup' }
];

describe('CSS degiskenleri TANIMLI', () => {
  // NEDEN VAR: popup.css `border-radius: var(--r)` yaziyordu ama --r diye bir
  // jeton yok (--r-sm/md/lg/full var). Tanimsiz degisken CSS'te HATA VERMEZ,
  // sessizce hiceye duser: kutunun kosesi 0 kaldi ve yuvarlak arayuzde tek
  // keskin kutu olarak durdu. Kullanici "bazi yerlerde border var bazilarinda
  // yok, garip duruyor" diye bildirdi. eslint ve audit:ui ikisi de kacirdi.
  const TEMA = 'ui/theme.css';
  const NL = String.fromCharCode(10);

  test('sayfa CSS inde kullanilan her --degisken temada tanimli', () => {
    const tanimli = new Set(
      [...read(TEMA).matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])
    );
    const eksik = new Map();
    for (const dosya of ['popup/popup.css', 'options/options.css', TEMA]) {
      // Yorumlari soy: yorum METNI icindeki var(--x) kullanim degildir.
      const src = read(dosya).replace(/\/\*[\s\S]*?\*\//g,
        m => m.split(NL).map(() => '').join(NL));
      for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!tanimli.has(m[1])) {
          const satir = src.slice(0, m.index).split(String.fromCharCode(10)).length;
          eksik.set(`${dosya}:${satir}  var(${m[1]})`, true);
        }
      }
    }
    assert.deepEqual([...eksik.keys()], [],
      `temada tanimsiz degisken kullanilmis: ${[...eksik.keys()].join(' | ')}`);
  });
});

describe('surum TEK MERKEZDEN geliyor', () => {
  // MERKEZ manifest.json: Chrome surumu zorunlu olarak orada tutuyor ve
  // arayuzun uc noktasi da onu okuyor (chrome.runtime.getManifest().version) -
  // options kenar cubugu, teshis paneli ve kural disa aktarimi.
  //
  // package.json ile dokuman basliklari ayri birer kopya tasimak zorunda
  // (npm ve markdown manifest okuyamaz). Kopya kacinilmaz; SESSIZ SAPMA
  // degil. Bu testler sapmayi gurultulu hale getiriyor.
  const manifestSurum = JSON.parse(read('manifest.json')).version;

  test('manifest surumu gecerli bicimde', () => {
    assert.match(manifestSurum, /^\d+\.\d+\.\d+$/, `bicim bozuk: ${manifestSurum}`);
  });

  test('package.json manifest ile ayni surumu tasiyor', () => {
    assert.equal(JSON.parse(read('package.json')).version, manifestSurum);
  });

  for (const dosya of ['CONTEXT.md', 'ARCHITECTURE.md']) {
    test(`${dosya} basligi manifest surumunu yaziyor`, () => {
      const satir = read(dosya).split(String.fromCharCode(10)).slice(0, 6).join(' ');
      const m = satir.match(/S(?:ü|u)r(?:ü|u)m\s+(\d+\.\d+\.\d+)/);
      assert.ok(m, `${dosya} ilk satirlarinda "Surum X.Y.Z" bulunamadi`);
      assert.equal(m[1], manifestSurum,
        `${dosya} ${m[1]} diyor, manifest ${manifestSurum}`);
    });
  }

  test('arayuz surumu SABIT GOMULU degil, manifest ten okunuyor', () => {
    for (const dosya of ['options/options.js', 'lib/sw/handlers.js', 'options/tabs/rules.js']) {
      const src = read(dosya);
      assert.doesNotMatch(src, /['"`]\d+\.\d+\.\d+['"`]/,
        `${dosya} icinde sabit surum dizesi var - getManifest kullanilmali`);
    }
  });
});

describe('tam tur GERCEKTEN tam', () => {
  // NEDEN VAR: bu surumde uc yeni e2e takimi eklendi (alarm, gozlemci,
  // erisim) ama tools/tam-tur.sh onlari bilmiyordu. "Tam tur" adi tasiyan
  // betik eksik kosuyordu ve bunu kimse fark etmezdi - denetimde cikti.
  test('package.json daki her test:e2e betigi tam turda kosuyor', () => {
    const pkg = JSON.parse(read('package.json'));
    const tur = read('tools/tam-tur.sh');

    // dayaniklilik BILINCLI olarak ayri kosar: 3 saat suruyor ve betigin
    // kendi yorumu bunu aciklikla yaziyor.
    const AYRI = new Set(['test:e2e:dayaniklilik']);

    const kosulan = new Set(
      tur.split(String.fromCharCode(10))
        .filter(satir => satir.trim().startsWith('kosu '))
        .map(satir => satir.trim().split(/\s+/)[2])
    );

    const beklenen = Object.keys(pkg.scripts)
      .filter(ad => ad.startsWith('test:e2e') && !AYRI.has(ad));

    const eksik = beklenen.filter(ad => !kosulan.has(ad));
    assert.deepEqual(eksik, [], `tam turda kosmayan takim: ${eksik.join(', ')}`);
  });

  test('tam turdaki her cagri package.json da tanimli', () => {
    const pkg = JSON.parse(read('package.json'));
    const tur = read('tools/tam-tur.sh');
    const kosulan = tur.split(String.fromCharCode(10))
      .filter(satir => satir.trim().startsWith('kosu '))
      .map(satir => satir.trim().split(/\s+/)[2]);
    const tanimsiz = kosulan.filter(ad => !pkg.scripts[ad]);
    assert.deepEqual(tanimsiz, [], `package.json da olmayan betik: ${tanimsiz.join(', ')}`);
  });
});

describe('paylasilan yuklem KOPYALANMAMIS', () => {
  // Istatistik listeleri ile "Listeleri temizle" AYNI yuklemle calismali:
  // biri "hangi kayit bir temizlik ozeti" derken oteki baska bir sey derse
  // liste ile silme birbirinden sapar. Yuklem lib/logger.js'te; arayuz onu
  // ICE AKTARMAK zorunda, yeniden yazmak degil.
  //
  // NEDEN VAR: bir ara yuklem logger'a tasindi ama insights.js kendi
  // kopyasini kullanmaya devam etti - denetimde yakalandi.
  test('insights.js temizlik ozeti yuklemini logger dan alir', () => {
    const src = read('options/tabs/insights.js');
    assert.match(src, /import \{[^}]*isCleanupSummary[^}]*\} from '\.\.\/\.\.\/lib\/logger\.js'/,
      'isCleanupSummary lib/logger.js ten ice aktarilmali');
    assert.doesNotMatch(src, /function\s+temizlikOzetiMi/,
      'yerel kopya YENIDEN yazilmis - logger dakiyle sapar');
  });

  test('yuklem lib/logger.js te TEK yerde tanimli', () => {
    const kaynaklar = ['lib/logger.js', 'lib/sw/handlers.js', 'options/tabs/insights.js',
      'options/tabs/logs.js', 'options/tabs/stats.js'];
    const tanim = kaynaklar.filter(f => /function\s+isCleanupSummary/.test(read(f)));
    assert.deepEqual(tanim, ['lib/logger.js'],
      `yuklem birden fazla yerde tanimli: ${tanim.join(', ')}`);
  });
});

describe('HTML yuvalamasi: etiketler DOGRU sirada kapaniyor', () => {
  // NEDEN VAR: iki ayar blogu betikle tasinirken her biri kapanis </div>'ini
  // kaybetti. Etiket SAYILARI denk kaldigi icin sayim tabanli bir kontrol
  // bunu goremedi; ama tarayici DOM'u yeniden kurdu ve Istatistik, Gunlukler,
  // Hakkinda panelleri <main>'in DISINA, dogrudan body'ye kacti. Uc sayfa
  // "acilmiyor" gorundu. Sayim degil YIGIN denetimi gerekiyordu.
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'col',
    'area', 'base', 'embed', 'track', 'wbr', 'path', 'circle', 'line', 'polyline',
    'polygon', 'rect', 'use', 'ellipse', 'g', 'defs', 'stop']);

  /** Yorumlari ve svg govdelerini SATIR SAYISINI KORUYARAK bosaltir. */
  const temizle = (html) => html
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/./g, ' '))
    .replace(/<svg[\s\S]*?<\/svg>/g, (m) => m.replace(/./g, ' '));

  for (const { html } of PAGES) {
    test(`${html} yuvalamasi tutarli`, () => {
      const src = temizle(read(html));
      const stack = [];
      const errors = [];
      for (const m of src.matchAll(/<(\/?)([a-zA-Z0-9!]+)([^>]*?)(\/?)>/g)) {
        const [, closing, rawName, , selfClosing] = m;
        const name = rawName.toLowerCase();
        if (VOID.has(name) || selfClosing || name.startsWith('!')) continue;
        const line = src.slice(0, m.index).split(String.fromCharCode(10)).length;
        if (!closing) {
          stack.push({ name, line });
          continue;
        }
        if (stack.length === 0) {
          errors.push(`satir ${line}: fazla </${name}>`);
        } else if (stack[stack.length - 1].name !== name) {
          const open = stack[stack.length - 1];
          errors.push(`satir ${line}: </${name}> geldi, acik olan <${open.name}> (satir ${open.line})`);
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].name === name) { stack.length = i; break; }
          }
        } else {
          stack.pop();
        }
      }
      assert.deepEqual(errors, [], `yuvalama hatasi: ${errors.join(' | ')}`);
      assert.deepEqual(stack.map(x => `<${x.name}> satir ${x.line}`), [], 'kapanmayan etiket');
    });
  }

  // Panellerin YERI de sozlesmenin parcasi: <main> disina cikan bir panel
  // gorunmez olur (olculdu: kaydirma sonrasi ekranda 0px).
  test('options: tum tab-panel ogeleri <main> icinde', () => {
    const src = read('options/options.html');
    const mainStart = src.indexOf('<main');
    const mainEnd = src.indexOf('</main>');
    assert.ok(mainStart > 0 && mainEnd > mainStart, '<main> bulunamadi');
    const panels = [...src.matchAll(/<section id="([a-z-]+-tab)"/g)];
    assert.ok(panels.length >= 6, `panel sayisi beklenenden az: ${panels.length}`);
    const outside = panels.filter(m => m.index < mainStart || m.index > mainEnd).map(m => m[1]);
    assert.deepEqual(outside, [], `<main> disinda kalan panel: ${outside.join(', ')}`);
  });
});

describe('DOM butunlugu', () => {
  for (const { html, dir } of PAGES) {
    test(`${dir}/ yalnizca ${html} icinde var olan id'lere baglanir`, () => {
      const ids = new Set([...read(html).matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
      const source = readPage(dir);
      const referenced = new Set([
        ...[...source.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
        ...[...source.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1])
      ]);
      const missing = [...referenced].filter(id => !ids.has(id));
      assert.deepEqual(missing, [], `HTML'de olmayan id: ${missing.join(', ')}`);
      assert.ok(referenced.size > 10, 'id referanslari toplanamadi');
    });

    test(`${html} icinde yinelenen id yok`, () => {
      const all = [...read(html).matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
      const seen = new Set();
      const duplicates = new Set();
      for (const id of all) {
        if (seen.has(id)) duplicates.add(id);
        seen.add(id);
      }
      assert.deepEqual([...duplicates], []);
    });
  }
});

describe('i18n butunlugu', () => {
  const defined = new Set(flattenKeys(tr));

  test('tr ve en paketleri ayni anahtarlari icerir', () => {
    const trKeys = new Set(flattenKeys(tr));
    const enKeys = new Set(flattenKeys(en));
    assert.deepEqual([...trKeys].filter(k => !enKeys.has(k)), [], 'en paketinde eksik');
    assert.deepEqual([...enKeys].filter(k => !trKeys.has(k)), [], 'tr paketinde eksik');
  });

  test('hicbir ceviri degeri bos degil', () => {
    const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) =>
      (value && typeof value === 'object')
        ? flatten(value, `${prefix}${key}.`)
        : [[`${prefix}${key}`, value]]);
    for (const [pack, name] of [[tr, 'tr'], [en, 'en']]) {
      for (const [key, value] of flatten(pack)) {
        assert.equal(typeof value, 'string', `${name}.${key} dize olmali`);
        assert.ok(value.trim().length > 0, `${name}.${key} bos`);
      }
    }
  });

  function collectUsedKeys() {
    const used = new Set();
    // Sabit dosya listesi KULLANMIYORUZ. service-worker.js modullere
    // bolundugunde BADGE_TITLE_KEYS lib/sw/constants.js'e tasindi ve bu
    // toplayici anahtarlari "olu" sanmaya basladi - yani koruma, dosya
    // tasindigi anda korumasiz kaldi. Tum kaynaklari tariyoruz.
    const jsFiles = collectSourceFiles().filter(f => !f.startsWith('locales/'));
    const patterns = [
      /\bt\('([a-zA-Z0-9_.]+)'/g,
      /(?:titleKey|messageKey|descKey|confirmKey):\s*'([a-zA-Z0-9_.]+)'/g,
      /'((?:options|popup|common|serviceWorker|contextMenu|badge)\.[a-zA-Z0-9_.]+)'/g
    ];
    for (const file of jsFiles) {
      const source = read(file);
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) used.add(match[1]);
      }
    }
    for (const { html } of PAGES) {
      for (const match of read(html).matchAll(/data-i18n(?:-[a-z]+)?="([a-zA-Z0-9_.]+)"/g)) {
        used.add(match[1]);
      }
    }
    return used;
  }

  test('kullanilan her anahtar tanimli', () => {
    const missing = [...collectUsedKeys()].filter(key => !defined.has(key));
    assert.deepEqual(missing, [], `tanimsiz anahtar: ${missing.join(', ')}`);
  });

  test('tanimli her anahtar kullaniliyor (olu ceviri yok)', () => {
    const used = collectUsedKeys();
    const unused = [...defined].filter(key => !used.has(key));
    assert.deepEqual(unused, [], `kullanilmayan anahtar: ${unused.join(', ')}`);
  });
});

describe('olu kod', () => {
  test('kullanilmayan import yok', () => {
    const problems = [];
    for (const file of collectSourceFiles()) {
      // Yorumlar ONCE atilir: icinde "import" gecen bir yorum, asagidaki
      // import-silme regex'ini tetikleyip gercek kodu yutuyordu.
      const source = stripComments(read(file));
      const names = [...source.matchAll(/import\s*\{([^}]+)\}\s*from/g)]
        .flatMap(match => match[1].split(',')
          .map(part => part.trim().split(/\s+as\s+/).pop().trim())
          .filter(Boolean));
      const body = source.replace(/import[^;]+;/g, '');
      for (const name of names) {
        if (!new RegExp(`\\b${name}\\b`).test(body)) problems.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('kaldirilan davranislar geri donmedi', () => {
  const sources = collectSourceFiles().concat(['manifest.json']);
  const forbidden = [
    ['chrome.webRequest kullanimi', /chrome\.webRequest/],
    ['webRequest izni', /"webRequest"/],
    ['eski ghostPurgeDomain', /ghostPurgeDomain/],
    ['10.000 kayit siniri', /maxResults:\s*10000/],
    ['kural icinde yerelleştirilmis sure metni', /durationLabel:/]
  ];

  for (const [label, pattern] of forbidden) {
    test(label, () => {
      const hits = sources.filter(file => pattern.test(stripComments(read(file))));
      assert.deepEqual(hits, [], `${label} halen var: ${hits.join(', ')}`);
    });
  }

  test('origin bazli browsingData cagrisina cookies verilmiyor', () => {
    // Chrome, origins filtresiyle cerezleri kayit edilebilir alan adi genelinde
    // siler; korumali komsu alan adlarinin cerezlerini goturur.
    const src = readFileContaining('function storageTypesFor');
    const typesBlock = src.slice(src.indexOf('function storageTypesFor'));
    const body = typesBlock.slice(0, typesBlock.indexOf('\n}'));
    assert.ok(!/\bcookies\s*[:=]/.test(body), 'storageTypesFor cookies icermemeli');
  });

  test('teshis loglari diske yazilmiyor', () => {
    const logger = read('lib/logger.js');
    assert.ok(logger.includes('chrome.storage.session'), 'oturum depolamasi kullanilmali');
    assert.ok(!/storage\.local\.set\(\{\s*\[LOGS_STORAGE_KEY\]/.test(logger));
  });
});

describe('dokuman dogrulugu', () => {
  // v2.0.1'e kadar dokumanlar "HTTP onbellegi site bazinda silinemez" diyordu.
  // Yanlisti (Chromium: kFilterableDataTypes = DATA_TYPE_SITE_DATA |
  // DATA_TYPE_CACHE) ve bu yanlis varsayim yuzunden silinen sitelerin
  // onbellege alinmis kaynaklari diskte kaliyordu.
  // Dil dosyalari da taranir: iddia bir ara YALNIZCA locales/tr.js icinde
  // "site bazinda silmeye izin vermez" seklinde hayatta kalmisti - dokumanlari
  // tarayip arayuz metinlerini atlamak bu sinif hatayi kacirir.
  const DOCS = [
    'ARCHITECTURE.md', 'CONTEXT.md', 'CHROMEWEBSTORE.md',
    'locales/tr.js', 'locales/en.js'
  ];
  const STALE_CLAIMS = [
    'site bazinda silinemez', 'site bazında silinemez', 'Site bazında silinemez',
    'site bazında silmeye izin vermez', 'site bazinda silmeye izin vermez',
    'does not allow per-site', 'cannot be cleared per-site'
  ];


  // URUN KODU da taranir - ucuncu kez ayni iddia, ucuncu farkli sakland?g? yer:
  // once dokumanlarda, sonra locales/tr.js icinde, sonra lib/storage.js
  // yorumunda. Yorumu "dokumantasyon degil" sayip atlamak bu sinif hatanin
  // tekrarlamasina izin veriyor: ayarin yanindaki yorum, o ayari okuyan herkes
  // icin gecerli bir gerekce gibi durur.
  //
  // TARIHSEL anlatim mesru: "uzun sure X sanildi; yanlisti" cumlesi iddiayi
  // ONAYLAMIYOR, curutuyor. Bu yuzden iddiayi ayni veya bir sonraki satirda
  // curuten bir isaret varsa satir gecerli sayilir.
  // Sabit liste yerine tum urun kodu: service-worker.js modullere bolundugunde
  // (lib/sw/*) sabit liste yeni dosyalari atlardi.
  const CODE_FILES = collectSourceFiles()
    .filter(f => !f.startsWith('locales/') && !f.startsWith('tools/'));
  const REFUTATIONS = ['sanildi', 'yanlis', 'yanlış', 'degil', 'değil', 'artik', 'artık'];

  test('yanlis onbellek iddiasi URUN KODU yorumlarinda da yasamiyor', () => {
    const CODE_CLAIMS = [...STALE_CLAIMS, 'origin bazinda silinemez', 'origin bazında silinemez'];
    for (const file of CODE_FILES) {
      const lines = read(file).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const claim = CODE_CLAIMS.find(c => lines[i].includes(c));
        if (!claim) continue;
        const window = `${lines[i]} ${lines[i + 1] || ''}`.toLowerCase();
        const refuted = REFUTATIONS.some(r => window.includes(r));
        assert.ok(refuted,
          `${file}:${i + 1} eskimis iddiayi GERCEK gibi yaziyor: "${claim}"`);
      }
    }
  });

  test('onbellek hakkindaki yanlis iddia dokumanlara geri donmedi', () => {
    for (const doc of DOCS) {
      const text = read(doc);
      for (const claim of STALE_CLAIMS) {
        assert.equal(text.includes(claim), false, `${doc} icinde eskimis iddia: "${claim}"`);
      }
    }
  });

  test('storageTypesFor cache tasir, filtrelenemeyen tur tasimaz', () => {
    const src = readFileContaining('function storageTypesFor');
    const start = src.indexOf('function storageTypesFor');
    assert.ok(start > 0, 'storageTypesFor bulunamadi');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);

    assert.match(body, /\bcache:\s*true/, 'cache: true bulunmali');
    // Bu turler kFilterableDataTypes icinde degil; origins ile birlikte
    // gonderilirse Chrome cagrinin TAMAMINI reddeder.
    for (const forbidden of ['cookies', 'history', 'downloads', 'formData', 'passwords', 'webSQL']) {
      assert.doesNotMatch(body, new RegExp('\\b' + forbidden + ':'),
        `${forbidden} origin filtresiyle gonderilemez`);
    }
  });

  test('levelOfControl tam enum ele aliniyor', () => {
    const privacy = read('lib/privacy.js');
    for (const level of ['not_controllable', 'controlled_by_other_extensions',
      'controllable_by_this_extension', 'controlled_by_this_extension']) {
      assert.ok(privacy.includes(level), `eksik levelOfControl degeri: ${level}`);
    }
  });
});


describe('2.8: service worker olay kaydi disiplini', () => {
  // MV3'te olay dinleyicileri service worker'in EN UST duzeyinde, senkron
  // kaydedilmelidir. Modul duzeyinde `await` kullanmak veya dinleyiciyi bir
  // fonksiyon icine gommek, worker uyandiginda olayin kacirilmasina yol acar.
  const SW = 'service-worker.js';

  test('modul duzeyinde top-level await yok', () => {
    for (const file of ['service-worker.js', ...collectSourceFiles().filter(f => f.startsWith('lib/'))]) {
      const src = stripComments(read(file));
      // Sutun 0'da baslayan `await` = modul duzeyi
      assert.doesNotMatch(src, /^await\s/m, `${file} icinde modul duzeyinde await var`);
      assert.doesNotMatch(src, /^const\s+\w+\s*=\s*await\s/m, `${file} icinde modul duzeyinde await atamasi var`);
    }
  });

  test('tum chrome.*.addListener cagrilari SENKRON ilk degerlendirmede kayitli', () => {
    // Kural: dinleyici, worker'in ILK degerlendirmesinde senkron kaydedilmeli.
    // Sutun 0 bunun en yaygin bicimi ama TEK bicimi degil: en ust duzeyde
    // KOSULSUZ cagrilan bir fonksiyonun icindeki kayit da ayni garantiyi verir.
    //
    // Bu ayrim SART, cunku OPSIYONEL izinli bir API (contextMenus) sutun 0'da
    // henuz var OLMAYABILIR. Kullanici izni sonradan verdiginde API o an
    // olusuyor; optional chaining ile yazilmis sutun 0'daki bir kayit o
    // pencerede hicbir dinleyici baglamiyordu - menu goruluyor ama tiklama
    // calismiyordu. Dogru cozum kaydi bir fonksiyona alip hem sutun 0'dan hem
    // permissions.onAdded'dan cagirmak; test bunu gorebilmeli, yoksa dogru
    // cozumu reddedip yanlisa zorlar.
    const src = stripComments(read(SW));
    const lines = src.split('\n');

    // En ust duzeyde KOSULSUZ cagrilan fonksiyon adlari: `ad();`
    const topLevelCalls = new Set(
      [...src.matchAll(/^(\w+)\(\);?$/gm)].map(m => m[1])
    );

    const offenders = [];
    let currentFn = null;
    let depth = 0;

    lines.forEach((line, index) => {
      const fnStart = line.match(/^(?:async\s+)?function\s+(\w+)\s*\(/);
      if (fnStart && depth === 0) currentFn = fnStart[1];

      const girintili = /\.addListener\(/.test(line)
        && /^\s*chrome\./.test(line)
        && !/^chrome\./.test(line);
      if (girintili && (!currentFn || !topLevelCalls.has(currentFn))) {
        offenders.push(`${index + 1}: ${line.trim().slice(0, 60)} (${currentFn || 'kapsamsiz'})`);
      }

      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) { depth = 0; currentFn = null; }
    });

    assert.deepEqual(offenders, [],
      'chrome olay dinleyicisi ya sutun 0-da ya da en ust duzeyde KOSULSUZ cagrilan bir fonksiyonda olmali');
  });

  test('optional chaining ile kaydedilen dinleyiciler sessiz kalmaz', () => {
    // chrome.commands?.onCommand?.addListener API yoksa HICBIR SEY yapmaz.
    // Teshis loglarinda bunun goruluyor olmasi gerekir.
    const src = read(SW);
    const optionalRegistrations = [...src.matchAll(/^chrome\.(\w+)\?\./gm)].map(m => m[1]);
    for (const api of new Set(optionalRegistrations)) {
      const guard = new RegExp(`if \\(!chrome\\.${api}\\?`);
      assert.match(src, guard,
        `chrome.${api} optional chaining ile kaydediliyor ama API yoksa uyari verilmiyor`);
    }
  });

  test('storage erisim seviyesi sertlestirmesi baslangic yolunda', () => {
    // lightBootstrap service-worker.js'ten lib/sw/bootstrap.js'e tasindi;
    // dosya adina bagli arama tasima aninda korumasiz kalir. Fonksiyonun
    // hangi dosyada oldugunu SABITLEMEK yerine ariyoruz.
    const file = collectSourceFiles()
      .find(f => read(f).includes('async function lightBootstrap'));
    assert.ok(file, 'lightBootstrap tanimi bulunamadi');

    const src = read(file);
    assert.match(src, /setAccessLevel/, 'setAccessLevel cagrilmali');
    assert.match(src, /TRUSTED_CONTEXTS/, 'TRUSTED_CONTEXTS kullanilmali');
    // lightBootstrap her SW uyanisinda calisir; idempotent oldugu icin dogru yer.
    const bootstrapStart = src.indexOf('async function lightBootstrap');
    const bootstrapBody = src.slice(bootstrapStart, src.indexOf('\n}', bootstrapStart));
    assert.match(bootstrapBody, /hardenStorageAccess/, 'lightBootstrap icinde cagrilmali');
  });

  test('originTypes yalnizca origins filtreli cagrida, extension ASLA', () => {
    // Yorumlari cikar: aciklama metninde gecen "extension: true" ifadesi
    // gercek bir kullanim degil.
    // originTypes hedefli cagriyla ayni dosyada; excludeOrigins ise toplu
    // akista - bolunmeden sonra bunlar AYRI dosyalarda olabilir.
    // Aranan sey KOD, kelime degil. Yalin 'originTypes' ile arasak bu sapmayi
    // aciklayan bir YORUM da eslesir; readFileContaining yorumlari ayikladigi
    // icin sonuc bos cikar ve test kodu degil kendini yakalar.
    const targeted = readFileContaining('originTypes: { unprotectedWeb');
    assert.match(targeted, /originTypes:\s*\{\s*unprotectedWeb:\s*true,\s*protectedWeb:\s*true\s*\}/,
      'hedefli cagri protectedWeb icermeli');

    // extension:true HICBIR kaynak dosyada olmamali (kendi verimizi siler).
    for (const file of collectSourceFiles()) {
      assert.doesNotMatch(stripComments(read(file)), /extension:\s*true/,
        `${file}: originTypes.extension:true kendi verimizi ve diger eklentileri yok eder`);
    }

    // excludeOrigins yolunda originTypes OLMAMALI.
    //
    // Yorumlar burada da ayiklanir - ustteki extension:true kontrolunun ayni
    // gerekcesiyle. Bu sapmanin NEDEN bilincli oldugunu anlatan yorum tam da
    // cagrinin basinda duruyor ve durmali: onu yasaklamak, bir sonraki
    // okuyucunun "tutarsizlik" sanip duzeltmesine davetiye olur.
    const bulk = readFileContaining('excludeOrigins: protectedOrigins');
    const bulkStart = bulk.indexOf('excludeOrigins: protectedOrigins');
    assert.ok(bulkStart > 0, 'toplu cagri bulunamadi');
    const bulkCall = bulk.slice(bulkStart - 200, bulkStart + 200);
    assert.doesNotMatch(bulkCall, /originTypes/,
      'excludeOrigins ile originTypes birlikte kullanilmamali');
  });
});

describe('JS in kullandigi durum siniflari CSS te TANIMLI', () => {
  // Bir sinifi JS'ten eklemek onu GORUNUR yapmaz. `is-locked` yalnizca
  // .toggle-list icin tanimliydi; settings.js onu .toggle-item'a ekleyince
  // sinif uygulaniyor ama HICBIR SEY degismiyordu - kutu tipatip aktif
  // gorunup sessizce tiklamayi reddediyordu. Olculmeden fark edilmedi.
  const css = read('options/options.css');

  const STATE_CLASSES = [
    ['.toggle-item.is-locked', 'bagli ayar satiri kilitliyken solmali'],
    ['.toggle-list.is-locked', 'sertlestirme listesi izinsizken solmali']
  ];

  for (const [selector, why] of STATE_CLASSES) {
    test(`${selector} tanimli`, () => {
      // Selector'de yalnizca nokta var; kacisi dar tutuyoruz ki regex
      // kendisi bir hata kaynagina donusmesin.
      const escaped = selector.split('.').join('\\.');
      assert.match(css, new RegExp(escaped + '\\s*\\{'), why);
    });
  }
});

describe('manifest', () => {
  const manifest = JSON.parse(read('manifest.json'));

  test('surum ve manifest semasi', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.type, 'module');
    assert.ok(Number.parseInt(manifest.minimum_chrome_version, 10) >= 119,
      'CHIPS partitionKey icin en az Chrome 119 gerekir');
  });

  test('gizli mod karari ACIKCA beyan edilmis', () => {
    // Alani bos birakmak "karar vermedik" demektir. spanning bilincli secim:
    // service worker normal profilde calisir ve gizli sekmeleri isMangedTab()
    // ile atlar. split iki ayri SW/alarm/sekme haritasi demek olurdu ve
    // storage.local her zaman paylasildigi icin gizli gezinti istatistikleri
    // DISKE yazilirdi - teshis loglarini storage.session'da tutma kararini
    // dogrudan baltalar.
    assert.equal(manifest.incognito, 'spanning');
  });

  test('kullanici listelerine dokunan izinler ISTENMEZ', () => {
    // Kullanicinin kasten kaydettigi icerik silinmez; izni hic istemiyoruz.
    const all = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
    for (const forbidden of ['bookmarks', 'readingList', 'sessions', 'topSites']) {
      assert.ok(!all.includes(forbidden), `${forbidden} izni istenmemeli`);
    }
  });

  test('hassas yetkiler opsiyonel', () => {
    assert.ok(!manifest.permissions.includes('webRequest'));
    assert.ok(manifest.permissions.includes('scripting'));
    for (const optional of ['privacy', 'contextMenus']) {
      assert.ok(manifest.optional_permissions.includes(optional), `${optional} opsiyonel olmali`);
      assert.ok(!manifest.permissions.includes(optional), `${optional} zorunlu olmamali`);
    }
  });

  test('adi gecen tum dosyalar mevcut', () => {
    const referenced = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      manifest.options_ui.page,
      ...Object.values(manifest.icons),
      'content/trace-observer.js'
    ];
    for (const file of referenced) {
      assert.doesNotThrow(() => read(file), `eksik dosya: ${file}`);
    }
  });

  test('_locales manifest mesajlarini karsilar', () => {
    const usedMessages = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map(m => m[1]);
    for (const locale of ['tr', 'en']) {
      const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
      for (const key of usedMessages) {
        assert.ok(messages[key], `_locales/${locale} icinde eksik: ${key}`);
      }
    }
  });
});

describe('icerik script i', () => {
  test('modul import etmez (icerik script leri ESM desteklemez)', () => {
    const source = read('content/trace-observer.js');
    assert.ok(!/^\s*import\s/m.test(source), 'icerik script i import kullanmamali');
  });

  test('agir PSL verisini sayfaya yuklemez', () => {
    assert.ok(!read('content/trace-observer.js').includes('psl'));
  });
});

describe('ceviri yer tutuculari', () => {
  test('her yer tutucu icin parametre geciliyor', () => {
    // Bu test "{domain}" gibi bir metnin ekranda ham gorunmesini engeller.
    const sources = collectSourceFiles().filter(f => !f.startsWith('locales/'));
    const calls = new Map();

    const addNames = (key, body) => {
      const names = new Set([
        // { domain: x, count: y }
        ...[...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1]),
        // { domain, count }  (kisayol)
        ...[...body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=,|$)/g)].map(m => m[1])
      ]);
      const existing = calls.get(key) || new Set();
      for (const name of names) existing.add(name);
      calls.set(key, existing);
    };

    /** Dengeli suslu parantez blogunun govdesini okur. */
    const readObjectBody = (src, openIndex) => {
      let depth = 0;
      for (let i = openIndex; i < Math.min(openIndex + 800, src.length); i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(openIndex + 1, i);
      }
      return null;
    };

    /** key'den sonra gelen `params: { ... }` govdesini bulur. */
    const addParamsAfter = (src, index, key) => {
      const rest = src.slice(index, index + 500);
      const paramsAt = rest.indexOf('params:');
      if (paramsAt === -1) return;
      const braceAt = rest.indexOf('{', paramsAt);
      if (braceAt === -1) return;
      const body = readObjectBody(rest, braceAt);
      if (body !== null) addNames(key, body);
    };

    for (const file of sources) {
      const src = read(file);

      // t('key', { ... })
      for (const match of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\s*,\s*\{/g)) {
        const body = readObjectBody(src, match.index + match[0].length - 1);
        if (body !== null) addNames(match[1], body);
      }

      // notify({ messageKey: 'key', params: { ... } })
      for (const match of src.matchAll(/messageKey:\s*'([a-zA-Z0-9_.]+)'/g)) {
        addParamsAfter(src, match.index, match[1]);
      }

      // openConfirm({ titleKey/descKey: 'key', ..., params: { ... } })
      for (const match of src.matchAll(/(?:descKey|titleKey):\s*'([a-zA-Z0-9_.]+)'/g)) {
        addParamsAfter(src, match.index, match[1]);
      }
    }

    assert.ok(calls.size > 20, `cagri yerleri toplanamadi (${calls.size})`);

    const lookup = (pack, key) => key.split('.').reduce((node, part) => node && node[part], pack);
    const problems = [];

    for (const [name, pack] of [['tr', tr], ['en', en]]) {
      for (const [key, params] of calls) {
        const template = lookup(pack, key);
        if (typeof template !== 'string') continue;
        for (const match of template.matchAll(/\{(\w+)\}/g)) {
          if (!params.has(match[1])) problems.push(`${name}.${key} -> {${match[1]}}`);
        }
      }
    }
    assert.deepEqual(problems, [], `karsiliksiz yer tutucu: ${problems.join(', ')}`);
  });
});

describe('2.9 sozlesmesi: kural yazma hatasi arayuzde ayirt edilir', () => {
  test('arayuz iki durumu AYRI mesajla gosterir', () => {
    // Bu bir sozlesme testi: options.js ve popup.js, INVALID_DOMAIN'i diger
    // hatalardan ayirt etmek ZORUNDA. Ayirt etmezlerse yukaridaki iki testin
    // sagladigi bilgi arayuze hic ulasmaz.
    assert.match(readPage('options'), /INVALID_DOMAIN/,
      'options sayfasi SET_RULE hatasini ayirt etmiyor');
    assert.match(readPage('popup'), /INVALID_DOMAIN/,
      'popup SET_RULE hatasini ayirt etmiyor');
  });
});

describe('sinirlama 6 sozlesmesi: arayuz izin sildigini iddia etmez', () => {
  const FALSE_CLAIMS = [
    'Site izinleri sıfırlandı',
    'tüm siteler için varsayılana dönecek',
    'Tüm site izinlerini sıfırla',
    'Site permissions were reset',
    'will return to default for all sites'
  ];

  test('yanlis "izin sildim" iddialari dil dosyalarinda yok', () => {
    for (const file of ['locales/tr.js', 'locales/en.js']) {
      const src = read(file);
      for (const claim of FALSE_CLAIMS) {
        assert.equal(src.includes(claim), false,
          `${file} eklentinin YAPAMADIGI seyi iddia ediyor: "${claim}"`);
      }
    }
  });

  test('privacy.js gercek sinirlamayi yaziyor', () => {
    const src = read('lib/privacy.js');
    assert.match(src, /set by this extension|eklentinin(\s+kendi)?\s+yazd/i,
      'clear() kapsaminin gerekcesi kodda yazili olmali');
  });
});

describe('contentSettings izni ISTENMEZ (calistirilamayan ozellik)', () => {
  // Chrome, eklentilerin kendi yazmadigi izin kaydini silmesine izin vermiyor.
  // clear() yalnizca eklentinin kendi kurallarini kapsiyor ve GhostTrace hic
  // kural yazmiyor -> izin hicbir sey yapmiyordu. Kullanicidan hicbir ise
  // yaramayan bir izin istemek, bir gizlilik eklentisi icin savunulamaz.
  //
  // v2.7.0: "Site izinleri" bolumu de KALDIRILDI. Kullaniciya "bunu
  // yapamiyorum, Chrome'un ayarlarina git" demekten baska bir sey yapmiyordu;
  // ayarlar sayfasinda yer kaplayip kullaniciyi disari atiyordu. Izin
  // istenmedigi ve API kullanilmadigi hala korunuyor.
  const manifest = JSON.parse(read('manifest.json'));

  test('manifest hicbir yerde contentSettings istemiyor', () => {
    const all = [
      ...(manifest.permissions || []),
      ...(manifest.optional_permissions || [])
    ];
    assert.ok(!all.includes('contentSettings'),
      'calistirilamayan ozellik icin izin istenmemeli');
  });

  test('urun kodunda chrome.contentSettings kullanimi yok', () => {
    for (const file of collectSourceFiles()) {
      const src = stripComments(read(file));
      assert.ok(!/chrome\.contentSettings/.test(src),
        `${file} hala chrome.contentSettings kullaniyor`);
    }
  });
});

describe('XSS yuzeyi: innerHTML yazma noktasi yok', () => {
  // lib/i18n.js icinde `data-i18n-html` baglamasi vardi ve el.innerHTML'e
  // yaziyordu. HICBIR html dosyasi bu niteligi kullanmiyordu - yani kullanilmayan
  // bir enjeksiyon noktasiydi.
  //
  // Neden kaldirildi: ceviri metinleri yer tutucu ALABILIYOR ({domain} gibi) ve
  // yer tutucuya giden veri site kaynaklidir. Ileride biri dusunmeden
  // data-i18n-html ekler ve o anahtar bir alan adi enterpole ederse, kotu
  // niyetli bir alan adi dogrudan HTML'e girer. Kullanilmayan bir yetenek icin
  // bu risk tasinmaz.
  test('i18n DOM baglamalari innerHTML kullanmiyor', () => {
    const src = read('lib/i18n.js');
    const start = src.indexOf('const DOM_BINDINGS');
    assert.ok(start > 0, 'DOM_BINDINGS bulunamadi');
    const table = src.slice(start, src.indexOf('];', start));
    assert.ok(!table.includes('innerHTML'),
      'ceviri baglamasi innerHTML yazmamali; textContent kullanilmali');
    assert.ok(!table.includes('data-i18n-html'), 'data-i18n-html baglamasi kaldirilmali');
  });

  test('hicbir sayfa data-i18n-html kullanmiyor', () => {
    for (const { html } of PAGES) {
      assert.ok(!read(html).includes('data-i18n-html'),
        `${html} kaldirilan baglamayi kullaniyor`);
    }
  });

  test('urun kodunda baska innerHTML yazimi yok (ikon sablonu haric)', () => {
    for (const file of collectSourceFiles()) {
      const src = stripComments(read(file));
      const hits = [...src.matchAll(/\.innerHTML\s*=/g)];
      for (const hit of hits) {
        // Tek mesru kullanim: sabit ikon tablosu (kullanici verisi icermez).
        const around = src.slice(Math.max(0, hit.index - 400), hit.index + 200);
        assert.ok(/ICON_PATHS/.test(around),
          `${file}: innerHTML yazimi yalnizca sabit ikon sablonunda olabilir`);
      }
    }
  });
});

describe('2026 dayanikliligi: kirilgan Chrome API cagrilari korumali', () => {
  // NEDEN: Chrome bir API'yi kaldirdiginda korumasiz cagri TypeError atar ve
  // o kod yolu tamamen coker. Surum numarasina gore dallanmak da yanlis
  // (kullanicinin surumu bilinmez, Chrome takvimi kayar); dogru yol YETENEK
  // TESPITI. Asagidaki yuzeyler ya Chrome tarafindan kaldirilmakta, ya
  // opsiyonel izne bagli, ya da surum kapisi olan yuzeyler.
  //
  // Chrome'un fiilen kaldirdiklari: browsingData `passwords` (144),
  // `webSQL`/`appcache` (152); Privacy Sandbox anahtarlari (topics/fledge/
  // adMeasurement) sunset surecinde.
  const FRAGILE = [
    'privacy',                    // opsiyonel izin + Privacy Sandbox sunset
    'browsingData.settings',      // gec eklendi, her surumde yok
    'action.setBadgeTextColor',   // Chrome 110+
    'storage.local.setAccessLevel', // Chrome 102+
    'storage.session',            // MV3, eski surumlerde yok
    'contextMenus',               // opsiyonel izne bagli -> tanimsiz olabilir
    'scripting',                  // MV3
    'notifications',
    'permissions',
    'commands',
    'downloads'
  ];

  const isFragile = (path) => FRAGILE.some(f => path === f || path.startsWith(f + '.'));

  test('her kirilgan cagri optional chaining, varlik kontrolu veya try/catch icinde', () => {
    const unguarded = [];

    for (const file of collectSourceFiles()) {
      const raw = read(file);
      // Yorumlari satir sayisini bozmadan cikar
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '');
      const lines = src.split('\n');

      lines.forEach((line, index) => {
        for (const match of line.matchAll(/chrome\.([A-Za-z_$][\w.$?]*?)\s*\(/g)) {
          const path = match[1].replace(/\?/g, '');
          if (!isFragile(path)) continue;

          // 1) Cagrinin kendisinde optional chaining
          if (match[0].includes('?.')) continue;

          // 2) Ayni satirda veya yukarida varlik kontrolu / try blogu
          const from = Math.max(0, index - 40);
          const window = lines.slice(from, index + 1).join('\n');
          const root = path.split('.')[0];
          const leaf = path.split('.').pop();
          const guarded =
            new RegExp(`chrome\\.${root}\\?\\.`).test(window) ||
            new RegExp(`typeof chrome\\.[\\w.?]*${leaf}`).test(window) ||
            new RegExp(`if\\s*\\(\\s*!?\\s*chrome\\.${root}`).test(window) ||
            /\btry\s*\{/.test(window);
          if (guarded) continue;

          unguarded.push(`${file}:${index + 1} chrome.${path}`);
        }
      });
    }

    assert.deepEqual(unguarded, [],
      `Kirilgan API korumasiz cagriliyor. Chrome bu yuzeyi kaldirirsa o kod yolu coker:\n  ${unguarded.join('\n  ')}`);
  });

  test('surum numarasina gore dallanma YOK (yetenek tespiti kullanilir)', () => {
    // Surum kapisi kirilgan: kullanicinin surumu bilinmez ve Chrome takvimi
    // kayar. Kod her yerde "bu API var mi" diye sorar, "surum kac" diye degil.
    for (const file of collectSourceFiles()) {
      const src = stripComments(read(file));
      assert.doesNotMatch(src, /Chrome\s*>=?\s*1\d\d/,
        `${file}: surum karsilastirmasi yerine yetenek tespiti kullanilmali`);
      assert.doesNotMatch(src, /navigator\.userAgentData?\s*\.\s*brands/,
        `${file}: surum tespiti icin userAgent okunmamali`);
    }
  });

  test('browsingData cagrilarinda Chrome kaldirdigi turler YOK', () => {
    // passwords Chrome 144'te, webSQL/appcache 152'de yok sayiliyor.
    // Gonderilmeleri zararsiz gorunur ama filtreli cagrida TAMAMINI reddeder.
    // Chrome dokumanindan dogrulanmis kaldirma listesi (2026-08):
    //   pluginData (88), serverBoundCertificates (76),
    //   passwords (144), webSQL (152), appcache (152)
    const REMOVED = ['passwords', 'webSQL', 'appcache', 'pluginData',
      'serverBoundCertificates'];
    for (const file of collectSourceFiles()) {
      const src = stripComments(read(file));
      if (!src.includes('browsingData')) continue;
      for (const type of REMOVED) {
        assert.doesNotMatch(src, new RegExp(`\\b${type}\\s*:\\s*true`),
          `${file}: Chrome'un kaldirdigi "${type}" turu gonderiliyor`);
      }
    }
  });
});

describe('arayuzde sunulan her log seviyesi GERCEKTEN farkli sonuc uretir', () => {
  // Arayuz "Ayrintili" (debug) diye bir seviye sunuyordu ama hicbir kod yolu
  // debug kaydi uretmiyordu; o secenek "Normal" ile birebir ayni sonucu
  // veriyordu. Bir seyi yapiyormus gibi gorunen ayar bu projede tekrar tekrar
  // temizlenen hata sinifi - bu test tekrarini engelliyor.

  test('HTML secenekleri LOG_LEVELS ile birebir ayni', () => {
    const html = read('options/options.html');
    const start = html.indexOf('id="selectLogLevel"');
    assert.ok(start > 0, 'log seviyesi secici bulunamadi');
    const block = html.slice(start, html.indexOf('</select>', start));
    const offered = [...block.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);

    const storage = read('lib/storage.js');
    const listed = storage.match(/export const LOG_LEVELS = \[([^\]]*)\]/);
    assert.ok(listed, 'LOG_LEVELS bulunamadi');
    const allowed = [...listed[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

    assert.deepEqual(offered.slice().sort(), allowed.slice().sort(),
      `arayuz ve kod ayni seviyeleri tanimali.\n  arayuz: ${offered.join(', ')}\n  kod   : ${allowed.join(', ')}`);
  });

  test('her seviye adi ENTRY_RANK esiginde bir karsilik buluyor', () => {
    const logger = read('lib/logger.js');
    const rank = logger.match(/const LEVEL_RANK = \{([^}]*)\}/);
    assert.ok(rank, 'LEVEL_RANK bulunamadi');
    const names = [...rank[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]);

    // off haric her ayar seviyesi icin en az bir kayit turu gecmeli
    const entryRank = logger.match(/const ENTRY_RANK = \{([\s\S]*?)\n\};/);
    assert.ok(entryRank, 'ENTRY_RANK bulunamadi');
    const maxEntry = Math.max(...[...entryRank[1].matchAll(/:\s*(\d+)/g)].map(m => Number(m[1])));

    for (const name of names) {
      if (name === 'off') continue;
      const value = Number(rank[1].match(new RegExp(name + '\\s*:\\s*(\\d+)'))[1]);
      assert.ok(value <= maxEntry,
        `"${name}" seviyesi hicbir kayit turunu gecirmiyor (esik ${value}, en yuksek kayit ${maxEntry}). ` +
        'Kullaniciya farkli sonuc verecegini ima eden ama vermeyen bir secenek.');
    }
  });

  test('LogLevel sabitlerinin hepsi bir yerden uretiliyor', () => {
    const logger = read('lib/logger.js');
    const block = logger.match(/export const LogLevel = Object\.freeze\(\{([^}]*)\}\)/);
    assert.ok(block, 'LogLevel bulunamadi');
    const levels = [...block[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]);

    const allSources = collectSourceFiles().map(f => stripComments(read(f))).join('\n');
    for (const level of levels) {
      assert.match(allSources, new RegExp(`LogLevel\\.${level}\\b`),
        `LogLevel.${level} hicbir yerde kullanilmiyor - olu seviye`);
    }
  });
});

describe('loglar sekmesi: kayma ureten kaliplar geri donmedi', () => {
  // Kullanici "tasarimsal olarak kaymalar vardi" dedi. Olculen alti sebep:
  //   1. th'lere piksel genislik verilmis ama table-layout:fixed yok ->
  //      tarayici kolon genisliklerini her satirda yeniden hesapliyor.
  //   2. Ayrinti <pre> acilip kapandiginda ayni yeniden hesaplama.
  //   3. overflow-y:auto -> kaydirma cubugu gelip gidince yatay kayma.
  //   4. max-height iki yerde tanimli (CSS 560, satir ici 520) - cakisma.
  //   5. Bos durum tablonun yaninda -> loglar gelince dusey ziplama.
  //   6. Bes tam metinli dugme; dar pencerede ongorulemez sarma.
  const html = read('options/options.html');
  const css = read('options/options.css');
  const logsTab = sectionById(html, 'logs-tab');

  test('log tablosu SABIT yerlesim ve colgroup kullaniyor', () => {
    assert.match(css, /\.log-data-table\s*\{[^}]*table-layout:\s*fixed/,
      'table-layout: fixed olmadan kolonlar icerige gore yeniden hesaplanir');
    assert.match(logsTab, /<colgroup>/,
      'kolon genislikleri colgroup ile verilmeli');
    assert.doesNotMatch(logsTab, /<th[^>]*style="[^"]*width/,
      'th uzerinde satir ici genislik sabit yerlesimle cakisir');
  });

  test('konsol SABIT yukseklik + her zaman gorunur kaydirma olugu', () => {
    const block = css.slice(css.indexOf('.log-console-wrap {'));
    const rule = block.slice(0, block.indexOf('}'));
    assert.match(rule, /height:/, 'sabit yukseklik olmali');
    assert.doesNotMatch(rule, /max-height:/,
      'max-height kart yuksekliginin satirlarla buyumesine yol acar');
    assert.ok(/overflow-y:\s*scroll/.test(rule) || /scrollbar-gutter:\s*stable/.test(css),
      'kaydirma cubugu gelip giderken yatay kayma olmamali');
  });

  test('bos durum konsolun ICINDE (kaplama), yaninda degil', () => {
    const consoleStart = logsTab.indexOf('log-console-card');
    const emptyStart = logsTab.indexOf('id="emptyLogsState"');
    assert.ok(consoleStart > 0 && emptyStart > consoleStart,
      'bos durum konsol kartinin icinde olmali');
    assert.match(logsTab, /id="emptyLogsState"[^>]*log-empty-overlay/,
      'kaplama sinifi olmali; yoksa bos/dolu gecisi yuksekligi degistirir');
    assert.match(css, /\.log-empty-overlay\s*\{[^}]*position:\s*absolute/,
      'kaplama akistan cikmali');
  });

  test('loglar sekmesinde SATIR ICI stil yok', () => {
    const inline = [...logsTab.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(inline, [],
      `satir ici stiller stylesheet ile cakisir ve tutarsiz bosluk uretir:\n  ${inline.join('\n  ')}`);
  });

  test('arac cubugunda yalnizca yikici eylem metinli', () => {
    // Bes tam metinli dugme cubugu cok genis yapiyordu. Yalnizca "Logları
    // Temizle" metin tasir; digerleri ikon + baslik (erisilebilirlik icin
    // aria-label ile).
    // YALNIZCA ust arac cubugu; "Sistem Durumu" kartindaki yenile dugmesi
    // metin tasiyabilir, o cubukta degil.
    const toolsStart = logsTab.indexOf("class=\"header-tools\"");
    const tools = logsTab.slice(toolsStart, logsTab.indexOf("</div>", logsTab.indexOf("btnClearLogs")));
    const labeled = [...tools.matchAll(/<button[^>]*id="(btn[^"]*)"[\s\S]*?<\/button>/g)]
      .filter(m => /<span[^>]*data-i18n=/.test(m[0]))
      .map(m => m[1]);
    assert.deepEqual(labeled, ['btnClearLogs'],
      `yalnizca yikici eylem metin tasimali; metinli bulunanlar: ${labeled.join(', ')}`);
  });

  test('her arama kutusundaki buyutec ikonu .search-icon tasiyor', () => {
    // BULGU (gercek tarayici): loglar sekmesindeki buyutec girdinin ICINDE
    // degil 16px SOLUNDA duruyordu. Sebep: .search-icon konumlandirmayi
    // (position:absolute; left:10px) yapan tek sey ve o svg'de sinif yoktu -
    // ikon flex akisinda kaliyor, girdi ise ikon icin ayirdigi 32px sol
    // boslugu koruyordu. Diger iki arama kutusunda sinif vardi; bu yuzden
    // yalnizca bu sekme bozuk gorunuyordu.
    let total = 0;
    for (const { html } of PAGES) {
      const source = read(html);
      const boxes = [...source.matchAll(/<div class="search-box">([\s\S]*?)<\/div>/g)];
      total += boxes.length;
      for (const [, body] of boxes) {
        assert.match(body, /<svg[^>]*class="search-icon"/,
          `${html}: arama kutusundaki svg .search-icon tasimali, yoksa ikon girdinin disinda kalir`);
      }
    }
    assert.ok(total >= 3, `arama kutulari bulunamadi (bulunan: ${total})`);
  });

  test('ikon dugmeleri erisilebilir isim tasiyor', () => {
    const iconButtons = [...logsTab.matchAll(/<button[^>]*class="btn btn-icon-only"[^>]*>/g)].map(m => m[0]);
    assert.ok(iconButtons.length >= 4, 'ikon dugmeleri bulunamadi');
    for (const btn of iconButtons) {
      assert.match(btn, /aria-label="/, `ikon dugmesi aria-label tasimali: ${btn.slice(0, 60)}`);
      assert.match(btn, /data-i18n-aria="/, 'aria-label cevrilebilir olmali');
    }
  });
});

describe('olcum bandi / durum bayragi: olculen tuzaklar geri donmedi', () => {
  // Bu bilesenleri IKI sekme paylasiyor (loglardaki Sistem Durumu ve
  // Istatistikler). Asagidaki maddeler tahmin degil, gercek tarayicida
  // olculmus kusurlar.
  const html = read('options/options.html');
  const css = read('options/options.css');
  const logsJs = read('options/tabs/logs.js');
  const statsTab = sectionById(html, 'stats-tab');

  test('olcum bandi SABIT kolon sayisi kullaniyor, auto-fit DEGIL', () => {
    // BULGU: auto-fit dar pencerede 3 kolon uretiyor; dort kalem 3+1 diziliyor
    // ve ikinci satirin bos iki hucresi gap zeminini (kenarlik rengini) koca
    // bir gri blok olarak gosteriyor. Dort kalemi tam bolen sayilar 4 ve 2.
    const start = css.indexOf('.metric-strip {');
    assert.ok(start > 0, '.metric-strip kurali bulunamadi');
    // Yorumlari AYIKLA: kuralin icindeki aciklama "auto-fit kullanilmiyor"
    // diyor ve duz metin taramasi onu ihlal saniyordu.
    const rule = css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(rule, /grid-template-columns:\s*repeat\(4,/,
      'dort kalem icin sabit 4 kolon olmali');
    assert.doesNotMatch(rule, /auto-fit|auto-fill/,
      'auto-fit bos izgara hucresi uretip kenarlik rengini blok olarak gosterir');
  });

  test('dar pencere kirilimi da dort kalemi TAM bolen bir sayi', () => {
    // 3 kolon 3+1 dizilimi uretir; 2 kolon 2+2 uretir.
    const bloklar = [...css.matchAll(/\.metric-strip\s*\{[^}]*grid-template-columns:\s*repeat\((\d+),/g)]
      .map(m => Number(m[1]));
    assert.ok(bloklar.length >= 2, 'en az bir duyarli kirilim tanimli olmali');
    for (const n of bloklar) {
      assert.equal(4 % n, 0, `${n} kolon dort kalemi tam bolmuyor; bos hucre olusur`);
    }
  });

  test('teknik cekmece dugmesi erisilebilir durum bildiriyor', () => {
    assert.match(logsJs, /'aria-expanded':\s*'false'/,
      'katlanan oge baslangic durumunu bildirmeli');
    assert.match(logsJs, /'aria-controls':\s*'diagnosticsTech'/,
      'dugme hangi bolgeyi kontrol ettigini soylemeli');
    assert.match(logsJs, /setAttribute\('aria-expanded',\s*String\(expanded\)\)/,
      'durum degisince aria da guncellenmeli');
  });

  test('durum rengi TEK tasiyici degil: deger metni de durumu soyluyor', () => {
    // Renk koru kullanici yesil/kehribar ayrimini gormez; bayraktaki deger
    // sozcugu ("Serbest", "Gecmis silme engelli", "7 / 8") durumu tasir.
    assert.match(logsJs, /status-flag-value/,
      'bayrak bir DEGER metni tasimali');
    assert.match(logsJs, /removalPolicyLabel\(/,
      'izin durumu sozcukle soylenmeli');
  });

  test('olcerin kendisi tek tasiyici degil, yaninda sayi duruyor', () => {
    // Segmentli olcer aria-hidden; oran zaten "7 / 8" olarak yazili.
    assert.match(logsJs, /class:\s*'status-meter',\s*attrs:\s*\{\s*'aria-hidden':\s*'true'\s*\}/,
      'gorsel olcer ekran okuyucuya tekrar okunmamali');
  });

  test('istatistik sekmesinde satir ici stil yok', () => {
    const inline = [...statsTab.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(inline, [], `satir ici stiller stylesheet ile cakisir:\n  ${inline.join('\n  ')}`);
  });

  test('istatistikte kalem basina SUSLEME rengi geri gelmedi', () => {
    // BULGU: alti kalem alti ayri renkte ikon karosu tasiyordu (amber,
    // camgobegi, mavi, zumrut, mor, gul) ve o renkler hicbir sey ifade
    // etmiyordu - gecmis neden camgobegi? Renk butcesi artik yalnizca DURUM
    // tasiyan ogelerde harcaniyor.
    const iconClasses = [...statsTab.matchAll(/class="[^"]*stat-icon-([a-z]+)/g)].map(m => m[1]);
    assert.deepEqual(iconClasses, [],
      `kalem basina renk anlamsizdi; bulunanlar: ${iconClasses.join(', ')}`);
    assert.ok(!css.includes('.stat-icon-'),
      'kullanilmayan ikon renk kurallari da silinmeli');
  });

  test('kahraman sayi ile olcum rakamlari AYRI karar', () => {
    // tabular-nums yalnizca SUTUN halinde hizalanan sayilar icin gerekli.
    // Kahraman sayi tek basina; monospace'te birim ile sayi arasindaki bosluk
    // 40px'te bir karakter genisligine cikip "392   B" hata gibi okunuyordu.
    const heroStart = css.indexOf('.stat-hero-num {');
    assert.ok(heroStart > 0, '.stat-hero-num bulunamadi');
    const hero = css.slice(heroStart, css.indexOf('}', heroStart));
    assert.doesNotMatch(hero, /font-family:\s*var\(--font-mono\)/,
      'tek basina duran sayi monospace olmamali');

    const numStart = css.indexOf('.metric-num {');
    const num = css.slice(numStart, css.indexOf('}', numStart));
    assert.match(num, /font-variant-numeric:\s*tabular-nums/,
      'ust uste hizalanan rakamlar tablo rakami olmali');
    assert.match(num, /font-family:\s*var\(--font-mono\)/,
      'banttaki rakamlar sabit genislikli olmali');
  });
});

describe('loglar konsolu: olculen iki sessiz kusur geri donmedi', () => {
  const html = read('options/options.html');
  const css = read('options/options.css');

  test('genisletme hucresi kurali .log-row td yi EZEBILECEK ozgullukte', () => {
    // BULGU: `.log-expand-cell { padding-right: 8px }` HIC uygulanmamis.
    // `.log-row td` ozgullugu (0,0,1,1), `.log-expand-cell` ise (0,0,1,0) -
    // govde kurali kazaniyor ve dolgu 12/12 kaliyor. Tarayicida olculdu.
    assert.match(css, /\.log-row\s+td\.log-expand-cell\s*\{/,
      'hucre kurali `.log-row td.log-expand-cell` seklinde yazilmali; ' +
      'yalnizca `.log-expand-cell` govde kurali tarafindan ezilir');
  });

  test('genisletme hucresinde UC NOKTA cizilmiyor', () => {
    // BULGU: hucrenin icerik kutusu 12px, ikon dugmesi 22px -> 10px tasma.
    // Govdedeki `text-overflow: ellipsis` tasma noktasina bir "..." ciziyordu;
    // 2px'e kirpilmis hali her satirin sag ucunda kucuk renkli bir nokta
    // olarak gorunuyor ve sebebi hic anlasilmiyordu.
    const start = css.indexOf('.log-row td.log-expand-cell {');
    assert.ok(start > 0, 'hucre kurali bulunamadi');
    const rule = css.slice(start, css.indexOf('}', start));
    assert.match(rule, /text-overflow:\s*clip/,
      'ikon dugmesi icin uc nokta anlamsiz; tasma olsa bile cizilmemeli');
    assert.match(rule, /padding:\s*0\s+7px/,
      'kolon 36px ve dugme 22px: 36 - 2*7 = 22, yani tam sigar');
  });

  test('arac cubugu kabinin CSS te bir yerlesim kurali var', () => {
    // BULGU: loglar arac cubugu `.toolbar-card` sinifini tasiyordu ve o sinif
    // CSS'te HIC tanimli degildi (hayalet sinif). Yerlesim kurali olmadigi
    // icin kap display:block kaliyor, cocuklar alt alta diziliyordu: arama
    // kutusu 962px yer kaplarken girdi 240px'ti, 722px bosa gidiyordu.
    const logsTab = sectionById(html, 'logs-tab');
    assert.doesNotMatch(logsTab, /class="toolbar-card"/,
      'tanimsiz .toolbar-card yerine tanimli .table-toolbar kullanilmali');

    const cubuk = logsTab.match(/<div class="([^"]*toolbar[^"]*)">/);
    assert.ok(cubuk, 'arac cubugu kabi bulunamadi');
    for (const sinif of cubuk[1].split(/\s+/).filter(Boolean)) {
      assert.ok(css.includes(`.${sinif}`),
        `arac cubugu sinifi CSS'te tanimsiz (hayalet sinif): .${sinif}`);
    }
  });
});

describe('secili site temizligi TOPLU temizlige donusmemeli', () => {
  // Yarim kalan bir SECILI SITE temizligi, BULK_CONTINUE_ALARM kurarsa 31
  // saniye sonra purgeAllNonWhitelisted() calisir - kullanicinin sectigi 3
  // sitelik is, beyaz liste disindaki HER SEYI silmeye donusur.
  //
  // Yapisal koruma: bu iddia calisma zamaninda test edilemiyor (yarim kalma
  // 60 saniyelik butceye takilmayi gerektiriyor), ama kodun o alarmi HIC
  // kurmamasi dogrulanabilir.
  test('PURGE_SELECTED_DOMANS isleyicisi BULK_CONTINUE_ALARM kurmaz', () => {
    // Belirtec ISLEYICIYE ozgu olmali: yalin ad messaging.js'te de geciyor
    // ve readFileContaining oradaki sabit tanimini buluyordu.
    const src = readFileContaining('[Action.PURGE_SELECTED_DOMAINS](message)');
    const start = src.indexOf('[Action.PURGE_SELECTED_DOMAINS](message)');
    const govde = src.slice(start, src.indexOf('async [Action.', start + 30));
    assert.doesNotMatch(govde, /BULK_CONTINUE_ALARM/,
      'secili site temizligi toplu temizlik alarmi kurmamali');
    assert.match(govde, /purgeAlarmName/,
      'devam yalnizca secilen alan adlari icin planlanmali');
  });
});

describe('onay pencereleri: baslik ve aciklama AYNI eyleme ait olmali', () => {
  // Tek kural silme, "Tum Site Kurallarini Sifirla" metnini gosteriyordu:
  // kullaniciya "tum siteler silinecek" diyip asil sonucu soylemiyordu.
  // Kopyala-yapistir oldugu icin lint de testler de goremiyordu.

  test('her openConfirm cagrisinda titleKey ile descKey ayni eylemi anlatir', () => {
    const dosyalar = collectSourceFiles()
      .filter(f => f.startsWith('options/') || f.startsWith('popup/'));
    assert.ok(dosyalar.length > 0, 'taranacak arayuz dosyasi bulunamadi');
    const hatalar = [];
    let bulunanCagri = 0;

    for (const dosya of dosyalar) {
      const kaynak = stripComments(read(dosya));
      const cagrilar = kaynak.matchAll(
        /titleKey:\s*'([^']+)'\s*,\s*descKey:\s*'([^']+)'/g
      );
      for (const [, titleKey, descKey] of cagrilar) {
        bulunanCagri++;
        // 'options.modalPurgeAllTitle' -> 'PurgeAll'
        const kok = key => key.replace(/^.*\bmodal/, '').replace(/(Title|Desc)$/, '');
        if (kok(titleKey) !== kok(descKey)) {
          hatalar.push(`${dosya}: ${titleKey} <-> ${descKey}`);
        }
      }
    }

    // Duzenek dogrulamasi: desen tutmazsa test bos gezip YESIL kalirdi.
    assert.ok(bulunanCagri >= 8, `onay penceresi taranamadi (${bulunanCagri} bulundu)`);
    assert.deepEqual(hatalar, [],
      `baslik/aciklama eslesmiyor:\n  ${hatalar.join('\n  ')}`);
  });
});

describe('HAYALET SINIF yok: JS in dokundugu her sinif CSS te tanimli', () => {
  // OLCULEN KUSUR: arayuz yeniden tasarlandiginda CSS'e YENI sinif adlari
  // yazildi ama JS'in URETTIGI eski adlar (.rule-actions-wrap,
  // .badge-scope-interactive, .setting-warning ...) atlandi - 31 tane.
  //
  // Bir sinifi JS'ten eklemek onu gorunur yapmaz. Karsiligi yoksa oge CIPLAK
  // kalir: <button> reset yuzunden duz metin gibi gorunur (kullanici
  // "tiklanabilir mi belli degil" dedi), kap display:block kalir ve cocuklar
  // ic ice girer ("dugmeler cok yakin"). Hicbiri hata vermez, testler yesil
  // kalir - sessiz bozukluk.
  const css = ['options/options.css', 'ui/theme.css', 'popup/popup.css']
    .map(f => read(f)).join('\n');

  const jsSources = collectSourceFiles()
    .filter(f => f.startsWith('options/') || f.startsWith('popup/'))
    .map(f => ({ file: f, src: read(f) }));

  /** JS in URETTIGI sinif adlari: h({class: ...}) ve classList.add/toggle. */
  function uretilenSiniflar() {
    const out = new Map();
    for (const { file, src } of jsSources) {
      const ekle = (ad) => {
        if (!ad || ad.includes('$')) return;         // sablon parcasi
        if (!out.has(ad)) out.set(ad, file);
      };
      for (const m of src.matchAll(/class:\s*'([^']+)'/g)) m[1].split(/\s+/).forEach(ekle);
      // UCLU OPERATOR de bir sinif kaynagi ve GOZDEN KACMISTI:
      //     class: entry.domain ? 'log-domain' : 'log-domain log-domain-empty'
      // Yukaridaki desen `class:` sonrasinda hemen tirnak bekliyor, bu yuzden
      // buradaki adlar HIC toplanmiyordu. Gercek sonucu: `.log-domain`in CSS
      // karsiligi yoktu, uzun alan adlari (avatars.githubusercontent.com)
      // 150px sabit kolondan tasip yandaki sutunun uzerine biniyordu -
      // kullanici ekran goruntusunde bunu bildirdi, guard sessiz kaldi.
      for (const m of src.matchAll(/class:\s*[^,\n]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
        m[1].split(/\s+/).forEach(ekle);
        m[2].split(/\s+/).forEach(ekle);
      }
      for (const m of src.matchAll(/class:\s*`([^`]+)`/g)) {
        // `a ${x} b` -> degisken kismi atilir, sabit adlar kalir
        m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).forEach(ekle);
      }
      for (const m of src.matchAll(/classList\.(?:add|toggle)\('([^']+)'/g)) ekle(m[1]);
      for (const m of src.matchAll(/className\s*=\s*'([^']+)'/g)) m[1].split(/\s+/).forEach(ekle);
    }
    return out;
  }

  test('duzenek: sinif adlari toplanabiliyor', () => {
    const uretilen = uretilenSiniflar();
    assert.ok(uretilen.size > 40,
      `JS'ten yeterli sinif toplanamadi (${uretilen.size}) - tarama bos geziyor`);
    assert.ok(css.length > 5000, 'CSS okunamadi');
  });

  test('JS in urettigi her sinif CSS te tanimli', () => {
    const eksik = [];
    for (const [ad, file] of uretilenSiniflar()) {
      if (!new RegExp('\\.' + ad.replace(/[-]/g, '\\-') + '\\b').test(css)) {
        eksik.push(`${ad} (${file})`);
      }
    }
    assert.deepEqual(eksik, [],
      `CSS'te karsiligi olmayan sinif(lar) - oge ciplak kalir:\n  ${eksik.join('\n  ')}`);
  });

  test('JS in SORGULADIGI her sinif HTML veya CSS te var', () => {
    // Sinif adi degisince sorgu SESSIZCE bos doner. Iki kez oldu:
    //   * popup '.actions-section' aradi, HTML '.acts' oldu -> Chrome'un
    //     kendi sayfalarinda eylemler gizlenmedi.
    //   * rules.js '#rules-tab .filter-pills .pill' aradi, HTML '.seg' oldu
    //     -> dongu SIFIR eleman gezdi, filtre ciplerine HIC dinleyici
    //     baglanmadi ve cipler olu kaldi.
    //
    // Bu testin ILK surumu ikincisini KACIRDI: yalnizca querySelector
    // literallerine bakiyordu (proje qs()/qsa() yardimcilarini kullaniyor) ve
    // yalnizca TEK sinifli seciciyi ayikliyordu (bilesik secicideki digerleri
    // gorulmuyordu). Ikisi de duzeltildi.
    const html = ['options/options.html', 'popup/popup.html'].map(f => read(f)).join('\n');
    const uretilenKaynak = jsSources.map(s => s.src).join('\n');
    const eksik = [];
    let bakilanSecici = 0;

    for (const { file, src } of jsSources) {
      // querySelector / querySelectorAll / qs / qsa
      for (const m of src.matchAll(/\b(?:querySelectorAll|querySelector|qsa|qs)\(\s*'([^']+)'/g)) {
        const secici = m[1];
        bakilanSecici++;
        // Secicideki TUM sinif belirteclerini ayikla (bilesik secici dahil).
        for (const c of secici.matchAll(/\.([\w-]+)/g)) {
          const ad = c[1];
          const varMi = new RegExp('class="[^"]*\\b' + ad + '\\b').test(html)
            || new RegExp("class:\\s*['`][^'`]*\\b" + ad + '\\b').test(uretilenKaynak)
            || new RegExp("classList\\.(?:add|toggle)\\('" + ad + "'").test(uretilenKaynak);
          if (!varMi) eksik.push(`${ad}  (secici "${secici}" — ${file})`);
        }
      }
    }

    // Duzenek dogrulamasi: desen tutmazsa test bos gezip YESIL kalirdi.
    assert.ok(bakilanSecici >= 15,
      `yeterli secici taranamadi (${bakilanSecici}) - tarama bos geziyor`);
    assert.deepEqual(eksik, [],
      `sorgulanan ama hicbir yerde uretilmeyen sinif(lar):\n  ${eksik.join('\n  ')}`);
  });
});

describe('HTML data-i18n baglamalari YER TUTUCU tasiyamaz', () => {
  // OLCULEN KUSUR: `modalSubdomainsLabel` metni "(*.{domain})" iceriyordu ve
  // HTML'de data-i18n ile baglaniyordu. Genel uygulayici PARAMETRE GECEMEZ
  // (bkz. lib/i18n.js DOM_BINDINGS) - kullanici ekranda ham "*.{domain}"
  // goruyordu. `{delay}` ile ayni sinif.
  //
  // Onceki yer tutucu testi yalnizca JS'teki t('anahtar', {...}) cagri
  // yerlerine bakiyordu; HTML baglamalari kor noktaydi.
  //
  // Kural: bir anahtar yer tutucu iceriyorsa JS'ten parametreyle
  // doldurulmali, data-i18n ile baglanmamali.

  test('data-i18n ile baglanan hicbir metin {yerTutucu} icermiyor', () => {
    const sorunlar = [];
    let bakilan = 0;

    for (const { html } of PAGES) {
      const src = read(html);
      for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([a-zA-Z0-9_.]+)"/g)) {
        const anahtar = m[1];
        bakilan++;
        for (const [ad, paket] of [['tr', tr], ['en', en]]) {
          const metin = anahtar.split('.').reduce((n, p) => n && n[p], paket);
          if (typeof metin !== 'string') continue;
          const tutucular = [...metin.matchAll(/\{(\w+)\}/g)].map(x => x[0]);
          if (tutucular.length) {
            sorunlar.push(`${html}: ${anahtar} -> ${ad} metni ${tutucular.join(' ')} iceriyor`);
          }
        }
      }
    }

    // Duzenek dogrulamasi: desen tutmazsa test bos gezip YESIL kalirdi.
    assert.ok(bakilan > 200, `yeterli baglama taranamadi (${bakilan})`);
    assert.deepEqual(sorunlar, [],
      `data-i18n parametre geciremez; bu metinler ekranda HAM gorunur:\n  ${sorunlar.join('\n  ')}`);
  });
});

describe('OTURUMLUK veri diske DUSMEZ (gizlilik sozlesmesi)', () => {
  // GIZLILIK DENETIMI BULGUSU: hem loglar hem 3. taraf haritasi
  // `chrome.storage.session || chrome.storage.local` yedegi kullaniyordu.
  //
  // Chrome 119 hedefinde storage.session her zaman var, yani yedek pratikte
  // hic tetiklenmiyor. Ama tetiklenseydi eklenti tam olarak VADETMEDIGI seyi
  // yapardi: gunlukleri ve hangi izleyiciyle nerede karsilastiginizi DISKE
  // yazardi. Bir gizlilik aracinda yanlis tarafa dusen yedek, yedek degil
  // sessiz bir sozlesme ihlalidir.
  //
  // Dogru arıza bicimi: oturum deposu yoksa OZELLIGI KAYBET, veriyi diske
  // yazma.

  const OTURUMLUK = ['lib/logger.js', 'lib/session-state.js'];

  test('oturumluk moduller storage.local YEDEGI kullanmiyor', () => {
    const sorunlar = [];
    for (const dosya of OTURUMLUK) {
      const src = stripComments(read(dosya));
      for (const m of src.matchAll(/chrome\.storage\.session\s*\|\|\s*chrome\.storage\.local/g)) {
        const satir = src.slice(0, m.index).split('\n').length;
        sorunlar.push(`${dosya}:${satir} storage.local yedegi`);
      }
    }
    assert.deepEqual(sorunlar, [],
      `oturumluk veri diske dusebilir:\n  ${sorunlar.join('\n  ')}`);
  });

  test('oturumluk moduller storage.local a HIC dokunmuyor', () => {
    const sorunlar = [];
    for (const dosya of OTURUMLUK) {
      const src = stripComments(read(dosya));
      if (/chrome\.storage\.local\b/.test(src)) sorunlar.push(dosya);
    }
    assert.deepEqual(sorunlar, [],
      `bu moduller yalnizca storage.session kullanmali: ${sorunlar.join(', ')}`);
  });
});


describe('MARKA simgesi eklentinin GERCEK ikonu olmali', () => {
  // KULLANICI BULGUSU: "ayarlar sayfasinda svg kalkan var, orada eklentiye
  // yapilan simge olmali".
  //
  // Ayarlar kenar cubugu ve popup ust seridi, marka konumunda JENERIK bir
  // kalkan SVG'si tasiyordu. Eklentinin gercek ikonu (icons/icon-*.png)
  // gozluklu bir hayalet - kalkanla hicbir ilgisi yok. Yani arac cubugunda,
  // eklenti listesinde ve magazada gorunen simge ile arayuzdeki simge
  // BIRBIRINDEN FARKLIYDI.
  //
  // Marka tutarsizligi kucuk gorunur ama guven kirar: kullanici arayuzdeki
  // isareti tanidigi simgeyle esleştiremez.

  const YUZEYLER = [
    ['options/options.html', 'side__brand'],
    ['popup/popup.html', 'top__mark']
  ];

  test('marka konumunda inline SVG degil GERCEK ikon var', () => {
    const sorunlar = [];
    for (const [dosya, isaret] of YUZEYLER) {
      const src = read(dosya);
      const im = src.indexOf(isaret);
      assert.ok(im > -1, `${dosya}: ${isaret} bulunamadi`);
      const pencere = src.slice(im, im + 400);
      if (/<svg/.test(pencere) && !/icons\/icon-/.test(pencere)) {
        sorunlar.push(`${dosya}: marka hala inline SVG`);
      }
      if (!/icons\/icon-\d+\.png/.test(pencere)) {
        sorunlar.push(`${dosya}: gercek ikon (icons/icon-*.png) kullanilmiyor`);
      }
    }
    assert.deepEqual(sorunlar, [],
      `marka simgesi tutarsiz:\n  ${sorunlar.join('\n  ')}`);
  });
});
