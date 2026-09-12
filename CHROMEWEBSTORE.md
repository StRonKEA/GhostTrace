# Chrome Web Store Listing — GhostTrace (Zero-Trace Privacy Engine)

> **Son güncelleme:** 2026-09-12
> **Eklenti sürümü:** 1.0.0
> **Manifest sürümü:** 3 · **Minimum Chrome:** 119

---

## 1. Mağaza Bilgileri

- **Ad:** GhostTrace - Otomatik Çerez, Geçmiş & Veri Temizleyici
- **Kısa açıklama (max 132):** İzin verilmeyen sitelerden ayrıldığınızda çerezleri, tarayıcı geçmişini ve yerel verileri iz bırakmadan temizler.
- **Kategori:** Gizlilik & Güvenlik
- **Diller:** Türkçe, İngilizce

### Ayrıntılı açıklama

```markdown
GhostTrace, izin vermediğiniz sitelerden ayrıldığınızda ardınızda dijital iz
bırakmamanızı sağlar. Yalnızca çerezleri silmekle kalmaz; o sitelerin tarayıcı
geçmişini, indirme kayıtlarını, LocalStorage, IndexedDB, Service Worker ve
Cache Storage verilerini de temizler.

• 3 kademeli koruma
  - Beyaz Liste: veriler ve oturumlar kalıcı olarak korunur.
  - Gri Liste: tarayıcı açık kaldığı sürece korunur, kapanınca silinir.
  - Geçici İzin: 15 dakika / 1 saat / 24 saat sonunda kural ve veri silinir.

• Doğru alan adı kapsamı
  Gerçek Public Suffix List kullanılır. Bir alt alan adını beyaz listeye almak
  kardeş veya üst alan adlarını kapsamaz; kullanici.github.io eklemek diğer
  github.io sitelerini korumaya almaz.

• Çerez düzeyinde seçici koruma
  Bir sitenin tüm çerezlerini, yalnızca oturum çerezlerini veya kendi
  belirlediğiniz kalıpları (sess*, auth_token) koruyabilirsiniz.

• Gizlilik sertleştirme (isteğe bağlı)
  3. taraf çerezleri, ilişkili site kümeleri, bağlantı takibi (ping) ve ağ
  öngörüsü kapatılabilir. İlişkili site kümeleri, Chrome'un bazı alan adı
  gruplarını "aynı taraf" saymasıdır: kapatmadığınız sürece o gruplar 3. taraf
  çerez engeline takılmadan çerez paylaşabilir.
• URL takip parametrelerini temizleme
  Ziyaret edilen adreslerdeki pazarlama ve analitik takip parametreleri (utm_*, fbclid, gclid vb.) anında adres çubuğundan kaldırılır ve geçmişten silinir.

• Açılışta tam süpürme
  İsteğe bağlı olarak, tarayıcı her başlatıldığında kural dışı tüm kalıntılar otomatik temizlenir.

• Çoklu sekme koruması
  Aynı siteden başka sekmeniz açıkken oturumunuz kapatılmaz.

• Şeffaf ölçüm
  "Kazanılan alan" yalnızca gerçekten ölçülen çerez ve geçmiş kayıtlarını sayar;
  tahmini rakam uydurulmaz.
```

---

## 2. İzin Gerekçeleri

### Zorunlu izinler

| İzin | Gerekçe |
| :--- | :--- |
| `cookies` | İzin verilmeyen sitelerin çerezlerini tespit edip silmek için. Her çerez, ait olduğu alan adının kuralına göre ayrı ayrı değerlendirilir. |
| `history` | İzin verilmeyen sitelerin URL'lerini tarayıcı geçmişinden kalıcı olarak silmek için. |
| `downloads` | İzin verilmeyen sitelerden yapılan indirmelerin `chrome://downloads` listesindeki kayıtlarını silmek için. Diskteki dosyalar silinmez. |
| `browsingData` | LocalStorage, IndexedDB, Service Worker, Cache Storage, HTTP disk önbelleği ve dosya sistemi (OPFS) artıklarını origin bazında temizlemek için. |
| `storage` | Kuralları, ayarları ve sayaçları yerel olarak saklamak için. Teşhis logları yalnızca oturum belleğinde tutulur, diske yazılmaz. |
| `tabs` | Hangi sekmenin kapandığını, hangi adrese geçildiğini ve aynı siteden açık başka sekme olup olmadığını tespit etmek için. |
| `alarms` | Temizlik gecikmesini, geçici izin sürelerini ve periyodik süpürmeyi Manifest V3 arka planında güvenilir şekilde çalıştırmak için. Tek zamanlama mekanizmasıdır. |
| `notifications` | Kullanıcı tercih ettiğinde temizlik sonucunu masaüstü bildirimi ile bildirmek için. |
| `scripting` | 3. taraf istek takibi için içerik script'ini **yalnızca ayar açıkken** kaydetmek için. Ayar kapalıysa hiçbir sayfaya kod enjekte edilmez. |
| `<all_urls>` | Herhangi bir siteden ayrıldığında o sitenin çerez ve depolama verilerine erişip temizlik yapabilmek için. |

### İsteğe bağlı izinler (kullanıcı talep etmedikçe istenmez)

| İzin | Gerekçe |
| :--- | :--- |
| `privacy` | "Gizlilik Sertleştirme" bölümü için: 3. taraf çerezleri, ilişkili site kümeleri, ağ öngörüsü, adres çubuğu önerileri ve hata sayfası önerilerini kapatmak. |
| `contextMenus` | Sağ tık menüsüne "bu sitenin verilerini temizle" ve "beyaz listeye ekle" girdilerini eklemek için. Yalnızca kullanıcı bu seçeneği açarsa istenir. |

### Kaldırılan izinler

`webRequest` izni v2.0.1'da **kaldırılmıştır**. 3. taraf istek tespiti artık
Resource Timing API kullanan ve yalnızca kullanıcı istediğinde kaydedilen bir
içerik script'i ile yapılır.

`contentSettings` izni v2.5.0'da **kaldırılmıştır**. "Site izinlerini sıfırla"
özelliği bu izinle birlikte tamamen çıkarıldı: `contentSettings.*.clear()`
yalnızca *eklentinin kendi yazdığı* kuralları siliyor, kullanıcının verdiği
izin kayıtları profilde kalıyordu. Yani "tüm siteler için sıfırlandı" demek
sessiz bir yanlış güvenceydi. Ayarlar artık Chrome'un kendi izin sayfasına
yönlendiriyor.

---

## 3. Gizlilik Beyanı

- **Veri toplama:** GhostTrace hiçbir kişisel veriyi, tarayıcı geçmişini veya
  kullanıcı hareketini üçüncü taraf sunuculara göndermez veya toplamaz.
- **Ağ isteği:** Eklenti çalışma zamanında hiçbir dış adrese istek atmaz.
  Public Suffix List verisi paketin içinde gömülüdür.
- **Yerel depolama:** Kurallar, ayarlar ve sayaçlar yalnızca
  `chrome.storage.local` içinde tutulur. Teşhis logları `chrome.storage.session`
  içindedir ve tarayıcı kapanınca silinir.
- **İzleme / analitik:** Eklentide üçüncü parti izleyici, telemetri veya reklam
  kodu bulunmaz.
- **Kaynak kod:** Bağımlılık içermez; tüm kod paketin içindedir.
