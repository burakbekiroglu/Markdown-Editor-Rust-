# QA — Windows Checklist

Hedef: Windows 10 (1809+) ve Windows 11 üzerinde manuel doğrulama seti. Her senaryo için beklenen davranış ve ilgili otomatik test referansı verilmiştir.

Kurulum geliştirme sürümü: `npm run tauri:dev`. Üretim paketi: `npm run tauri:build` (NSIS).

## 1. Ortam matrisi

| Senaryo | Win10 1809 | Win10 21H2 | Win11 23H2 |
|---|---|---|---|
| Uygulama açılışı | ☐ | ☐ | ☐ |
| Klasör açma + ağaç | ☐ | ☐ | ☐ |
| Kaydetme (Ctrl+S) | ☐ | ☐ | ☐ |
| Harici izleyici | ☐ | ☐ | ☐ |
| Pencere kapatma onayı | ☐ | ☐ | ☐ |

DPI: %100, %125, %150 ölçeklerde bir açılış + önizleme kontrolü yapın (e2e/high-dpi.e2e.ts birimleri otomatik kapsar).

## 2. WebView2 yok senaryosu

Amaç: WebView2 runtime yüklü olmayan bir makinede kurulumun çalışması.

1. WebView2'yi kaldırın (Win10 1809–21H2'de Evergreen runtime varsayılan olarak gelmeyebilir; Win11'de işletim sistemiyle birlikte gelir, kaldırma gerekmez — temiz bir Win10 VM kullanın).
2. `npm run tauri:build` ile üretilen NSIS kurulumunu çalıştırın.
3. Beklenen: `webviewInstallMode: downloadBootstrapper` (tauri.conf.json → `bundle.windows.webviewInstallMode`) WebView2'yi çevrimiçi indirip kurar; kurulumdan sonra uygulama açılır.
4. Çevrimdışı makinede: bootstrapper başarısız olur ve kullanıcıya WebView2 indirme bağlantısı gösterilmelidir. Bu davranışı doğrulayın ve not edin.
5. Uygulama başladıktan sonra: CSP `connect-src 'self' ipc: http://ipc.localhost` dışına hiçbir ağ isteği yapılmaz (`npm run test -- offline`).

## 3. Çevrimdışı doğrulama

1. Makineyi ağdan tamamen ayırın (Wi-Fi kapat, kablo çek).
2. Uygulamayı açın, klasör açın, belge açıp düzenleyin, Ctrl+S ile kaydedin → tüm işlemler yereldir; her şey çalışmalıdır.
3. Geliştirici araçlarında (dev sürümde) network paneli: yalnızca yerel köprü istekleri.
4. `npm run test` — `src/lib/offline.test.ts` CSP'de uzak bağlantı kaynağı olmadığını statik doğrular.

## 4. Path güvenliği ve uzun yollar

1. 260 karakterden uzun tam yol içeren klasör açın, dosya oluşturun/kaydedin (otomatik: `src-tauri/tests/long_paths.rs`).
2. Çalışma kökünde `mklink /J escape ..` benzeri bir junction oluşturun; ağaçta gözükmemeli ya da açılmamalı — kök dışına çıkan link `SymlinkEscape` reddeder (otomatik: `path_confinement.rs`, `read_guards.rs`).
3. Sarkan junction: hedefi silin, linke erişim girişimi sarkan link olarak reddedilmelidir.
4. `C:\Work` köküne bir `C:\Workshop` kardeşi koyun; içerik asla kardeşe yazılamaz (bileşen bazlı, ASCII case-folding kapsama karşılaştırması).
5. Klasör büyük/küçük harf farklılığı: `NOTES/A.MD` gibi farklı yazım isteği kabul edilir ve kanonik disk yazımına döner.

## 5. Atomik kaydetme ve Windows kilitleri

Otomatik taban: `src-tauri/tests/atomic_write.rs`, `fs_ops_conflicts.rs`. Manuel:

1. **Normal kaydetme:** düzenle → Ctrl+S → dosya doğru içerik; klasörde `.md-editor-save-*.tmp` kalıntısı yok.
2. **Antivirüs kilidi simülasyonu:** hedef dosyayı başka bir programla `FILE_SHARE_NONE` paylaşım modunda kilitleyin (örn. açık handle tutan bir betik), Ctrl+S → kaydetme hata verir (kullanıcıya bildirilir), diskteki dosya **eski tam içerik** kalır, geçici dosya temizlenir; kilidi bırakın → tekrar Ctrl+S başarıyla yazar. Rust tarafı paylaşılmaz ihlali (32/33/5) 3 denemeye kadar 25→250 ms üstel geri çekilmeyle yeniden dener.
3. **Çakışma senaryosu:** belge açıkken dosyayı Not Defteri ile dışarıdan değiştirin → beklenen: harici değişiklik banner'ı; Ctrl+S'yi bekleyen düzenlemeler ezilmez (`ConflictDetected` akışı, `src/lib/editor/conflict.ts`).
4. **Uygulamanın kendi yazma yankısı:** uygulama kaydettikten sonra çakışma banner'ı **tetiklenmemeli** (self-write echo dedup, `watcher_dedup.rs`).

