import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractHostname,
  normalizeDomain,
  getRootDomain,
  getPublicSuffix,
  isInternalUrl,
  isIpHost,
  hostFromCookieDomain,
  buildOrigins,
  createDomainScope,
  stripTrackingParams
} from '../lib/domain.js';

describe('extractHostname', () => {
  test('URL ve ciplak domainden host cikarir', () => {
    assert.equal(extractHostname('https://Mail.Google.com/inbox?a=1'), 'mail.google.com');
    assert.equal(extractHostname('example.com'), 'example.com');
    assert.equal(extractHostname('  WWW.Example.COM  '), 'www.example.com');
    assert.equal(extractHostname('*.example.com'), 'example.com');
  });

  test('sondaki noktayi kanoniklestirir', () => {
    assert.equal(extractHostname('example.com.'), 'example.com');
  });

  test('IP ve localhost korunur', () => {
    assert.equal(extractHostname('http://127.0.0.1:8080/x'), '127.0.0.1');
    assert.equal(extractHostname('localhost'), 'localhost');
    assert.equal(extractHostname('http://[::1]/'), '::1');
  });

  test('tarayici ici ve gecersiz adresler bos doner', () => {
    for (const bad of [
      '', null, undefined, 'chrome://settings', 'chrome-extension://abc/x.html',
      'about:blank', 'file:///C:/x.txt', 'data:text/html,x', 'javascript:alert(1)',
      'devtools://x', 'view-source:https://a.com', '-.png', 'a..b', 'blob:https://a.com/x'
    ]) {
      assert.equal(extractHostname(bad), '', `beklenen bos: ${bad}`);
    }
  });

  test('IDN punycode formunda doner', () => {
    assert.equal(extractHostname('https://münchen.de'), 'xn--mnchen-3ya.de');
  });
});

describe('normalizeDomain', () => {
  test('www onekini kaldirir', () => {
    assert.equal(normalizeDomain('https://www.example.com/x'), 'example.com');
    assert.equal(normalizeDomain('www.mail.example.com'), 'mail.example.com');
  });

  test('www ile baslayan gercek alt alan adini bozmaz', () => {
    assert.equal(normalizeDomain('wwwx.example.com'), 'wwwx.example.com');
  });
});

