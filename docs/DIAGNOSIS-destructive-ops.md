# Teşhis Notu — Yıkıcı İşlemler (sil / taşı / yeniden adlandır) ve `awaitTasks timed out`

> **Salt teşhis.** Bu notta hiçbir uygulama davranışı değiştirilmedi ve hiçbir
> kaynak dosya düzenlenmedi. Not yalnızca mevcut durumu ve kök nedeni belgeler;
> öneriler ayrı ve kısa bir bölümde (§6) tutuldu.
>
> **Birleştirilen üç alt görev:** (a) üç yıkıcı işlemin uçtan uca akış haritası
> (§1), (b) onay diyaloğu / üzerine yazma kontrolü / Recycle Bin
> entegrasyonundaki eksikler (§2), (c) `awaitTasks timed out` hatasının kök
> nedeni (§3). Bu üç bulgu tek bir tutarlı notta birleştirildi ve **güncel
> kaynağa karşı yeniden doğrulandı**; eski revizyondan kalan ve artık geçersiz
> olan iddialar §4'te açıkça işaretlendi.
>
> **Kanıt düzeyi etiketleri:**
> `[DO]` = doğrulandı (bu turda kaynak okundu), `[ÇI]` = çıkarım (depo dışı
> crate/runtime davranışı, bu turda okunmadı), `[Hİ]` = hipotez (doğrulanmadı).
>
> **Yöntem ve sınır:** `src/` ve `src-tauri/src/` bu turda okundu; aşağıdaki tüm
> satır numaraları **güncel ağaçtan** üretildi. `cargo`, `vitest` ve uygulama
> **çalıştırılmadı** (görev salt teşhis). `trash`, `tauri` ve
> `tauri-plugin-dialog` crate iç satırları okunmadı; o yerler `[ÇI]` olarak
> işaretlendi. Kilitli sürümler: `src-tauri/Cargo.toml:16` → `tauri = "2"`,
> `src-tauri/Cargo.toml:17` → `tauri-plugin-dialog = "2"`,
> `src-tauri/Cargo.toml:24` → `trash = "5"` (varsayılan özellikler).

## 0. Özet

| Soru | Cevap | Kanıt |
| --- | --- | --- |
| Yıkıcı işlemlerin gerçek giriş noktaları | Bağlam menüsü + sürükle-bırak + satır klavyesi, hepsi `src/lib/tree/FileTree.svelte` ve `src/lib/tree/Tree.svelte` | `FileTree.svelte:107-132`, `:140-240`, `Tree.svelte:133-140` `[DO]` |
| Servis katmanı | `TreeStore` (`rename`, `move`, `remove`) → `tree/ipc.ts` → `ipc/client.ts` `invokeCommand` | `treeStore.svelte.ts:142-192`, `tree/ipc.ts:74-84` `[DO]` |
| Komut katmanı | `fs_delete_entry` **async + iki katmanlı sınırlı**; `fs_rename_entry` / `fs_move` **hâlâ senkron** | `fs_ops.rs:602-611`, `:567-589` `[DO]` |
| Üzerine yazma koruması nerede? | Yalnız sunucuda, **atomik**: `MoveFileExW` `MOVEFILE_REPLACE_EXISTING` olmadan | `fs_ops.rs:302-376`, `:399-411`, `:503-520` `[DO]` |
| Recycle Bin entegrasyonu | Tek yol `trash::delete`; geri alma/yükleme komutu, kalıcı silme alternatifi ve `SelfWriteRegistry` kaydı **yok** | `fs_ops.rs:526-537`, `lib.rs:162-182` `[DO]` |
| `awaitTasks timed out` sınıfı | **Bloklanan `await`** — iptal edilmeyen promise değil, UI onay deadlock'u değil | §3.1 `[DO]` |
| Silme ayağı bugün askıda kalır mı? | **Hayır.** Dış `spawn_blocking` + iç 60 sn `recv_timeout`; her durumda settle olur | `fs_ops.rs:602-658` `[DO]` |
| Geriye kalan hiç-bitmeyen `await` | `open_workspace` diyalog kanalı: `receiver.recv().await`, **timeout/iptal yok** | `workspace_commands.rs:88-100` `[DO]` |
| En yüksek riskli eksik koruma | `confirmDelete` kirli sekme durumuna hiç bakmıyor → kaydedilmemiş değişiklik sessizce kaybolur | `FileTree.svelte:299-322` vs. `tabsStore.svelte.ts:38` `[DO]` |

