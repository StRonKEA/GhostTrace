import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';

// chrome stub'i modul yuklemesinden ONCE kurulmali (moduller yuklenirken
// chrome.storage.onChanged dinleyicisi bagliyor).
installChromeStub();

const storage = await import('../lib/storage.js');
const rulesLib = await import('../lib/rules.js');

const {
  matchDomainRule, isRuleProtected, setDomainRule, deleteDomainRule,
  pruneExpiredRules, normalizeRule, snoozeAlarmName, RuleType
} = rulesLib;

beforeEach(async () => {
  installChromeStub();
  storage.__resetCacheForTests();
});

describe('matchDomainRule', () => {
  const rules = {
    'example.com': { domain: 'example.com', type: 'white', subdomains: true },
    'exact.com': { domain: 'exact.com', type: 'white', subdomains: false },
    'mail.corp.com': { domain: 'mail.corp.com', type: 'white', subdomains: false },
    'grey.com': { domain: 'grey.com', type: 'grey', subdomains: true }
  };

  test('birebir eslesme', () => {
    assert.equal(matchDomainRule('example.com', rules).type, 'white');
    assert.equal(matchDomainRule('https://example.com/x', rules).type, 'white');
  });

  test('www varyasyonu ayni kurala duser', () => {
    assert.equal(matchDomainRule('www.example.com', rules).type, 'white');
  });

  test('subdomains:true alt alan adlarini kapsar', () => {
    assert.equal(matchDomainRule('mail.example.com', rules).type, 'white');
    assert.equal(matchDomainRule('a.b.example.com', rules).type, 'white');
  });

  test('subdomains:false alt alan adlarini kapsamaz', () => {
    assert.equal(matchDomainRule('mail.exact.com', rules).type, 'default');
    assert.equal(matchDomainRule('exact.com', rules).type, 'white');
  });

  test('alt alan adi kurali kardes ve ust alan adini kapsamaz', () => {
    assert.equal(matchDomainRule('mail.corp.com', rules).type, 'white');
    assert.equal(matchDomainRule('ads.corp.com', rules).type, 'default');
    assert.equal(matchDomainRule('corp.com', rules).type, 'default');
  });

  test('subdomains:false olan alt alan adi kurali KENDI dallarini kapsamaz', () => {
    assert.equal(matchDomainRule('x.mail.corp.com', rules).type, 'default');
  });
});

describe('alt alan adi kurali + "alt alan adlarini da kapsa" (v2.7.0)', () => {
  // Kapsam YALNIZCA asagi dogru genisler: kendisi + kendi dallari.
  // Kardes ve ust alan adi hicbir kosulda kapsanmaz.
  const rules = {
    'mail.google.com': { domain: 'mail.google.com', type: 'white', subdomains: true }
  };

  test('kuralin kendisi korunur', () => {
    assert.equal(matchDomainRule('mail.google.com', rules).type, 'white');
  });

  test('KENDI alt dallari korunur', () => {
    assert.equal(matchDomainRule('x.mail.google.com', rules).type, 'white');
    assert.equal(matchDomainRule('a.b.mail.google.com', rules).type, 'white');
  });

  test('KARDES alan adi korunmaz', () => {
    assert.equal(matchDomainRule('drive.google.com', rules).type, 'default');
  });

  test('UST alan adi korunmaz', () => {
    assert.equal(matchDomainRule('google.com', rules).type, 'default');
    assert.equal(matchDomainRule('www.google.com', rules).type, 'default');
  });

  test('benzer isimli baska alan adina sizmaz', () => {
    assert.equal(matchDomainRule('notmail.google.com', rules).type, 'default');
    assert.equal(matchDomainRule('mail.google.com.evil.net', rules).type, 'default');
  });

  test('benzer isimli baska alan adina sizmaz', () => {
    assert.equal(matchDomainRule('notexample.com', rules).type, 'default');
    assert.equal(matchDomainRule('example.com.evil.net', rules).type, 'default');
  });

  test('suresi dolmus gecici izin default sayilir ve expired isaretlenir', () => {
    const expiredRules = {
      'temp.com': { domain: 'temp.com', type: 'temp', expiresAt: Date.now() - 1000, subdomains: true }
    };
    const match = matchDomainRule('temp.com', expiredRules);
    assert.equal(match.type, 'default');
    assert.equal(match.expired, true);
    assert.equal(isRuleProtected(match), false);
  });

  test('aktif gecici izin korumalidir', () => {
    const activeRules = {
      'temp.com': { domain: 'temp.com', type: 'temp', expiresAt: Date.now() + 60000, subdomains: true }
    };
    const match = matchDomainRule('temp.com', activeRules);
    assert.equal(match.type, 'temp');
    assert.equal(isRuleProtected(match), true);
  });

  test('isRuleProtected tum korumali turleri kapsar', () => {
    assert.equal(isRuleProtected({ type: 'white' }), true);
    assert.equal(isRuleProtected({ type: 'grey' }), true);
    assert.equal(isRuleProtected({ type: 'temp' }), true);
    assert.equal(isRuleProtected({ type: 'default' }), false);
    assert.equal(isRuleProtected(null), false);
  });

  test('public suffix seviyesindeki kural alt siteleri kazara kapsamaz', () => {
    const psRules = { 'co.uk': { domain: 'co.uk', type: 'white', subdomains: true } };
    assert.equal(matchDomainRule('bbc.co.uk', psRules).type, 'default');
    assert.equal(matchDomainRule('co.uk', psRules).type, 'white');
  });
});

