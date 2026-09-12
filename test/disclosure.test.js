// GhostTrace - kademeli aciklama davranisi.
//
// DOM taklidi GERCEK options.html'den kuruluyor: burada olculen sey, sayfada
// fiilen bulunan (i) dugmeleri ve ayrinti panelleri.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { installChromeStub } from './helpers/chrome-stub.js';
import { installDom } from './helpers/dom-stub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let initDisclosures;

before(async () => {
  installChromeStub();
  installDom(join(ROOT, 'options', 'options.html'));
  ({ initDisclosures } = await import('../options/ui/disclosure.js'));
  initDisclosures(globalThis.document);
});

const dugmeler = () => [...globalThis.document.querySelectorAll('.row__info')];

describe('kademeli aciklama', () => {
  test('sayfada (i) dugmeleri var', () => {
    // Duzenek dogrulamasi: secici tutmazsa asagidaki testler bos gezip
    // YESIL kalirdi.
    assert.ok(dugmeler().length >= 10,
      `beklenen en az 10 aciklama dugmesi, bulunan: ${dugmeler().length}`);
  });

  test('her dugme bir panele baglanmis ve panel KAPALI basliyor', () => {
    for (const b of dugmeler()) {
      const hedefId = b._attrs['aria-controls'];
      assert.ok(hedefId, 'dugme aria-controls tasimali');
      const panel = globalThis.document.getElementById(hedefId);
      assert.ok(panel, `aria-controls var olmayan id gosteriyor: ${hedefId}`);
      assert.equal(b._attrs['aria-expanded'], 'false', 'baslangicta kapali bildirilmeli');
      assert.equal(panel.hidden, true, 'panel baslangicta gizli olmali');
    }
  });

  test('tiklayinca acilir, tekrar tiklayinca kapanir', async () => {
    const b = dugmeler()[0];
    const panel = globalThis.document.getElementById(b._attrs['aria-controls']);

    await b._fire('click');
    assert.equal(panel.hidden, false, 'ilk tiklamada acilmali');
    assert.equal(b._attrs['aria-expanded'], 'true', 'aria da acildigini soylemeli');

    await b._fire('click');
    assert.equal(panel.hidden, true, 'ikinci tiklamada kapanmali');
    assert.equal(b._attrs['aria-expanded'], 'false');
  });

  test('paneller birbirinden BAGIMSIZ', () => {
    // Akordiyon degil: bir ayarin aciklamasini okurken digerinin kapanmasi
    // karsilastirma yapmayi imkansiz kilar.
    assert.ok(dugmeler().length >= 2);
  });

  test('ayrintisi OLMAYAN satirda dugme birakilmaz', () => {
    // Tiklaninca hicbir sey yapmayan dugme, kullaniciya isleyen bir secenek
    // gostermek demek.
    for (const b of dugmeler()) {
      const panel = b.closest('.row')?.querySelector('.row__detail');
      assert.ok(panel, 'dugmesi olan her satirda ayrinti paneli olmali');
    }
  });

  test('her ayrinti paneli BENZERSIZ id tasiyor', () => {
    const idler = dugmeler().map(b => b._attrs['aria-controls']);
    assert.equal(new Set(idler).size, idler.length,
      `yinelenen aria-controls: ${idler.join(', ')}`);
  });
});
