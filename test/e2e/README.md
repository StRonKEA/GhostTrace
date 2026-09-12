# Gerçek tarayıcı testleri (E2E)

```bash
npm run e2e:setup      # bir kez: test tarayıcısını indirir (~190 MB)
npm run test:e2e       # 17 senaryo, ~1 dk, TAMAMEN YEREL
npm run test:e2e:live  # gerçek sitelerde, İNTERNETE ÇIKAR, ~5 dk
npm run test:e2e:features # 64 senaryo, TÜM özellikler, gerçek siteler, ~10 dk
npm run test:e2e:frames   # "iframe'leri de izle" ayarının gerçek kazancını ölçer
npm run test:e2e:gunluk   # 21 senaryo, günlük kullanım akışı, ~20 dk
npm run test:e2e:muhasebe # 46 senaryo, TAM MUHASEBE, taklit siteler, ~55 dk
npm run test:e2e:canli    # 31 senaryo, GERCEK siteler + GERCEK arayuz, ~23 dk
                          #   GT_HEADED=1 ile tarayici GORUNUR acilir
npm run test:e2e:matris   # 23 senaryo, HER AYAR acik/kapali ETKISIYLE, ~2 dk
npm run e2e:kill          # YALNIZCA test tarayicisini kapatir
```

**Elle hazirlik isteyen dorduncu takim** (gizli pencere izni gerekir):

```bash
GT_PROFILE=<profil> npm run test:e2e:gizli   # 9 senaryo, GIZLI+NORMAL karisik
```

**Ag engellemesi KAPALI olmasi gereken takim:**

```bash
npm run test:e2e:yetim    # 8 senaryo, gercek reklam aglarinin yetim cerezleri
```

**Surum oncesi kontrol listesinden otomatiklestirilenler** (2026-09-02):

```bash
npm run test:e2e:alarm     # 7 senaryo, >=30 sn ALARM yolu (~1 dk) - liste madde 3
npm run test:e2e:gozlemci  # 10 senaryo, acik sekmeye geri doldurma (~1 dk) - madde 5
npm run test:e2e:erisim    # madde 6 - ON KOSUL ELLE, yoksa olcmeden cikar (kod 2)
```

`test:e2e:alarm` cleanDelay=30 ile GERCEK alarm yolunu olcer; `test:e2e`
yalnizca `cleanDelay: 0` yolunu olcuyor ve o yol alarm KULLANMIYOR. MV3
alarmi hizlandirilamiyor ama BEKLENEBILIYOR - olculen atesleme 31.1 sn.

`test:e2e:erisim` ON KOSULU programatik kurulamiyor: `<all_urls>` zorunlu izin
oldugu icin `permissions.remove` reddediliyor, Chrome 152'de chrome://extensions
detay gorunumunde site erisimi radyo grubu ARTIK YOK ve
`chrome://settings/content/siteAccess` da yok. Kontrol arac cubugu menusune
tasindi, o menu CDP ile surulemiyor. Ayrinti: CONTEXT.md kontrol listesi 6.

## `test:e2e:matris` — her ayar acik/kapali, ETKISIYLE

`canli-kullanim` Faz 8 on dort anahtari acip kapatir ama yalnizca KUTUCUGUN
degistigini dogrular. Bir anahtar tiklaninca `checked` degisir ve depoya
yazilir; bu, o ayarin temizligi gercekten degistirdigini GOSTERMEZ. Sessizce
islevsiz kalan bir ayar boyle fark edilmez.

Bu takim her ozellik icin ayni senaryoyu iki kez kosar: ayar KAPALIYKEN veri
DURMALI, ACIKKEN GITMELI. Iddia "kutucuk degisti" degil, "veri gitti / kaldi".
Ayarlar gercek arayuzden, `label.switch` uzerine koordinatli fare olayiyla
degistirilir. `cleanDelay=0` oldugu icin 23 kontrol 2 dakikada biter;
zamanlama dogrulugu ayri bir yerde (muhasebe FAZ 5) olculur.

## `test:e2e:gizli` — gizli ve normal pencere AYNI ANDA