Literal `awaitTasks timed out` metni **bu depoda yok** `[DO]`: depo genelinde
`awaitTasks` arandı, tek eşleşme bu notun kendisi. Yani mesaj uygulamadan değil,
bekleyen promise'ları izleyen dış katmandan (geliştirme/e2e koşum kancası)
geliyor `[ÇI]`. Teşhis bu yüzden "hangi `invoke` hiç sonuçlanmıyor" sorusuna
indirgeniyor. Depodaki diğer `timeout` kullanımları bu soruyla ilgisiz:
`watcher.rs:372,389` (`recv_timeout` poll dilimi) ve `watcher.rs:451`
(hazırlık beklemesi).

## 1. Akış haritası (gerçek giriş noktaları)

### 1.1 Silme

1. `FileTree.svelte:107-115` — bağlam menüsü tanımı; `delete` öğesi `:113`
   (`hint: 'Del'`, `danger: true`, `menu.target === null` ise pasif).
2. `Tree.svelte:137-140` — odaklı satırda `Delete` → `onDeleteRequest(entry)`;
   aynı dosyada `F2` → `onRenameStart` (`:133-136`). Satır klavyesi yeniden
   adlandırma sürerken tamamen devre dışı (`:83`).
3. `FileTree.svelte:117-119` (`openMenu`), `:121-132` (`handleMenuSelect`);
   `delete` dalı `:129-131` → `deleteTarget = target`.
4. `FileTree.svelte:416` — `Tree`'nin `onDeleteRequest` bağlaması.
5. `FileTree.svelte:450-459` — onay diyaloğu; mesaj metni `:453`
   ("… Geri Dönüşüm Kutusu'na taşınacak."), `danger={true}` `:455`,
   `onConfirm` `:456`, `onCancel` `:457`.
6. `ConfirmDialog.svelte:25-33` — `confirm()`: `busy` kilidi `:26-27`,
   `await onConfirm()` `:29`, `finally` ile bırakma `:30-32`.
7. `FileTree.svelte:299-322` — `confirmDelete()`: sözleşme yorumu `:292-298`,
   paylaşımlı `busy` kontrolü `:301-306` (sessiz yutma değil, `toast.info`
   `:304`), hedef yakalama `:307`, `store.remove` `:310`, başarısızlıkta erken
   çıkış `:311`, `tabs.markDeleted` `:312`, seçim temizliği `:313`,
   `deleteTarget` sıfırlama `:314`, beklenmedik hata `:315-318`,
   `finally` → `busy = false` `:319-321`.
8. `FileTree.svelte:328-331` — `cancelDelete()`: hiçbir fs çağrısı yok,
   kullanıcıya `toast.info`.
9. `treeStore.svelte.ts:181-192` — `remove()`: başarıda `#forgetSubtree`
   (`:184`), üst klasörü yeniden listeleme (`:185`), toast (`:186`); hatada
   `describeFsError` toast (`:189`) ve `false` dönüş (`:190`). **Reddetmez.**
10. `tree/ipc.ts:82-84` — `deleteEntry` → `invokeCommand('fs_delete_entry', { rel })`.
11. `src/lib/ipc/client.ts` — tek IPC sarmalayıcısı (`invokeCommand`).
12. `lib.rs:173` — komut kaydı (liste `:162-182`, panic fence `:69-82`).
13. `fs_ops.rs:602-611` — `fs_delete_entry` (**async**): `:608`
    `tauri::async_runtime::spawn_blocking`, `:610` `JoinError` →
    `AppError::internal`.
14. `fs_ops.rs:613-618` — `delete_entry_at_bounded`: iç iş parçacığı +
    `DELETE_TIMEOUT`.
15. `fs_ops.rs:526-537` — `delete_entry_at`: `resolve_existing` (`:527`), kök
    koruması (`:528-530`), `trash::delete` (`:531`), tüm hatalar tek `IO_ERROR`
    metnine düşüyor (`:531-536`).

Ek yol (uygulama içi silme değil, dış değişiklik): watcher `remove` batch'i
`FileTree.svelte:90-95` → `tabs.markDeleted` (`:92`) +
`store.refreshFromChanges` (`:94`). Abonelik `:57-88`.

### 1.2 Taşıma (yalnız sürükle-bırak; menüde taşı komutu yok)

1. `FileTree.svelte:145-152` (`handleDragStart`), `:155-161` (`handleDragOver`,
   yalnız klasör hedefi), `:163-170` (`handleDragLeave`), `:172-175`
   (`handleDragEnd`), `:177-195` (`handleDrop`, `applyMove` `:194`),
   `:202-208` (`handleRootDragOver`), `:210-216` (`handleRootDragLeave`),
   `:218-225` (`handleRootDrop`, `applyMove` `:224`).
