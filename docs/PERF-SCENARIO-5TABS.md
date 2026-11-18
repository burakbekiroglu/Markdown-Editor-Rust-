# 5 Sekmeli Ölçüm Senaryosu — Yeniden Üretilebilir Prosedür

Bu belge **yalnızca senaryo tanımını** kapsar: uygulamanın nasıl başlatılacağı, 5
belgenin hangi sırayla açılacağı, sekmeler arası geçişin sırası/sayısı ve ölçüm
anına kadar uygulanacak sabit ısınma/bekleme süreleri. Ölçüm komutu, tekrar
sayısı, baseline sayıları ve kabul eşikleri bu belgenin kapsamı dışındadır
(bkz. `docs/PERFORMANCE.md` §5). Uygulama kodunda değişiklik yapılmaz.

Prosedür, `scripts/measure-perf.mjs` içindeki mevcut yürütme yolunun
(`runProfile`, `writeSessionFile`, `measurementDocument`, `visitAllTabs`)
birebir tarifidir; böylece aynı adımlar hem koşucu tarafından hem elle
uygulanabilir.

## 0. Sabit değerler (doğrulanabilir)

| Ad | Sabit değer | Kaynak |
| --- | --- | --- |
| Release ikili | `src-tauri/target/release/md-editor.exe` | `measure-perf.mjs` `exe` |
| Pencere | 1100×750 (en az 640×480), başlık `Markdown Editor` | `src-tauri/src/lib.rs` |
| CDP hata ayıklama portu | `9337` | `DEBUG_PORT` |
| WebView2 ek bayraklar | `--remote-debugging-port=9337 --remote-allow-origins=*` | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` |
| WebView2 profil dizini | `.temp_files/perf-webview-profile-<pid>` (ölçüm oturumu başına benzersiz) | `webviewProfile` |
| Oturum dosyası | `%APPDATA%\com.mdeditor.app\session.json`, anahtar `session` | `src/lib/session/ipc.ts`, `session.rs` |
| Çalışma alanı kökü | `.temp_files/perf-workspace` | `workspace` |
| Belgeler | `not-01.md` … `not-05.md` (5 adet) | `writeWorkspaceFiles` |
| Belge boyutu | 31.685–31.693 bayt, her biri 595 satır (596 `split('\n')` parçası) | `measurementDocument` (aşağıdaki tablo) |
| Sekme sayısı | **5** | `--tabs 5` |
| Sekme ziyareti | **5** (her sekme tam 1 kez, artan sırayla) | `visitAllTabs` |
| Sekme ziyareti anahtarı | `--visit-tabs` (yoksa adım 7 hiç çalışmaz → senaryo geçersiz) | `VISIT_TABS` |
| Sekme başına yerleşme beklemesi | **300 ms** (sabit) | `visitAllTabs` |
| Isınma beklemesi | **2500 ms** (sabit, hareketsiz) | `runProfile` |
| İlk boya yoklama sınırı | 25.000 ms, 20 ms aralık | `openSession` |
| Sekme listesi yoklama sınırı | 25.000 ms, 50 ms aralık | `waitForTabs` |
| Sekme etkinleşme sınırı | sekme başına **8.000 ms**, 50 ms aralık; adım bütçesi 5.000 + 21.000×N ms | `visitAllTabs`, `runProfile` |
| CDP portu temizlenme sınırı | 10.000 ms, 150 ms aralık | `waitForCleanPort` |
| Başlatma öncesi sessizlik | **300 ms** | `runProfile` |
| Kapatma sonrası sessizlik | **800 ms** | `runProfile` |
| Kabul edilen origin'ler | `http://tauri.localhost`, `http://ipc.localhost`, `http://asset.localhost`, `http://mdasset.localhost` | `LOCAL_ORIGINS` |

`not-0N.md` içerikleri deterministiktir; aynı koşuda bayt sayısı ve SHA-256
sabittir:

| Dosya | Bayt | `split('\n')` parçası | SHA-256 |
| --- | --- | --- | --- |
| `not-01.md` | 31.685 | 596 | `0d63c548637d171e647fa861b2b65b3b548751057806fdf7bd48f14106cffcd6` |
| `not-02.md` | 31.686 | 596 | `5a4d47ee46c89e7a7d0ed9a9359751b55c8d99177d86039386c5401827f383e3` |
| `not-03.md` | 31.689 | 596 | `d6d3b85870938ede617c512a0a2fac5554a64ad59811cc92b67a666bfcbecffa` |
| `not-04.md` | 31.691 | 596 | `ebf2902eb1024892484b0103d70276533ef88ba0f6026566057ed3cf133bc941` |
| `not-05.md` | 31.693 | 596 | `30d6315118907e8cd0b97c9fe1dafd77afefa777a392cae344c2b8df656bba10` |

> SHA'lar `measurementDocument(index)` fonksiyonunun birebir kopyası Node ile
> çalıştırılarak üretildi; koşucu içeriği değiştirirse bu tablo güncellenmelidir.

Doğrulama (PowerShell, yalnızca okuma — dosyalar adım 2'de yazıldıktan sonra):

```powershell
Get-ChildItem .temp_files\perf-workspace\not-*.md | Sort-Object Name |
  ForEach-Object { "$($_.Name) $($_.Length) " + (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() }
```

Çıktı, yukarıdaki tablonun beş satırıyla bayt bayt ve SHA-256 bazında
eşleşmelidir; eşleşmiyorsa senaryo geçersizdir (§4).

## 1. Ön koşullar

- **P1 — Yalıtım.** Makinede başka bir `md-editor.exe` veya bu uygulamaya ait
  `msedgewebview2.exe` süreci çalışmıyor olmalı. Koşucu her profilde önce
  `cleanupAll()` çağırır; senaryo **serileştirilir** (aynı anda tek ölçüm).
- **P2 — Güncel release ikili.** `dist/` gömülü olmalı:
  `npm run build` → `cargo build --release --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml`.
  Doğrulama: `src-tauri/target/release/md-editor.exe` var **ve** açılışta yüklenen
  sayfa `localhost:1420` değil. (Geliştirme sunucusu URL'si görülürse senaryo
  geçersizdir; ikili yanlış derlenmiştir.)

  **Repo'daki çalıştırma yöntemi.** Ölçüm, yayınlanmış ikiliyi **doğrudan
  başlatır** (adım 4); `npm run tauri:build` aynı ikiliyi üretir
  (`beforeBuildCommand: npm run build` + release derlemesi,
  `src-tauri/tauri.conf.json`). `npm run dev`, `npm run tauri:dev` ve
  `npm run preview` bu senaryo için **geçersizdir**: `devUrl`
  `http://localhost:1420`'e bağlanırlar ve ölçülen şey paketlenmiş uygulama
  olmaktan çıkar.

- **P3 — Kullanıcı oturumu korunur.** Gerçek `session.json` yedeklenir; adım 3
  geçici olarak üzerine yazar. Kökü `.temp_files/perf-workspace` olan bir oturum
  gerçek kullanıcı durumu sayılmaz (kesintiye uğramış önceki koşudan kalmıştır).
- **P4 — Etkileşimsizlik.** Başlatmadan sonra pencereye klavye/fare ile
  dokunulmaz; tek etkileşim adım 7'deki programatik sekme tıklamalarıdır.

## 2. Adım listesi

1. **Temizlik ve sessiz ortam.** Tüm `md-editor` süreçlerini ve komut satırında
   `com.mdeditor.app` veya `perf-webview-profile` geçen `msedgewebview2.exe`
   süreçlerini sonlandır. `http://127.0.0.1:9337/json/version` yanıt vermeyi
   bırakana kadar bekle (üst sınır 10.000 ms, 150 ms aralık). Ardından **300 ms**
   sessizlik.
2. **Çalışma alanını kur.** `.temp_files/perf-workspace` dizinini tamamen sil ve
   yeniden oluştur. İçine **yalnızca** `not-01.md` … `not-05.md` dosyalarını,
   `measurementDocument(1..5)` içeriğiyle yaz (45 bölüm; her bölümde sabit
   paragraf iki kez + 4 maddelik liste; %4 == 0 olan bölümlerde tablo; %4 == 2
   olan bölümlerde `js` kod bloğu). Doğrula: dosya sayısı 5, bayt sayıları ve
   SHA-256 değerleri §0 tablosuyla eşleşiyor.
3. **Oturum dosyasını yaz.** `%APPDATA%\com.mdeditor.app\session.json` içine
   `tauri-plugin-store` sarmalıyla `{"session": { … }}` yaz:
   - `version`: `1`
   - `root`: `.temp_files/perf-workspace` mutlak yolu, `/` ayraçlı
   - `tabs`: **sırayla** `not-01.md`, `not-02.md`, `not-03.md`, `not-04.md`,
     `not-05.md` (`cursor: null`, `scroll: null`)
   - `activePath`: `not-01.md`
   - `viewMode`: `split`, `splitRatio`: `0.5`, `sidebarWidth`: `250`

   Doğrula: JSON parse ediliyor ve `session.tabs.length === 5`
   (sarmal unutulursa uygulama 0 sekme açar ve senaryo sessizce geçersizleşir).
4. **Başlat.** Tek örnek kilidini bekle: başka bir `md-editor.exe` süreci
   kalmadığını doğrula (üst sınır 15.000 ms, 500 ms aralık; süreç varsa
   başlatma pencere açmadan çıkar → senaryo geçersiz). `launchedAt` zaman
   damgasını **spawn'dan hemen önce** al. İkiliyi argümansız başlat; ortam
   değişkenleri:
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9337 --remote-allow-origins=*"`,
   `WEBVIEW2_USER_DATA_FOLDER=.temp_files/perf-webview-profile-<pid>`.
   Tek pencere açılır (1100×750, `Markdown Editor`).
5. **İlk boyayı bekle.** CDP'de `type == "page"` hedefine bağlan; sayfada
   `fcp > 0` olana kadar yokla (üst sınır 25.000 ms, 20 ms aralık). `href`
   `localhost:1420` içeriyorsa **dur** (P2 ihlali).
6. **Sekme listesini bekle.** `document.querySelectorAll('[data-tab-id]').length >= 5`
   olana kadar yokla (üst sınır 25.000 ms, 50 ms aralık). 5'e ulaşmazsa senaryo
   geçersizdir.
7. **Sekmeleri sırayla ziyaret et — tam 5 geçiş.** `[data-tab-id]` düğümlerinin
   kimliklerini DOM sırasıyla oku; DOM sırası oturum sırasıyla aynıdır
   (`not-01.md` → `not-05.md`). Kimlik değerleri uygulamanın ürettiği
   değerlerdir (taze açılışta `tab-1` … `tab-5`); sabit varsayılmaz, DOM'dan
   okunur. Her sekme için:
   1. `[data-tab-id="<id>"]` düğümüne gerçek bir `click()` gönder;
   2. etkinlik ve yüklemeyi doğrula: `.editor-pane[data-tab] == <id>`,
      `.editor-pane .cm-content` metin uzunluğu > 0, `.preview-pane` iç HTML
      uzunluğu > 0 (sekmeye özgü üst sınır **8.000 ms**, 50 ms aralık);
   3. **300 ms** sabit yerleşme beklemesi (önizleme 120 ms debounce + vurgulama).

   Sıra ve sayı değişmez: 1, 2, 3, 4, 5 — her biri bir kez. Geri dönüş veya
   tekrar tıklama yoktur.
8. **Isınma beklemesi.** Son (5.) sekmenin 300 ms yerleşmesi bittikten sonra
   **2500 ms** boyunca hiçbir etkileşim/komut gönderme; yerleşim, derleme ve
   debounce işlerinin bitmesini bekle.
9. **Ölçüm anı.** Ölçüm, 5. sekmenin yerleşmesi + 2500 ms dolduğu anda başlar;
   yani `t_ölçüm = t5 + 300 ms + 2500 ms` (`t5` = 5. sekmenin adım 7.2
   doğrulamasını geçtiği an). Bu andan sonra ne ölçüleceği bu belgenin kapsamı
   dışındadır.
10. **Kapat ve geri yükle.** Pencereyi kapat; `800 ms` sessizlikten sonra
    P3'te yedeklenen gerçek `session.json`'ı geri koy. Kalibrasyon oturumu ise
    geri konmaz, silinir.

## 3. Soğuk / sıcak ayrımı

- **Soğuk koşu:** WebView2 profil dizini (`.temp_files/perf-webview-profile-<pid>`)
  başlatmadan önce silinir → WebView2 ilk kurulum yolu izlenir.
- **Sıcak koşu:** Aynı ölçüm oturumu içinde profil dizini korunur. İlk açılış
  ölçülmez; aynı adımlarla (1–8) bir **ısınma koşusu** yapılır, ardından
  ölçülecek koşu aynı profil dizininde tekrarlanır. Profil dizini her ölçüm
  oturumunda (süreç başına) benzersizdir; böylece kilitleme ve artık süreç
  sorunları senaryoya sızmaz.
- 5 sekmeli senaryo, sekme başına kalıcı belleğin (CodeMirror belgesi + sözdizimi
  ağacı) gerçekten ölçülmesi için **sekme ziyaretlerini atlamaz**; yalnızca
  oturum geri yüklemesiyle yetinmek 4 sekmenin arabelleğini yüklemeden "5 sekme"
  raporlar.

## 4. Geçersizlik koşulları (senaryo reddedilir, ölçüm alınmaz)

- Açılış sayfası `localhost:1420` (geliştirme sunucusu) — ikili `dist/` gömülü değil.
- `data-tab-id` sayısı 5'in altında veya 25 s içinde 5'e ulaşmadı.
- Sekme ziyaretleri etkin değil (`--visit-tabs` verilmemiş): 5 sekme hiç
  ziyaret edilmez, sekme başına arabellek ölçülmez.
- Herhangi bir sekmede etkinlik doğrulanamadı, editör arabelleği boş
  (`docChars == 0`) veya önizleme HTML'i boş (`previewHtml == 0`).
- CDP portu 9337 10 s içinde boşalmadı ya da birden fazla `md-editor` süreci var.
- `not-0N.md` bayt/SHA değerleri §0 tablosuyla eşleşmiyor (içerik değişmiş).
- Ölçüm anından önce pencereye kullanıcı etkileşimi (tuş/fare) yapıldı.

## 5. Bu belgenin doğrulanması

- Sabit değerler `scripts/measure-perf.mjs` (`exe`, `DEBUG_PORT`, `openSession`,
  `waitForTabs`, `visitAllTabs`, `runProfile`, `writeSessionFile`,
  `measurementDocument`, `LOCAL_ORIGINS`, `VISIT_TABS`), `src-tauri/src/lib.rs`
  (pencere boyutu/başlık), `src/lib/session/ipc.ts` (store yolu/anahtarı),
  `src/lib/session/schema.ts` + `src/lib/tree/tabsStore.svelte.ts` (sekme
  kimliği `tab-<n>`) ve `src-tauri/tauri.conf.json` (identifier) dosyalarından
  okundu.
- Belge boyutları/SHA'lar, `measurementDocument` mantığı birebir Node ile
  çalıştırılarak üretildi; 5 dosya 31.685–31.693 bayt / 595 satır (596
  `split('\n')` parçası) çıktı ve `.temp_files/perf-workspace` içindeki gerçek
  koşucu çıktılarıyla bayt-bayt eşleşti.
- Uygulama kodu ve bağımlılıklar değiştirilmedi.