## 6. Kısayol matrisi

Kaynak: `src/lib/app/shortcuts.ts` (`KEY_COMMANDS`). Otomatik: `e2e/shortcuts.e2e.ts`.

| Kısayol | Komut | Editor odaklı | Editor dışında | Not |
|---|---|---|---|---|
| Ctrl+S | Kaydet | ☐ | ☐ | WebView yazdırma/kaydet iletişimi açılmaz (`preventDefault`) |
| Ctrl+B | Kalın | ☐ | ☐ | |
| Ctrl+W | Sekme kapat | ☐ | ☐ | Kaydedilmemişse kapatma onayı |
| Ctrl+F | Bul | ☐ | ☐ | |
| Ctrl+P | Hızlı aç | ☐ | ☐ | Tarayıcı yazdırma diyalogu açılmaz |

Ayrıca bir kısayolun kaydedilmemiş işleyici olmadığında tuşun yine de yutulduğunu doğrulayın (tarayıcı varsayılanı engellenir).

## 7. Encoding / EOL senaryoları

Otomatik taban: `src-tauri/tests/encoding_roundtrip.rs`. Manuel doğrulama:

| Senaryo | Hazırlık | Beklenen |
|---|---|---|
| LF dosyası düzenle+kaydet | LF ile yazılmış `.md` | LF korunur; `hexdump` ile `\r` yok ☐ |
| CRLF dosyası düzenle+kaydet | CRLF ile yazılmış `.md` | CRLF korunur ☐ |
| BOM'lu dosya düzenle+kaydet | UTF-8 BOM'lu `.md` | BOM korunur ☐ |
| BOM'suz dosya | BOM'suz `.md` | BOM eklenmez ☐ |
| Karışık EOL | `%50/%50` CRLF/LF | Çoğunluk sonuca normalleştirilir; beraberlikte LF ☐ |
| Round-trip bayt kararlılığı | Oku → değiştirme → kaydet (değişikliksiz) | Disk baytları değişmez ☐ |

`fs_read_document` ikili dosyaları (`BinaryFile`) ve çok büyük dosyaları (`TooLarge`) reddeder; bunları da klasörde deneyin.

## 8. Oturum ve pencere

1. İki sekme açın, kaydedilmemiş değişiklik bırakın, X'e basın → kapatma onay diyaloğu (`CloseConfirmDialog`).
2. Onaylandıktan sonra pencere yok edilir (`app_close_window`); bir kez daha `CloseRequested` döngüsü oluşmaz.
3. Oturum yeniden başlatıldığında sekmeler geri gelir; bozuk oturum dosyası durumunda pencere yine açılır ve uyarı `take_startup_warnings` ile bildirilir.

## 9. Performans bütçeleri (regresyon kapısı)

```bash
npm run perf:startup      # ilk boyama gecikmesi
npm run perf:memory       # 5 sekmeli çalışma kümesi (≤150 MiB hedefi)
npm run perf:installer    # NSIS kurulum boyutu
```

Kayıt: `docs/STARTUP-BASELINE.md`, `perf/startup-baseline.json`.

## 10. Pencere kapatma yolları — hızlı elle QA listesi

> Bu liste `awaitTasks timed out` nedeniyle otomatik koşamayan "uygulamayı
> çalıştırıp elle doğrula" adımının yazılı karşılığıdır. Teşhis arka planı için
> `docs/DIAGNOSIS-awaitTasks-hypotheses.md` §4'e bakın. Bu adımları komut
> çalıştıran bir otomasyon değil, insanlı doğrulama olarak uygulayın.

Başlatma: `npm run tauri:dev` (projenin kayıtlı scripti; `bun run tauri dev`
değişkeni kullanılıyorsa eşdeğerdir). Dev sunucusu hazır olana kadar bekleyin;
zaman aşımı görürseniz yalnızca `awaitTasks timed out` mesajı mı olduğunu
ayırt edin — süreç kendiliğinden kapanmaz.

1. **Başlık çubuğu kapatma düğmesiyle kapatma.** Ana pencerede X'e basın.
   *Beklenen:* kaydedilmemiş değişiklik varsa `CloseConfirmDialog` onay
   diyaloğu açılır (`§8.1`); onay sonrası `app_close_window` ile pencere
   yok edilir ve sürecin tamamı düzgün çıkar (arka plana öksüz pencere kalmaz).
   *İzin hatası görülürse:* `src-tauri/capabilities/` içinde `core:window:close`
   iznine bakın; davranışsal kapsamı `src/lib/app/closeWindowChain.test.ts`
   doğrular.