2. `FileTree.svelte:140-143` — `canMoveInto`: kendi alt ağacı `:141`, aynı
   klasör `:142`. **Yalnız frontend**; Rust tarafı da ayrıca reddeder
   (`fs_ops.rs:496-501`). Alt klasöre bırakma denemesi tipli hataya çevrilir
   (`FileTree.svelte:184-193`, `AppError('InvalidPath', …)` `:188-190`).
3. `FileTree.svelte:227-240` — `applyMove()`: paylaşımlı `busy` kilidi
   (`:228-229`), `store.move` (`:231`), `null` ise erken çıkış (`:232`),
   `tabs.renamePath` (`:234`), sekme hatası toast'ı (`:235`), seçim (`:236`),
   `finally` → `busy = false` (`:237-239`).
4. `treeStore.svelte.ts:164-179` — `move()`: alt ağaç düşürme (`:168`),
   kaynak/hedef klasör yeniden listeleme (`:169-170`), hedefi açma (`:171`),
   toast (`:173`), hata toast'ı (`:176`).
5. `tree/ipc.ts:78-80` → `fs_move` (`fs_ops.rs:577-589`, **senkron**).
6. `fs_ops.rs:473-523` — `move_entry_at`: `resolve_dir` (`:488`),
   `ensure_same_volume` (`:489`, tanım `:451-465`), aynı konum no-op
   (`:493-495`), kendi alt klasörü (`:496-501`, `INVALID_TARGET`), hedef
   çakışması (`:503-513`, `ENTRY_EXISTS` / aynı öğe ise no-op `:504`),
   atomik yazma `rename_no_overwrite` (`:515-520`).

### 1.3 Yeniden adlandırma

1. `Tree.svelte:133-136` — satırda `F2`; menü öğesi `FileTree.svelte:112`;
   `submitRename` bağlaması `FileTree.svelte:413`, başlatma `:415`.
2. `FileTree.svelte:268-290` — `submitRename()`: aynı ad ise sessiz kapatma
   (`:269-272`), yalnız boşluk farkı `:273-279` (`InvalidPath` toast `:275-277`,
   giriş açık kalır), `store.rename` `:280`, başarısızlıkta erken çıkış
   `:281-284`, sekme yolu güncellemesi `:285`, seçim `:288`.
3. `treeStore.svelte.ts:142-155` — `rename()`: yol değiştiyse üst klasörü
   yeniden listeleme ve klasörse alt ağaç düşürme (`:145-148`), toast (`:149`),
   hata toast'ı (`:152`).
4. `tree/ipc.ts:74-76` → `fs_rename_entry` (`fs_ops.rs:567-575`, **senkron**).
5. `fs_ops.rs:383-429` — `rename_entry_at`: hedef çözümü `:388`, ad doğrulama
   `:392`, çakışma/aynı-öğe kontrolü `:399-411` (case-only istisnası `:400`,
   `:412`), yazma `:412-425` (`fs::rename` yalnız case-only dalda `:415`,
   aksi halde `rename_no_overwrite` `:419-424`).

### 1.4 Ortak durum

Sekme durumu üç akışta da `src/lib/tree/tabsStore.svelte.ts` üzerinden
güncellenir (`renamePath` `:74-80`, `markDeleted` `:82-85`); saf matris
`src/lib/tree/tabs.ts` (`applyRenameToTabs`, `markDeletedTabs`). `dirty` alanı
`:38`, varsayılan parametre `:26`, değiştirici `:57-59`.

## 2. Eksik korumalar (dosya:satır ile, güncel durum)

### 2.1 Onay diyaloğu

- **Kaydedilmemiş değişiklik koruması yok — en yüksek riskli eksik `[DO]`.**
  Kirli durum verisi mevcut: `Tab.dirty` (`tabsStore.svelte.ts:38`), setter
  (`:57-59`), `renamePath` onu koruyor (`:74-80`). Ancak `confirmDelete`
  (`FileTree.svelte:299-322`) sekme durumuna **hiç bakmıyor**: kirli tampon
  kontrolü de, "önce kaydet" yolu da yok. Dosya çöp kutusuna gider, bellekteki
  değişiklik sessizce kaybolur; kurtarmanın tek yolu elle Geri Dönüşüm
  Kutusu'dur. Karşılaştırma: kapatma akışında kirli sekme kontrolü **var** —
  `lib.rs:23` (`CLOSE_REQUESTED_EVENT`) + `lib.rs:29-41`
  (`handle_window_event`); frontend kararı `src/lib/app/closeCoordinator.ts`.
