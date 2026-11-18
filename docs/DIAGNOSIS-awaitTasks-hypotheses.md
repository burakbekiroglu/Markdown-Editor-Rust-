# Teşhis Notu — `awaitTasks timed out`: üç hipotezin değerlendirilmesi

> **Salt teşhis.** Bu turda hiçbir kaynak dosya düzenlenmedi, hiçbir test/derleme
> komutu çalıştırılmadı ve hiçbir düzeltme uygulanmadı. Amaç üç aday kök nedeni
> kanıtlamak/ elemek ve mümkünse deterministik yeniden üretim adımlarını yazmak.
>
> **Girdi:** iki önceki alt görevin bulguları — (1) yıkıcı işlemlerin uçtan uca
> akış haritası, (2) onay diyaloğu / üzerine yazma / Recycle Bin entegrasyon
> eksikleri — `docs/DIAGNOSIS-destructive-ops.md` §1 ve §2'de birleştirilmiş
> hâlde. Bu notta o bulgular **güncel kaynağa karşı yeniden okundu**; satır
> referansları bu turda üretildi.
>
> **Kanıt düzeyi:** `[DO]` bu turda kaynak okundu · `[ÇI]` depo dışı
> crate/runtime davranışı (okunmadı) · `[Hİ]` doğrulanmadı.
>
> **Yöntem sınırı:** `src/` ve `src-tauri/src/` okundu. Tauri'nin sync komutları
> hangi thread'de koştuğu, `tauri-plugin-dialog`'un `pick_folder` geri çağrısını
> hangi koşulda hiç çağırmadığı ve bekleyen görevleri izleyen katmanın zaman
> aşımı süresi **depo dışıdır** ve bu turda ölçülmedi — bunlar `[ÇI]`.
> `awaitTasks` metni depoda **yok** `[DO]`: repo genelinde arama yalnız bu notu
> ve `fs_ops.rs:598`'deki yorumu bulur. Yani mesaj dış koşum katmanından gelir;
> zaman aşımı süresi oradan okunmalıdır.

## 0. Sonuç tablosu

| # | Hipotez | Karar | Çekirdek kanıt |
| --- | --- | --- | --- |
| A | İptal edilmeyen / await edilmeyen (fire-and-forget) promise | **ELENDİ** | `FileTree.svelte:299-322`, `ConfirmDialog.svelte:25-33`, `treeStore.svelte.ts:181-192` `[DO]` |
| B | Hiç sonuçlanmayan I/O veya event nedeniyle bloklanmış `await` | **DOĞRULANDI (kök neden sınıfı)** | `workspace_commands.rs:88-102`, `fs_ops.rs:602-611,613-618,620-658` `[DO]` |
| C | UI onayı/dialog bekleyen deadlock | **ELENDİ** (kök neden olarak) | `ConfirmDialog.svelte:25-33,48,54-56`, `FileTree.svelte:450-458`, `workspace_commands.rs:100-112,146` `[DO]` |
| — | **Tek en olası kök neden** | **B1 — `open_workspace` kanalı** | §4 |

## 1. Hipotez A — fire-and-forget / sahipsiz promise: **ELENDİ**

**İddia:** Bir promise await edilmeden bırakılıyor veya iptal edilmediği için
askıda kalıyor; bekleyen görev izleyicisi bu yüzden zaman aşımına düşüyor.

**Kanıt (yıkıcı işlem zinciri, uçtan uca):**

- `FileTree.svelte:299-322` — `confirmDelete`: `await store.remove(...)`
  (`:310`), hata dalı `:311-318`, `finally { busy = false }` `:319-321`.
  Sözleşme yorumu `:292-298` açıkça "dönen promise her koşulda çözülür
  (reddetmez)" diyor. `[DO]`
- `ConfirmDialog.svelte:25-33` — `confirm()`: `busy` kilidi `:26-27`,
  `await onConfirm()` `:29`, `finally` ile bırakma `:30-32`. Sahipsiz bırakılan
  bir çağrı yok; `onclick={confirm}` `:53` tek giriş. `[DO]`
- `treeStore.svelte.ts:181-192` — `remove()`: `await deleteEntry` `:183`,
  `catch` içinde toast + `false` `:188-190`. **Reddetmez**, dolayısıyla
  `confirmDelete`'in `catch`'i bile normalde çalışmaz. `[DO]`