`features-incognito` gizli pencereyi tek yonlu olcer. Bu takim KARISIK
kullanimi olcer: ayni sitenin iki profilde ayni anda acik olmasi ve
sekmelerin farkli siralarla kapanmasi. Temizlik karari "bu sitenin acik
sekmesi var mi?" sorusuna dayanir; o sorgu iki profili ayirt etmezse iki
yonlu hata olur ve IKISI DE SESSIZDIR:

- gizli sekme ACIK diye normal profilin temizligi ATLANIR (veri kalir)
- gizli sekme KAPANDI diye normal profilin verisi SILINIR (erken silme)

Olcum `getAllCookieStores()` ile depolari ACIKCA ayirir. Ayirmadan
"silindi mi?" sorusu yanlis depodan cevaplanir - olculmeye calisilan hata
olcum tarafinda tekrarlanirdi.

## `test:e2e:yetim` — gercek reklam aglarinin yetim cerezleri

`canli-kullanim` kosumunda, ag duzeyinde reklam engelleme KAPALIYKEN tur
sonunda 84 alan adi kaldi ve 80'i korumasizdi: 33across.com, 3lift.com,
adroll.com... Hicbiri ziyaret edilmemisti; hepsi UCUNCU TARAF olarak cerez
birakmisti. Onlari yetim supurmesi toplar - ama supurmenin GERCEK reklam
agi cerezlerini gercekten topladigi hic olculmemisti.

Fark onemli: taklit ortamda yetim sayisi bir elin parmaklarini gecmez.
Gercekte 80 cikti ve supurmenin tek turda aldigi ust sinir 60
(`SWEEP_MAX_DOMAINS`). Yani gercek yuk, taklidin hic uretmedigi bir kosulu
tetikliyor: supurme kapasiteyi asiyor ve DEVAM ALARMIYLA surmek zorunda.

**Bu takim agda reklam engelleme varsa BOS GECER** (NextDNS, Pi-hole,
tarayici engelleyicisi): reklam alan adlari yuklenmez, yetim olusmaz.
Bos gecen test olmayan testtir - bu yuzden ilk test yetim sayisini ON KOSUL
olarak sinar ve bes taneden azsa ACIKCA patlar.

> **`taskkill /IM chrome.exe` KULLANMAYIN.** Her Chromium surecini oldurur,
> kullanicinin kendi tarayicisi dahil - bir kez yapildi ve kullanicinin
> Helium penceresi kapandi. `npm run e2e:kill` yalnizca komut satirinda
> `gt-e2e-` gecici profili gecen surecleri hedefler.

## Tekrar eden testler neden ayiklandi

Uc takim ayni sinami tekrar ediyordu ve maliyet ASIL OLARAK BEKLEYISLERDEYDI,
iddia sayisinda degil:

- `canli-muhasebe.e2e.mjs` SILINDI. `canli-kullanim.e2e.mjs` yazilmadan onceki
  taslakti; sekiz testinin sekizi de yeni dosyada, cogu ayni isimle duruyordu.
  `package.json`'da betigi bile yoktu - kimse cagirmiyordu.
- `muhasebe.e2e.mjs` iki uzun bosta kalma tasiyordu (FAZ 7'de 30 dk, FAZ 8r'de
  25 dk) ve ikisi de ayni seyi olcuyordu. Olculen sey gecen TOPLAM sureye degil
  BOSTA KALMA suresine bagli; 30 dakika worker'i defalarca oldurup diriltiyor ve
  15 dakikalik periyodik alarmi iki kez gecirtiyor. 8r kaldirildi, DAHA KATI
  kontrolleri (kural/istatistik korunmasi, birebir muhasebe) FAZ 7'ye tasindi.
- `canli-kullanim.e2e.mjs` bosta kalmasi 25 dakikadan 6 dakikaya indi. MV3
  service worker'i ~30 saniyede oluyor; 6 dakika onu on kereden fazla oldurup
  diriltiyor. Periyodik alarmin gercekten tetiklendigi zaten muhasebe FAZ 7'de
  olculuyor.

Kazanc: tur basina ~44 dakika ve 313 satir.