- **Onay metni zayıf** `[DO]`: `FileTree.svelte:453` yalnız adı yazıyor; öğenin
  klasör mü dosya mı olduğu, klasörse kaç öğe içerdiği ve tam yol yok. Klasör
  silmede içeriğin de gittiği belirtilmiyor.
- **Odak tuzağı yok** `[DO]`: `ConfirmDialog.svelte:21-23` yalnız onay
  düğmesine odak veriyor; `role="alertdialog"` + `aria-modal="true"` (`:44`)
  var, `Escape` (`:35-40`) var, ama `Tab` döngüsü kurulmadığından odak arkadaki
  ağaca kaçabilir (WCAG 2.1.2 / 2.4.3 riski).
- **Taşımada onay ve geri alma yok** `[DO]`: sürükle-bırak doğrudan `applyMove`
  çağırıyor (`:194`, `:224`); undo yok. `busy` düz bir boolean (`:32`, `:229`)
  olduğu için uçuştaki taşıma sırasında ikinci bırakma **sessizce** yutuluyor
  (`:228` dönüşünde bildirim yok). Bu, silme yolundaki `:301-306` davranışıyla
  **asimetrik**: orada kullanıcıya `toast.info` gösteriliyor.
- **`busy` kilidi silme ile paylaşılıyor** `[DO]`: `confirmDelete:301-306` artık
  sessiz dönmüyor (`toast.info` `:304`), ancak silme yine de taşıma bitene
  kadar başlatılamıyor; kullanıcı elle yeniden denemek zorunda.
- **Yeniden adlandırmada onay yok** (kabul edilebilir), ancak çakışma yalnız
  sunucudan gelen hatayla, gidiş-dönüş sonrası anlaşılıyor
  (`FileTree.svelte:280-284` + `treeStore.svelte.ts:151-154`) `[DO]`.

### 2.2 Üzerine yazma kontrolü

- Koruma **atomik ve sunucu tarafında** `[DO]`: `rename_no_overwrite`
  (`fs_ops.rs:302-376`) Windows'ta `MoveFileExW` çağırır ve bilinçli olarak
  `MOVE_FILE_FLAGS(0)` kullanır (`:327-334`); `ERROR_FILE_EXISTS` /
  `ERROR_ALREADY_EXISTS` (`:315-316`) → `ENTRY_EXISTS` (`:341-343`, sabit
  `:29`). `std::fs::rename` bu yüzden ana yoldan çıkarılmış (gerekçe yorumu
  `:290-301`). Çağrı yerleri: yeniden adlandırma `:419-424`, taşıma `:515-520`.
- Ön kontrol yok `[DO]`: `entriesByDir` önbelleği (`treeStore.svelte.ts:25`)
  hedef klasörde aynı adlı öğe olup olmadığını zaten bilebilir; çakışma için
  kullanılmıyor, kullanıcı ancak tur sonrası öğreniyor.
- "Değiştir / ikisini koru" seçeneği yok `[DO]`; kullanıcı adı elle düzeltmek
  zorunda.
- **Çapraz sürücü taşıma tamamen reddediliyor** `[DO]`: `fs_ops.rs:489` →
  `:451-465` (volume öneki), ayrıca OS hatası ikinci kez `:345-350` →
  `CROSS_DRIVE` (sabit `:39`). Kopyala + çöp kutusuna taşı yedeği yok;
  USB/çıkarılabilir diskte taşıma yalnız toast ile başarısız olur.
- Yalnız Windows dışı derlemede check-then-act penceresi var
  (`fs_ops.rs:358-375`: `symlink_metadata` + `fs::rename`) `[DO]`. Ürün
  Windows'a kilitli olduğu için (`Cargo.toml:1-6`) bu bir ürün riski değil,
  taşınabilirlik notudur.

### 2.3 Recycle Bin entegrasyonu

- Tek yol `trash::delete` (`fs_ops.rs:531`) `[DO]`. Kalıcı silme alternatifi ve
  geri alma komutu yok: `lib.rs:162-182` kayıt listesinde `fs_restore*` /
  `fs_undo*` bulunmuyor. Geri yükleme tamamen işletim sistemine bırakılmış
  (yalnız elle, `--ignored` ile koşulan `src-tauri/tests/trash_restore.rs`;
  manuel tur `docs/TRASH-RESTORE-CHECKLIST.md`).
