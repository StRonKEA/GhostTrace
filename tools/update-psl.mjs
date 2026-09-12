// GhostTrace - Public Suffix List guncelleyici
//
// Kullanim: npm run psl:update
//
// lib/psl.js dosyasini publicsuffix.org'daki guncel listeden yeniden uretir.
// Neden gerekli: kayit edilebilir kok alan adi (eTLD+1) hesabi bu listeye
// dayanir. Liste eskirse "kullanici.github.io" gibi private suffix'ler yanlis
// cozulur ve bir siteyi beyaz listeye almak butun bir platformu korumaya alir.
//
// Liste calisma zamaninda DEGIL, derleme zamaninda indirilir: gizlilik
// eklentisinin arka planda ag istegi atmasi istenmez.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'psl.js');

/** Unicode etiketleri Chrome'un dondurdugu punycode formuna cevirir. */
function toAscii(rule) {
  try {
    return new URL(`http://${rule}`).hostname;
  } catch {
    return null;
  }
}

function parse(raw) {
  const literal = new Set();
  const wildcard = new Set();
  const exception = new Set();
  let version = 'unknown';
  let singleLabelSkipped = 0;
  let unparsable = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('// VERSION:')) {
      version = trimmed.replace('// VERSION:', '').trim();
    }
    if (!trimmed || trimmed.startsWith('//')) continue;

    let rule = trimmed;
    let isException = false;
    let isWildcard = false;

    if (rule.startsWith('!')) { isException = true; rule = rule.slice(1); }
    if (rule.startsWith('*.')) { isWildcard = true; rule = rule.slice(2); }

    const ascii = toAscii(rule);
    if (!ascii) { unparsable++; continue; }

    if (isException) exception.add(ascii);
    else if (isWildcard) wildcard.add(ascii);
    else if (ascii.includes('.')) literal.add(ascii);
    // Tek etiketli kurallar (com, net, tr ...) atlanir: algoritma bilinmeyen
    // TLD'yi zaten tek etiketli public suffix kabul eder.
    else singleLabelSkipped++;
  }

  return { literal, wildcard, exception, version, singleLabelSkipped, unparsable };
}

function render({ literal, wildcard, exception, version }) {
  const maxLabels = Math.max(
    ...[...literal, ...wildcard, ...exception].map(rule => rule.split('.').length)
  ) + 1;
  const sorted = (set) => [...set].sort().join('\n');

  return `// GhostTrace - Public Suffix List verisi (OTOMATIK URETILDI - elle duzenlemeyin)
// Yeniden uretmek icin: npm run psl:update
// Kaynak : ${SOURCE_URL}
// Lisans : Mozilla Public License 2.0
// Surum  : ${version}
//
// Tek etiketli kurallar (com, net, tr ...) atlanmistir; algoritma bilinmeyen
// TLD'yi varsayilan olarak tek etiketli public suffix kabul eder.

export const PSL_VERSION = '${version}';
export const PSL_MAX_LABELS = ${maxLabels};

// Cok etiketli birebir kurallar (ornek: co.uk, com.tr, github.io)
const LITERAL_RULES = \`${sorted(literal)}\`;

// Joker kurallar; anahtar "*." onekinden sonraki kisimdir (ornek: *.bd -> bd)
const WILDCARD_RULES = \`${sorted(wildcard)}\`;

// Istisna kurallari (ornek: !city.kawasaki.jp -> city.kawasaki.jp)
const EXCEPTION_RULES = \`${sorted(exception)}\`;

const NEWLINE = String.fromCharCode(10);

// Set'ler ILK KULLANIMDA kurulur. Bu dosya (dolayli olarak) popup tarafindan da
// yukleniyor; ~9 bin Set ekleme maliyetini alan adi hesabi gerekmedikce odemeyiz.
let literalSet = null;
let wildcardSet = null;
let exceptionSet = null;

export function pslLiteral() {
  if (!literalSet) literalSet = new Set(LITERAL_RULES.split(NEWLINE));
  return literalSet;
}

export function pslWildcard() {
  if (!wildcardSet) wildcardSet = new Set(WILDCARD_RULES.split(NEWLINE));
  return wildcardSet;
}

export function pslException() {
  if (!exceptionSet) exceptionSet = new Set(EXCEPTION_RULES.split(NEWLINE));
  return exceptionSet;
}
`;
}

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  console.error(`Liste indirilemedi: HTTP ${response.status}`);
  process.exit(1);
}

const parsed = parse(await response.text());
if (parsed.literal.size < 5000) {
  console.error(`Beklenmedik derecede kucuk liste (${parsed.literal.size} kural); yazma iptal edildi.`);
  process.exit(1);
}

const output = render(parsed);
writeFileSync(OUTPUT, output, 'utf8');

console.log(`Surum      : ${parsed.version}`);
console.log(`Birebir    : ${parsed.literal.size}`);
console.log(`Joker      : ${parsed.wildcard.size}`);
console.log(`Istisna    : ${parsed.exception.size}`);
console.log(`Atlanan    : ${parsed.singleLabelSkipped} tek etiketli, ${parsed.unparsable} cozulemeyen`);
console.log(`Yazildi    : ${OUTPUT} (${output.length} bayt)`);
console.log('\nSimdi "npm test" ile domain testlerini dogrulayin.');