2. **Frontend'den tetiklenen kapatma yolu.** `App.svelte`'teki
   `subscribeAppCloseRequested` zincirini tetikleyin (uygulama içi
   kapatma/eşleşen kapatma isteği). *Beklenen:* yukarıdaki akışla aynı sonuç —
   onay → `app_close_window` → tek `CloseRequested` döngüsü, ikinci kez
   tetiklenmez (`§8.2`). *İzin hatası görülürse:* hem frontend çağrısının
   komut adını hem capabilities dosyasındaki `app_close_window` iznini
   karşılaştırın.
3. **Opener ile açılan pencere/bağlantıyı kapatma.** Önizlemede harici bir
   `http(s):` bağlantısına tıklayın (opener yolu, `src/lib/preview/links.ts`
   → `@tauri-apps/plugin-opener`); açılan tarayıcı penceresini kapatın.
   *Beklenen:* ana pencere hiç etkilenmez — sekme durumu, kaydedilmemiş
   düzenlemeler ve watcher akışı korunur. *İzin hatası görülürse:*
   `opener:allow-open-url` (yalnızca `http/https`) iznine bakın;
   `src/lib/security/securityAudit.test.ts` §opener testleri kapsamı sabitler.
4. **Artçılı durum kontrolü.** 1–3'ten sonra uygulamayı yeniden başlatın.
   *Beklenen:* oturum sekmeleri geri gelir, bozuk oturum uyarısı varsa
   `take_startup_warnings` üzerinden bildirilir (`§8.3`); kayıt dizininde
   bekleyen/kilitli geçici dosya kalmamıştır.

## 11. Tek pencere kanıtı (single-instance)

Otomatik taban: `src-tauri/tests/single_instance.rs` (ikinci örnek kendi kendine sonlanır) ve
`scripts/verify-single-instance.ps1` (OS seviyesinde süreç/pencere sayımı):

```powershell
pwsh -NoProfile -File scripts/verify-single-instance.ps1
# kanıt kaydı:
pwsh -NoProfile -File scripts/verify-single-instance.ps1 -JsonOut .temp_files/single-instance-evidence.json
```

Beklenen çıktı: `PASS: iki ardışık başlatma sonrası 1 ana süreç, 1 görünür pencere.`
`after-launch-1` ve `after-launch-2-exited` kontrol noktalarında `MainProcessCount = 1` ve
`VisibleWindowCount = 1` raporlanır; `right-after-launch-2` noktasında kısa ömürlü ikinci
süreç **görülmesi normaldir** (single-instance plugin argv teslim eder ve süreci kapatır) —
o noktanın kuralı geçici sürecin pencere açmamasıdır. `SecondExitedOnOwn = True` beklenir.

Betikle kapatılamayan kalan gözlemler — manuel adım adım:

1. **Görev Yöneticisi'nde tek süreç:** uygulama açıkken Görev Yöneticisi → Ayrıntılar sekmesini açın. Uygulamayı kapatın; aynı ikili dosyayı çift tıklayarak iki kez arka arkaya başlatın. *Beklenen:* `md-editor.exe` yazan yalnızca **1** satır; ikinci çift tıklama kalıcı bir ikinci satır üretmez (kısa ömürlü ikinci süreç saniyeler içinde kaybolur). ☐
2. **Görev çubuğunda tek simge:** İki ardışık başlatmadan sonra görev çubuğunda uygulama için yalnızca bir simge/açık pencere önizlemesi bulunur. ☐
3. **İkinci başlatma mevcut pencereyi odaklar:** Uygulama arka plandayken (başka pencereye odak) uygulama simgesini tekrar çift tıklayın. *Beklenen:* yeni pencere açılmaz; mevcut pencere ön plana çıkar, simge durumundan küçültülmüşse geri yüklenir ve odaklanır (`focus_main_window`: `unminimize` → `show` → `set_focus`). ☐
4. **Komut satırı argümanı ile ikinci başlatma:** `md-editor.exe <bir-dosya.md>` komutuyla ikinci örnek başlatın. *Beklenen:* yine tek pencere; argümanın hedef pencerede nasıl ele alındığını not edin (sessizce yutulması kabul edilebilir, çift pencere **değil**). ☐
5. **Kapat-onay reddi sonrası yeniden başlatma:** kaydedilmemiş değişiklikle kapatma onayını reddedin, ardından uygulamayı tekrar başlatın. *Beklenen:* yeni örnek normal şekilde pencere açar; önceki örnek hâlâ çalışıyorsa yine tek pencere korunur. ☐

Her adımın sonucunu Windows sürümü + tarih ile işaretleyin; 1. adımda kalıcı çift satır görülürse
`scripts/verify-single-instance.ps1` çıktısını hatayla birlikte ekleyin.

## Durum takibi

Kutuları çalıştırdığınız Windows sürümü + tarih ile doldurun. Bir kutu başarısızsa hatayı otomatik testin kapsayıp kapsamadığını belirtin (otomatik kapsamıyorsa `src-tauri/tests/` veya `e2e/` altına regresyon testi ekleyin).