- Hata tek bir `IO_ERROR` metnine düşüyor (`fs_ops.rs:531-536`); "çöp kutusu
  dolu", "öğe reddedildi, kalıcı silinsin mi" gibi ayrım yok. `trash` crate'i
  bu ayrımı kendi hata tipiyle raporluyor olabilir `[ÇI]`; uygulama bu bilgiyi
  tek metne indirgeyip atıyor.
- **Silme/taşıma/yeniden adlandırma `SelfWriteRegistry`'ye kaydedilmiyor**
  `[DO]`. Kayıt yalnız yazma yolunda var (`src-tauri/src/fs/write.rs:74`);
  `fs_ops.rs` içinde `SelfWriteRegistry` referansı **sıfır** (grep: yalnız
  `lib.rs:154`, `workspace_commands.rs:14,86,125`, `watcher.rs`, `fs/write.rs`).
  Sonuç: watcher aynı değişikliği ayrıca `remove`/`rename` batch'i olarak
  yayınlar ve `store.remove` (`treeStore.svelte.ts:184-185`) ile birlikte aynı
  klasör iki kez listelenir — işlevsel hata değil, gereksiz tur ve yarış
  penceresi.
- 60 sn sınırı dolduğunda iş parçacığı arka planda **terk edilir**
  (`fs_ops.rs:631-634` yorumu, `:649-653`). Bu bilinçli bir tasarım; ancak
  kullanıcıya "tamamlanmadı" hatası gösterilirken shell işleminin sonradan
  tamamlanabilmesi `[Hİ]` — bkz. §5/H2.

### 2.4 Klavye / kısayol tutarsızlıkları

- Menü `Ctrl+N`, `Ctrl+Shift+N`, `F2`, `Del` ipuçlarını gösteriyor
  (`FileTree.svelte:110-113`), ama merkezi kısayol katmanında bu komutlar yok
  `[DO]`: `src/lib/app/shortcuts.ts:15`
  `CommandId = 'save' | 'bold' | 'close-tab' | 'find' | 'quick-open'`, harita
  `:20-26` (`n` eşlenmemiş). Yani ipuçları yanıltıcı; `Del`/`F2` yalnız ağaç
  satırı DOM odağındayken çalışır (`Tree.svelte:133-140`) — odak editördeyken
  hiçbir şey olmuyor.

## 3. `awaitTasks timed out` — kök neden

### 3.1 Aday sınıflarının ayrımı

| Aday | Değerlendirme | Kanıt |
| --- | --- | --- |
| İptal edilmeyen / sahipsiz promise | **Değil.** `confirmDelete` `finally` ile `busy`'yi bırakır (`FileTree.svelte:319-321`); `ConfirmDialog.confirm` `finally` ile kendi `busy`'sini bırakır (`ConfirmDialog.svelte:30-32`); hiçbir `await` "unutulmuş" değil. Sorun promise'ın **hiç settle olmaması**. | `[DO]` |
| **Bloklanan `await`** | **Evet — birincil sınıf.** Silme zincirinde eskiden `invoke` promise'ı hiç sonuçlanmıyordu (kaynakta kapatıldı); `open_workspace`'te bugün de sonuçlanmayabilir. | §3.2, §3.3 `[DO]` |
| UI onayı bekleyen deadlock | **Değil (kök neden olarak).** Onay diyaloğu bir Promise ile beklenmiyor: `ConfirmDialog` yalnız `onConfirm`'i çağırıyor (`:29`) ve o da IPC'yi bekliyor. UI *belirtisi* deadlock gibi görünür ("İşleniyor…" `:56`, düğmeler `disabled={busy}` `:48,54`), ama kilit IPC'de. | `ConfirmDialog.svelte:25-33,48,54-56` `[DO]` |

### 3.2 Silme ayağı — kaynakta **kapatılmış** durumda

Eski hatanın mekanizması ve düzeltmesi kaynakta kendi dokümanında kayıtlı
(`fs_ops.rs:591-601`):

1. `trash::delete` (`:531`) Windows shell dosya işlemi COM API'sini sürer ve
   shell geri raporlayana kadar bloklar `[ÇI]`.
2. Senkron bir `#[tauri::command]` gövdesi ana thread'de satır içi çalışır;
   shell'in STA işinin geri dönecek bir mesaj pompası bulunmaz → çağrı hiç
   dönmez → `invoke('fs_delete_entry')` hiç settle olmaz → onay diyaloğu
   "İşleniyor…" durumunda kilitli kalır → bekleyen görev izleyicisi zaman
   aşımına düşer (`fs_ops.rs:591-601` bunu birebir yazıyor) `[DO]`.