- `ipc/client.ts` — `createInvokeCommand`: `try/await transport` + `catch`'te
  `normalizeAppError` fırlatır. Yani her IPC çağrısı ya çözülür ya reddedilir;
  "sessizce askıda kalan" bir sarmalayıcı yolu yok. `[DO]`

**Fire-and-forget çağrı yerleri (gerçekten var, ama zararsız):** `App.svelte:103`
(`reportStartupWarnings`), `:110` (`restoreSession`), `:114`
(`sessionPersister.flush`), `:127-132` (`subscribeAppCloseRequested` +
`.catch`), `:256-260` (`loadEditorPane` + `.catch`), `:282-294`
(`subscribeWorkspaceWatch` + `.catch`), `:284` (`applyExternalChanges`). Hiçbiri
silme/taşıma diyaloğunun `busy` durumunu tutmaz ve hepsi hata yolunu ya kendi
içinde ya `.catch` ile kapatır. `[DO]`

**Eleme gerekçesi (mantıksal):** Sahipsiz bir promise'in *hiçbir* bekleyicisi
yoktur; bu yüzden belirti "sessiz hiçbir şey olmuyor" olur, "diyalog
'İşleniyor…' durumunda kilitli + bekleyen görev zaman aşımı" olmaz. Gözlenen
belirti bir `await`'in çözülmemesini gerektirir; A sınıfı bunu üretemez.

**Elendiği koşulun tersi (A'yı geri getirecek kanıt):** Askıda kalan görevin
yığın dökümü `App.svelte:103/110/114/284` satırlarından birini gösterirse **ve**
arayüz donmuş değilse (yalnız sessiz atlama varsa) A yeniden açılır.

## 2. Hipotez B — sonuçlanmayan I/O/event üzerinde bloklanmış `await`: **DOĞRULANDI**

### B1 — `open_workspace` kanalı: sınırsız `recv().await` (birincil)

`workspace_commands.rs:82-112`:

- `tauri::async_runtime::channel(1)` `:88`
- `pick_folder` geri çağrısı `blocking_send` ile gönderiyor `:92-98`; kanal
  kapalıysa hata **yalnız `eprintln!`** `:96` — komuta iletilmiyor.
- `receiver.recv().await` `:100` — **timeout yok, iptal tokeni yok, `select!`
  yok**. `[DO]`
- Geri çağrı hiç gelmezse (diyalog barındırıcısı işi zamanlayamazsa, ana thread
  başka bir senkron komutla bloke ise, pencere/dialog sahibi çökerse) kanal
  kapanmaz → future **sonsuza kadar** bekler → `invoke('open_workspace')`
  hiç settle olmaz → `picking` `App.svelte:335-347` içinde `true` kalır ve
  "Klasör aç" düğmesi `disabled={picking}` (`:447`) kilitlenir. `[DO]` (depo
  tarafı) + `[ÇI]` (hangi geri çağrı arızasının oluştuğu ölçülmedi)

### B2 — senkron `fs_move` / `fs_rename_entry`: ana thread'i sınırsız geciktiren amplifikatör

`fs_ops.rs:566-589` — iki komut da **senkron** (`fs_rename_entry` `:567`,
`fs_move` `:577`); `rename_no_overwrite` → `MoveFileExW` (`:302-376`).
Depo kendi yorumunda senkron `#[tauri::command]` gövdesinin ana thread'de satır
içi koştuğunu yazıyor (`fs_ops.rs:591-601`). Çok büyük klasörde taşıma ana
thread'i saniyeler/dakikalar boyunca tutarsa **hem** diyalog geri çağrısı
gecikir **hem** tüm IPC gecikir; bu bir kilitlenme değil, sınırsız gecikmedir ve
B1'i tetikleyen/derinleştiren koşuldur. `[DO]` (senkronluk) + `[ÇI]` (süre
ölçülmedi)

### B3 — silme ayağı bugün yapısal olarak kapalı

`fs_ops.rs:602-611` `fs_delete_entry` **async** + `spawn_blocking` (`:608`) +
`JoinError` → `Internal` (`:610`); iç içe `delete_entry_at_bounded`
(`:613-618`) + `DELETE_TIMEOUT = 60 sn` (`:620-626`) + `run_blocking_bounded`
`:628-658` (`recv_timeout` `:649`; başarı `:650`, timeout `:651-653`,
`Disconnected` `:654-656`). Her yol settle eder. `[DO]`