AYIKLANMAYANLAR ve nedeni: `canli-kullanim` ile `muhasebe` arasindaki
ortusme KASITLIDIR - ayni sozlesme biri taklit sitede, oteki gercek sitede ve
gercek arayuzden olculur. Bu oturumda bulunan alt alan adi hatasi tam bu
farktan cikti: `muhasebe` yesilken `canli-kullanim` kirmiziydi. Ayni sekilde
`features-*` mesaj yoluyla, `canli-kullanim` arayuz yoluyla olcer; popup
sureli izin hatasi yalnizca ikincisinde gorunurdu. `gunluk-kullanim`'daki
ortusen iddialar bedava (bekleyisi yok) ve anlati akisinin parcasi.

## `test:e2e:canli` — gerçek siteler, gerçek arayüz

Diğer bütün e2e dosyalarından iki noktada ayrılır, ve bu iki fark üç
gerçek hatayı ortaya çıkardı:

**1. Siteler gerçek.** Ötekiler `--host-resolver-rules` ile her alan adını
127.0.0.1'e çevirir; her taklit site tam 3 çerez bırakır, hiçbiri
yönlendirme yapmaz. Burada gerçek DNS, gerçek HTTPS, gerçek reklam ağları
var — `__Secure-`/`__Host-` önekleri, `HttpOnly`, bir sitenin onlarca alt
alan adına çerez dağıtması ve **yönlendirmeler** yalnızca burada görünür.

**2. Kurallar ve ayarlar ARAYÜZDEN değiştirilir.** Ötekiler
`chrome.runtime.sendMessage({action:'SET_RULE'})` gönderip popup'ı ve
ayarlar sayfasını tamamen atlar. Burada gerçek popup
`chrome.action.openPopup()` ile açılır (sekme olarak açmak işe yaramaz:
popup aktif sekmeyi `tabs.query({active:true, currentWindow:true})` ile
bulur ve kendini bulur) ve düğmelere **koordinatlı gerçek fare olayıyla**
basılır. `element.click()` kullanılmaz: o, ögenin üstünde başka bir öge
olsa bile çalışır ve "düğme altta kalıyor" sınıfı hataları gizler. Her
tıklamadan önce öge görünür alana kaydırılır ve o noktadaki en üstteki
öge doğrulanır.

Bu dosyanın yakaladığı, başka hiçbir testin göremediği hatalar:

- **Popup'tan verilen süreli izin hiç dolmuyordu.** Popup yalnızca
  `durationMinutes` gönderiyor, ayarlar sayfası ayrıca `expiresAt`
  hesaplıyordu; `normalizeRule` sadece ikincisini okuduğu için popup
  yolunda alarm hiç kurulmuyordu. "1 saat koru" = sonsuza kadar koru.
- **Son sekme alt alan adındaysa çerezler hiç silinmiyordu.**
  `privacycenter.instagram.com`'dan çıkılınca kapsam oraya çıpalanıyor,
  sitenin `.instagram.com`'daki çerezleri ne çekiliyor ne eşleşiyordu.
  Arayüz "Temizlendi" derken 7 çerez duruyordu — ne uyarı ne hata.
- **Ana anahtar açılınca biriken veri bekliyordu** (popup anahtarı yolu).

Muhasebe biçimi `muhasebe.e2e.mjs` ile aynıdır ama çerez sayısı önceden
bilinemediği için "tam 3" denmez: sekme kapanmadan hemen önce tam envanter
çıkarılır, sonra aynı listenin sıfırlandığı doğrulanır. Sayı değişken,
muhasebe birebir.

## `test:e2e:muhasebe` — sayıların tutup tutmadığı

Diğer takımlar "temizlendi mi?" diye sorar; bu takım **her adımda tek tek
sayar**: sitenin kaç çerezi vardı, kaçı silindi, tarayıcıda kaç tanesi
kaldı, istatistiğe kaç işlendi, ne kadar sürdü, hedeften ne kadar saptı.
İddia `> 0` değil, birebir eşitliktir.

Ölçtüğü, başka hiçbir yerde görünmeyen şeyler:

