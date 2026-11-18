# Mimari — Markdown Editor

Frontend: Svelte 5 (runes) + CodeMirror 6, Vite ile derlenir.
Backend: Tauri v2, Rust (güvenlik-kritik dosya işlemleri).

## Temel akışlar

```
Svelte bileşeni ──> lib/ipc/client.ts (invokeCommand) ──> Tauri invoke ──> src-tauri komutları
Rust ──> emit("fs:changed" / "fs:watcher-error") ──> lib/watch/events.ts ──> çakışma/tekileştirme katmanı
```

- **Komut yüzeyinin tek kaynağı:** `src/lib/ipc/types.ts` → `CommandSignatures`. Rust tarafındaki komut adları ve `AppErrorCode` (`src-tauri/src/error.rs`) ile birebir senkron tutulur; iki dosya birlikte değiştirilir.
- **IPC katmanı:** `src/lib/ipc/client.ts` (`InvokeTransport` + `invokeCommand`), `src/lib/ipc/errors.ts` (`AppErrorPayload` normalizasyonu), `src/lib/ipc/events.ts` (olay dinleme).
- **Alan katmanları:** `lib/tree` (ağaç/sekme), `lib/editor` (belge oturumu, çakışma banner'ları), `lib/save` (kaydetme akışı), `lib/session` (oturum kalıcılığı), `lib/watch` (olay işleme), `lib/preview` (markdown-it + DOMPurify sanitizasyon), `lib/app` (kısayollar, tema, pencere kapanma).

## IPC sözleşmesi

Tüm komutlar `invokeCommand(command, args)` üzerinden çağrılır. Argümanlar Tauri v2 varsayılanı gereği **camelCase** (`parentRel`, `newName`), sonuçlar seri hâlinde camelCase'dir.

### Hata sözleşmesi

Her komut reddi frontend'de `AppErrorPayload { code, message }` şekline normalize edilir. Kod listesi (`src/lib/ipc/types.ts` → `APP_ERROR_CODES`) Rust `AppErrorCode` ile aynıdır:

`InvalidPath · PathEscape · SymlinkEscape · NotFound · PermissionDenied · BinaryFile · TooLarge · ConflictDetected · SaveFailed · WatcherFailed · Internal`

### Komutlar

| Komut | Amaç |
|---|---|
| `open_workspace` / `open_workspace_path` / `current_workspace` / `close_workspace` | Çalışma kökü yönetimi; `WorkspaceInfo { root, name, watcherError? }` |
| `list_workspace_dir`, `fs_list_dir`, `fs_index`, `fs_metadata` | Dizin listesi / özyinelemeli indeks (gizli+symlink atlanır, `truncated` ve atılma sayaçları raporlanır) |
| `fs_create_file`, `fs_create_folder`, `fs_rename_entry`, `fs_move`, `fs_delete_entry` | Ağaç işlemleri; var olan hedef asla ezilmez, silme Geri Dönüşüm Kutusu'na taşır |
| `fs_read_file` / `fs_read_document` | UTF-8 metin okuma; `fs_read_document` ikili ve aşırı büyük dosyaları reddeder, `{ contents, hash }` döner |
| `fs_write_file_atomic` | Atomik kaydetme; `expectedHash` çakışma kontrolü, `SaveResult { hash }` döner |
| `take_startup_warnings` | Pencere açılmadan oluşan ölümcül olmayan hatalar (bozuk oturum dosyası) |
| `report_first_paint` | İlk boyama anı Rust tarafına bildirilir (perf log) |
| `app_close_window` | Kapatma onayından sonra pencereyi Rust tarafında yok eder; `destroy`/`close` ACL izni webview'e verilmez |

### Olaylar

- `fs:changed` — debounce edilmiş harici değişiklik paketi (`FsChangeKind: create | modify | remove`).
- `fs:watcher-error` — izleyici hatası (`WatcherFailed`); izleyici 3 denemeye kadar linear backoff ile yeniden kurulur.

## Path güvenliği (confinement)

Tek kapı: `src-tauri/src/paths.rs::resolve_in_root(root, requested)`. Her dosya sistemi komutu köke göreli istekle girer ve çıkışta kök içinde kanıtlanmış bir mutlak yol alır.

Savunmalar sırayla:

1. `..`, mutlak yollar, sürücü-bağıl (`C:notes`), UNC paylaşımları (`\\server\share`), cihaz/verbatim ad uzayları (`\\.\`, `\\?\`) dosya sistemine dokunulmadan reddedilir (`PathEscape`).
2. Kök `dunce::canonicalize` ile kanonikleştirilir; NTFS junction/symlink çözülür, Windows `\\?\` öneki temizlenir.
3. Her var olan bileşen `symlink_metadata` ile incelenir; bir reparse point (symlink **veya** junction — `FILE_ATTRIBUTE_REPARSE_POINT` bayrağı) çözülür ve kök içinde kalmak zorundadır; sarkan (dangling) link hiçbir zaman kanıtlanamaz → `SymlinkEscape`.
4. Kapsama bileşen bileşen karşılaştırılır; Windows'ta ASCII küçük harfe katlanarak (`C:\Work` ≡ `c:\work`) ama `C:\Workshop` ile karışmadan.
5. Henüz var olmayan son bileşenler en derin doğrulanmış ata eklenir → yeni dosya/klasör oluşturma kaçış yolu açmadan çalışır.

Not: kontrol anlık bir görüntüdür (TOCTOU); çağıranlar `create_new` / rename-denenen-yeniden anlambilimiyle kapanışta hata verir.

## Atomik yazma

`src-tauri/src/fs/atomic.rs` — kaydetmeler hedef dosyaya asla doğrudan yazmaz:

1. Yeni içerik **aynı dizinde** (aynı disk birimi) `.{md-editor-save-<name>.<pid>.<seq>.tmp}` geçici dosyasına yazılır, `flush` + `sync_all` ile diske zorlanır.
2. Dosya kapatılır (Windows, açık handle'ı olan dosyayı rename etmeyi reddeder).
3. `fs::rename` ile hedefin üzerine yazılır.

Crash penceresi: rename öncesi çökerse eski dosya bayt-bayt-aynı kalır; rename sonrası çökerse tam yazılmış yeni dosya kalır. Okuyucular ara durum görmez.

**Windows kilitleme yeniden denemesi:** Antivirüs/arayıcı, geçici dosyayı veya hedefi açtığında `ERROR_SHARING_VIOLATION (32)`, `ERROR_LOCK_VIOLATION (33)` ya da `ERROR_ACCESS_DENIED (5)` alınır. Bunlar üstel geri çekilmeyle (varsayılan 3 deneme, 25 ms → 250 ms tavan) yeniden denenir; kalıcı kilitlemede `SharingViolation` hatası döner, eski içerik diskte sağlam kalır ve ön bellek temizlenir.

**Kaydetme çakışma kontrolü:** `fs_read_document` diskin ham baytlarının hash'ini döner; `fs_write_file_atomic` `expectedHash` verildiyse mevcut içerik diskte değişmişse `ConflictDetected` ile reddeder (`lib/editor/writeMine.ts`, `conflict.ts` akışındaki banner).

## Watcher deduplication

`src-tauri/src/watcher.rs` — `notify` kanonik kökü özyinelemeli izler; ham olaylar köke kapatılır ve 150 ms'lik pencerede yol başına toplanır, pencere başına tam bir `fs:changed` yayımlanır.

İki hash tabanlı sessizleştirme kuralı:

1. **Self-write echo:** Uygulamanın kendi yazıları `SelfWriteRegistry`'ye 2 saniye (TTL) kaydedilir. Olay anındaki içerik hash'i kayıtla eşleşirse olay kendi yankısıdır ve atlanır; aynı yol farklı hash ile gelirse gerçek harici değişikliktir.
2. **Son yayın hash'i:** Bir yol için daha önce yayımlanan hash ile aynı içerik tekrar yayımlanmaz (8 MiB üstü dosyalar hiç hashlenmez, olayları her zaman geçer).

Klasörün kendisi yazılmadıkça (uygulamanın kendi atomik rename'i gibi) sekme çakışma banner'ı tetiklenmez.

## Encoding / EOL korunumu

`src-tauri/src/fs/encoding.rs` — editör dekode edilmiş metin üzerinde çalışır; kaydetme sırasında disk formatı geri kazanılarak **bayt-kararlı round-trip** sağlanır:

- Öndeki UTF-8 BOM hatırlanır; yalnızca orijinalde BOM varsa geri yazılır.
- Baskın satır sonu tespit edilir (CRLF vs LF) ve aynen geri uygulanır; karışık dosyalar çoğunluğa normalleştirilir, beraberlik LF'e (editörün doğal bitişi) çözülür.

## Güvenlik duruşu

- **CSP** (`tauri.conf.json`): `default-src 'self'`, `connect-src 'self' ipc: http://ipc.localhost` — uygulama ağ istekleri yapamaz (`src/lib/offline.test.ts` bunu doğrular).
- **Önizleme sanitizasyonu:** markdown-it çıktısı DOMPurify ile temizlenir (`lib/preview/sanitize.test.ts`, `securityAudit.test.ts` XSS vektörlerini otomatik sınar).
- **Pencere yok etme:** `app_close_window` uygulama komutu olarak kalır; webview'e `close`/`destroy` ACL izni verilmez.
- **ACL scope:** `src-tauri/capabilities/default.json` minimum izin kümesini tutar.