3. **Düzeltme iki katmanlı** `[DO]`:
   - Dış katman: komut `async` (`:602-603`) ve bloklayan iş
     `tauri::async_runtime::spawn_blocking` ile blocking havuza taşınıyor
     (`:608`); `JoinError` tipli `Internal` hatasına çevriliyor (`:610`).
   - İç katman: `delete_entry_at_bounded` (`:613-618`) işi ayrı bir
     `fs-delete` iş parçacığına verip en fazla **60 sn** bekliyor
     (`DELETE_TIMEOUT` `:620-626`, `run_blocking_bounded` `:628-658`,
     `recv_timeout` `:649`).
   - Dönüş **her koşulda** gerçekleşir: başarı `:650`, süre aşımı `:651-653`
     (tipli `Internal`), iş parçacığı düşmesi `:654-656`.

**Sonuç:** "`awaitTasks timed out`" belirtisinin **silme** ayağı artık kapalı.
Silme zincirinde bugün hiç-bitmeyen bir `await` kalmadı:
`confirmDelete` → `store.remove` → `deleteEntry` → async komut; her yol
`resolve` veya `reject` ile sonlanıyor. Bu, `docs/TRASH-RESTORE-CHECKLIST.md`
§4'teki "diyalog 'İşleniyor…' durumunda kilitlenmez" test sonucuyla tutarlı.

### 3.3 Kalan birincil neden: `open_workspace` diyalog kanalı

`workspace_commands.rs:81-112` — **zaman aşımı, `select!` ve iptal yolu yok**
`[DO]`:

1. `tauri::async_runtime::channel(1)` (`:88`).
2. `pick_folder` geri çağrısı sonucu `blocking_send` ile gönderiliyor
   (`:92-98`); kanal kapalıysa hata yalnız `eprintln!`'e yazılıyor (`:96`),
   komuta iletilmiyor.
3. Komut `receiver.recv().await` (`:100`) ile bekliyor — **timeout yok, iptal
   tokeni yok**.
4. Geri çağrı hiç gelmezse (diyalog hiç açılmazsa, `run_on_main_thread`
   başarısız olursa veya ana thread başka bir işlemle bloke ise) kanal
   kapanmaz ve future **sonsuza kadar** bekler.

Diyalog gerçekten ana thread'e bağlıdır `[ÇI]`: `tauri-plugin-dialog`
`pick_folder` işini ana thread'e gönderip işi ayrı bir thread'de başlatır ve
`run_on_main_thread` dönüşünü yutar. Bu cümle crate içi okumadır, bu turda
yeniden doğrulanmadı; **depo tarafı** — kanal, `recv`, iptal yokluğu —
doğrulandı.

**Guard yanılgısı (önceki revizyonda düzeltilmiş, korunuyor):**
`transition_guard` diyalog beklerken **tutulmuyor**. Guard yalnız
`adopt_folder` içinde alınıyor (`workspace_commands.rs:146`) ve `adopt_folder`
senkron bir fonksiyon olup `recv().await` çözüldükten **sonra** çağrılıyor
(`:109-111`); ayrıca `workspace.rs` yorumu guard'ın "son `await`'ten sonra
alınması" gerektiğini yazıyor. Yani askıda `open_workspace` yalnız kendi
promise'ını asar, sonraki kök geçişlerini kilitlemez. `close_workspace` de
guard'ı yalnız kendi senkron gövdesinde tutar (`:201`).

Bu, yıkıcı işlemlerle aynı kullanıcı akışında (klasör aç → ağacı kullan)
bulunan **hiç bitmeyen tek future** adayıdır ve `awaitTasks timed out`
raporunun bugünkü en olası kaynağıdır `[DO]` (kanal/recv) + `[ÇI]` (hangi
çağrının askıda kaldığı ölçülmedi).

### 3.4 Neden move/rename deadlock değil

`fs_move` / `fs_rename_entry` senkron ve ana thread'de çalışır
(`fs_ops.rs:567-589`) `[DO]`. Ancak çağırdıkları yazma `rename_no_overwrite`
(`:302-376`) pompa beklemeyen düz Win32 `MoveFileExW` çağrısıdır; normalde
döner. Yalnız çok büyük klasörlerde uzun süre bloke ederek **aynı belirtiyi**
(UI donması → tüm IPC gecikmesi) üretebilir; bu bir kilitlenme değil,
gecikmedir `[ÇI]`. `ENTRY_EXISTS` yolları (`:399-411`, `:503-513`) tek bir
`symlink_metadata` dışında I/O beklemez.