**Eleme/geri açma koşulu:** Devtools'ta `open_workspace` çağrısının başarılı
senaryoda < 1 sn'de çözüldüğü ve arızalı koşumda askıda kalan görevin **başka**
bir komuta ait olduğu gösterilirse B1 elenir. B3 için: 60 sn sonra tipli hata
gelmiyorsa (yani `fs_delete_entry` hâlâ askıdaysa) eski tek katmanlı düzeltme
ağaçta demektir — bu ağaçta öyle değil.

## 3. Hipotez C — UI onayı/dialog bekleyen deadlock: **ELENDİ**

**Kanıt:**

- `ConfirmDialog.svelte:25-33` — `confirm()` yalnız `onConfirm()`'i await eder;
  o da IPC'yi bekler. Kullanıcının "Sil/Vazgeç" kararı için **promise
  üretilmiyor**: diyalog `deleteTarget` durumundan koşullu render ediliyor
  (`FileTree.svelte:450-458`), karar bir *state* değişimi. Yani kimse
  kullanıcıyı await etmiyor → bu yol bir promise'i asla asamaz. `[DO]`
- Belirti deadlock'a benziyor ("İşleniyor…" `ConfirmDialog.svelte:56`, düğmeler
  `disabled={busy}` `:48,54`) ama kilit IPC'de, UI'da değil.
- Kapanış onayı da aynı: `handleCloseRequested` `App.svelte:376-382` yalnız
  `closePrompt` durumunu kurar; `destroyWindow` kullanıcı kararından sonra
  çağrılır (`:382`). Bekleyen promise yok. `[DO]`
- Döngüsel bekleme (klasik deadlock) yok: `transition_guard` diyalog beklerken
  **tutulmuyor**; yalnız `adopt_folder` içinde alınıyor
  (`workspace_commands.rs:146`) ve `adopt_folder` `recv()` çözüldükten sonra
  çağrılıyor (`:100-112`). Kural kendi yorumunda yazılı: "guard'ı await
  boyunca tutma". `[DO]`

**Sınıflandırma notu:** yerel **klasör seçici** gerçekten kullanıcı arayüzüne
bağlıdır, ama bu bir deadlock değil **sınırsız bekleme**dir; bu yüzden B1
altında değerlendirildi.

