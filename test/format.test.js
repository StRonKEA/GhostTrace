// GhostTrace - Bicimlendirme fonksiyonlari
//
// NEDEN VAR: Olculen kapsam raporunda options/ui/format.js %44.74 cikti.
// Bu fonksiyonlar kullanicinin GORDUGU sayilari uretiyor: kazanilan alan,
// goreli tarih, kalan sure, kural suresi. Hatali biri kullaniciya yanlis
// bilgi gosterir ve hicbir sey patlamaz - sessiz yanlislik.
//
// Hepsi saf fonksiyon (girdi -> dize), o yuzden dogrudan cagrilabilir.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';

let fmt;
let t;

before(async () => {
  installChromeStub({ tabs: [] });
  const i18n = await import('../lib/i18n.js');
  await i18n.initI18n();
  t = i18n.t;
  fmt = await import('../options/ui/format.js');
});

describe('formatBytes', () => {
  test('sifir ve gecersiz girdi 0 B doner', () => {
    assert.equal(fmt.formatBytes(0), '0 B');
    assert.equal(fmt.formatBytes(null), '0 B');
    assert.equal(fmt.formatBytes(undefined), '0 B');
    assert.equal(fmt.formatBytes(-500), '0 B', 'negatif deger uydurma sayi uretmemeli');
  });

  test('birimler dogru esikte degisir', () => {
    assert.match(fmt.formatBytes(512), /512\s*B/);
    assert.match(fmt.formatBytes(1024), /1\s*KB/);
    assert.match(fmt.formatBytes(1024 * 1024), /1\s*MB/);
    assert.match(fmt.formatBytes(1024 ** 3), /1\s*GB/);
  });

  test('cok buyuk deger TB ile sinirli kalir, tanimsiz birim uretmez', () => {
    const out = fmt.formatBytes(1024 ** 6);
    assert.match(out, /TB$/, `en ust birim TB olmali, gelen: ${out}`);
    assert.ok(!out.includes('undefined'), 'birim listesi tasmamali');
  });
});

describe('formatNumber', () => {
  test('sayi olmayan girdi 0 olur, NaN gostermez', () => {
    assert.equal(fmt.formatNumber('abc'), fmt.formatNumber(0));
    assert.ok(!fmt.formatNumber(undefined).includes('NaN'));
  });
});

describe('formatDate', () => {
  test('bos zaman damgasi tire doner', () => {
    assert.equal(fmt.formatDate(0), '-');
    assert.equal(fmt.formatDate(null), '-');
  });

  test('gecerli zaman damgasi tarih uretir', () => {
    const out = fmt.formatDate(Date.UTC(2026, 0, 15));
    assert.ok(out !== '-' && out.length > 4, `tarih uretilmeli, gelen: ${out}`);
  });
});

describe('formatRelative', () => {
  test('bos deger "yok" karsiligini doner', () => {
    assert.equal(fmt.formatRelative(0), t('common.none'));
  });

  test('bir dakikadan yeni ise "az once"', () => {
    assert.equal(fmt.formatRelative(Date.now() - 5_000), t('common.justNow'));
  });

  test('dakika / saat / gun esikleri ayri metin uretir', () => {
    const dk = fmt.formatRelative(Date.now() - 5 * 60_000);
    const saat = fmt.formatRelative(Date.now() - 5 * 3_600_000);
    const gun = fmt.formatRelative(Date.now() - 3 * 86_400_000);
    assert.notEqual(dk, saat, 'dakika ve saat ayni gorunmemeli');
    assert.notEqual(saat, gun, 'saat ve gun ayni gorunmemeli');
    for (const out of [dk, saat, gun]) {
      assert.ok(!out.includes('NaN') && !out.includes('undefined'), `bozuk cikti: ${out}`);
    }
  });
});

describe('formatDuration', () => {
  test('0 / bos = oturum kapsami', () => {
    assert.equal(fmt.formatDuration(0), t('common.sessionScope'));
    assert.equal(fmt.formatDuration(null), t('common.sessionScope'));
  });

  test('60 dakikanin altinda dakika birimi', () => {
    assert.match(fmt.formatDuration(15), /15/);
    assert.ok(fmt.formatDuration(15).includes(t('common.minutesUnit')));
  });

  test('tam saat ondalik gostermez, buçuk saat gosterir', () => {
    assert.match(fmt.formatDuration(120), /^2\s/, 'tam saat "2" olmali, "2.0" degil');
    assert.match(fmt.formatDuration(90), /1\.5/, 'bucuk saat ondalikli gosterilmeli');
  });
});

