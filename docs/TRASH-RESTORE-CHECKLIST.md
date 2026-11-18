# Geri Dönüşüm Kutusu — Manuel Doğrulama Kontrol Listesi

> Kapsam: yalnızca **silme** akışı (`fs_delete_entry` → `trash::delete`). Taşıma
> ve yeniden adlandırma bu listenin dışındadır.
>
> Otomatik testler bu davranışın bir kısmını kapsar
> (`src-tauri/src/fs_ops.rs` → `delete_*` testleri,
> `src-tauri/tests/fs_ops_conflicts.rs` → `ENTRY_EXISTS` çakışmaları,
> `src/lib/tree/treeStore.test.ts` → onay/ret sonrası ağaç durumu,
> `src/lib/tree/FileTree.test.ts` → onay/iptal/hata akışı). Gerçek Windows Geri
> Dönüşüm Kutusu'nu kullanan geri yükleme adımı yalnızca elle doğrulanabilir.

## 1. Otomatik ön kontrol

```powershell
npx vitest run src/lib/tree/treeStore.test.ts src/lib/tree/FileTree.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --test fs_ops_conflicts
cargo test --manifest-path src-tauri/Cargo.toml delete
```

Beklenen: onay diyaloğu, iptal (hiçbir fs çağrısı yok) ve hata (diyalog
"İşleniyor…" durumunda kilitlenmez) senaryoları geçer; `delete_entry_at`
testleri öğenin çalışma alanından kalktığını doğrular; `ENTRY_EXISTS`
testleri hedef mevcutken kaynağın ve hedefin bozulmadığını doğrular.

## 2. Gerçek Geri Dönüşüm Kutusu'ndan geri yükleme

Aşağıdaki komut **gerçek** Geri Dönüşüm Kutusu'nu kullanır ve yalnızca kendi
oluşturduğu geçici öğeyi geri yükler; bu yüzden varsayılan olarak `#[ignore]`
işaretlidir:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test trash_restore -- --ignored --nocapture
```

Beklenen: `deleted_entry_can_be_restored_from_the_recycle_bin` geçer — öğe
çalışma alanından kalkar, Geri Dönüşüm Kutusu'nda özgün yoluyla bulunur ve
geri yüklendiğinde içeriği bozulmadan eski yerine döner.

## 3. Uygulama üzerinden elle kontrol

1. `npm run tauri:dev` ile uygulamayı aç ve bir klasör seç.
2. Ağaçta bir `.md` dosyasına sağ tıkla → **Sil**. Onay diyaloğu açılmalı ve
   metin öğenin **Geri Dönüşüm Kutusu'na taşınacağını** söylemeli.
3. **Vazgeç** (veya `Esc`): dosya ağaçta ve diskte yerinde kalmalı; hiçbir dosya
   sistemi işlemi yapılmamalı (ağaç yeniden yüklenmez).
4. Tekrar **Sil** → onayla: dosya ağaçtan kalkmalı, "Öğe Geri Dönüşüm
   Kutusu'na taşındı." bildirimi görünmeli ve diyalog kapanmalı.
5. Windows Gezgin'i → **Geri Dönüşüm Kutusu**: öğe özgün adı ve yoluyla
   görünmeli. **Geri yükle** → dosya eski konumuna dönmeli.
6. Hata yolu: dosyayı başka bir programda kilitle (ör. açık tut) ve silmeyi
   dene. Hata bildirimi görünmeli; onay düğmesi "İşleniyor…" durumunda
   kilitlenmemeli, yeniden denenebilir olmalı.
7. Çalışma alanı kökünü silmeyi dene (mümkünse): işlem reddedilmeli
   (`fs_ops.rs` → `delete_entry_at` kök koruması).

## 4. Sonuç kaydı

| Adım | Beklenti | Sonuç | Tarih / not |
| --- | --- | --- | --- |
| 1 | Tüm otomatik testler geçer | ✅ Geçti | 2026-11-18 — `vitest` 14/14 (treeStore) + 11/11 (FileTree); `cargo test --test fs_ops_conflicts` 11/11; `cargo test delete` 4 lib + 3 entegrasyon testi |
| 2 | `--ignored` geri yükleme testi geçer | ✅ Geçti | 2026-11-18 — gerçek Geri Dönüşüm Kutusu'na silindi, listede özgün yoluyla bulundu, geri yüklendi; içerik bozulmadı |
| 3 | İptalde fs işlemi yok | ✅ Otomatik doğrulandı | `FileTree.test.ts` → "onay diyaloğu iptal edilirse hiçbir dosya sistemi işlemi yapılmaz" |
| 4 | Onayda öğe çöp kutusuna gider | ✅ Otomatik doğrulandı | `treeStore.test.ts` (tek `deleteEntry` çağrısı, ağaçtan düşer) + `FileTree.test.ts`; gerçek çöp kutusu karşılığı satır 2 |
| 5 | Çöp kutusundan geri yükleme çalışır | ✅ Otomatik doğrulandı | Satır 2'deki `--ignored` testi; ayrıca Windows Gezgin'i üzerinden insan turu yapılmadı |
| 6 | Hatada promise sonlanır, diyalog kilitlenmez | ✅ Otomatik doğrulandı | `FileTree.test.ts` → "silme reddedilirse hata bildirilir ve diyalog işleniyor durumunda kilitlenmez" |

> Not: 2026-11-18 tarihli sonuçlar otomatik test çalıştırmalarına dayanır. Uygulama
> üzerinden (3. bölüm, adım 1–7) ve Windows Gezgin'i ile yapılan insan turu bu
> ortamda yürütülmedi; elle yapıldığında tabloya ayrıca işlenmelidir.
