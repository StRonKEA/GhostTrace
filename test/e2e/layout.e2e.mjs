// GhostTrace - YERLESIM olcumleri (gercek tarayici).
//
// NEDEN: bu projede iki kez "goz" yanildi (yazi kalinligi ve kilit
// soluklastirmasi). Kirpilan bir etiket ekran goruntusunde "..." olarak
// gorunur ama hangi genislikte kirildigi tahmin edilemez. Burada olculen sey
// scrollWidth > clientWidth, yani gercekten tasma olup olmadigi.
//
// Kosum: npm run test:e2e:layout

import {
  launchChrome, attachExtension, openExtensionPage, evaluate, sleep,
  createRunner, assertOk, assertEqual
} from './harness.mjs';

const chrome = await launchChrome({ live: true, headless: true });
const runner = createRunner();
let setupError = null;

/** Bir secicideki her elemanin yatay tasmasini olcer. */
const TASMA = (secici) => `
  return (() => {
    const out = [];
    for (const el of document.querySelectorAll(${JSON.stringify(secici)})) {
      // 1px tolerans: alt piksel yuvarlamasi yanlis alarm uretiyor.
      const tasma = el.scrollWidth - el.clientWidth;
      if (tasma > 1) {
        out.push((el.id || el.className || el.tagName) + ' +' + tasma + 'px "'
          + (el.textContent || '').trim().slice(0, 40) + '"');
      }
    }
    return JSON.stringify(out);
  })()
`;