- **Zamanlama sapması** — `cleanDelay` ayarının gerçek karşılığı
  (0 → ~1 sn, 30 → ~30,3 sn, 60 → ~60,5 sn) ve süreli iznin dakika
  hassasiyeti (3 dk → 180,5 sn).
- **Yan hasar** — korumalı üst alan adının, alt alan adı temizlenirken
  aynı isimli çerezini kaybetmemesi. Chrome'da `cookies.remove(url, name)`
  o URL'de görünen tüm aynı isimli çerezleri sildiği için gerçek risk.
- **Uzun boşta kalma** — 30 ve 25 dakikalık iki bekleme; service worker
  defalarca ölüp dirilirken alarmların, kuralların ve istatistiğin
  hayatta kalması.
- **Toplam defter** — koşum sonunda tarayıcıda kalan her alan adının
  korumalı bir kurala ait olduğu, günlükte ERROR/WARN bulunmadığı.

**Eklenti yeniden yükleme (`chrome.runtime.reload()`) bu düzenekte
ölçülemez** ve bilerek dışarıda bırakılmıştır: eklenti komut satırından
`--load-extension` ile yüklendiği için `reload()` sonrası geri gelmiyor —
`manifest.json` bile `ERR_BLOCKED_BY_CLIENT` dönüyor. Gerçek kurulumda
Chrome eklentiyi kendisi geri yükler. Ürün tarafı olan
`onInstalled(reason:'update')` ve `onStartup` birim testlerde gerçekten
tetiklenerek kapsanıyor.

**Elle hazırlık isteyen iki takım** (Chrome bu izinleri programatik vermiyor):

```bash
GT_PROFILE=<profil> npm run test:e2e:incognito  # "Gizli pencerede çalıştır" açık olmalı
GT_PROFILE=<profil> npm run test:e2e:hardening  # `privacy` izni verilmiş olmalı
```

İkisi de ön koşulu **kendisi sınar** ve sağlanmamışsa ölçmeden çıkar (kod 2).
Gizli pencere yalıtımı ayrıca birim testlerinde tam olarak kapsanmıştır
(`test/service-worker.test.js` → "GIZLI PENCERE normal profile SIZMAZ").

İki takım var ve ayrımı kasıtlı:

| | `test:e2e` | `test:e2e:live` |
| :--- | :--- | :--- |
| Ağ | yok — tüm alan adları 127.0.0.1'e | gerçek DNS, gerçek siteler |
| Tekrarlanabilirlik | tam | siteler değiştikçe dalgalanır |
| Ne ölçer | sözleşme (kesin iddialar) | gerçek dünya davranışı |

`test:e2e:live` gerçek reklam ağlarına, gerçek CDN'lere ve gerçek iframe
ağaçlarına karşı çalışır — uydurma bir test sitesinin taklit edemeyeceği şeyler.
Buna karşılık **reklam sayılarına eşik koymaz**: o sayılar rapordur, iddia
değil. Kesin iddialar yalnızca temizlik davranışı üzerinedir (ne silindi, ne
korundu), çünkü o deterministiktir.

Birim testler `chrome.*` taklidiyle koşar. Bu klasör aynı sözleşmeyi **gerçek
Chrome'da, gerçek çerez deposu ve gerçek `browsingData` üzerinde** ölçer.
Taklidin doğru modelleyemediği üç şey yalnızca burada görünür:

- **Gerçek sekme olayları** — sekme kapanınca temizliğin fiilen çalışması.
- **Gerçek Resource Timing ve iframe ağacı** — hangi 3. tarafın görülüp
  hangisinin görülmediği.
- **Gerçek MV3 service worker** — mesajlaşma, alarm ve kayıt yaşam döngüsü.

## Güvenlik

**Kullanıcının gerçek tarayıcı profiline asla dokunulmaz.** Bu eklenti veri
siler; gerçek profille koşmak kullanıcının çerezlerini ve geçmişini yok etmek
olurdu. Her koşum:

- tek kullanımlık bir `--user-data-dir` açar ve sonunda siler,
- `--host-resolver-rules=MAP * 127.0.0.1:<port>` ile **tüm** alan adlarını
  yerel test sunucusuna yönlendirir — dışarı hiçbir istek çıkmaz,
