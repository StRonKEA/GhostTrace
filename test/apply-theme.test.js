// GhostTrace - tema uygulayici davranisi.
//
// Kritik nokta: 'system' secildiginde data-theme SILINMELI, yazilmamali.
// CSS'te "sistem temasi" durumu ozniteligin YOKLUGU ile ifade ediliyor;
// data-theme="system" yazmak hicbir tema blogunu eslestirmez ve sayfa
// belirtecsiz kalir - yani okunamaz.

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { installChromeStub } from './helpers/chrome-stub.js';
import { installDom } from './helpers/dom-stub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let applyTheme, watchTheme, chrome;

before(async () => {
  chrome = installChromeStub();
  // Gercek sayfadan kurulur: uygulayici belgeye dokundugu icin ayni
  // documentElement uzerinde olculmeli.
  installDom(join(ROOT, 'options', 'options.html'));
  ({ applyTheme, watchTheme } = await import('../ui/apply-theme.js'));
});

beforeEach(() => {
  globalThis.document.documentElement.removeAttribute('data-theme');
});

const kokTema = () => globalThis.document.documentElement._attrs['data-theme'];

describe('applyTheme', () => {
  test('koyu secimi oznitelige yazilir', () => {
    assert.equal(applyTheme('dark'), 'dark');
    assert.equal(kokTema(), 'dark');
  });

  test('acik secimi oznitelige yazilir', () => {
    assert.equal(applyTheme('light'), 'light');
    assert.equal(kokTema(), 'light');
  });

  test('system oznitelige YAZILMAZ, silinir', () => {
    applyTheme('dark');
    assert.equal(kokTema(), 'dark', 'once koyu olmali');
    assert.equal(applyTheme('system'), 'system');
    assert.equal(kokTema(), undefined,
      `system icin oznitelik silinmeli, kalan: ${kokTema()}`);
  });

  test('bilinmeyen deger sisteme duser', () => {
    applyTheme('dark');
    assert.equal(applyTheme('neon'), 'system');
    assert.equal(kokTema(), undefined, 'gecersiz deger oznitelik birakmamali');
  });

  test('bos/undefined sisteme duser', () => {
    applyTheme('dark');
    assert.equal(applyTheme(undefined), 'system');
    assert.equal(kokTema(), undefined);
  });
});

describe('watchTheme', () => {
  test('ilk cagrida ayardaki temayi uygular', async () => {
    await watchTheme(async () => ({ theme: 'dark' }));
    assert.equal(kokTema(), 'dark');
  });

  test('ayar okunamazsa sayfa temasiz kalmaz', async () => {
    applyTheme('dark');
    await watchTheme(async () => { throw new Error('depolama yok'); });
    assert.equal(kokTema(), undefined, 'hata durumunda sistem temasina dusmeli');
  });

  test('tema ayari degisince YENIDEN uygulanir', async () => {
    // Izlemezsek: kullanici ayarlardan temayi degistirir, acik duran popup
    // ve ikinci sekme yeniden acilana kadar eski temada kalir.
    let mevcut = 'light';
    await watchTheme(async () => ({ theme: mevcut }));
    assert.equal(kokTema(), 'light');

    mevcut = 'dark';
    await chrome.storage.local.set({ theme: 'dark' });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(kokTema(), 'dark',
      `depolama degisiminde tema guncellenmeli, kalan: ${kokTema()}`);
  });
});