### 3.5 İkincil dikkat: async komut gövdeleri panic fence'inin dışında

`lib.rs:69-82` `fenced_handler` yalnız **senkron** dispatch'i sarıyor `[DO]`.
Async komutlar (`open_workspace`, `fs_delete_entry`) gövde olarak ayrı bir
görevde koşar. Depo bu riskin farkında: `open_workspace` kendi gövdesinde
`catch_panic` kullanıyor (`workspace_commands.rs:109`), `fs_delete_entry`
blocking panic'ini `JoinError` ile tipli hataya çeviriyor (`fs_ops.rs:610`) ve
iç iş parçacığının düşmesini `Disconnected` olarak yakalıyor (`:654-656`).
Yine de "async gövdede panic → promise asılı kalır" sınıfının genel kapısı
mimari olarak açık `[ÇI]`.

## 4. Çelişen bulgular ve önceki revizyondan düzeltmeler

Alt görev bulguları birleştirilirken güncel kaynakla **çelişen** noktalar.
Bunlar "birleştirme sırasında fark edilen tutarsızlıklar"dır; hiçbiri kod
değişikliğiyle giderilmedi.

| # | Önceki iddia | Güncel kanıt | Sonuç |
| --- | --- | --- | --- |
| Ç1 | Yeniden adlandırma/taşıma `fs::rename` kullanıyor (`:321`, `:420`); Windows'ta `MOVEFILE_REPLACE_EXISTING` geçtiği için yarışan hedef sessizce ezilebilir | Windows ana yolu `rename_no_overwrite` → `MoveFileExW` + `MOVE_FILE_FLAGS(0)` (`fs_ops.rs:302-376`, özellikle `:327-334`); `fs::rename` yalnız case-only dalda `:415` ve non-Windows `:363` | **Eski risk iddiası geçersiz.** Üzerine yazma koruması atomik ve doğru; satır referansları tazelendi |
| Ç2 | Silme düzeltmesi = `async` + `spawn_blocking` + `JoinError` → `Internal` | Buna ek olarak iç iş parçacığı + 60 sn `recv_timeout` var (`fs_ops.rs:613-618`, `:620-626`, `:628-658`) | Düzeltme **iki katmanlı**; silme timeout'u artık tipli hataya dönüşüyor |
| Ç3 | `fs_ops.rs` satırları: `delete_entry_at` `:443-455`, `move_entry_at` `:372-441`, `rename_entry_at` `:293-328`, `ensure_same_volume` `:350-364`, `trash::delete` `:449` | `:526-537`, `:473-523`, `:383-429`, `:451-465`, `:531` | Tümü kaymış; bu notta güncellendi |
| Ç4 | `fs_delete_entry` `:520-529` (`spawn_blocking` `:525`, `JoinError` `:527`) | `:602-611` (`spawn_blocking` `:608`, `map_err` `:610`) | Kaymış; güncellendi |
| Ç5 | Onay diyaloğu `FileTree.svelte:441-450`, mesaj `:444`, `danger` `:446`; `onDeleteRequest` `:407` | `:450-459`, mesaj `:453`, `danger` `:455`; `onDeleteRequest` `:416` | Kaymış; güncellendi |
| Ç6 | §3.3'ün eski hali: "`transition_guard` diyalog beklerken tutulur" | Guard yalnız `adopt_folder` içinde (`workspace_commands.rs:146`), `recv` çözüldükten sonra (`:109-111`) | **Zaten düzeltilmişti; doğrulandı ve korundu** |
| Ç7 | `awaitTasks timed out` metni depoda yok | Depo grep: tek eşleşme bu not | **Doğrulandı**, değişiklik yok |

## 5. Hipotezler ve doğrulanmamış varsayımlar

- **H1 — STA/pompa riski blocking havuzunda tekrarlayabilir `[Hİ]`.**
  `trash = "5"` varsayılan özelliklerle kullanılıyor (`Cargo.toml:24`); crate
  COM'u çağıran thread'in apartment'ında başlatıyorsa `[ÇI]`, `spawn_blocking`
  ve `fs-delete` iş parçacıkları taze thread olduğundan STA + pompasız
  kombinasyon orada da takılabilir. Bugün bu durumda bile komut 60 sn sonra
  tipli hatayla döner; yani **belirti sınırlandı, kök neden ölçülmedi**.
- **H2 — Zaman aşımından sonra silme arka planda tamamlanabilir `[Hİ]`.**
  `run_blocking_bounded` terk edilen iş parçacığını durdurmuyor
  (`fs_ops.rs:631-634`). Kullanıcı "tamamlanmadı" hatası görürken öğe sonradan
  çöp kutusuna giderse ağaç/watch durumu kısa süre tutarsız görünebilir.
  Ölçülmedi.