describe('getRootDomain - Public Suffix List', () => {
  test('basit TLD', () => {
    assert.equal(getRootDomain('mail.google.com'), 'google.com');
    assert.equal(getRootDomain('a.b.c.example.net'), 'example.net');
    assert.equal(getRootDomain('example.com'), 'example.com');
  });

  test('iki parcali ICANN suffixleri', () => {
    assert.equal(getRootDomain('shop.example.com.tr'), 'example.com.tr');
    assert.equal(getRootDomain('www.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(getRootDomain('a.b.example.co.jp'), 'example.co.jp');
    assert.equal(getRootDomain('x.example.gov.au'), 'example.gov.au');
  });

  test('private suffixler ayri site sayilir (eski elle yazilan liste bunu kaciriyordu)', () => {
    assert.equal(getRootDomain('kullanici.github.io'), 'kullanici.github.io');
    assert.equal(getRootDomain('sayfa.kullanici.github.io'), 'kullanici.github.io');
    assert.equal(getRootDomain('app.vercel.app'), 'app.vercel.app');
    assert.equal(getRootDomain('site.pages.dev'), 'site.pages.dev');
    assert.equal(getRootDomain('blog.blogspot.com'), 'blog.blogspot.com');
    assert.equal(getRootDomain('shop.myshopify.com'), 'shop.myshopify.com');
  });

  test('joker kurallar', () => {
    // *.compute.amazonaws.com PSL joker kuralidir
    assert.equal(getRootDomain('i-123.eu-west-1.compute.amazonaws.com'), 'i-123.eu-west-1.compute.amazonaws.com');
  });

  test('public suffixin kendisi daha fazla indirgenmez', () => {
    assert.equal(getRootDomain('github.io'), 'github.io');
    assert.equal(getRootDomain('co.uk'), 'co.uk');
  });

  test('IP ve tek etiketli hostlar oldugu gibi doner', () => {
    assert.equal(getRootDomain('192.168.1.1'), '192.168.1.1');
    assert.equal(getRootDomain('localhost'), 'localhost');
  });

  test('getPublicSuffix', () => {
    assert.equal(getPublicSuffix('mail.google.com'), 'com');
    assert.equal(getPublicSuffix('bbc.co.uk'), 'co.uk');
    assert.equal(getPublicSuffix('a.kullanici.github.io'), 'github.io');
  });
});

describe('yardimcilar', () => {
  test('isInternalUrl', () => {
    assert.equal(isInternalUrl('chrome://extensions'), true);
    assert.equal(isInternalUrl('https://example.com'), false);
    assert.equal(isInternalUrl(''), true);
  });

  test('isIpHost', () => {
    assert.equal(isIpHost('10.0.0.1'), true);
    assert.equal(isIpHost('example.com'), false);
    assert.equal(isIpHost('::1'), true);
  });

  test('hostFromCookieDomain', () => {
    assert.equal(hostFromCookieDomain('.example.com'), 'example.com');
    assert.equal(hostFromCookieDomain('mail.example.com'), 'mail.example.com');
    assert.equal(hostFromCookieDomain(''), '');
  });

  test('buildOrigins http+https ve www varyasyonu uretir', () => {
    const origins = buildOrigins(['example.com']);
    assert.deepEqual(origins.sort(), [
      'http://example.com', 'http://www.example.com',
      'https://example.com', 'https://www.example.com'
    ]);
  });
});

describe('createDomainScope', () => {
  test('kok alan adi kapsami tum alt alan adlarini icerir', () => {
    const scope = createDomainScope('google.com');
    assert.equal(scope.isRoot, true);
    assert.equal(scope.base, 'google.com');
    assert.equal(scope.matches('google.com'), true);
    assert.equal(scope.matches('www.google.com'), true);
    assert.equal(scope.matches('mail.google.com'), true);
    assert.equal(scope.matches('a.b.google.com'), true);
    assert.equal(scope.matches('google.com.tr'), false);
    assert.equal(scope.matches('notgoogle.com'), false);
    assert.equal(scope.matches('evilgoogle.com'), false);
  });

  test('alt alan adi kapsami kardes ve ust alan adini DISLAR', () => {
    const scope = createDomainScope('mail.google.com');
    assert.equal(scope.isRoot, false);
    assert.equal(scope.base, 'mail.google.com');
    assert.equal(scope.matches('mail.google.com'), true);
    assert.equal(scope.matches('inbox.mail.google.com'), true);
    assert.equal(scope.matches('ads.google.com'), false);
    assert.equal(scope.matches('google.com'), false);
  });

  test('matchesCookie cerez domainini dogru cozer', () => {
    const scope = createDomainScope('google.com');
    assert.equal(scope.matchesCookie({ domain: '.google.com' }), true);
    assert.equal(scope.matchesCookie({ domain: 'mail.google.com' }), true);
    assert.equal(scope.matchesCookie({ domain: '.evil.com' }), false);
    assert.equal(scope.matchesCookie(null), false);
  });

  test('IP kapsami alt alan adi eslestirmez', () => {
    const scope = createDomainScope('127.0.0.1');
    assert.equal(scope.matches('127.0.0.1'), true);
    assert.equal(scope.matches('a.127.0.0.1'), false);
  });

  test('originsFor yalnizca kapsama giren hostlari alir', () => {
    const scope = createDomainScope('google.com');
    const origins = scope.originsFor(['mail.google.com', 'evil.com']);
    assert.ok(origins.includes('https://mail.google.com'));
    assert.ok(origins.includes('https://google.com'));
    assert.ok(!origins.includes('https://evil.com'));
  });

  test('gecersiz girdide null doner', () => {
    assert.equal(createDomainScope('chrome://x'), null);
    assert.equal(createDomainScope(''), null);
  });
});

describe('stripTrackingParams', () => {
  test('utm_* parametrelerini temizler', () => {
    const input = 'https://example.com/page?article=123&utm_source=twitter&utm_medium=social&utm_campaign=spring';
    const output = stripTrackingParams(input);
    assert.equal(output, 'https://example.com/page?article=123');
  });

  test('fbclid, gclid vb. tiklama izleyicilerini temizler', () => {
    const input = 'https://example.com/shop?item=42&fbclid=abc123xyz&gclid=google456';
    const output = stripTrackingParams(input);
    assert.equal(output, 'https://example.com/shop?item=42');
  });

  test('tum parametreler takip ise soru isaretini kaldirir', () => {
    const input = 'https://example.com/login?utm_source=email';
    const output = stripTrackingParams(input);
    assert.equal(output, 'https://example.com/login');
  });

  test('takip parametresi yoksa URL-yi degistirmez', () => {
    const input = 'https://example.com/search?q=privacy&page=2';
    assert.equal(stripTrackingParams(input), input);
  });

  test('dahili veya gecersiz adreste girdiyi aynen doner', () => {
    assert.equal(stripTrackingParams('chrome://settings/?utm_source=1'), 'chrome://settings/?utm_source=1');
    assert.equal(stripTrackingParams(''), '');
    assert.equal(stripTrackingParams(null), null);
  });
});
