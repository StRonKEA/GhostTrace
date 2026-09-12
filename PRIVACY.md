# GhostTrace — Gizlilik Politikası

**Yürürlük tarihi:** 12 Eylül 2026
**Sürüm:** 1.0.0

> Bu belge, Chrome Web Store'un hassas veri işleyen eklentiler için zorunlu
> tuttuğu gizlilik politikasıdır. Yayımlanmış bir adrese konulmalı ve o adres
> Geliştirici Panosu'na girilmelidir.

---

## Özet

**GhostTrace hiçbir veri toplamaz, hiçbir veriyi hiçbir yere göndermez.**

Eklenti tarayıcınızdan dışarıya tek bir ağ isteği bile atmaz. Sunucumuz yoktur,
hesap yoktur, analitik yoktur, telemetri yoktur, reklam kodu yoktur. Eklentinin
yaptığı tek şey, sizin belirlediğiniz kurallara göre **verinizi kendi
cihazınızda silmektir**.

---

## 1. Eriştiğimiz veriler ve nedeni

GhostTrace'in işi veri silmek olduğu için, silmesi gereken veriye erişmesi
gerekir. Her erişimin tek amacı silmektir:

| Veri | Neden erişiliyor |
| :--- | :--- |
| Çerezler | İzin verilmeyen sitelerin çerezlerini bulup silmek için |
| Tarayıcı geçmişi | İzin verilmeyen sitelerin adreslerini geçmişten silmek için |
| İndirme kayıtları | `chrome://downloads` listesindeki kayıtları silmek için — **diskteki dosyalarınıza dokunulmaz** |
| Site depolaması | localStorage, IndexedDB, Service Worker, Cache Storage ve OPFS artıklarını silmek için |
| Açık sekmeler | Hangi sekmenin kapandığını ve aynı siteden başka sekme kalıp kalmadığını anlamak için |

Bu verilerin hiçbiri **okunup bir yere gönderilmez**. Örneğin çerezlerin
**değeri** hiçbir zaman arayüze bile çıkarılmaz; yalnızca adı, alan adı ve
uzunluğu gösterilir.

## 2. Cihazınızda saklananlar

**Diske yazılanlar** (`chrome.storage.local`) — yalnızca sizin
yapılandırmanız:

- Beyaz liste kurallarınız ve ayarlarınız
- Toplam sayaçlar (kaç çerez silindi gibi)

**Diske YAZILMAYANLAR** (`chrome.storage.session` — tarayıcıyı kapattığınızda
silinir):

- Teşhis günlükleri
- Hangi sitede hangi üçüncü tarafla karşılaşıldığının haritası

Bu ayrım bilinçlidir ve kodda zorlanır: oturum deposu bir şekilde
kullanılamazsa eklenti bu bilgileri **diske yazmak yerine tutmaktan
vazgeçer**. Gezinti geçmişiniz hiçbir koşulda kalıcı hale gelmez.

Hiçbir veri cihazınızdan çıkmaz — senkronizasyon (`chrome.storage.sync`) dahi
kullanılmaz.

## 3. Ağ iletişimi

**Yoktur.** Eklenti çalışma zamanında hiçbir adrese bağlanmaz. Alan adı
çözümlemesi için gereken Public Suffix List verisi paketin içine gömülüdür,
indirilmez. Uzaktan kod çalıştırılmaz; tüm kod paketin içindedir ve
incelenebilir.

## 4. Veri paylaşımı

GhostTrace hiçbir veriyi:

- satmaz,
- üçüncü taraflara aktarmaz,
- eklentinin tek amacı dışında kullanmaz,
- kredi değerlendirmesi veya borç verme amacıyla kullanmaz.

Paylaşılacak bir veri yoktur, çünkü toplanan bir veri yoktur.

## 5. İsteğe bağlı izinler

Aşağıdaki izinler **varsayılan olarak istenmez**; yalnızca ilgili özelliği siz
açarsanız sorulur ve istediğiniz zaman geri alabilirsiniz:

- `privacy` — Gizlilik Sertleştirme bölümü (üçüncü taraf çerezleri, ilişkili
  site kümeleri, Privacy Sandbox anahtarları gibi tarayıcı ayarlarını
  kapatmak için)
- `contextMenus` — sağ tık menüsü girdileri

## 6. Çocukların gizliliği

GhostTrace kişisel veri toplamadığı için çocuklardan da veri toplamaz.

## 7. Değişiklikler

Bu politika değişirse yürürlük tarihi güncellenir ve değişiklik eklenti
deposunda yayımlanır. Veri işleme davranışını değiştiren bir güncelleme
yapılırsa, sürüm notlarında açıkça belirtilir.

## 8. İletişim

Sorularınız ve bildirimleriniz için: [GitHub Issues](https://github.com/StRonKEA/GhostTrace/issues)

---

# GhostTrace — Privacy Policy

**Effective date:** 12 September 2026
**Version:** 1.0.0

## Summary

**GhostTrace collects no data and sends no data anywhere.**

The extension makes no outbound network requests whatsoever. There is no
server, no account, no analytics, no telemetry, and no advertising code. All
it does is **delete your data on your own device**, according to rules you
define.

## 1. Data we access, and why

Because the extension's job is deletion, it must reach the data it deletes.
Every access exists solely to delete:

| Data | Why it is accessed |
| :--- | :--- |
| Cookies | To find and delete cookies belonging to sites not on your whitelist |
| Browsing history | To remove URLs of non-whitelisted sites from history |
| Download records | To clear entries in `chrome://downloads` — **files on your disk are never touched** |
| Site storage | To clear localStorage, IndexedDB, Service Workers, Cache Storage and OPFS remnants |
| Open tabs | To detect when a tab closes and whether another tab for the same site remains |

None of this is read and transmitted anywhere. Cookie **values**, for
instance, are never even shown in the interface — only name, domain and
length.

## 2. What is stored on your device

**Written to disk** (`chrome.storage.local`) — your configuration only:

- Your whitelist rules and settings
- Aggregate counters (such as how many cookies were deleted)

**Never written to disk** (`chrome.storage.session` — cleared when you close
the browser):

- Diagnostic logs
- The map of which third parties were seen on which sites

This separation is deliberate and enforced in code: if session storage is
somehow unavailable, the extension **stops keeping this information rather
than writing it to disk**. Your browsing trail never becomes persistent.

No data leaves your device — not even browser sync (`chrome.storage.sync`) is
used.

## 3. Network communication

**None.** The extension connects to no address at runtime. The Public Suffix
List data needed for domain resolution is bundled inside the package, not
downloaded. No remote code is executed; all code ships in the package and can
be inspected.

## 4. Data sharing

GhostTrace does not sell, transfer to third parties, use for purposes
unrelated to its single purpose, or use for creditworthiness or lending
purposes — any data. There is nothing to share, because nothing is collected.

## 5. Optional permissions

These are **not requested by default**; they are requested only if you enable
the corresponding feature, and you may revoke them at any time:

- `privacy` — the Privacy Hardening section (to turn off browser settings such
  as third-party cookies, related website sets, and Privacy Sandbox toggles)
- `contextMenus` — right-click menu entries

## 6. Children's privacy

GhostTrace collects no personal data from anyone, including children.

## 7. Changes

If this policy changes, the effective date is updated and the change is
published in the extension's repository. Any update that changes data-handling
behaviour will be stated explicitly in the release notes.

## 8. Contact

Questions and support: [GitHub Issues](https://github.com/StRonKEA/GhostTrace/issues)