describe('normalizeRule', () => {
  test('alt alan adi kuralinda subdomains VARSAYILAN false olur', () => {
    // Kullanici acikca istemedikce alt alan adi kurali yalnizca kendisini
    // kapsar; "kapsa" secenegi opt-in'dir.
    assert.equal(normalizeRule('mail.google.com', 'white', {}).subdomains, false);
    assert.equal(normalizeRule('mail.google.com', 'white', { subdomains: false }).subdomains, false);
  });

  test('alt alan adi kuralinda subdomains ACIKCA secilebilir', () => {
    // v2.7.0: secenek artik kilitli degil. mail.google.com + kapsa ->
    // kendisi ve KENDI dallari korunur (kardes/ust ASLA).
    assert.equal(normalizeRule('mail.google.com', 'white', { subdomains: true }).subdomains, true);
  });

  test('kok alan adi kuralinda subdomains VARSAYILAN true olur', () => {
    assert.equal(normalizeRule('google.com', 'white', {}).subdomains, true);
    assert.equal(normalizeRule('google.com', 'white', { subdomains: true }).subdomains, true);
    assert.equal(normalizeRule('google.com', 'white', { subdomains: false }).subdomains, false);
  });

  test('keepCookies kucuk harfe indirilip tekilleştirilir', () => {
    const rule = normalizeRule('a.com', 'white', { keepMode: 'custom', keepCookies: [' Sess* ', 'sess*', 'AUTH'] });
    assert.deepEqual(rule.keepCookies.sort(), ['auth', 'sess*']);
  });

  test('temp olmayan turde expiresAt temizlenir', () => {
    assert.equal(normalizeRule('a.com', 'white', { expiresAt: Date.now() + 1000 }).expiresAt, null);
  });

  test('gecersiz alan adinda null doner', () => {
    assert.equal(normalizeRule('chrome://x', 'white'), null);
  });
});

describe('kural + alarm yasam dongusu (B1/B2 regresyonu)', () => {
  test('temp kurali kaydedilince snooze alarmi kurulur', async () => {
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await setDomainRule('example.com', RuleType.TEMP, { expiresAt, durationMinutes: 15 });

    const alarm = await chrome.alarms.get(snoozeAlarmName('example.com'));
    assert.ok(alarm, 'snooze alarmi kurulmali');
    assert.equal(alarm.when, expiresAt);
  });

  test('temp kurali beyaz listeye cevrilince ESKI ALARM SILINIR', async () => {
    // Bu, v1.1.0'daki en tehlikeli hatanin regresyon testidir:
    // gecici izin -> beyaz liste gecisinde alarm hayatta kaliyor, suresi
    // dolunca beyaz liste kuralini silip siteyi temizliyordu.
    await setDomainRule('example.com', RuleType.TEMP, { expiresAt: Date.now() + 60000 });
    assert.ok(await chrome.alarms.get(snoozeAlarmName('example.com')));

    await setDomainRule('example.com', RuleType.WHITE, { subdomains: true });

    assert.equal(await chrome.alarms.get(snoozeAlarmName('example.com')), undefined,
      'beyaz listeye gecince snooze alarmi kalmamali');
    const rules = await storage.getRules();
    assert.equal(rules['example.com'].type, 'white');
    assert.equal(rules['example.com'].expiresAt, null);
  });

  test('kural silinince alarm da silinir', async () => {
    await setDomainRule('example.com', RuleType.TEMP, { expiresAt: Date.now() + 60000 });
    await deleteDomainRule('example.com');
    assert.equal(await chrome.alarms.get(snoozeAlarmName('example.com')), undefined);
  });

  test('www.x.com ve x.com ayni kanonik kurala yazilir', async () => {
    await setDomainRule('www.example.com', RuleType.WHITE);
    const rules = await storage.getRules();
    assert.deepEqual(Object.keys(rules), ['example.com']);
  });

  test('pruneExpiredRules suresi dolmuslari ve yetim alarmlari toplar', async () => {
    await setDomainRule('expired.com', RuleType.TEMP, { expiresAt: Date.now() + 50 });
    await setDomainRule('keep.com', RuleType.WHITE);
    // Kurali elle suresi dolmus yap
    await storage.mutateRules(rules => {
      rules['expired.com'].expiresAt = Date.now() - 1000;
      return rules;
    });

    const removed = await pruneExpiredRules();
    assert.deepEqual(removed, ['expired.com']);

    const rules = await storage.getRules();
    assert.deepEqual(Object.keys(rules), ['keep.com']);
    assert.equal(await chrome.alarms.get(snoozeAlarmName('expired.com')), undefined);
  });

  test('yetim snooze alarmi (kurali olmayan) temizlenir', async () => {
    await chrome.alarms.create(snoozeAlarmName('orphan.com'), { when: Date.now() + 60000 });
    await pruneExpiredRules();
    assert.equal(await chrome.alarms.get(snoozeAlarmName('orphan.com')), undefined);
  });
});
