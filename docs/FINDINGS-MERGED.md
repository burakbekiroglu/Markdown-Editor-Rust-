# Birleşik Denetim Bulguları — Öncelik Sıralı Tek Tablo

> **Kaynak:** üç denetim kolunun ara çıktıları — (1) yıkıcı işlemler teşhisi
> (`docs/DIAGNOSIS-destructive-ops.md`), (2) `awaitTasks timed out` hipotez
> analizi (`docs/DIAGNOSIS-awaitTasks-hypotheses.md`), (3) performans/bellek
> bütçe denetimi (`docs/PERFORMANCE.md` + `docs/STARTUP-BASELINE.md`,
> `docs/GZIP-BASELINE.md`, `docs/WORKING-SET-MEASUREMENT.md`).
>
> Bu birleştirmede **yeni kod incelemesi yapılmadı, yeni iddia üretilmedi**;
> mevcut kanıtlar normalize edildi. Düzeltmeler uygulanmadı.
>
> **Kategori lejandı:** 1 = veri kaybı / doğruluk · 2 = kullanıcı
> engellenmesi / yanıt vermeme · 3 = kullanılabilirlik / UX & erişilebilirlik
> · 4 = operasyonel / ölçüm araçları.
>
> **Durum etiketleri:** `doğrulandı` = kaynak okumasıyla bu turda teyit edildi
> (`[DO]`); `doğrulanmadı` = `[Hİ]` hipotez veya `[ÇI]` depo dışı çıkarım.
>
> **Sıralama:** etki × doğruluk güveni (azalan).

## Öncelik sıralı findings tablosu