**Eleme koşulunun tersi (C'yi geri getirecek kanıt):** `transition_guard`
veya başka bir mutex'in `await` boyunca tutulduğu bir yığın/kilit dökümü, ya da
diyalog kararını bekleyen bir promise (`new Promise(...)` ile kurulmuş) ortaya
çıkarsa C yeniden açılır. Bu ağaçta ikisi de yok `[DO]`.

## 4. Tek en olası kök neden

**B1 — `open_workspace` komutunun sınırsız `receiver.recv().await` beklemesi**
(`src-tauri/src/workspace_commands.rs:88-102`), kullanıcı akışı "Klasör aç"
(`src/App.svelte:447` → `pickFolder` `:334-348` → `src/lib/tree/ipc.ts:36` →
`invoke('open_workspace')`). Geri çağrı hiç gelmezse promise hiç settle olmaz;
"Klasör aç" düğmesi `picking` yüzünden kilitli kalır ve bekleyen görev izleyicisi
zaman aşımına düşer.

**Amplifikatör:** ana thread'de koşan senkron `fs_move` / `fs_rename_entry`
(`src-tauri/src/fs_ops.rs:566-589`) geri çağrının zamanlanmasını geciktirir.

**Kesinlik sınırı:** Askıda kalabileceği depo tarafında kanıtlandı `[DO]`;
bildirilen koşumda zaman aşımına düşen görevin **gerçekten** bu komut olduğu
ölçülmedi `[Hİ]`. Silme ayağının eski (tek katmanlı) hâli de aynı B sınıfındaydı
ve bu ağaçta kapalı olduğu için, bildirilen koşum düzeltmeden önceye aitse
tarihsel kök neden B sınıfının silme dalıdır.

## 5. Yeniden üretim adımları

> Depoda yapılandırılabilir bir zaman aşımı **yok** `[DO]`; mesaj dış koşum
> katmanından geliyor. Bu yüzden aşağıda "timeout süresi" olarak o katmanın
> değeri okunmalıdır; okunamıyorsa **her** değer tetikler çünkü await sınırsız.

### R1 — B1 (birincil) — `open_workspace` hiç settle olmuyor

1. Uygulamayı hata ayıklama derlemesinde aç, WebView Devtools konsolunu aç.
2. Konsolda ölçüm kancasını kur:
   `t0=performance.now(); window.__probe=window.__TAURI_INTERNALS__.invoke('open_workspace',{}).then(v=>console.log('settled',performance.now()-t0,v)).catch(e=>console.log('rejected',performance.now()-t0,e));`
3. **Tetikleyici:** Devtools açıkken "Klasör aç" düğmesine bas (`App.svelte:447`).
   Diyalog görünür olduğunda **Vazgeç**'e bas.
4. **Beklenen gözlem:** `settled ... null` satırı, iptalden sonra < 1 sn içinde.
   Bu satır hiç gelmiyorsa B1 doğrulanır.
5. **Amplifikatör varyantı (B2):** ~100k dosyalı bir klasörü ağaçta sürükle-bırak
   ile taşı (`applyMove` `FileTree.svelte:227-240` → senkron `fs_move`), taşıma
   sürerken aynı anda "Klasör aç"a bas. Ana thread bloke olduğu sürece diyalog
   açılmaz; `fs_move` dönene kadar `open_workspace` promise'i askıda kalır.
6. **Timeout süresi:** dış izleyicinin değeri (yoksa sınırsız). Ölçüm için
   `fs_move` süresini `Measure-Command` ile ayrıca kaydet; askıda kalma süresi en
   az bu süre kadar olmalı.
7. **Determinizm:** adım 4 tek başına deterministik; adım 5'in süresi donanıma
   bağlı (yüksek ama %100 değil).

### R2 — B3 (silme ayağı, tarihsel) — yalnız düzeltme öncesi derlemede anlamlı

1. Geri Dönüşüm Kutusu'na taşınması 60 sn'den uzun süren bir klasör seç
   (çok sayıda küçük dosya).
2. Ağaçta sağ tık → **Sil** (`FileTree.svelte:113`) → onayla (`:450-458`).
3. **Beklenen gözlem (güncel ağaçta):** 60 sn sonra `Internal` tipli hata toast'ı
   ("Geri Dönüşüm Kutusu işlemi 60s içinde tamamlanmadı",
   `fs_ops.rs:651-653`), diyalog "İşleniyor…"dan çıkar.
4. **Zaman aşımı süresi: 60 sn** (`DELETE_TIMEOUT`, `fs_ops.rs:620-626`).
   Eski derlemede bu adım tipli hata yerine süresiz "İşleniyor…" verir.

### R3 — A ve C'yi yanlışlayan kontrol testleri (deterministik)

- **C kontrolü:** Silme onay diyaloğunu aç ve **hiç yanıt verme**. Beklenen:
  hiçbir promise askıda olmadığı için zaman aşımı **oluşmaz**; diyalog süresiz
  açık kalır, uygulamanın geri kalanı çalışır. Zaman aşımı oluşuyorsa C elenemez.
- **A kontrolü:** Normal boyutlu bir dosyayı sil. Beklenen: diyalog kapanır,
  toast "Öğe Geri Dönüşüm Kutusu'na taşındı." (`treeStore.svelte.ts:186`),
  `busy` bırakılır (`ConfirmDialog.svelte:30-32`, `FileTree.svelte:319-321`).
  Diyalog "İşleniyor…"da kalıyorsa sahipsiz promise değil, bloklanmış await
  vardır — A değil B.

## 6. Bu notun sınırları

- Uygulama çalıştırılmadı; `cargo`, `vitest` ve tarayıcı/E2E koşulmadı. Tüm
  kararlar kaynak okumasına dayanır; §5'teki adımlar **önerilen** yineleme
  yollarıdır, bu turda yürütülmedi.
- Tauri'nin sync komut thread'i, `tauri-plugin-dialog`'un geri çağrı garantisi
  ve dış bekleyen-görev izleyicisinin zaman aşımı `[ÇI]` kaldı.
- Hangi komutun gerçekten askıda kaldığı ölçülmedi; §4 bu yüzden "en olası"
  diyor, "kanıtlanmış" demiyor.