- `--disable-extensions-except` ile yalnızca GhostTrace'i yükler.

## Test alan adları neden `.example`?

Bazı tarayıcı dağıtımlarının (ör. Helium) dahili engelleyicisi `example.com`'u
`ERR_BLOCKED_BY_CLIENT` ile düşürüyor. `.example` TLD'si eklentinin PSL
mantığında `.com` ile birebir aynı davranıyor
(`getRootDomain('mail.gtsite.example')` → `gtsite.example`), yani kapsam
ilişkileri korunuyor ve test tarayıcıdan bağımsız kalıyor.

## Neden ayrı bir tarayıcı indiriliyor?

**Markalı Google Chrome bu testleri koşamaz.** `--load-extension` markalı
derlemelerde derleme zamanında reddediliyor; Chrome'un kendi logu birebir:

```
WARNING:extension_service.cc:419] --load-extension is not allowed in
Google Chrome, ignoring.
```

Hiçbir bayrak bunu açmıyor (`--enable-unsafe-extension-debugging` ve
`--disable-features=DisableLoadExtensionCommandLineSwitch` denendi, ikisi de
etkisiz). `npm run e2e:setup`, Google'ın tam bu iş için yayınladığı **markasız
Chrome for Testing** derlemesini `.cache/` altına indirir (`.gitignore`'da).

Tarayıcı sırası: `GT_CHROME` → indirilen Chrome for Testing → sistem Chromium.
Bulunamazsa test **açık hata verir** ve ne yapılacağını söyler; sessizce
atlanan bir tarayıcı testi, hiç olmayan bir testtir.

**Portable Helium bilerek listede yok** — bu depo bir Helium kurulumunun içinde
yaşıyor ve Helium kullanıcının ana tarayıcısı olabiliyor. Orada koşmak
gerekirse açıkça belirtilmeli:

```bash
GT_CHROME="/path/to/chrome" npm run test:e2e
```

## Dosyalar

| Dosya | Sorumluluk |
| :--- | :--- |
| `cdp.mjs` | Bağımlılıksız CDP istemcisi (Node 22+ yerleşik WebSocket) |
| `harness.mjs` | Test sitesi, Chrome başlatma, hedefe bağlanma, koşucu |
| `scope.e2e.mjs` | Alt alan adı kapsamı: çerez + localStorage düzeyinde |
| `observer.e2e.mjs` | 3. taraf gözlemcisi (iframe açık/kapalı) + sekme kapanışı temizliği |
| `live.e2e.mjs` | **Gerçek siteler** (Wikipedia, GitHub, Stack Overflow, BBC, CNN, Hürriyet) |
| `frame-survey.e2e.mjs` | iframe ayarının marjinal kazancı — engelli ağda **çalışmayı reddeder** |
| `features-common.mjs` | Özellik takımlarının ortak yardımcıları |
| `features-rules.e2e.mjs` | **Kademe 1-2** koruma kademeleri, kapsam kuralı, `keepMode` (15) |
| `features-purge.e2e.mjs` | **Kademe 3-4** yedi temizlik yolu, veri türleri (16) |
| `features-system.e2e.mjs` | **Kademe 5-6-7** keşif, kural yönetimi, sistem (21) |
| `features-options.e2e.mjs` | **Kademe 10** kalan ayarlar: rozet, log seviyesi, önbellek, grup, dil (12) |
| `features-incognito.e2e.mjs` | **Kademe 8** gizli pencere yalıtımı — elle hazırlık ister |
| `features-hardening.e2e.mjs` | **Kademe 9** gizlilik sertleştirme — elle hazırlık ister |
| `../../tools/fetch-chrome.mjs` | Chrome for Testing indirici (`npm run e2e:setup`) |

Bu testler `npm test` içinde **değil**: gerçek tarayıcı gerektiriyorlar ve
yaklaşık bir dakika sürüyorlar.

## Ölçüm ortamı: ağdaki reklam engellemesi sonucu bozar

Bu makinede router düzeyinde **NextDNS** reklam engellemesi var. Test tarayıcısı
temiz profille ve tek eklentiyle açılsa da **sistem DNS'ini kullandığı için
engellemeden etkilenir**: reklam script'leri yüklenmez, reklam çerçeveleri boş
`about:blank` kalır ve "iframe izleme hiçbir şey yakalamıyor" gibi görünür.

Bu tuzağa bir kez düşüldü ve yanlış bir sonuç dokümana kadar girdi. Sonuç
çıkarmadan önce kontrol edin:

```bash
curl -s https://securepubads.g.doubleclick.net/tag/js/gpt.js | head -c 60
# Gerçek script beklenir; "/* Blocked by NextDNS */" gibi bir yanıt
# gelirse reklam ölçümleri GEÇERSİZDİR.
```

`npm run test:e2e:frames` bu durumu **kendisi sınar** ve engelleme varsa
ölçmeden çıkar (kod 2). Sessizce geçersiz bir sayı üretmektense hiç
üretmemek doğru.

**Tarayıcı tarafından baypas edilemiyor — denendi.**
`--dns-over-https-mode=secure` etkisiz kaldı; Node'dan doğrudan IP ile DoH
(`1.1.1.1`, `8.8.8.8`) zaman aşımına uğradı — engelleyici bypass yollarını da
kapatıyor. Yani bu kodla çözülebilecek bir şey değil: **ölçümü yapan kişinin
ağında engelleme geçici olarak kapalı olmalı.** Aksi hâlde reklam çerçevesi
ölçümleri anlamsızdır (temizlik ölçümleri etkilenmez, onlar reklam
gerektirmiyor).

## Tohumlama otomatik temizliği tetikler

`cleanDelay: 0` iken **sekme kapatmak anında temizlik başlatır.** Test verisi
hazırlarken sekme açıp kapatmak, tohumu daha ölçülmeden sildiriyor. Bu tuzağa
üç ayrı testte düşüldü ve bazıları **yanlış sebeple yeşil** görünüyordu.

Kural: veri hazırlarken ya otomatik temizliği kapatın (`enabled: false`), ya
kuralı **önce** yazın, ya da sekmeyi kapatmadan ölçün. Aynı şekilde 3. taraf
ölçümü sekme **açıkken** yapılmalı — kapanış yetim taramasını tetikleyip
kayıtları düşürür.

## Bilinen tuzaklar (tekrar düşülmesin diye)

- **Doğru eklentiye bağlanmak doğrulanmalı.** "İlk `service_worker` hedefi"
  almak yanlış eklentiye bağlanıyor; tarayıcının kendi bileşen eklentilerinin
  de service worker'ı var ve `--disable-extensions-except` onları kapsamıyor.
  `attachExtension` manifest sürümünü depodakiyle karşılaştırır.
- **Yoklama kısa zaman aşımıyla yapılmalı.** Chrome for Testing'in kendi
  "Contextual Tasks" eklentisinin service worker'ı `Runtime.evaluate`'e hiç
  yanıt vermiyor; sabit 30 sn ile o tek hedef tüm arama bütçesini yiyordu.
- **`proc.kill()` yetmez.** Chrome'un renderer/gpu/utility süreçleri hayatta
  kalıyor; bir koşum ~90 yetim süreç bırakmıştı. `Browser.close` + `taskkill /T`.
- **Kayıt tarayıcı sürecinde görünmek yetmez.**
  `getRegisteredContentScripts` kaydı gösterirken yeni sekmenin *renderer*'ı
  hâlâ eski kapsamla başlayabiliyor; o turda alt çerçeveler gözlemlenmiyor.
  Beklemeyi uzatmak çözmüyor — sayfayı yeniden yüklemek gerekiyor.
- **`waitFor` boş olmayan dizeyi başarı sayar.** Predicate'ten teşhis metni
  döndürmek kontrolü tamamen baypas etti ve dört koşum yalancı yeşil verdi.
  Teşhis predicate'in *dışında* toplanmalı.
- **Sıfır test başarı değildir.** Kurulum patladığında koşucu "0/0 geçti" deyip
  0 ile çıkıyordu; artık açıkça başarısız sayılıyor ve hata yazdırılıyor.
