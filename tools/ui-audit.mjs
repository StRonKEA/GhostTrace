// GhostTrace - Arayuz TUTARLILIK denetimi
//
// NEDEN VAR: gorsel tutarsizlik goz karariyla aranir ve kacar. Bu oturumda
// ayni kusur UC kez cikti (gorunmez kenarlik, dengesiz dugme genisligi,
// ortusen bildirim) - her seferinde kullanici bildirdi, test degil.
//
// Burada olculebilir olani olcuyoruz: ayni ad iki bilesende kullanilmis mi,
// yazi boyutu olcegin disina cikmis mi, renk merkez disinda sabitlenmis mi,
// ayni islevdeki dugme iki yerde ayri mi gorunuyor.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const oku = (p) => readFileSync(join(ROOT, p), 'utf8');

const SAYFA_CSS = ['popup/popup.css', 'options/options.css'];
const MERKEZ = 'ui/theme.css';

let sorun = 0;
const gecti = (ad, not) => console.log(`  TEMIZ   ${ad}${not ? '   ' + not : ''}`);
const kaldi = (ad, ayrinti) => { sorun++; console.log(`  SORUN   ${ad}`); for (const s of ayrinti) console.log(`          ${s}`); };

/** Bir dosyadaki kural bloklarini {secici: [ozellikler]} olarak cikarir. */
function kurallar(css) {
  const harita = new Map();
  const temiz = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(temiz))) {
    const secici = m[1].trim();
    if (!secici || secici.startsWith('@')) continue;
    const ozellikler = m[2].split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const tek of secici.split(',').map(s => s.trim())) {
      if (!harita.has(tek)) harita.set(tek, []);
      harita.get(tek).push(...ozellikler);
    }
  }
  return harita;
}

// --------------------------------------------------------------------------
console.log('\nGhostTrace arayuz tutarlilik denetimi\n');

// 1) AYNI AD, FARKLI BILESEN
// Iki sayfa ayni sinif adini KURUCU ozelliklerle tanimliyorsa ad yalan
// soyluyor demektir: birinde kapsayici, digerinde ic oge olabilir.
{
  const KURUCU = new Set(['display', 'flex', 'position', 'grid-template-columns', 'flex-direction']);
  const [a, b] = SAYFA_CSS.map(p => kurallar(oku(p)));
  const carpisan = [];
  for (const [secici, ozA] of a) {
    if (!b.has(secici)) continue;
    const ozB = b.get(secici);
    const ad = (o) => o.split(':')[0].trim();
    const kurucuA = ozA.filter(o => KURUCU.has(ad(o)));
    const kurucuB = ozB.filter(o => KURUCU.has(ad(o)));
    // AYNI ad + AYNI bildirim = paylasilan yardimci sinif (ornek .hidden).
    // Sorun ancak DEGERLER ayrilirsa var: o zaman ad iki farkli seyi anlatir.
    const ayni = kurucuA.join('|') === kurucuB.join('|');
    if (kurucuA.length && kurucuB.length && !ayni) {
      carpisan.push(`${secici}  ->  ${SAYFA_CSS[0]}: ${kurucuA.join(',')}  |  ${SAYFA_CSS[1]}: ${kurucuB.join(',')}`);
    }
  }
  if (carpisan.length) kaldi('Ayni sinif adi iki sayfada FARKLI bilesen', carpisan);
  else gecti('Sinif adlari iki sayfada ayni seyi anlatiyor');
}

// 2) TIPOGRAFI OLCEGI
// Olcek disindaki bir boyut (ornek 11.5px) hicbir yerde eslesmez; yan yana
// duran iki metin sebepsiz farkli buyuklukte gorunur.
{
  const olcek = new Set();
  for (const m of oku(MERKEZ).matchAll(/--fs-[a-z]+:\s*([\d.]+)rem/g)) {
    olcek.add(Math.round(Number(m[1]) * 16));
  }
  const disarda = [];
  for (const p of SAYFA_CSS) {
    const satirlar = oku(p).split('\n');
    satirlar.forEach((s, i) => {
      const m = s.match(/font-size:\s*([\d.]+)px/);
      if (m && !olcek.has(Number(m[1]))) disarda.push(`${p}:${i + 1}  font-size: ${m[1]}px  (olcek: ${[...olcek].sort((x, y) => x - y).join(', ')})`);
    });
  }
  if (disarda.length) kaldi('Yazi boyutu tipografi olceginin DISINDA', disarda);
  else gecti('Tum yazi boyutlari olcekte', `olcek: ${[...olcek].sort((x, y) => x - y).join('/')}`);
}

