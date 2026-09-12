# GhostTrace — Proje Bağlamı

> Sürüm 1.0.0 · Manifest V3 · Sıfır İz Gizlilik Motoru

---

## 1. Amaç ve Vizyon

GhostTrace, kullanıcı açıkça izin vermedikçe (Beyaz Liste / Gri Liste / Geçici İzin) ziyaret edilen hiçbir sitenin verisini tarayıcıda tutmaz. Siteden ayrıldıktan veya sekme kapandıktan sonra tüm dijital ayak izleri (`cleanDelay` sonrasında) otomatik temizlenir.

---

## 2. Kapsam ve Kurallar

- **Alan Adı Kapsamı (`DomainScope`)**:
  - `psl.js` (Public Suffix List) üzerinden eTLD+1 hesaplanır.
  - Kök kural (`example.com`) tüm alt alan adlarını kapsar.
  - Alt alan kuralı (`sub.example.com`) aksi seçilmedikçe yalnızca kendisini kapsar; üst veya kardeş alanlara sızmaz.
- **Koruma Kademeleri**:
  - `white`: Kalıcı koruma (çerez düzeyi `all`, `session`, `custom` destekli).
  - `grey`: Oturum boyunca koruma (tarayıcı kapanınca silinir).
  - `temp`: Süreli koruma (15m, 1h, 24h); süre bitince açık sekme yoksa temizlenir.
  - `default`: Korumasız; sekme kapanınca temizlenir.

---

## 3. Temizlik Mekanizması

1. **Çerezler**: `chrome.cookies.remove` ile tek tek temizlenir; komşu alan çerezlerine zarar vermez. Yan hasar gören üst alan çerezleri anında geri yüklenir (`restoreCookie`).
2. **Geçmiş**: `chrome.history.deleteUrl` ile sayfalanmış ve zaman pencereli olarak silinir.
3. **Depolama**: `chrome.browsingData.remove({ origins })` ile LocalStorage, IndexedDB, Service Worker, OPFS ve HTTP disk önbelleği silinir.
4. **İzleme Parametreleri**: URL üzerindeki reklam/analitik parametreleri (`utm_*`, `fbclid`, `gclid` vb.) anında adres çubuğundan kaldırılır ve geçmişten silinir.
5. **Açılış Temizliği**: `cleanOnStartup` aktifse tarayıcı açılışında korumasız tüm veriler tam süpürülür.

---

## 4. Güvenlik ve Gizlilik Garantileri

- **Sıfır Telemetri**: Hiçbir dış ağ isteği atılmaz.
- **Geçici Teşhis Günlükleri**: Loglar ve 3. taraf haritaları yalnızca `chrome.storage.session` içinde tutulur; diske gezinti izi yazılmaz.
- **Güvenilir Bağlam**: `chrome.storage.local` yalnızca uzantının güvenilir sayfalarına (`TRUSTED_CONTEXTS`) açıktır; sayfalara enjekte edilen scriptler erişemez.