| # | Öncelik | Kat. | Dosya:symbol | Sorun | Kanıt | Etki tahmini | En küçük düzeltme önerisi | Durum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Kritik | 1 | `FileTree.svelte` `confirmDelete` (299-322) | Kirli sekme koruması yok: silme onayı `Tab.dirty`'ye bakmıyor; bellekteki değişiklik çöp kutusuna giden dosyayla sessizce kayboluyor | `tabsStore.svelte.ts:38,57-59` dirty alanı var; `confirmDelete` 299-322 hiç kontrol etmiyor; kapatma akışında karşılığı var (`lib.rs:23,29-41`, `closeCoordinator.ts`) | Veri kaybı (MB ile ölçülemez; kullanıcı yazısı) | `confirmDelete`'e kirli sekme kontrolü + "önce kaydet" akışı | doğrulandı |
| 2 | Kritik | 2 | `workspace_commands.rs` `open_workspace` (88-102) | `receiver.recv().await` sınırsız: timeout/iptal yok; geri çağrı gelmezse promise hiç settle olmaz → "Klasör aç" `picking` ile kilitli kalır, dış izleyici `awaitTasks timed out` verir. `blocking_send` başarısızlığı yalnız `eprintln!` | `channel(1) :88`, `blocking_send :92-98`, `recv().await :100`, iptal yok | Tek özellik kilitlenmesi; sekme sayısıyla doğrusal büyüme yok (tek askıda future) | Diyalog kanalına timeout + iptal; `blocking_send` hatasını komuta ilet | doğrulandı (depo tarafı) — koşumdaki gerçek askıda komut ölçülmedi (bkz. doğrulanmadı §D2) |
| 3 | Yüksek | 2 | `fs_ops.rs` `fs_move` (577-589), `fs_rename_entry` (567-575) | Senkron komutlar ana thread'de koşuyor; büyük klasörde taşıma UI'ı ve tüm IPC'yi saniyelerce/dakikalarca bloklar; B2'yi tetikleyen/derinleştiren amplifikatör | `fs_ops.rs:566-589`, `rename_no_overwrite` `:302-376`; silme ayağıyla asimetri (`fs_delete_entry` async + spawn_blocking `:602-611`) | Donma süresi hedef boyutla ölçülemedi (depo dışı `[ÇI]`); ana thread blokajı kesin | `fs_move`/`fs_rename_entry` → `async` + `spawn_blocking` (silme deseni) | doğrulandı |
| 4 | Yüksek | 1 | `FileTree.svelte` `applyMove` (227-240) | Taşıma onay ve geri alma (undo) yok; uçuştaki ikinci bırakma `busy` boolean'ıyla sessizce yutuluyor (silme yolundaki `toast.info` davranışıyla asimetrik) | `:194,:224` doğrudan çağrı; `:228-229` tek boolean; `lib.rs:162-182`'de `fs_undo*` yok | Veri konumu kaybı (yanlış taşıma geri alınamaz) | Taşıma undo veya en azından ikinci bırakma bildirimi | doğrulandı |
| 5 | Yüksek | 1 | `fs_ops.rs` `ensure_same_volume` (451-465) | Çapraz sürücü taşıma tamamen reddediliyor; kopyala + çöp kutusu yedeği yok; USB/çıkarılabilir diskte taşıma yalnız toast ile başarısız | `fs_ops.rs:489 → :451-465`; OS hatası ikinci kez `:345-350 → CROSS_DRIVE` | İşlev eksikliği (hareket alanı yok, MB değil) | `CROSS_DRIVE` için kopyala + çöp kutusuna taşı yedeği | doğrulandı |
| 6 | Orta | 1 | `fs_ops.rs` `delete_entry_at` (526-537) | Silme/taşıma/yeniden adlandırma `SelfWriteRegistry`'ye kaydedilmiyor (yalnız yazma yolu `fs/write.rs:74` kayıtlı) → watcher aynı değişikliği ayrıca yayınlar, klasör iki kez listelenir, yarış penceresi açılır | `fs_ops.rs` içinde `SelfWriteRegistry` referansı sıfır (grep kanıtı notta) | Gereksiz yenileme turu; sekme başına küçük CPU/bellek; yarış penceresi | Üç yıkıcı işlemi de `SelfWriteRegistry`'ye kaydet | doğrulandı |
| 7 | Orta | 3 | `ConfirmDialog.svelte` (21-23, 44) | Odak tuzağı yok: `role="alertdialog"` + `aria-modal` + `Escape` var ama `Tab` döngüsü kurulmadığından odak arkadaki ağaca kaçabilir (WCAG 2.1.2 / 2.4.3) | `ConfirmDialog.svelte:21-23,35-40,44` | Klavye erişilebilirlik riski | Odak tuzağı ekle | doğrulandı |
| 8 | Orta | 3 | `FileTree.svelte` onay metni (453) | Onay metni zayıf: yalnız adı yazıyor; dosya/klasör ayrımı, klasörse öğe sayısı ve tam yol yok | `FileTree.svelte:450-459` | Kullanıcı yanlış öğeyi silebilir | Onay metnine ayrım + sayı + yol | doğrulandı |
| 9 | Orta | 3 | `treeStore.svelte.ts` `rename` / `FileTree.svelte` `submitRename` (268-290) | `ENTRY_EXISTS` çakışması ancak sunucu hatasıyla gidiş-dönüş sonrası öğreniliyor; `entriesByDir` önbelleği (`treeStore.svelte.ts:25`) ön kontrol için kullanılmıyor; "değiştir" seçeneği yok | `fs_ops.rs:399-411,503-513` sunucu tarafı atomik koruma sağlıyor; ön kontrol eksik | Gecikmiş geri bildirim (çakışma tur sonrası) | `entriesByDir` ile ön kontrol + "değiştir" seçeneği | doğrulandı |
| 10 | Orta | 3 | `fs_ops.rs` `delete_entry_at` (531-536) | `trash` hataları tek `IO_ERROR` metnine düşüyor; "çöp kutusu dolu", "kalıcı silinsin mi" ayrımı kayboluyor | `fs_ops.rs:531-536`; crate hata tipi okunmadı | Hata mesajı kalitesi; kullanıcı doğru eylemi seçemiyor | `trash` hata tiplerini ayrıştır (crate davranışı önce ölçülmeli) | doğrulanmadı (bkz. §D3 — crate içi `[ÇI]`/`[Hİ]`) |
| 11 | Orta | 3 | `FileTree.svelte` (110-113) / `shortcuts.ts` (15,20-26) | Menü `Ctrl+N`, `Ctrl+Shift+N`, `F2`, `Del` ipuçları gösteriyor ama merkezî kısayol katmanında bu komutlar yok; `Del`/`F2` yalnız ağaç satırı odaklıyken çalışıyor | `shortcuts.ts:15` `CommandId` listesi; `Tree.svelte:133-140` | Yanıltıcı ipuçları; odak editördeyken hiçbir şey olmuyor | Komutları ekle veya ipuçlarını gerçek davranışa göre düzelt | doğrulandı |
| 12 | Düşük | 3 | `FileTree.svelte` (32, 228-229, 301-306) | `busy` kilidi silme ile taşıma arasında paylaşımlı; silme, taşıma bitene kadar başlatılamıyor (artık sessiz değil, `toast.info` var) | `confirmDelete:301-306` | Elle yeniden deneme zorunluluğu | `busy` kilidini işlem başına ayır | doğrulandı |
| 13 | Düşük | 1 | `fs_ops.rs` `run_blocking_bounded` (628-658) | 60 sn sınırı dolduğunda iş parçacığı arka planda terk edilir; silme sonradan tamamlanabilir (durum kısa süre tutarsız görünür) | `fs_ops.rs:631-634,649-653`; bilinçli tasarım | Kısa süreli tutarsız görüntü | (Tasarım kararı; ölçüm sonrası yeniden değerlendir) | doğrulanmadı (bkz. §D1) |
| 14 | Bilgi | 1 | `markdown.ts` / `PreviewPane.svelte` | Önizleme maliyeti belge yoğunluğuyla artıyor: tablo+kod bloğu yoğun 38 KB stres belgesi aynı ikilide 164.8 MiB ölçer (tipik belgede 144.0 MiB, ~5-7 MiB bütçe payı) | `docs/PERFORMANCE.md` §5 sızdırma denetimi + stres ölçümü | Sekme sayısıyla doğrusal büyüme; yoğun belgelerde bütçe aşımı riski | (Bütçe kapısı gözetim altında; önbellek yokluğu bilinçli) | doğrulandı (ölçüm) |
| 15 | Bilgi | 4 | `measure-perf.mjs` `cleanupAll` | Ölçüm harness riskleri: öksüz `msedgewebview2.exe` süreçleri mutex'i miras alır → sonraki başlatmalar sessiz `exit 0`; eşzamanlı iki ölçüm birbirini öldürür; `--remote-debugging-port` tek başına WebView2 157.x'te ~5 sn içinde `exit 0` | `docs/PERFORMANCE.md` §5 koşu izolasyonu notları | Ölçüm güvenilirliği (ürün değil) | Serileştirilmiş koşu + artık süreç temizliği kuralına uy | doğrulandı |
| 16 | Bilgi | 4 | `lib.rs` `fenced_handler` (69-82) | Panic fence yalnız senkron dispatch'i sarıyor; async komut gövdelerinde panic → promise asılı kalır sınıfının genel kapısı mimari olarak açık (mevcut iki async komut kendi içinde paniklenmiş) | `open_workspace` `catch_panic` (`workspace_commands.rs:109`), `fs_delete_entry` `JoinError → Internal` (`fs_ops.rs:610`) | Potansiyel askıda promise (koşullu) | Ortak async fence deseni (arka plan görevine alınabilir) | doğrulanmadı (bkz. §D4 — crate içi `[ÇI]`) |
| 17 | Bilgi | 4 | `PERFORMANCE.md` §5 | 5 sekme bütçe payı ince: 142.8-145.0 MiB bandı vs 150 MiB eşik (~5-7 MiB pay), makine yüküne duyarlı | `--tabs 5` çoklu koşu tabloları | Yeni özellikler ~5 MiB bellek eklerse eşik aşılabılır | Yeni bellek maliyetli özelliklerde kapıyı yeniden ölç | doğrulandı (ölçüm) |

