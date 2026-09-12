# GhostTrace — Mimari Dokümantasyonu

> Sürüm 1.0.0 · Manifest V3 · Minimum Chrome: 119 · Sıfır Çalışma Zamanı Bağımlılığı

---

## 1. Katmanlar ve Modül Yapısı

Her modül tek bir sorumluluk taşır. Bağımlılık yönü tek yönlüdür: `Arayüz → lib/sw → lib/purge → lib`.

```
┌────────────────────────────────────────────────────────────────────────┐
│                                Arayüz                                  │
│  popup/popup.js          options/options.js  (giriş: sekme ve başlat)  │
│                          options/ui/         dom, format, toast        │
│                          options/tabs/       rules, site-data,         │
│                                              cookie-modal, settings,   │
│                                              stats, logs, insights     │
└───────────────────────────┬────────────────────────────────────────────┘
                            │  lib/messaging.js (Action mesajları)
┌───────────────────────────▼────────────────────────────────────────────┐
│  service-worker.js — Üst düzey olay dinleyicileri                      │
│                                                                        │
│  lib/sw/   tabs · badge · alarms · scheduler · sweep · observer ·      │
│            context-menu · bootstrap · site-data · handlers             │
└───────────────────────────┬────────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────────┐
│                    lib/purge/ — Temizlik Motoru                        │
│  context.js     Önbellekli kural/ayar bağlamı                          │
│  cookies.js     Çerez silme ve üst alan koruma kurtarma                │
│  history.js     Geçmiş silme (URL ve sayfalama)                        │
│  downloads.js   İndirme geçmişi temizliği (diskteki dosyaya dokunulmaz)│
│  storage.js     LocalStorage, IndexedDB, Cache, SW, OPFS               │
│  index.js       Yönetim: purgeDomain, purgeAllNonWhitelisted           │
└───────────────────────────┬────────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────────┐
│                          lib/ — Çekirdek                               │
│  psl.js            Public Suffix List veri tablosu                     │
│  domain.js         Host çözümleme, DomainScope, URL takip temizliği    │
│  rules.js          Kural eşleme (white, grey, temp, default)           │
│  cookies.js        Çerez getirme, tekilleştirme, CHIPS, geri yükleme   │
│  history.js        Sayfalanmış geçmiş taraması ve parçalı silme        │
│  storage.js        storage.local/session yönetimi, migrasyon, şema     │
│  session-state.js  Oturumluk sekme haritası ve 3. taraf kayıtları      │
│  logger.js         Yalnızca RAM'de tutulan teşhis günlükleri           │
│  i18n.js           Worker-güvenli çoklu dil motoru (en/tr)             │
│  privacy.js        Privacy Sandbox ve ağ öngörüsü sertleştirmesi       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Temel İlkeler

### 2.1 DomainScope ([lib/domain.js](lib/domain.js))
Tüm temizlik işlemleri tek bir `DomainScope` nesnesi üzerinden çalışır:
- **Kök Alan Adı (`example.com`)**: PSL (`psl.js`) üzerinden hesaplanır. Kendisi ve tüm alt alan adlarını kapsar.
- **Alt Alan Adı (`sub.example.com`)**: Varsayılan olarak yalnızca kendisini kapsar (`subdomains: true` seçilmedikçe). Kardeş veya üst alan adını kapsamaz.
- **IP Adresi (`192.168.1.1`)**: Alt alan adı kavramı yoktur, tam eşleşmeyle çalışır.

### 2.2 Koruma Kademeleri ([lib/rules.js](lib/rules.js))
- **Beyaz Liste (`white`)**: Veriler kalıcı olarak korunur. `keepMode` ile çerez bazında seçicilik (`all`, `session`, `custom`) uygulanabilir.
- **Gri Liste (`grey`)**: Tarayıcı açık kaldığı sürece korunur; tarayıcı kapandığında kurallar ve veriler silinir.
- **Geçici İzin (`temp`)**: Süre bitimine kadar korunur (`gt:snooze:` alarmı); süre dolunca açık sekme yoksa temizlenir.
- **Varsayılan (`default`)**: Korunmaz. Sekme kapatıldığında veya siteden ayrıldığında `cleanDelay` sonrasında temizlenir.

### 2.3 Ne Silinir, Ne Korunur?

| Veri Türü | Silme Yöntemi | Kapsam ve Önlemler |
| :--- | :--- | :--- |
| **Çerezler (CHIPS dahil)** | `chrome.cookies.remove` | Tek tek silinir. `browsingData.remove({cookies:true})` kullanılmaz (Chrome alan adı genelinde silip beyaz listeli alt alanları bozduğu için). Yan hasar gören üst alan çerezleri `restoreCookie` ile anında geri konur. |
| **Geçmiş** | `chrome.history.deleteUrl` | Sayfalanmış arama (`searchHistoryPaged`) + parçalı silme (`deleteHistoryItems`). URL bazında silinir. |
| **İndirme Kayıtları** | `chrome.downloads.erase` | İndirme listesi girdileri silinir; diskteki dosyalara dokunulmaz. |
| **LocalStorage, IndexedDB, Service Worker, OPFS** | `browsingData.remove({origins})` | Keşfedilen tüm alt alan adı origin'leri dahil edilir. `originTypes: { unprotectedWeb: true, protectedWeb: true }` eklenir. `extension: true` verilmez. |
| **HTTP Disk Önbelleği** | `browsingData.remove({origins}, {cache: true})` | Kaynak URL'si bazında silinir. BFCache ve prerender girdilerini de düşürür. |
| **URL İzleme Parametreleri** | `history.replaceState` + `deleteUrl` | `utm_*`, `fbclid`, `gclid` vb. adres çubuğundan anında, geçmişten silinerek arındırılır. |
| **Yer İmleri & Okuma Listesi** | — | Dokunulmaz. Kullanıcının kasten kaydettiği içerik iz sayılmaz. |

---

## 3. Durum Yönetimi ve MV3 Güvenliği

| Veri | Depo | Gerekçe |
| :--- | :--- | :--- |
| Kurallar, ayarlar, sayaçlar | `chrome.storage.local` | Kalıcı olmalı |
| Sekme haritası, 3. taraf istekleri | `chrome.storage.session` | Service worker ölümlerinden sağ çıkmalı, tarayıcı kapanınca silinmeli |
| Teşhis logları | `chrome.storage.session` | **Diske yazılmaz** — gezinti geçmişinin gölge kopyasını oluşturmaz |
| Bekleyen temizlikler | `chrome.alarms` | Service worker ölümlerinden sağ çıkar |

---

## 4. Test Altyapısı

- **Birim Testleri (`test/`)**: 898 test (`node:test`). Bellek içi `chrome-stub.js` ile tüm Chrome MV3 API'leri taklit edilir.
- **Bütünlük Denetimi (`test/integrity.test.js`)**: DOM id eşleşmeleri, i18n anahtarları, kullanılmayan importlar ve mimari sözleşmeler doğrulanır.