// 3) RENK MERKEZDE
// Sayfa dosyasinda sabitlenen renk, tema degisince guncellenmez.
{
  const disarda = [];
  for (const p of SAYFA_CSS) {
    oku(p).split('\n').forEach((s, i) => {
      if (/\/\*/.test(s)) return;
      const m = s.match(/(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/);
      if (m) disarda.push(`${p}:${i + 1}  ${m[1]}`);
    });
  }
  if (disarda.length) kaldi('Renk merkez tema DISINDA sabitlenmis', disarda);
  else gecti('Renkler yalnizca temadan geliyor');
}

// 4) YIKICI ONAY DUGMESI TEK GORUNUMDE
// Ayni karar - "bu yikici islemi onayla" - her yerde ayni gorunmeli.
{
  const html = oku('options/options.html');
  const sorunlar = [];
  if (/id="modalBtnConfirm"[^>]*class="btn btn--danger"/.test(html)) {
    sorunlar.push('options: onay dugmesi "btn--danger" (cerceveli) - popup\'taki dolu kirmiziyla ayni degil');
  }
  if (sorunlar.length) kaldi('Yikici ONAY dugmesi iki yerde farkli gorunuyor', sorunlar);
  else gecti('Yikici onay dugmesi her yerde ayni');
}

// 5) MODAL YAPISI
// Her modal ayni iskeleti tasimali: overlay > modal > modal__foot ve
// altbilgide once VAZGEC sonra eylem.
{
  const html = oku('options/options.html');
  const sorunlar = [];
  const modallar = [...html.matchAll(/<div id="(\w+)" class="overlay[^"]*">([\s\S]*?)\n {2}<\/div>/g)];
  for (const [, id, govde] of modallar) {
    if (!/class="modal[\s"]/.test(govde)) sorunlar.push(`${id}: .modal kabugu yok`);
    if (!/class="modal__foot"/.test(govde)) sorunlar.push(`${id}: .modal__foot yok`);
    const foot = govde.match(/<footer class="modal__foot">([\s\S]*?)<\/footer>/);
    if (foot) {
      const ilk = foot[1].match(/data-i18n="([^"]+)"/);
      if (ilk && !/cancel/i.test(ilk[1])) sorunlar.push(`${id}: altbilgide ONCE vazgec gelmeli, gelen: ${ilk[1]}`);
    }
  }
  if (!modallar.length) sorunlar.push('hic modal bulunamadi - desen degismis olabilir');
  if (sorunlar.length) kaldi('Modal iskeleti tutarsiz', sorunlar);
  else gecti('Tum modallar ayni iskelet', `${modallar.length} modal`);
}

// 6) AYNI DOSYADA IKI KEZ TANIMLI SECICI
// .btn-action-group boyle bulundu: bir yerde display:flex, 40 satir sonra
// display:grid. Ilki HIC uygulanmiyordu ama okuyani yanlis yonlendiriyordu.
// Cakisma ayni dosyada oldugu icin 1. kontrol (sayfalar arasi) goremiyordu.
{
  const CAKISAN = ['display', 'grid-template-columns', 'position', 'flex-direction'];
  const carpisan = [];
  for (const p of [...SAYFA_CSS, MERKEZ]) {
    const gorulen = new Map();
    // @media bloklarini AT: icindekiler bilincli duyarli gecersiz kilma,
    // olu kural degil. Dengeli parantezle cikariyoruz - regex ic ice
    // bloklarda yanlis yerde kesiyordu.
    let temiz = oku(p).replace(/\/\*[\s\S]*?\*\//g, '');
    for (;;) {
      const bas = temiz.indexOf('@media');
      if (bas === -1) break;
      const i = temiz.indexOf('{', bas);
      let derinlik = 0;
      let son = -1;
      for (let k = i; k < temiz.length; k++) {
        if (temiz[k] === '{') derinlik++;
        else if (temiz[k] === '}' && --derinlik === 0) { son = k; break; }
      }
      if (son === -1) break;
      temiz = temiz.slice(0, bas) + temiz.slice(son + 1);
    }
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(temiz))) {
      const secici = m[1].trim();
      if (!secici || secici.startsWith('@') || secici.includes(',')) continue;
      for (const bildirim of m[2].split(';')) {
        const [ad, deger] = bildirim.split(':').map(s => (s || '').trim());
        if (!CAKISAN.includes(ad)) continue;
        const anahtar = `${secici} ${ad}`;
        if (gorulen.has(anahtar) && gorulen.get(anahtar) !== deger) {
          // UYARI METNI ONEMLI: OLU olan yalnizca BU BILDIRIM. Ilk blogun
          // geri kalani (gap, align-items ...) ezilmiyor ve calisiyor
          // olabilir. Selektoru blogtan tamamen cikarmak onlari da goturur -
          // bir kez tam bunu yaptim ve dugmeler yapisik kaldi.
          carpisan.push(`${p}  ${secici} { ${ad} }  "${gorulen.get(anahtar)}" sonra "${deger}"`
            + `
          -> YALNIZCA bu bildirim olu. Selektoru blogtan silme;`
            + ` sadece bu satiri kaldir, ayni bloktaki digerleri calisiyor olabilir.`);
        }
        gorulen.set(anahtar, deger);
      }
    }
  }
  if (carpisan.length) kaldi('Ayni secici ayni dosyada CAKISAN degerle iki kez', carpisan);
  else gecti('Olu (ezilen) kural yok');
}

console.log(sorun ? `\nArayuzde ${sorun} tutarsizlik var.\n` : '\nArayuz TUTARLI.\n');
process.exit(sorun ? 1 : 0);