- **H3 — Mesaj dış koşum katmanından geliyor `[ÇI]`.** Depoda literal yok;
  bekleyen promise'ları izleyen bir geliştirme/e2e kancası olduğu varsayılıyor.
  Hangi komutun askıda kaldığı bu katmanın logu olmadan kesinleştirilemez.
- **H4 — `open_workspace` "en olası" kaynak, "kanıtlanmış" kaynak değil
  `[Hİ]`.** Askıda kalabileceği kaynakta doğrulandı (§3.3), ama zaman aşımı
  raporunun o koşumda gerçekten bu komuta ait olduğu ölçülmedi. Alternatif:
  büyük klasörde senkron `fs_move`/`fs_rename_entry` ana thread'i bloke edip
  tüm IPC'yi geciktirmiş olabilir (§3.4).
- **H5 — `trash` hata ayrımı kayboluyor `[Hİ]`.** Crate'in "kalıcı silinsin
  mi" ayrımını sunduğu, uygulamanın bunu tek `IO_ERROR` metnine indirdiği
  varsayımı; crate kaynağı okunmadı.

## 6. Öneriler (kısa — bu turda uygulanmadı)

- `confirmDelete`'e kirli sekme kontrolü (`tabsStore` `dirty` zaten var) ve
  "önce kaydet" akışı; onay metnine dosya/klasör ayrımı ve öğe sayısı;
  `ConfirmDialog`'a odak tuzağı.
- `open_workspace` diyaloğuna iptal + zaman aşımı; `blocking_send`
  başarısızlığını `eprintln!` yerine komuta iletmek.
- `fs_move` / `fs_rename_entry` → `async` + `spawn_blocking` (silme ile aynı
  desen; büyük klasör donmasını da giderir).
- `busy` kilidini işlem başına ayır (silme/taşıma birbirini bekletmesin);
  taşımaya geri alma (undo) ekle.
- `ENTRY_EXISTS` için ön kontrol (`entriesByDir`) ve "değiştir" seçeneği;
  `CROSS_DRIVE` için kopyala + çöp kutusuna taşı yedeği.
- Silme/taşıma/yeniden adlandırmayı `SelfWriteRegistry`'ye kaydet.
- `shortcuts.ts`'e `delete` / `rename` / `new` komutları (menü ipuçlarıyla
  tutarlı) veya ipuçlarını gerçek davranışa göre düzeltmek.

## 7. Doğrulama / yanlışlama adımları (bu görevde UYGULANMADI)

1. `cargo test --manifest-path src-tauri/Cargo.toml --test trash_restore -- --ignored --nocapture`
   — gerçek Geri Dönüşüm Kutusu; `run_blocking_bounded` sonrası
   `delete_entry_at`'in dönüp dönmediğini ve H1'i ölçer.
2. Geliştirme derlemesinde ~10k dosyalı bir klasörü sil: 60 sn dolup tipli hata
   mı geliyor, yoksa işlem tamamlanıyor mu (H2)?
3. `delete_entry_at` içine `trash::delete` öncesi/sonrası log koy: çift
   tamamlanmıyorsa blokaj sürüyor demektir (H1).
4. §3.3 için: "Klasör aç"a bas, diyalog hiç açılmadan pencereyi arka plana al;
   `open_workspace` promise'ı dönmüyorsa asıl neden doğrulanır (H4).
5. `fs_move` / `fs_rename_entry` için büyük klasörde süre ölç: ana thread
   donması sürüyorsa senkron komutlar da blocking havuza alınmalı.

## 8. Bu notun sınırları

- Uygulama çalıştırılmadı, `cargo`/`vitest` koşulmadı — görev salt teşhis
  olduğu için yalnız kaynak okuması yapıldı. §3.3'teki crate içi satırlar,
  §3.5'teki async-panic davranışı ve §5'teki tüm hipotezler **doğrulanmadı**.
- `tauri` / `tauri-plugin-dialog` / `trash` crate içi davranışlar önceki
  turdan devralındı ve bu turda yeniden okunmadı; `[ÇI]` etiketlendi.
- Depo tarafındaki tüm satır referansları güncel kaynaktan üretildi ve tek tek
  kontrol edildi; §4'te listelenen eski referanslar artık geçersizdir.
- Bu not hiçbir davranış değişikliği önermeden mevcut durumu belgeler; §6
  yalnız yön gösterir ve uygulanmamıştır.