## Birleştirmede tekrarlanan/çelişen bulgular

- **Tekrarlar birleştirildi:** `open_workspace` sınırsız `recv().await` (D1 kolonu B1 = D2 kolonu §3.3) tek satır (#2); senkron `fs_move`/`fs_rename_entry` (B2 = §3.4) tek satır (#3); silme ayağının iki katmanlı düzeltmesiyle kapanması (B3 = §3.2) her iki kolonda da tutarlı — bulgu değil, "kapalı" kaydı.
- **Çelişki — çözümlenmiş eski iddia:** önceki revizyonda "yeniden adlandırma/taşıma `fs::rename` kullanıyor, üzerine yazma yarışı var" deniliyordu; güncel kaynak Windows ana yolunun `rename_no_overwrite` → `MoveFileExW` + `MOVE_FILE_FLAGS(0)` olduğunu, `fs::rename`'in yalnız case-only dalda kaldığını gösterdi → **geçersiz**, tabloya alınmadı (`DIAGNOSIS-destructive-ops.md` §4/Ç1).
- **Eleme kayıtları (bulgu değil):** hipotez A (sahipsiz/fire-and-forget promise) ve C (UI onayı deadlock) iki kolonda da **elendi** — kaynak zincirleri tüm yolların settle ettiğini gösteriyor; kök neden sınıfı B (sonuçlanmayan I/O/event) doğrulandı. A/C yalnız belirti benzerliği yaratıyor.
- **Kanıt düzeyi normalize edildi:** eski satır referansları (Ç3, Ç4, Ç5) bu birleşik tabloda güncel ağaç numaralarıyla yazıldı; `[DO]`/`[ÇI]`/`[Hİ]` etiketleri Durum kolonuna indirgendi.

## Doğrulanmamış maddeler (ayrı alt bölüm)

**D1 — Terk edilen silme iş parçacığı sonradan tamamlanabilir mi? (#13, `[Hİ]`)**
`run_blocking_bounded` iş parçacığını durdurmuyor (`fs_ops.rs:631-634`). Kullanıcı "tamamlanmadı" hatası görürken öğenin çöp kutusuna gitmesi ölçülmedi. Ölçüm yolu: `delete_entry_at` içine `trash::delete` öncesi/sonrası log koymak.

**D2 — `awaitTasks timed out` raporundaki askıda komut `open_workspace` mi? (#2, `[Hİ]`)**
Depo tarafında sınırsız await kanıtlandı; ancak zaman aşımına düşen görevin gerçekten bu komuta ait olduğu ölçülmedi. Alternatif: büyük klasörde senkron `fs_move` ana thread'i bloke edip tüm IPC'yi geciktirmiş olabilir. Ayrım yolu: devtools'ta `open_workspace` promise probe (teşhis notu §5/R1) + dış izleyici logu.

**D3 — `trash` crate'inin hata ayrımı (#10, `[Hİ]`/`[ÇI]`)**
Crate'in "kalıcı silinsin mi" ayrımını kendi hata tipiyle sunduğu varsayılıyor; crate kaynağı okunmadı. Ölçüm yolu: `trash::delete` hata tipi örneği toplamak veya crate kaynağını okumak.

**D4 — STA/pompa riski blocking havuzunda tekrarlayabilir (#16, `[Hİ]`/`[ÇI]`)**
`trash = "5"` varsayılan özelliklerle, `spawn_blocking` taze thread'de COM'u başlatıyorsa STA + pompasız kombinasyon orada da takılabilir; bugün bile komut 60 sn sonra tipli hatayla dönüyor, yani belirti sınırlandı, kök neden ölçülmedi. Ölçüm yolu: `cargo test --test trash_restore -- --ignored` gerçek Geri Dönüşüm Kutusu ile.

**D5 — `awaitTasks` mesajının kaynağı depo dışı (tüm kolonlar, `[ÇI]`)**
`awaitTasks timed out` metni depoda yok; dış bekleyen-görev izleme katmanından geliyor varsayılıyor ve o katmanın zaman aşımı süresi okunmadı.

**D6 — Async gövde panic fence genel kapısı (#16, `[ÇI]`)**
Sınıf mimari olarak açık ama bu turda panikleyen bir async gövde örneği yok; her iki async komut kendi panik yolunu tipli hataya çeviriyor.

## Özet

17 birleşik madde: 12 doğrulanmış, 5 doğrulanmamış (D1-D6; #16 iki kez görünüyor). Sıralamanın zirvesinde üç doğrulanmış kritik/yüksek madde var: kirli sekme korumasız silme (#1), `open_workspace` sınırsız await (#2) ve senkron `fs_move`/`fs_rename_entry` (#3). Performans kolonu bütçe aşımı raporlamıyor; tek taşıdığı riskler önizleme yoğunluk duyarlılığı (#14), ince bütçe payı (#17) ve ölçüm harness kırılganlıkları (#15). Hiçbir düzeltme uygulanmadı.