describe('formatRemaining', () => {
  test('bos deger bos dize doner', () => {
    assert.equal(fmt.formatRemaining(null), '');
    assert.equal(fmt.formatRemaining(0), '');
  });

  test('gecmis zaman "suresi doldu" doner', () => {
    assert.equal(fmt.formatRemaining(Date.now() - 1000), t('popup.timeExpired'));
  });

  test('saat + dakika birlikte gosterilir', () => {
    const out = fmt.formatRemaining(Date.now() + (90 * 60_000) + 5_000);
    assert.ok(out.includes(t('common.hoursUnit')), `saat birimi olmali: ${out}`);
    assert.ok(out.includes(t('common.minutesUnit')), `dakika birimi olmali: ${out}`);
  });

  test('tam saatte dakika kismi YAZILMAZ', () => {
    const out = fmt.formatRemaining(Date.now() + (120 * 60_000));
    assert.ok(out.includes(t('common.hoursUnit')));
    assert.ok(!out.includes(t('common.minutesUnit')),
      `tam saatte "0 dakika" yazilmamali: ${out}`);
  });
});

describe('kural secimi <-> kural nesnesi', () => {
  test('beyaz ve gri dogru cevrilir', () => {
    assert.equal(fmt.parseRuleSelection('white').type, 'white');
    assert.equal(fmt.parseRuleSelection('grey').type, 'grey');
    assert.equal(fmt.parseRuleSelection('bilinmeyen').type, 'white',
      'taninmayan deger en GUVENLI kademeye (beyaz) dusmeli');
  });

  test('gecici izin YALNIZCA sureyi uretir, bitisi normalizeRule turetir', async () => {
    // Bitis zamani ARTIK BURADA HESAPLANMIYOR. Iki ayri yerin cevirmesi su
    // hataya yol acmisti: burasi hesapliyordu, popup hesaplamiyordu,
    // normalizeRule ise yalnizca expiresAt okuyordu - popup'tan verilen
    // gecici izin hicbir zaman dolmuyordu. Cevirme tek yerde toplandi.
    const parsed = fmt.parseRuleSelection('temp_15');
    assert.equal(parsed.type, 'temp');
    assert.equal(parsed.options.durationMinutes, 15);
    assert.equal(parsed.options.expiresAt, undefined,
      'bitis zamani burada hesaplanmamali - tek yer normalizeRule');

    // Zincirin tamami yine dogru bitis uretmeli.
    const { normalizeRule } = await import('../lib/rules.js');
    const once = Date.now();
    const kural = normalizeRule('ornek.com', parsed.type, parsed.options);
    assert.ok(kural.expiresAt >= once + 15 * 60_000 - 50,
      'zincir sonunda bitis zamani sure kadar ileride olmali');
  });

  test('bozuk sure varsayilan 60 dakikaya duser', () => {
    assert.equal(fmt.parseRuleSelection('temp_abc').options.durationMinutes, 60);
    assert.equal(fmt.parseRuleSelection('temp_').options.durationMinutes, 60);
  });

  test('gidis-donus: secim -> kural -> secim korunur', () => {
    for (const value of ['white', 'grey', 'temp_15', 'temp_60', 'temp_1440']) {
      const parsed = fmt.parseRuleSelection(value);
      const back = fmt.ruleToSelection({ type: parsed.type, ...parsed.options });
      assert.equal(back, value, `gidis-donus bozuluyor: ${value} -> ${back}`);
    }
  });

  test('STANDART OLMAYAN sure listedeki en yakina degil 60 dakikaya duser', () => {
    // Bu davranis BILINCLI olarak belgeleniyor: arayuzdeki acilir liste yalnizca
    // 15/60/1440 tasiyor. Ice aktarma ile gelen 30 dakikalik bir kural listede
    // "60" olarak gorunur; kullanici dokunmadan kaydederse sure 60 olur.
    assert.equal(fmt.ruleToSelection({ type: 'temp', durationMinutes: 30 }), 'temp_60');
    assert.equal(fmt.ruleToSelection({ type: 'temp', durationMinutes: 5 }), 'temp_60');
  });

  test('bos kural beyaz doner', () => {
    assert.equal(fmt.ruleToSelection(null), 'white');
    assert.equal(fmt.ruleToSelection({ type: 'white' }), 'white');
  });
});

describe('timestampForFileName', () => {
  test('YYYYMMDD_HHMM bicimi uretir', () => {
    const out = fmt.timestampForFileName();
    assert.match(out, /^\d{8}_\d{4}$/, `beklenen bicim YYYYMMDD_HHMM, gelen: ${out}`);
  });

  test('dosya adinda kullanilamayan karakter icermez', () => {
    assert.ok(!/[\\/:*?"<>|]/.test(fmt.timestampForFileName()));
  });
});