try {
  const { extensionId } = await attachExtension(chrome.client);

  // ---------------- POPUP ----------------
  const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 400, height: 640, deviceScaleFactor: 1, mobile: false
  }, popup.sessionId);
  await sleep(1200);

  console.log(`\nYERLESIM olcumleri (eklenti ${extensionId})\n`);

  await runner.test('popup: hicbir dugme etiketi KIRPILMIYOR', async () => {
    const raw = await evaluate(chrome.client, popup.sessionId, TASMA('.btn-text'));
    const kirpilan = JSON.parse(raw);
    assertEqual(kirpilan.length, 0,
      `kirpilan etiket(ler): ${kirpilan.join(' | ')}`);
  });

  await runner.test('popup: govde YATAY kaymiyor', async () => {
    const fark = await evaluate(chrome.client, popup.sessionId,
      'return document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assertOk(Number(fark) <= 1, `popup yatay tasiyor: +${fark}px`);
  });

  await runner.test('popup: dokunma hedefleri en az 28px', async () => {
    const raw = await evaluate(chrome.client, popup.sessionId, `
      return (() => {
        const kucuk = [];
        for (const b of document.querySelectorAll('button')) {
          if (b.offsetParent === null) continue;   // gizli
          const r = b.getBoundingClientRect();
          if (r.height < 28 || r.width < 28) {
            kucuk.push((b.id || b.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
          }
        }
        return JSON.stringify(kucuk);
      })()
    `);
    const kucuk = JSON.parse(raw);
    assertEqual(kucuk.length, 0, `kucuk hedef(ler): ${kucuk.join(' | ')}`);
  });

  await runner.test('popup: ikon dugmeleri erisilebilir AD tasiyor', async () => {
    const raw = await evaluate(chrome.client, popup.sessionId, `
      return (() => {
        const isimsiz = [];
        for (const b of document.querySelectorAll('button')) {
          const metin = (b.textContent || '').trim();
          const ad = b.getAttribute('aria-label') || '';
          if (!metin && !ad) isimsiz.push(b.id || b.className);
        }
        return JSON.stringify(isimsiz);
      })()
    `);
    const isimsiz = JSON.parse(raw);
    assertEqual(isimsiz.length, 0, `isimsiz dugme(ler): ${isimsiz.join(' | ')}`);
  });

  // ---------------- AYARLAR ----------------
  const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
  await chrome.client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  }, page.sessionId);
  await sleep(1200);

  await runner.test('ayarlar: sayfa YATAY kaymiyor', async () => {
    const fark = await evaluate(chrome.client, page.sessionId,
      'return document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assertOk(Number(fark) <= 1, `sayfa yatay tasiyor: +${fark}px`);
  });

  await runner.test('ayarlar: dar pencerede de yatay kaymiyor', async () => {
    await chrome.client.send('Emulation.setDeviceMetricsOverride', {
      width: 760, height: 900, deviceScaleFactor: 1, mobile: false
    }, page.sessionId);
    await sleep(400);
    const fark = await evaluate(chrome.client, page.sessionId,
      'return document.documentElement.scrollWidth - document.documentElement.clientWidth');
    await chrome.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    }, page.sessionId);
    await sleep(300);
    assertOk(Number(fark) <= 1, `760px'te yatay tasiyor: +${fark}px`);
  });

  await runner.test('ayarlar sekmesi: aciklamalar KAPALI basliyor', async () => {
    await evaluate(chrome.client, page.sessionId,
      `document.querySelector('[data-tab="settings-tab"]').click(); return 'ok';`);
    await sleep(700);
    const acik = await evaluate(chrome.client, page.sessionId, `
      return document.querySelectorAll('.row__detail:not([hidden])').length;
    `);
    assertEqual(Number(acik), 0, `${acik} aciklama paneli acik basliyor`);
  });

  await runner.test('ayarlar sekmesi: (i) tiklayinca aciklama GORUNUR oluyor', async () => {
    const yukseklik = await evaluate(chrome.client, page.sessionId, `
      return (() => {
        const b = document.querySelector('#settings-tab .row__info');
        b.click();
        const p = document.getElementById(b.getAttribute('aria-controls'));
        const h = p.getBoundingClientRect().height;
        b.click();
        return h;
      })()
    `);
    assertOk(Number(yukseklik) > 10,
      `acilan panelin yuksekligi olmali, olculen: ${yukseklik}px`);
  });

  await runner.test('ayarlar sayfasi kisaldi: 2800px altinda', async () => {
    // Onceki surum 3897px tek kaydirmaydi ve hicbir ayar taranamiyordu.
    const h = await evaluate(chrome.client, page.sessionId,
      `return document.getElementById('settings-tab').getBoundingClientRect().height;`);
    assertOk(Number(h) < 2800, `ayarlar paneli hala uzun: ${Math.round(h)}px`);
  });

  await runner.test('bagli ayar KILITLIYKEN gercekten soluk', async () => {
    // Sinifi eklemek gorunur bir sey yapmiyorsa kutu aktif gorunup sessizce
    // tiklamayi reddeder - bu projede bir kez tam olarak bu olmustu.
    const opaklik = await evaluate(chrome.client, page.sessionId, `
      return (() => {
        const ust = document.getElementById('settingTrackThirdParty');
        const alt = document.getElementById('settingTrackThirdPartyFrames');
        const satir = alt.closest('.toggle-item');
        if (ust.checked) { ust.click(); }
        const o = getComputedStyle(satir).opacity;
        return o;
      })()
    `);
    assertOk(Number(opaklik) < 0.9,
      `kilitli satir solmali, olculen opaklik: ${opaklik}`);
  });
  await runner.test('kenar sutunu sayfanin TAMAMINI kapliyor', async () => {
    // .side sticky ve 100vh: uzun sayfalarda kendi zemini ekran yuksekliginde
    // biter ve sutun yarida kesilmis gorunur. Zemin kapta olmali.
    const raw = await evaluate(chrome.client, page.sessionId, `
      return (() => {
        const shell = document.querySelector('.shell');
        const stil = getComputedStyle(shell, '::before');
        return JSON.stringify({
          sayfa: Math.round(document.documentElement.scrollHeight),
          kap: Math.round(shell.getBoundingClientRect().height),
          zemin: stil.backgroundColor,
          genislik: stil.width
        });
      })()
    `);
    const o = JSON.parse(raw);
    assertOk(o.zemin && o.zemin !== 'rgba(0, 0, 0, 0)',
      `kenar sutununun zemini yok: ${JSON.stringify(o)}`);
    assertOk(o.kap >= o.sayfa - 2,
      `kap sayfayi kaplamiyor: kap ${o.kap}px, sayfa ${o.sayfa}px`);
  });
  await runner.test('popup: Chrome ic sayfasinda site eylemleri GIZLI', async () => {
    // Kullanici bildirdi: chrome://newtab uzerinde popup, o sayfada hicbir
    // isi olmayan "Beyaz Listeye Ekle / Gecici Izin / Temizle" dugmelerini
    // ETKIN gosteriyordu. Sebep: popup.js kabi '.actions-section' ile
    // ariyordu, yeniden tasarim '.acts' yapmisti -> sorgu null donuyordu.
    const durum = await evaluate(chrome.client, popup.sessionId, `
      return (() => {
        const kap = document.getElementById('actionsSection');
        const ic = document.getElementById('internalCard');
        return JSON.stringify({
          kapVar: Boolean(kap),
          kapGizli: kap ? kap.classList.contains('hidden') : null,
          icKartGizli: ic ? ic.classList.contains('hidden') : null,
          rozet: (document.getElementById('delayBadge') || {}).textContent || '',
          temizleGorunur: (() => {
            const t = document.getElementById('btnPurgeNow');
            return Boolean(t && t.offsetParent !== null);
          })()
        });
      })()
    `);
    const d = JSON.parse(durum);
    assertOk(d.kapVar, 'eylem kabi id ile bulunabilmeli (actionsSection)');
    // Test sayfasi bir eklenti sayfasi = Chrome ic sayfasi sayilir.
    assertEqual(d.kapGizli, true,
      `ic sayfada site eylemleri gizli olmali; durum: ${durum}`);
    assertOk(!d.rozet.includes('{'),
      `gecikme rozetinde HAM SABLON gorunmemeli: "${d.rozet}"`);
    // Temizle dugmesi de ic sayfada anlamsiz: kabin ICINDE olmali ki
    // digerleriyle birlikte gizlensin.
    assertEqual(d.temizleGorunur, false,
      'ic sayfada "Bu Siteyi Simdi Temizle" gorunmemeli');
  });
  await runner.test('filtre cipleri GERCEKTEN tiklanabilir (uc sekme)', async () => {
    // OLCULEN KUSUR: rules.js cipleri '#rules-tab .filter-pills .pill' ile
    // ariyordu; yeniden tasarim '.seg' yapinca dongu SIFIR eleman gezdi ve
    // HIC dinleyici baglanmadi. Cipler olu kaldi, hicbir hata olusmadi.
    //
    // Yapi testi her kablolama hatasini yakalayamaz; asil kanit TIKLAMAK.
    // Burada olculen sey: tiklamadan sonra aktiflik gercekten TASINIYOR mu.
    const SEKMELER = [
      ['rules-tab', 'data-filter'],
      ['site-data-tab', 'data-site-filter'],
      ['logs-tab', 'data-log-filter']
    ];

    const sorunlar = [];
    for (const [tab, oznitelik] of SEKMELER) {
      await evaluate(chrome.client, page.sessionId,
        `document.querySelector('[data-tab="${tab}"]').click(); return 1;`);
      await sleep(600);

      const sonuc = await evaluate(chrome.client, page.sessionId, `
        return (() => {
          const cipler = [...document.querySelectorAll('#${tab} [${oznitelik}]')];
          if (cipler.length < 2) return JSON.stringify({ hata: 'cip bulunamadi: ' + cipler.length });

          const oncekiAktif = cipler.find(c => c.classList.contains('active'));
          const hedef = cipler.find(c => !c.classList.contains('active'));
          hedef.click();
          return JSON.stringify({
            hedefAktif: hedef.classList.contains('active'),
            oncekiBirakti: oncekiAktif ? !oncekiAktif.classList.contains('active') : true,
            hedefAd: hedef.getAttribute('${oznitelik}')
          });
        })()
      `);
      await sleep(500);

      const d = JSON.parse(sonuc);
      if (d.hata) { sorunlar.push(`${tab}: ${d.hata}`); continue; }
      if (!d.hedefAktif) sorunlar.push(`${tab}: tiklanan cip ("${d.hedefAd}") aktif olmadi`);
      if (!d.oncekiBirakti) sorunlar.push(`${tab}: onceki cip aktifligi birakmadi`);
    }

    assertEqual(sorunlar.length, 0,
      `filtre cipleri olu:\n  ${sorunlar.join('\n  ')}`);
  });

  await runner.test('UZUN alan adi gunluk sutunundan TASMIYOR', async () => {
    // KULLANICI BULGUSU (ekran goruntusu): "avatars.githubusercontent.com"
    // gibi uzun alan adlari, yanindaki "Olay" sutununun UZERINE biniyordu.
    //
    // Sebep: tablo `table-layout: fixed`, ama hucrenin sinifi (.log-domain)
    // CSS'te HIC tanimli degildi - hayalet sinif. Tasma kurali olmayinca
    // metin kolon sinirini asiyordu.
    //
    // Bu GORSEL bir kusur; ekran goruntusune bakmak kanit degil. Olculen sey
    // hucrenin GERCEK tasma miktari: scrollWidth (icerigin istedigi genislik)
    // clientWidth'i (kolonun verdigi genislik) asmamali.
    await evaluate(chrome.client, page.sessionId,
      `document.querySelector('[data-tab="logs-tab"]').click(); return 1;`);
    await sleep(600);

    const olcum = await evaluate(chrome.client, page.sessionId, `
      const tbody = document.querySelector('#logsTableBody');
      if (!tbody) return JSON.stringify({ hata: 'gunluk tablosu yok' });

      // Gercekten uzun bir alan adi enjekte et: dogal gunlukte bu uzunlukta
      // bir kayit her kosumda olmayabilir, o zaman test hicbir sey olcmez.
      //
      // Hucre DOGRU SUTUNA dusmeli. Ilk denemede tek <td>'lik satir
      // eklenmisti; colgroup sirasi geregi o hucre ZAMAN sutununa (104px)
      // oturdu ve test yanlis kolonu olctu. Once zaman ve seviye hucreleri
      // gelmeli ki ucuncu hucre alan adi sutununa denk gelsin.
      const tr = document.createElement('tr');
      tr.appendChild(document.createElement('td'));   // zaman
      tr.appendChild(document.createElement('td'));   // seviye
      const td = document.createElement('td');
      td.className = 'log-domain';
      td.textContent = 'cok-cok-uzun-alt-alan-adi.avatars.githubusercontent.com';
      tr.appendChild(td);
      tbody.appendChild(tr);

      const stil = getComputedStyle(td);
      const sonuc = {
        genislik: td.clientWidth,
        // ASIL SORU bu: metin hucre kutusunun DISINA bosaniyor mu?
        // scrollWidth > clientWidth bunu yanitlamaz - kirpilmis metinde de
        // scrollWidth icerik boyunu bildirir. Belirleyici olan overflow:
        // 'visible' ise metin yandaki sutunun uzerine biner (kullanicinin
        // bildirdigi durum), 'hidden' ise kutuda kalir.
        tasabilir: stil.overflow !== 'hidden' && stil.overflowX !== 'hidden',
        overflow: stil.overflow,
        tasmaKurali: stil.textOverflow,
        sarma: stil.whiteSpace
      };
      tr.remove();
      return JSON.stringify(sonuc);
    `);

    const d = JSON.parse(olcum);
    assertOk(!d.hata, d.hata || '');
    assertOk(d.genislik > 100, `kolon olculebilir genislikte olmali: ${d.genislik}px`);
    assertEqual(d.tasabilir, false,
      `uzun alan adi sutun disina tasabiliyor (overflow: ${d.overflow})`);
    assertEqual(d.tasmaKurali, 'ellipsis',
      'sigmayan ad uc nokta ile kirpilmali, sessizce kesilmemeli');
    assertEqual(d.sarma, 'nowrap', 'gunluk satiri sabit yukseklikte kalmali');
    console.log(`      -> kolon ${d.genislik}px, overflow: ${d.overflow}, kirpma: ${d.tasmaKurali}`);
  });
  await runner.test('BOLUM dikey ritmi TUM SEKMELERDE tutarli', async () => {
    // KULLANICI BULGUSU (iki asama):
    //   1) "yazilar arasi mesafeler uyumsuz" -> istatistik sekmesinde
    //      baslik->aciklama 4px/12px, aciklama->icerik 0px cikti.
    //   2) Duzeltme YALNIZCA istatistikte olculmustu. Ayarlar sekmesinde
    //      "Gizlilik sertlestirme" bolumunde aciklama ile icerik yine
    //      BITISIKTI (0px).
    //
    // Sebep ogretici: CSS `.grp__sub + .permrow` yaziyordu ama `+` BITISIK
    // kardes demek. Izin verilmisse o satir gizleniyor, sirasi gelen gorunur
    // oge `.toggle-list` oluyor ve ona kural yok. Yani bosluk IZIN DURUMUNA
    // gore kayboluyordu - tek sekme olcen bir test bunu goremez.
    //
    // Olcum GORUNUR ogeye yapilir: gizli bir kardesin kutusu yoktur ve ham
    // nextElementSibling anlamsiz sayilar uretir (ilk denemede -1728px).
    const SEKMELER = ['rules-tab', 'site-data-tab', 'settings-tab',
      'stats-tab', 'logs-tab'];
    // IKI DURUM olculur. Bu takim tek kullanimlik profille kosuyor, yani
    // `privacy` izni HIC verilmemis olur ve `.permrow` her zaman GORUNUR
    // kalir. Kusur tam da izin VERILDIGINDE ortaya cikiyordu; test kosulu
    // profile birakirsa o hali hicbir zaman goremez.
    const DURUMLAR = [
      { ad: 'izin-satiri-gorunur', permrowGizle: false },
      { ad: 'izin-verilmis', permrowGizle: true }
    ];
    const sorunlar = [];

    for (const { ad: durum, permrowGizle } of DURUMLAR)
    for (const tab of SEKMELER) {
      await evaluate(chrome.client, page.sessionId,
        `document.querySelector('[data-tab="${tab}"]').click(); return 1;`);
      await sleep(450);

      const ham = await evaluate(chrome.client, page.sessionId, `
        const gorunur = (e) => Boolean(e) && e.getClientRects().length > 0;
        const bosluk = (ust, alt) =>
          Math.round(alt.getBoundingClientRect().top - ust.getBoundingClientRect().bottom);

        // Veri yoksa gizlenen bolumler olcumden duser; yerlesim kurallari
        // veriden bagimsiz oldugu icin gecici olarak acilir.
        const gizli = [...document.querySelectorAll('#${tab} .grp.hidden')];
        gizli.forEach(s => s.classList.remove('hidden'));

        // Izin verilmis durumu taklit et: izin satiri gizlenir. Boylece
        // .grp__sub + .permrow BITISIK kardes kurali devre disi kalir ve
        // aciklamadan sonraki GORUNUR ogeye kural olup olmadigi olculur.
        const permGizlendi = [];
        if (${permrowGizle}) {
          for (const e of document.querySelectorAll('#${tab} .permrow')) {
            if (e.getClientRects().length) { e.style.display = 'none'; permGizlendi.push(e); }
          }
        }

        const out = { basAcik: [], acikIcerik: [] };
        for (const s of document.querySelectorAll('#${tab} .grp')) {
          const bas = s.querySelector('.grp__head') || s.querySelector('.grp__title');
          const alt = s.querySelector('.grp__sub');
          if (gorunur(bas) && gorunur(alt)) out.basAcik.push(bosluk(bas, alt));
          if (!gorunur(alt)) continue;
          let ic = alt.nextElementSibling;
          while (ic && !gorunur(ic)) ic = ic.nextElementSibling;
          if (gorunur(ic)) out.acikIcerik.push(bosluk(alt, ic));
        }
        permGizlendi.forEach(e => { e.style.display = ''; });
        gizli.forEach(s => s.classList.add('hidden'));
        return JSON.stringify(out);
      `);

      const d = JSON.parse(ham);
      for (const [ad, liste] of [['baslik->aciklama', d.basAcik],
        ['aciklama->icerik', d.acikIcerik]]) {
        const benzersiz = [...new Set(liste)];
        if (benzersiz.length > 1) {
          sorunlar.push(`[${durum}] ${tab} ${ad}: ${JSON.stringify(liste)}`);
        }
        if (benzersiz.some(v => v <= 0)) {
          sorunlar.push(`[${durum}] ${tab} ${ad}: sifir/negatif bosluk ${JSON.stringify(benzersiz)}`);
        }
      }
    }

    assertEqual(sorunlar.length, 0,
      `dikey ritim tutarsiz:\n      ${sorunlar.join('\n      ')}`);
    console.log(`      -> ${SEKMELER.length} sekme x ${DURUMLAR.length} durum olculdu, ritim tutarli`);
  });

  await runner.test('popup: TIKLANABILIR her kontrol GORUNUR sinir tasiyor', async () => {
    // KULLANICI BULGUSU: "yalnizca gecmisi sil normal bir yazi gibi duruyor,
    // buton oldugu anlasilmiyor". Olcum sebebi gosterdi: kenarlik VARDI ama
    // rengi rgba(0,0,0,0) - yani genislik var, renk yok. .btn--quiet saydam
    // kenarlik veriyor ve ozel sinif onu ezmiyordu.
    //
    // Bu, oturumda UCUNCU kez cikan ayni kusur (kapsam etiketi ve filtre
    // cipleri de tiklanabilir gorunmuyordu). Artik olculuyor: bir kontrol ya
    // gorunur kenarlik tasiyacak ya da zeminden ayrisan bir arka plani
    // olacak. Ikisi de yoksa duz metinden ayirt edilemez.
    const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
    await sleep(700);

    const ham = await evaluate(chrome.client, popup.sessionId, `
      for (const id of ['domainCard', 'actionsSection', 'protectOpts']) {
        const e = document.getElementById(id);
        if (e) e.classList.remove('hidden');
      }
      // Regex YOK: heredoc kacislari bu satiri iki kez bozdu. Duz metin
      // ayristirma ayni isi yapiyor ve kacis gerektirmiyor.
      const saydam = (renk) => {
        const s = String(renk);
        const a = s.indexOf("("), z = s.indexOf(")");
        if (a < 0 || z < 0) return true;
        const p = s.slice(a + 1, z).split(",").map(x => parseFloat(x.trim()));
        return p.length > 3 && p[3] === 0;
      };
      const kotu = [];
      for (const el of document.querySelectorAll("button")) {
        if (!el.getClientRects().length) continue;
        const s = getComputedStyle(el);
        const kenarVar = parseFloat(s.borderTopWidth) > 0 && !saydam(s.borderTopColor);
        const zeminVar = !saydam(s.backgroundColor);
        if (!kenarVar && !zeminVar) {
          kotu.push((el.id || "?") + " " + (el.className || "") + " [" + (el.textContent || "").trim().slice(0, 24) + "]");
        }
      }
      return JSON.stringify(kotu);
    `);

    const kotu = JSON.parse(ham);
    // Simge dugmeleri (dis carki, chevron) bilincli olarak sade: metinleri
    // yok, ikonlari zaten tiklanabilirligi anlatiyor.
    const beklenen = kotu.filter(k => !/top__cog|btn--icon|durseg__b|menu__opt/.test(k));
    assertEqual(beklenen.length, 0,
      'duz yazidan ayirt edilemeyen dugme(ler): ' + beklenen.join(' | '));
    console.log('      -> ' + (kotu.length - beklenen.length) + ' sade simge dugmesi haric, hepsi gorunur');
  });

  await runner.test('islem dugmeleri SUTUN boyunca hizali (sabit yuvalar)', async () => {
    // KULLANICI BULGUSU: "buton boyutlari esit olmadigi icin duzensiz
    // duruyor, muhtemelen kelime uzunluguna gore uzaniyor".
    //
    // COZUM SONRADAN DEGISTI ve bu test eski cozumu dogruluyordu. Ilk cozum
    // her dugmeye 104px asgari genislik veriyordu; olcum gosterdi ki bu,
    // islem sutununu 336px'e (tablonun ucte biri) cikariyor ve ALAN ADI
    // sutununu 203px'e sikistirip uzun alan adlarini ikiye boluyordu.
    //
    // Yurulukteki cozum UC SABIT YUVA: grid-template-columns: auto 76px 88px.
    // Hizalama artik "her dugme ayni genislikte" degil, "her SUTUN her satirda
    // ayni yerde". Ilk yuva `auto`, cunku "Gecmisi sil" yalnizca bazi
    // satirlarda cikar ve olmayan dugme icin yer ayirmak asil sorundu.
    //
    // Test o yuzden esit genislik degil, YUVA GENISLIKLERININ ETIKETTEN
    // BAGIMSIZ oldugunu olcer - duzensiz gorunumu ureten sey buydu.
    await evaluate(chrome.client, page.sessionId,
      "document.querySelector('[data-tab=\"site-data-tab\"]').click(); return 1;");
    await sleep(2500);

    // Bos test profilinde tablo bos kalir ve olcum HICBIR SEY yapmaz - bos
    // gecen bir test, olmayan bir testtir. Bu yuzden ayni izgara iki kez,
    // KISA ve UZUN etiketlerle kuruluyor: olculen sey VERI degil, CSS kurali.
    const ham = await evaluate(chrome.client, page.sessionId, `
      const olc = (etiketler) => {
        const kap = document.createElement('div');
        kap.className = 'btn-action-group';
        kap.style.position = 'fixed';
        kap.style.top = '0';
        kap.style.width = '400px';
        for (const [sinif, metin] of etiketler) {
          const d = document.createElement('button');
          d.className = sinif;
          d.textContent = metin;
          kap.appendChild(d);
        }
        document.body.appendChild(kap);
        const g = [...kap.querySelectorAll('button')]
          .map(b => Math.round(b.getBoundingClientRect().width));
        kap.remove();
        return g;
      };
      return JSON.stringify({
        kisa: olc([['btn-sm', 'Sil'], ['btn-danger-sm', 'Kaldir'], ['btn-success-sm', 'Ekle']]),
        uzun: olc([['btn-sm', 'Gecmisi sil'], ['btn-danger-sm', 'Temizle'],
                   ['btn-success-sm', 'Beyaz liste']])
      });
    `);
    const o = JSON.parse(ham);
    console.log('      -> kisa etiket ' + o.kisa.join('/') + 'px, uzun etiket ' + o.uzun.join('/') + 'px');

    // Sabit yuvalar (2 ve 3) etiket uzunlugundan BAGIMSIZ ayni genislikte
    // olmali - "kelime uzunluguna gore uzaniyor" sikayetinin olcumu budur.
    assertEqual(o.kisa[1], o.uzun[1],
      '2. yuva etikete gore degisiyor: ' + o.kisa[1] + ' vs ' + o.uzun[1]);
    assertEqual(o.kisa[2], o.uzun[2],
      '3. yuva etikete gore degisiyor: ' + o.kisa[2] + ' vs ' + o.uzun[2]);

    // Ve degerler CSS'te YAZILI olanlar olmali; kaymasi sessiz bir regresyon.
    assertEqual(o.uzun[1], 76, '2. yuva 76px olmali');
    assertEqual(o.uzun[2], 88, '3. yuva 88px olmali');
  });

  await runner.test('popup: hata seridi hicbir kontrolu ORTMUYOR', async () => {
    // KULLANICI BULGUSU (ekran goruntusu): "popupda boyle uyari diger
    // secenekleri kapatiyor". Bildirim position:fixed idi ve en alttaki ana
    // anahtarin ustune biniyordu.
    //
    // Birim testi bunu GOREMEZ: metni okur, konumu okumaz. Bu yuzden olcum
    // burada - serit gorunurken alttaki kontrol hala tam gorunur olmali.
    const popup = await openExtensionPage(chrome.client, extensionId, 'popup/popup.html');
    await sleep(700);

    const ham = await evaluate(chrome.client, popup.sessionId, `
      const serit = document.getElementById('errorNotice');
      serit.textContent = 'Bu sitenin verileri temizlenemedi.';
      serit.classList.remove('hidden');
      const anahtar = document.querySelector('.master');
      const s = serit.getBoundingClientRect();
      const a = anahtar.getBoundingClientRect();
      const kesisiyor = !(s.bottom <= a.top || s.top >= a.bottom);
      return JSON.stringify({
        seritVar: s.height > 0,
        konum: getComputedStyle(serit).position,
        kesisiyor,
        sayfaTasiyor: document.body.scrollWidth > window.innerWidth
      });
    `);
    const o = JSON.parse(ham);
    assertOk(o.seritVar, 'hata seridi gorunur olmali');
    assertEqual(o.konum, 'static',
      'serit AKISTA durmali; position:' + o.konum + ' ustune biner');
    assertEqual(o.kesisiyor, false,
      'hata seridi ana anahtarin ustune BINMEMELI');
    assertEqual(o.sayfaTasiyor, false, 'serit yatay tasma yaratmamali');
    console.log('      -> serit akista (' + o.konum + '), ortusme yok');
  });

  await runner.test('site verileri: ALAN ADI bolunmuyor, islem sutunu tabloyu yemiyor', async () => {
    // KULLANICI BULGUSU (ekran goruntusu): "alan adi kisimi kayiyor" -
    // internetdownloadmanager.com iki satira bolunuyordu.
    //
    // Olcum sebebi gosterdi: sutun darligi degil, ISLEM sutunu 352px
    // (tablonun ucte biri) aliyordu. Ucuncu yuva "Gecmisi sil" icindi ve
    // yalnizca beyaz listedeki, gecmisi olan sitelerde cikiyor - yani cogu
    // satirda OLMAYAN bir dugme icin 104px ayriliyordu.
    const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
    // GORUNTU BOYUTU SABITLENMELI. Emulation ayari SAYFA BASINA; kendi
    // sayfasini acan test ayarlamazsa varsayilan pencerede olcer (tablo
    // ~963px) ama esikler 1280px tasarim hedefine gore konmustur. Olcum
    // penceresi yazili degilse sonuc tekrarlanabilir degildir.
    await chrome.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    }, page.sessionId);
    await sleep(1100);
    await evaluate(chrome.client, page.sessionId, `
      document.querySelector('[data-tab="site-data-tab"]').click();
      return 'ok';
    `);
    await sleep(500);

    const ham = await evaluate(chrome.client, page.sessionId, `
      const govde = document.getElementById('siteDataTableBody');
      govde.innerHTML = '';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type=checkbox></td>' +
        '<td><span class="domain-code">internetdownloadmanager.com</span></td>' +
        '<td>Ana site</td><td>1</td><td>-</td><td>-</td><td>Izin verilmeyen</td>' +
        '<td><div class="btn-action-group"><span class="act-slot-empty"></span>' +
        '<button class="btn-danger-sm">Temizle</button>' +
        '<button class="btn-success-sm">Beyaz liste</button></div></td>';
      govde.appendChild(tr);
      const tablo = document.querySelector('.site-data-table');
      const basliklar = [...tablo.querySelectorAll('thead th')];
      return JSON.stringify({
        adYukseklik: Math.round(tr.querySelector('.domain-code').getBoundingClientRect().height),
        adSutun: Math.round(basliklar[1].getBoundingClientRect().width),
        islemSutun: Math.round(basliklar[7].getBoundingClientRect().width),
        tablo: Math.round(tablo.getBoundingClientRect().width),
        bosYuva: Math.round(tr.querySelector('.act-slot-empty').getBoundingClientRect().width)
      });
    `);
    const o = JSON.parse(ham);

    // Tek satir: mono 13px'te bir satir ~15-17px. Bolunse iki kati olurdu.
    assertOk(o.adYukseklik < 26,
      'alan adi TEK satirda kalmali; olculen yukseklik ' + o.adYukseklik + 'px');
    assertOk(o.bosYuva === 0,
      'olmayan dugme icin yer AYRILMAMALI; bos yuva ' + o.bosYuva + 'px');
    assertOk(o.islemSutun < o.tablo * 0.3,
      'islem sutunu tablonun ucte birini gecmemeli; ' + o.islemSutun + '/' + o.tablo + 'px');
    assertOk(o.adSutun >= 240,
      'alan adi sutunu taban genisligi almali; olculen ' + o.adSutun + 'px');
    console.log('      -> alan adi ' + o.adSutun + 'px (tek satir), islem ' + o.islemSutun + 'px');
  });

  await runner.test('site verileri: sigmayan tablo KIRPILMAZ, kaydirilir', async () => {
    // KULLANICI BULGUSU (ekran goruntusu): ISLEMLER sutunu kesilmis, en
    // sagdaki dugme yarim gorunuyordu.
    //
    // Sebep: .panel overflow:hidden tasiyor. Kose yuvarlatmasi icin dogru
    // ama tablo icin bu, dugmelerin ERISILEMEZ olmasi demekti - kaydiramaz,
    // tiklayamazsin. Kirpmak sessiz bir islev kaybi.
    //
    // EN KOTU DURUM burada: beyaz listede + gecmisi olan satir UC dugme
    // tasir (Gecmisi sil / Korumali / Kaldir). Iki dugmeli satirla olcmek
    // bu durumu hic gormuyordu.
    const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
    // GORUNTU BOYUTU SABITLENMELI. Emulation ayari SAYFA BASINA; kendi
    // sayfasini acan test ayarlamazsa varsayilan pencerede olcer (tablo
    // ~963px) ama esikler 1280px tasarim hedefine gore konmustur. Olcum
    // penceresi yazili degilse sonuc tekrarlanabilir degildir.
    await chrome.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    }, page.sessionId);
    await sleep(1100);
    await evaluate(chrome.client, page.sessionId, `
      document.querySelector('[data-tab="site-data-tab"]').click();
      return 'ok';
    `);
    await sleep(500);

    const ham = await evaluate(chrome.client, page.sessionId, `
      const govde = document.getElementById('siteDataTableBody');
      govde.innerHTML = '';
      const uc = document.createElement('tr');
      uc.innerHTML = '<td><input type=checkbox></td>' +
        '<td><span class="domain-code">accounts.google.com</span></td>' +
        '<td>Ana site</td><td>7</td><td>1</td><td>-</td><td>Beyaz liste</td>' +
        '<td><div class="btn-action-group">' +
        '<button class="btn-warning-sm">Gecmisi sil</button>' +
        '<span class="tag-protected">Korumali</span>' +
        '<button class="btn-danger-sm">Kaldir</button></div></td>';
      govde.appendChild(uc);

      const tablo = document.querySelector('.site-data-table');
      const sar = tablo.closest('.table-scroll');
      if (!sar) return JSON.stringify({ sarmalayiciYok: true });

      // En saga kaydirip son dugmenin GORUNUR alana girdigini dogrula.
      sar.scrollLeft = sar.scrollWidth;
      const dugme = uc.querySelector('.btn-danger-sm').getBoundingClientRect();
      const kutu = sar.getBoundingClientRect();
      const ulasilir = dugme.right <= kutu.right + 1 && dugme.left >= kutu.left - 1;
      sar.scrollLeft = 0;

      return JSON.stringify({
        sarmalayiciYok: false,
        overflow: getComputedStyle(sar).overflowX,
        ulasilir,
        sayfaTasiyor: document.documentElement.scrollWidth > window.innerWidth,
        adSutun: Math.round(tablo.querySelectorAll('thead th')[1].getBoundingClientRect().width)
      });
    `);
    const o = JSON.parse(ham);
    assertOk(!o.sarmalayiciYok, 'tablo bir .table-scroll sarmalayicisi icinde olmali');
    assertEqual(o.overflow, 'auto', 'sarmalayici yatay KAYDIRABILMELI, kirpmamali');
    assertEqual(o.ulasilir, true,
      'en sagdaki islem dugmesine kaydirarak ULASILABILMELI');
    assertEqual(o.sayfaTasiyor, false, 'SAYFA yatay kaymamali - kaydirma tabloda kalmali');
    assertOk(o.adSutun >= 240, 'alan adi tabani korunmali; olculen ' + o.adSutun + 'px');
    console.log('      -> uc dugmeli satirda bile dugmeler erisilir, sayfa kaymiyor');
  });

  await runner.test('islem dugmeleri BIRBIRINE YAPISIK degil', async () => {
    // KULLANICI BULGUSU (ekran goruntusu): "butonlar yapisik".
    //
    // BENIM URETTIGIM GERILEME. Denetim araci .btn-action-group'un ayni
    // dosyada iki kez tanimli oldugunu bildirdi; ikinci tanim display'i
    // eziyordu. Selektoru ilk bloktan tamamen cikardim - ama o blokta
    // display'in YANINDA `gap` de vardi ve o EZILMIYORDU. Yani kural
    // tamamen olu degildi, yalnizca bir bildirimi oluydu.
    //
    // Olcum bunu zaten gosteriyordu: izgara genisligi 312px cikmisti,
    // yani 3 x 104 ve HIC bosluk yok. Veriye bakmamisim.
    const page = await openExtensionPage(chrome.client, extensionId, 'options/options.html');
    // GORUNTU BOYUTU SABITLENMELI. Emulation ayari SAYFA BASINA; kendi
    // sayfasini acan test ayarlamazsa varsayilan pencerede olcer (tablo
    // ~963px) ama esikler 1280px tasarim hedefine gore konmustur. Olcum
    // penceresi yazili degilse sonuc tekrarlanabilir degildir.
    await chrome.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    }, page.sessionId);
    await sleep(1100);
    await evaluate(chrome.client, page.sessionId, `
      document.querySelector('[data-tab="site-data-tab"]').click();
      return 'ok';
    `);
    await sleep(500);

    const ham = await evaluate(chrome.client, page.sessionId, `
      const govde = document.getElementById('siteDataTableBody');
      govde.innerHTML = '';
      // IKI GERCEK DUGME yan yana. Onceki surumde ortada dar bir "Korumali"
      // ETIKETI vardi; etiket 104px yuvada ortalandigi icin yanlarinda
      // bosluk kaliyor ve test yapisikligi HIC gormuyordu. Kullanicinin
      // gordugu durum bu: iki dugme, ikisi de yuvasini dolduruyor.
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type=checkbox></td>' +
        '<td><span class="domain-code">doubleclick.net</span></td>' +
        '<td>3. taraf</td><td>-</td><td>-</td><td>1</td><td>Izin verilmeyen</td>' +
        '<td><div class="btn-action-group"><span class="act-slot-empty"></span>' +
        '<button class="btn-danger-sm">Temizle</button>' +
        '<button class="btn-success-sm">Beyaz liste</button></div></td>';
      govde.appendChild(tr);

      const ogeler = [...tr.querySelectorAll('.btn-action-group > *')]
        .filter(o => o.getBoundingClientRect().width > 0)
        .map(o => o.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      const araliklar = [];
      for (let i = 1; i < ogeler.length; i++) {
        araliklar.push(Math.round(ogeler[i].left - ogeler[i - 1].right));
      }
      // Kurallar tablosundaki eylem kabi ayni dili konusmali.
      const kural = getComputedStyle(document.querySelector('.rule-actions-wrap')
        || document.createElement('div')).gap;
      return JSON.stringify({ araliklar, izgaraGap: getComputedStyle(
        tr.querySelector('.btn-action-group')).gap, kural });
    `);
    const o = JSON.parse(ham);
    const enDar = Math.min(...o.araliklar);
    assertOk(enDar >= 4,
      'komsu islem dugmeleri arasinda gorunur bosluk olmali; olculen araliklar: '
      + o.araliklar.join(', ') + 'px');
    console.log('      -> araliklar ' + o.araliklar.join('/') + 'px (gap: ' + o.izgaraGap + ')');
  });

} catch (e) {
  setupError = e;
} finally {
  await chrome.close();
}

if (setupError) {
  console.error('\nKURULUM HATASI:', setupError.message);
  process.exit(1);
}
process.exit(runner.summary() ? 0 : 1);
