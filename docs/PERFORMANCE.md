# Performans ve Paket Bütçesi

Bu belge, hafif Windows Markdown editörünün (Tauri v2 + Svelte 5 + CodeMirror 6)
paket bütçesi, açılış ilk boyası, bellek (RSS) ve açılış ağ davranışının
ölçüldüğü koşulları ve ham sonuçları kaydeder. Sayılar, aşağıda yazılı makine ve
derleme üzerinde alınmıştır; farklı donanımda tekrar üretilebilir ama birebir
aynı çıkmaz.

- **Ölçüm tarihi:** 2026-11-18
- **Platform:** Windows, `win32 x64`
- **Araç zinciri:** Node.js `v24.19.0`, npm `11.17.0`, cargo/rustc `1.99.1`
- **Derleme profili:** release (frontend `dist/` çıktısı Tauri ikilisine gömülü)
- **Ön yüz derlemesi:** `npx vite build` (vite `8.3.8`, `build.manifest: true`)
- **Release ikilisi:** `src-tauri/target/release/md-editor.exe`

## Bütçe özeti

| Ölçüm | Eşik | Ölçülen (medyan) | Sonuç |
| --- | --- | --- | --- |
| Başlangıç (entry) JS chunk, gzip | ≤ 250 KB | **42.6 KB** | geçti |
| İlk yüklenen JS toplamı, gzip | ≤ 320 KB | **310.1 KB** | geçti |
| Tembel önizleme chunk, gzip | ≤ 160 KB | **53.8 KB** (`PreviewPane`) | geçti |
| Süreç başlangıcı → ilk boya (FCP), sıcak | ≤ 900 ms hedef | **399 ms** (5 koşu medyanı) | geçti |
| Soğuk açılış (WebView2 ilk kurulum), FCP | ≤ 3 s | **447 ms** | geçti |
| Boşta CPU (süreç ağacı, 5 s pencere) | ≈ 0 (≤ %1 makine) | **%0.039 makine** | geçti |
| `app:first-paint` performance mark (sayfa) | bilgi | **115 ms** | — |
| Rust `Instant` süreç süresi | bilgi | **347 ms** | — |
| RSS, boşta (0 sekme), özel çalışma seti | bilgi | **74.4 MiB** | — |
| RSS, 20 sekme açık, özel çalışma seti | bilgi | **91.2 MiB** (eski ham ölçüm 354.9 MiB) | — |
| Toplam çalışma seti, 5 sekme açık (indirgenmiş) | ≤ 150 MB | **144.0 MiB** medyan / **145.0 MiB** en yüksek (özel 105.0 MiB) | geçti |
| Kurulum paketi (NSIS, WebView2 hariç) | ≤ 12 MB | **2.69 MiB** | geçti |
| Açılışta dış ağ isteği | 0 | **0** | geçti |

> **Bütçe aşımı yok.** Önizleme ayrı bir tembel girişe taşındığından
> (`src/lib/preview/PreviewPane.svelte` → `EditorPane` içinden `import()`)
> tembel önizleme chunk'ı daha önce raporlanan 242.8 KB gzip'ten 53.8 KB'a
> düştü. Eşik değerleri ölçüme göre gevşetilmedi; editör (CodeMirror 6) ve
> önizleme (markdown-it + DOMPurify + highlight.js) artık ayrı chunk'larda.
> İlk yüklenen JS toplamı değişmedi (ikisi de açılışta yükleniyor), yalnızca
> iki ayrı istek olarak geliyor.
>
> **Not (yeniden ölçüm):** Ayrım sonrası aynı makinede tek koşuluk ölçümde
> süreç → FCP boşta **687 ms**, 5 sekmede **710 ms** (Rust `Instant` 403 ms)
> okundu. Hedef ≤ 900 ms hâlâ sağlanıyor; fark makine yükü/kapalı önbellekten
> kaynaklanıyor, sayfa içi FCP 148–164 ms bandında kaldı.

## 1. Paket bütçesi (chunk boyutları)

**Yöntem.** `vite.config.ts` içinde `build.manifest: true` açık olduğundan
`dist/.vite/manifest.json` her chunk'ı kaynak modülüne eşler. Ölçüm, dosya adı
tahmini yapmadan bu manifesti okur:

- **Başlangıç chunk'ları:** manifestte `isEntry` işaretli giriş + yalnızca statik
  `imports` zincirindeki paylaşılan (`_` ile başlayan) chunk'lar. Dinamik
  import'lar başlangıç yüküne katılmaz.
- **İlk yüklenen JS toplamı:** başlangıç zinciri + uygulama ilk sekmede hemen
  `import()` ettiği `EditorPane` dinamik girişi ve onun statik/dinamik import
  zinciri (highlight.js alt kümesi, opener eklentisi). Kullanıcı hiçbir şey
  yapmadan çalışma zamanına giren JS'in tamamıdır; eşik **≤ 320 KB gzip**.
- **Tembel önizleme chunk'ı:** `src/lib/preview/**` kaynaklı dinamik giriş; yoksa
  önizlemeyi içeren `EditorPane` dinamik girişi (yedek) — hangisinin ölçüldüğü
  çıktıda yazılır.
- Her chunk `zlib` seviye 9 ile gzip'lenir; toplam gzip baytı bütçeyle
  karşılaştırılır. Aşımda script `exit code 1` döndürür.

**Komut.**

```powershell
npx vite build
node scripts/check-bundle-budget.mjs        # npm run perf:bundle
```

**Ham çıktı (2026-11-18).**

```
=== başlangıç chunk'ları (statik) ===
  assets/index-D7GZXkSh.js  raw 125.0 KB  gzip 42.1 KB
  assets/rolldown-runtime-XKyaHtl9.js  raw 0.7 KB  gzip 0.4 KB
  toplam gzip 42.6 KB / bütçe 250 KB
=== ilk yüklenen JS (başlangıç + hemen açılan editör) ===
  ...
  assets/EditorPane-B4LxhZh5.js  raw 555.6 KB  gzip 189.7 KB
  assets/PreviewPane-BtPm0l1o.js  raw 131.3 KB  gzip 53.8 KB
  toplam gzip 310.1 KB / bütçe 320 KB
=== tembel önizleme chunk'ı ===
  assets/PreviewPane-BtPm0l1o.js  raw 131.3 KB  gzip 53.8 KB / bütçe 160 KB
=== sonuç ===
  başlangıç: uygun (42.6 KB gzip)
  ilk yük JS toplamı: uygun (310.1 KB gzip)
  önizleme (assets/PreviewPane-BtPm0l1o.js): uygun (53.8 KB gzip)
```

**Değerlendirme.**

- Başlangıç yükü bütçenin çok altında (42.6 / 250 KB). Ağır CodeMirror,
  markdown-it, DOMPurify ve highlight.js paketleri gerçekten dinamik chunk'ta
  kalıyor; `src/lib/perf/startup-budget.test.ts` bunu statik import grafiği
  üzerinden ayrıca koruyor.
- Önizleme artık `src/lib/preview/PreviewPane.svelte` üzerinden ayrı bir
  `import()` girişi: kendi chunk'ı 131.3 KB ham / **53.8 KB gzip** ve bütçenin
  (160 KB) çok altında. Editörün (`EditorPane`) chunk'ı 555.6 KB ham /
  189.7 KB gzip'e indi.
- `SOURCE_LINE_ATTR` sabiti `src/lib/preview/sourceLine.ts` içine taşındı:
  `EditorPane` yalnızca bu sabiti statik import ettiği için markdown-it ve
  DOMPurify editör chunk'ına geri sızmıyor (`markdown.ts` sabiti yeniden
  dışa aktarır).
- İlk yüklenen JS toplamı 310.1 KB gzip; 320 KB bütçesinin altında ve
  önizleme ayrımından önceki 309.4 KB ile aynı mertebede (iki chunk da ilk
  sekmede yükleniyor, sadece ayrı istekler).

**Yeniden doğrulama (aynı gün, `npx vite build` + `npm run perf:bundle`).**
Başlangıç chunk'ı **42.7 KB**, ilk yüklenen JS toplamı **310.4 KB**, tembel
önizleme **53.8 KB** gzip; `exit code 0` (tüm eşikler uygun). Chunk hash'leri
derleme başına değişir (`index-B6CmcUkv.js`, `EditorPane-D5L_eoyl.js`,
`PreviewPane-BOA_IVf-.js`). `npx vitest run src/lib/perf/startup-budget.test.ts`
→ 7/7 test geçti.

## 2. İlk boya (performance mark + Rust `Instant`)

**Enstrümantasyon.**

- `src/main.ts`: üretim derlemesinde iki `requestAnimationFrame` sonrası
  `reportFirstPaint()` çağrılır.
- `src/lib/perf/firstPaint.ts`: `performance.mark('app:first-paint')` koyar ve
  `report_first_paint` IPC komutunu çağırır; dönen süreç süresini
  `app:first-paint:rust` mark'ı olarak zaman çizelgesine yazar.
- `src-tauri/src/perf.rs`: süreç başlangıcı `OnceLock<Instant>` ile bir kez
  kaydedilir; `report_first_paint` `Instant::elapsed` ile geçen süreyi hesaplar,
  loglar ve milisaniye döndürür.

**Yöntem.** Ölçüm koşucusu (`scripts/measure-perf.mjs`) release ikilisini
WebView2 ile başlatır, CDP (`--remote-debugging-port`) üzerinden
`performance.getEntriesByType('paint')` ve `app:first-paint*` mark'larını okur;
"başlangıç" olarak süreç `spawn` anını kullanır. Sayfa içi süreler
`performance.now()` tabanlıdır, süreç süresi `launchedAt` ile FCP anı arasındaki
farktan hesaplanır.

**Ham sonuç (3 koşu).**

| Profil | Koşu | Süreç → FCP | Sayfa FCP | `app:first-paint` mark | Rust `Instant` |
| --- | --- | --- | --- | --- | --- |
| boşta | #1 | 419 ms | 136 ms | 115 ms | 349 ms |
| boşta | #2 | 402 ms | 132 ms | 118 ms | 343 ms |
| boşta | #3 | 409 ms | 124 ms | 109 ms | 347 ms |
| 20 sekme | #1 | 412 ms | 124 ms | 119 ms | 368 ms |
| 20 sekme | #2 | 407 ms | 124 ms | 113 ms | 357 ms |
| 20 sekme | #3 | 447 ms | 140 ms | 126 ms | 388 ms |

**Medyan:** boşta süreç → FCP **409 ms** (Rust 347 ms), 20 sekmede **412 ms**
(Rust 368 ms). Hedef ≤ 900 ms; her iki profil de hedefin altında.

Not: 20 sekme profilinde ilk boya süresi neredeyse değişmiyor çünkü editör
içeriği ilk boyadan sonra, boşta zamanda yükleniyor; sekme sayısı ilk boyayı
değil, sonrasındaki yerleşimi ve belleği etkiliyor.

### 2b. Sıcak/soğuk başlatma ve boşta CPU (kabul kriteri)

**Komut.**

```powershell
npm run perf:startup        # 1 soğuk + 1 ısınma + 5 ardışık sıcak, boşta CPU
node scripts/measure-perf.mjs --startup --warm-runs 5 --gate-startup --json-out .temp_files/startup.json
```

**Yöntem.**

- **Soğuk açılış:** WebView2 kullanıcı profili (`.temp_files/perf-webview-profile`)
  silinir; ölçülen açılış WebView2 ilk kurulumunu içerir. Eşik ≤ 3000 ms.
- **Sıcak başlatma:** profil korunur, bir ısınma koşusu (ölçüme girmez) ardından
  **5 ardışık** başlatma ölçülür ve medyanı alınır. Eşik ≤ 900 ms.
- Süre, süreç `spawn` anından sayfanın `first-contentful-paint` anına kadardır
  (§2 ile aynı). Oturum dosyası yoktur (boş durum ekranı); oturum geri yükleme
  zaten ilk boyadan sonraya ertelenir.
- **Boşta CPU:** ilk boyadan 2.5 s sonra, 5 s'lik pencerede süreç ağacının
  (`md-editor` + WebView2 alt süreçleri) toplam CPU süresi iki örnek arasında
  ölçülür. Değer hem tek çekirdek yüzdesi hem **tüm makine kapasitesinin
  yüzdesi** olarak raporlanır (ikincisi Görev Yöneticisi'nin tanımıdır ve eşik
  onunla denetlenir: ≤ %1). Pencerenin ikinci yarısı (`kuyruk`) ayrı ölçülür:
  tekrar eden bir arka plan zamanlayıcısı kuyrukta görünür.
- `--gate-startup` eşiklerden biri aşılırsa `exit code 1` döndürür; dış ağ
  isteği de aynı koşuda denetlenir.

**Ham sonuç (2026-11-18, 16 mantıksal çekirdek, release ikili, `--gate-startup`).**

| Koşu | Süreç → FCP | Sayfa FCP | Rust `Instant` | Boşta CPU (makine) |
| --- | --- | --- | --- | --- |
| soğuk #1 (WebView2 ilk kurulum) | 447 ms | 144 ms | 340 ms | 0% |
| sıcak #1 | 384 ms | 116 ms | 324 ms | 0.039% |
| sıcak #2 | 426 ms | 132 ms | 358 ms | 0.039% |
| sıcak #3 | 396 ms | 120 ms | 331 ms | 0.019% |
| sıcak #4 | 399 ms | 120 ms | 337 ms | 0.059% |
| sıcak #5 | 413 ms | 128 ms | 346 ms | 0.039% |

- **5 sıcak başlatma medyanı: 399 ms** (eşik 900 ms) → geçti.
- **Soğuk açılış (WebView2 ilk kurulum dahil): 447 ms** (eşik 3000 ms) → geçti.
- **Boşta CPU medyanı: %0.039 makine** (tek çekirdeğin %0.63'ü; kuyruk medyanı
  %0; en yüksek %0.059) → eşik %1 makine, geçti.
- **Açılışta dış ağ isteği: 0.** Yüklenen kaynaklar yalnızca
  `tauri.localhost` (kabuk JS/CSS, favicon) ve `ipc.localhost`
  (`take_startup_warnings`, `current_workspace`, `report_first_paint`,
  `plugin:event|listen`, `plugin:store|load|get|set|save`).
- Açılışta yüklenen JS yalnızca kabuk chunk'larıdır (`index-*.js`,
  `rolldown-runtime-*.js`); `EditorPane`, `PreviewPane`, markdown-it, DOMPurify
  ve highlight.js chunk'ları istek listesinde **yoktur** — ilk sekme/önizleme
  açıldığında dinamik `import()` ile gelirler.

> İlk ölçüm turunda tek bir sıcak koşuda %36 (tek çekirdek) sıçrama görüldü;
> aynı turun diğer koşuları %0–3 bandındaydı ve kuyruk penceresi çoğunlukla
> %0 okundu. Tekrarlanan ölçümlerde (yukarıdaki tablo ve bir önceki tur:
> 387 ms medyan / %0.019 makine) medyan %0.039 makine, kuyruk %0; bu, tekrar
> eden bir zamanlayıcıdan değil, WebView2/Chromium arka plan işlerinden veya
> makinedeki başka süreçlerden gelen tek seferlik gürültüdür. Kaynak düzeyinde
> tekrar eden zamanlayıcı yasağı `src/lib/perf/startup-budget.test.ts` ile
> ayrıca korunur (`setInterval` açılış grafiğinde yasak).

## 3. Bellek (RSS)

**Yöntem.** `scripts/measure-perf.mjs`, uygulama sürecinin tüm canlı alt
süreçlerini (`msedgewebview2.exe` alt süreçleri dahil) `Win32_Process`
ebeveyn/çocuk ilişkisinden çıkarır ve her süreç için
`Win32_PerfFormattedData_PerfProc_Process` sayaçlarından iki değer okur:

- **`WorkingSet` (ham toplam):** süreç ağacının çalışma setlerinin toplamı.
  Paylaşılan sayfalar (aynı WebView2/Chromium DLL'leri) ağacın her üyesinde
  yeniden sayıldığı için gerçek tüketimden yüksektir; yalnızca bilgi amaçlı
  raporlanır.
- **`WorkingSetPrivate` (özel çalışma seti):** yalnızca o sürece ait, başka
  süreçlerle paylaşılmayan fiziksel sayfalar. Paylaşılan runtime sayfalarını hiç
  saymadığı için alt sınırdır; tanı olarak raporlanır.
- **Toplam (indirgenmiş) çalışma seti:** özel sayfalar artı paylaşılan
  sayfaların `1 / ShareCount` payı (`QueryWorkingSetEx`/PSAPI). Her fiziksel
  sayfa bir kez sayılır; **bellek bütçesi bu değerle** denetlenir.

İlk boyadan ~2.5 saniye sonra, yerleşim işleri bitince ölçülür.

**Ölçüm koşulları.**

- Boşta profil: `session.json` yok; uygulama boş durum ekranıyla açılır (0 sekme).
- Sekmeli profil: geçerli bir `session.json` yazılır — kök olarak üretilmiş bir
  çalışma alanı (`.temp_files/perf-workspace`) ve içinde N adet Markdown dosyası
  (`not-01.md` … `not-NN.md`). Uygulama bu oturumu gerçek geri yükleme yolundan
  açar; ölçümde `data-tab-id` düğüm sayısı N olana kadar beklenir. Belgeler
  deterministiktir (`measurementDocument`) ve **düz yazı ağırlıklı** gerçekçi bir
  belgedir: 45 bölüm, ikişer paragraf ve liste, her dördüncü bölümde bir tablo
  veya kod bloğu → ~31.7 KB / ~300 satır. Böylece sekme başına editör arabelleği
  (CodeMirror belgesi + sözdizimi ağacı) ve etkin sekmenin önizleme HTML'i
  gerçekten ölçülür; birkaç satırlık bir dosya bu arabellekleri neredeyse hiç
  doldurmaz ve "ölçülmemiş buffer" bırakır.
- Ölçüm, kullanıcının gerçek oturum dosyasını yedekler ve iş bitince geri koyar;
  WebView2 için **süreç başına benzersiz** bir profil dizini
  (`.temp_files/perf-webview-profile-<pid>`) kullanılır. Sabit dizin, kesintiye
  uğramış bir çalıştırmanın artık WebView2 süreçleri tarafından kilitlenip
  sonraki ölçümü "süreç ağacı kökü çalışma seti sorgusunda yok" hatasıyla
  düşürebiliyordu; tek ölçüm içindeki koşular profili paylaşmaya devam eder.

**Ham sonuç (ham çalışma seti toplamı, 2026-11-18).**

| Profil | RSS (MiB) |
| --- | --- |
| boşta #1 | 329.3 |
| boşta #2 | 329.9 |
| boşta #3 | 327.1 |
| 20 sekme #1 | 354.9 |
| 20 sekme #2 | 358.2 |
| 20 sekme #3 | 354.5 |

**Ham sonuç (özel çalışma seti, aynı koşular).** Ölçüm `WorkingSetPrivate`
sayaçlarıyla yenilendi; boşta **74.3 MiB** (77.2 / 74.2 / 74.3), 5 sekme
**89.9 MiB** (90.7 / 89.9 / 89.3), 20 sekme **91.2 MiB** (tek koşu, ham toplam
359.7 MiB). Ham toplam ile özel toplam arasındaki fark (~240 MiB), WebView2
çalışma zamanı DLL'lerinin ağacın her sürecinde yeniden sayılmasından gelir.

**Değerlendirme.** Sekme başına maliyet ham toplamda ≈ 1.3 MiB, özel çalışma
setinde ≈ 1.5 MiB; 20 sekme yalnızca ölçülü bir artış ekliyor. Değerin büyük
kısmı WebView2/Chromium çok süreçli mimarisidir. Bellek bütçesi §5'te
tanımlıdır.

## 4. Açılışta ağ isteği

**Yöntem.** Aynı koşucu, CDP üzerinden `performance.getEntriesByType('resource')`
listesini toplar ve her URL'nin origin'ini yerel Tauri origin'leriyle
(`http://tauri.localhost`, `http://ipc.localhost`, `http://asset.localhost`,
`http://mdasset.localhost`) karşılaştırır. Dış origin varsa script hata verir
(`exit code 1`). `data:`/`blob:` gibi URL'ler ağ isteği sayılmaz.

**Sonuç.** 6 koşunun tamamında dış istek sayısı **0**. Yüklenen kaynakların
tamamı yerel:

```
http://tauri.localhost/assets/index-BWzIrFyt.js
http://tauri.localhost/assets/rolldown-runtime-XKyaHtl9.js
http://tauri.localhost/assets/index-CVF2FXn4.css
http://tauri.localhost/favicon.ico
http://tauri.localhost/assets/EditorPane-D8CNmPof.js
http://tauri.localhost/assets/EditorPane-6LRX78AP.css
http://tauri.localhost/assets/{javascript,core,typescript,json,bash,rust,xml,python,markdown,css}-*.js
http://ipc.localhost/{current_workspace,report_first_paint,session_load,session_save,
                     open_workspace_path,fs_metadata,list_workspace_dir,fs_read_document,
                     plugin:event|listen}
```

Bu, CSP'nin `connect-src 'self' ipc:` kısıtıyla tutarlıdır ve
`src/lib/perf/startup-budget.test.ts` içindeki statik "açılış grafiğinde ağ API'si
yok" testini çalışma zamanı kanıtıyla tamamlar.

İstek ve modül bazında süre dağılımı (hangi istek kaç ms harcıyor) ile
5 sıcak başlatma medyanının baseline'ı `docs/STARTUP-BASELINE.md` içindedir.

## 5. 5 sekme profili (bellek bütçesi)

**Yöntem.** `scripts/measure-perf.mjs --tabs 5` aynı release ikilisini, kökü
`.temp_files/perf-workspace` olan ve 5 deterministik Markdown belgesi (~31.7 KB,
~300 satır, düz yazı ağırlıklı) içeren geçerli bir oturumla açar;
`data-tab-id` sayısı 5 olana kadar bekler. Bellek `--max-rss-mib` ile bütçeye
bağlanır: sekmeli profilin **en yüksek** toplam çalışma seti eşiği aşarsa script
`exit code 1` döndürür.

> Harness notu: oturum `tauri-plugin-store` ile `{"session": {…}}` sarmalı
> altında saklanır (`src/lib/session/ipc.ts`). Koşucu daha önce dosyayı sarmalsız
> yazdığı için 5/20 sekme profili sessizce 0 sekme açıyordu; `writeSessionFile`
> bu sarmalı yazacak şekilde düzeltildi ve 5 sekme doğrulandı.
>
> Belge boyutu notu: senaryo daha önce ~4 satırlık (~120 bayt) dosyalarla
> koşuyordu. Böyle bir dosya editör arabelleğini ve önizleme HTML'ini neredeyse
> hiç doldurmadığı için "5 sekme açık" maliyeti ölçülmüyordu; `measurementDocument`
> artık ~300 satırlık gerçekçi bir belge üretir. Aynı ikili ve aynı makinede bu
> değişiklik ölçülen toplam çalışma setini ~16 MiB yükseltir (128.6 → 144.0 MiB
> medyan); fark, gerçekten ölçülmeye başlayan editör/önizleme arabellekleridir.

**Komut.**

```powershell
node scripts/measure-perf.mjs --tabs 5 --runs 2 --max-rss-mib 150   # npm run perf:memory (--runs 1)
```

> **Koşu izolasyonu (zorunlu ön koşul).** Uygulama `tauri-plugin-single-instance`
> kullanır ve kilit, uygulama tanımlayıcısından türeyen **adlandırılmış mutex**
> `com.mdeditor.app-sim`'dir (exe adından değil). Ölçüm sırasında:
>
> - İkinci bir başlatma pencere açmadan `exit 0` ile biter; koşucu bunu
>   "CDP sayfa hedefi bulunamadı" olarak görür. Aynı mutex'i paylaştıkları için
>   `md-editor-baseline.exe`, `md-editor-5tab.exe` gibi **kopya ikililer de**
>   çakışır; `Get-Process md-editor` bunları **listelemez**.
> - `md-editor.exe` öldürülürken WebView2 alt süreçleri yaşarsa mutex tutamacını
>   **miras alırlar**; kök süreç yokken bile mutex "held" kalır ve sonraki tüm
>   başlatmalar sessizce `exit 0` olur. Ölçümden önce kökü ölmüş
>   `msedgewebview2.exe` artıkları temizlenmelidir (profil yolu `.temp_files`
>   altında olanlar).
> - `cleanupAll()` içindeki `Get-Process md-editor | Stop-Process -Force`
>   eşzamanlı başka bir ölçümün canlı örneğini de öldürür; bu yüzden **aynı anda
>   tek ölçüm koşusu** çalıştırılmalıdır. Mutex durumu okuma amaçlı
>   `CreateMutexW` + `ERROR_ALREADY_EXISTS` ile doğrulanabilir.

> WebView2 notu: güncel WebView2 çalışma zamanında (`157.x`) uzaktan hata
> ayıklama bayrağı `--remote-debugging-port` **tek başına** verilirse uygulama
> pencereyi hiç yüklemeden ~5 s içinde `exit 0` ile kapanıyor ve koşucu
> "CDP sayfa hedefi bulunamadı" hatasıyla düşüyor. `runProfile` artık
> `--remote-debugging-port=<port> --remote-allow-origins=*` gönderir; bu bayrak
> olmadan 5/20 sekme profili ölçülemez.
>
> İkili notu: ölçüm release ikilisinin (`src-tauri/target/release/md-editor.exe`)
> `dist/` içeriğini gömdüğünü varsayar. Arayüz değişikliğinden sonra
> `npm run build` + `cargo build --release --manifest-path src-tauri/Cargo.toml`
> çalıştırılmadan alınan ölçüm eski arayüzü ölçer. Ayrıca webview `about:blank`
> ta kalıyorsa (CDP'de `page:about:blank`, `#app` yok) sekme profili hiç
> kurulamaz; önce çalışan bir ikili üretilmelidir.
>
> Gözlenen baseline (2026-11-18, çalışan ikili, `--runs 1 --visit-tabs`):
> boşta **113.1 MiB**, 5 sekme **181.9 / 182.6 MiB** indirgenmiş toplam çalışma
> seti (özel 146.1 MiB, ham 421.7 MiB, JS heap 10.5 MiB) → bütçe **aşıldı**.
> Sekmelerin tabana eklediği fark ~69 MiB'dir; `HeapProfiler.collectGarbage`
> sonrası süreç ağacının özel toplamı 245 → 207 MiB'e iner, yani büyümenin
> büyük kısmı GC edilebilir tahsis churn'üdür (~3.4 MiB gerçek tutma). DOM
> düğümü sayısı (689) ve belge sayısı sekme ziyaretleri boyunca sabit kalır:
> kapanan sekme modeli, listener veya timer sızdırmıyor.

**Kabul kriterinin metriği (açık tanım).** Kriter "5 sekme açıkken **toplam
çalışma seti** ≤ 150 MB" der. Bir süreç ağacı için bu büyüklüğün tek doğru
tanımı, her fiziksel sayfayı **bir kez** sayan toplamdır:

> **metrik:** `Σ özel sayfalar + Σ (paylaşılan sayfa / ShareCount)` — süreç
> ağacının toplam (indirgenmiş) çalışma seti
> **kaynak:** `QueryWorkingSetEx` (PSAPI); süreç ağacının tüm üyeleri
> **neden bu tanım:** Aynı fiziksel sayfaları süreç başına yeniden sayan ham
> `WorkingSet` toplamı fiziksel bellekte var olmayan bir toplam üretir (0
> sekmede bile ~338 MiB). Yalnızca özel sayfaları toplamak ise paylaşılan
> WebView2/Chromium runtime sayfalarını hiç saymaz ve alt sınır verir. Paylaşım
> sayısına bölerek indirgenen toplam, her sayfayı bir kez içerdiği için
> kriterin doğrudan karşılığıdır.

Ham `WorkingSet` toplamının neden tüketim metriği olamayacağı ölçümle de
görünür: boşta (0 sekme) **~338 MiB** ham toplam, aynı koşularda özel
toplam yalnızca **74.4 MiB**, indirgenmiş toplam ise ~112 MiB. Aradaki fark,
hiçbir sürece ait olmayan paylaşılan WebView2/Chromium sayfalarının 4–8 süreçte
yedi kez sayılmasıdır. Bu yüzden koşucu ham toplamı ve özel toplamı **bütçe
değil tanı** olarak raporlar (`measure-perf.mjs` içindeki `MEMORY_METRIC`),
bütçe kapısı indirgenmiş toplamla denetlenir ve metrik tanımı makine-okunur
rapora (`budget.metric`) yazılır.

**Sonuç (2026-11-18, `--tabs 5 --runs 2`, release ikili, ~31.7 KB belgeler).**

| Profil | Sekme | FCP (süreç) | Rust `Instant` | Toplam çalışma seti (indirgenmiş) | Özel toplam (tanı) | Ham toplam (tanı) |
| --- | --- | --- | --- | --- | --- | --- |
| boşta | 0 | — | — | 112.0 / 119.1 MiB (medyan 116.0) | 74.5 / 83.3 MiB | 338.2 / 353.5 MiB |
| 5 sekme | 5 | 450 / 440 ms | 358 / 355 ms | **143.1 / 145.0 MiB** (medyan **144.0**) | 103.8 / 105.9 MiB | 380.0 / 380.5 MiB |

**Değerlendirme.** Kart kriteri **≤ 150 MB**; ölçülen 5 sekme toplam çalışma
seti **144.0 MiB medyan, 145.0 MiB en yüksek** — kriter karşılanıyor, bütçeye
~5 MiB pay kalıyor. Bağımsız serileştirilmiş koşularda aynı senaryo
**142.8 / 143.5 MiB** (ikinci oturum, `--runs 2`) ve **143.7 MiB** (üçüncü
koşu, `--runs 1`) verdi; gözlenen bant **142.8–145.0 MiB**, yani pay
≈ 5–7 MiB'dir (`budget.pass=true`, `exit code 0`). Sekmelerin boştaki tabana eklediği fark ≈ 28 MiB; bunun
~16 MiB'si artık ölçülen belge/önizleme arabellekleridir, kalanı WebView2/
Chromium çok süreçli mimarisidir. Duyarlılık sınırı: tablo ve kod bloğu
yoğunluğu yüksek yapay bir belge (her bölümde tablo + kod bloğu, 38 KB) aynı
ikilide **164.8 MiB** ölçer; bu bir stress senaryosudur ve kart kriterinin
"tipik belge" varsayımının dışındadır, ama önizleme maliyetinin belge
yoğunluğuyla arttığını gösterir (bkz. "Sızıntı/tutma denetimi" altındaki
önizleme maddesi).

**Sızıntı/tutma denetimi (2026-11-18, kaynak + ölçüm).** Kartın istediği dört
tutma kaynağı tek tek denetlendi; üçü zaten sınırlı, biri ölçümle sınırları
belirlenmiş feature maliyeti:

| Kaynak | Denetim | Durum |
| --- | --- | --- |
| Kapatılan sekmenin doküman modeli | `EditorSession.prune(openTabIds)` her sekme listesi değişiminde kapalı sekmelerin `EditorState`'ini siler (`src/lib/editor/session.ts`, `EditorPane.svelte` `$effect`) | sınırlı |
| Kapatılan sekmenin event listener'ı | `conflicts.bindEditor` dönen `unbind` çağrılır, `tabBindings` temizlenir; `scrollSync.detach()` mod değişiminde ve `onDestroy`'da; `ResizeObserver.disconnect`, `pagehide`/`watch` abonelikleri effect dönüşlerinde | sınırlı |
| Zamanlayıcılar | Önizleme debounce `clearTimeout` ile; `observeEditorTheme` → `stopThemeWatch()`; oturum yazıcısı `dispose()`; `setTimeout`/`requestIdleCallback` tek seferlik | sınırlı |
| Undo-history | CodeMirror `history()` `minDepth` (varsayılan 100) ile sınırlar: `updateBranch` en fazla `minDepth + 20` olay tutar (`node_modules/@codemirror/commands/dist/index.js`) | sınırlı |
| Önizleme cache'i | Önizleme katmanında önbellek yok (`markdown.ts` her render'da parser üretir, sonuç tutulmaz); yalnızca etkin sekmenin `html`'i + DOM'u yaşar | sınırlı |
| Tüm sekmeler için tam doküman kopyası | Yalnızca **açık** sekmelerin `EditorState`'i tutulur (sekme geçişi ve kaydedilmemiş içerik için gerekli); kapalı sekme `prune` ile düşer. Etkin sekmenin metni ayrıca `previewSource` ve önizleme `html`'i olarak bir kez daha yaşar | tasarım gereği |
| Ölçülmemiş editör/önizleme arabelleği | Senaryo 120 baytlık dosyalarla koşuyordu → arabellekler ölçülmüyordu; `measurementDocument` ile ~31.7 KB belge ölçülüyor | düzeltildi |

**Yeniden doğrulama.**

```powershell
node scripts/measure-perf.mjs --tabs 5 --runs 2 --max-rss-mib 150 --json-out .temp_files/budget/memory.json
# [bellek bütçesi] metrik: Süreç ağacının toplam çalışma seti = Σ özel sayfalar + Σ (paylaşılan sayfa / ShareCount); her fiziksel sayfa bir kez
# [bellek bütçesi] 5 sekme en yüksek toplam çalışma seti 145.0 MiB / bütçe 150 MiB → uygun
# [bellek bütçesi] tanı: özel çalışma seti toplamı 105.9 MiB, ham WorkingSet toplamı 380.5 MiB (bütçe değil)
```


## 6. Kurulum paketi bütçesi

**Yöntem.** `npm run tauri:build` NSIS kurulum dosyasını
`src-tauri/target/release/bundle/nsis/` altına yazar. `bundle.windows.
webviewInstallMode.type = "downloadBootstrapper"` olduğu için WebView2 çalışma
zamanı pakete gömülmez; ölçülen boyut WebView2 hariç kurulum paketidir.
`scripts/check-installer-budget.mjs` dosyayı diskten okur, 12 MB (MiB) bütçesiyle
karşılaştırır; paket yoksa ölçüm eksikliğini `exit code 2` ile bildirir.

**Komut.**

```powershell
npm run tauri:build
node scripts/check-installer-budget.mjs      # npm run perf:installer
```

**Ham çıktı (2026-11-18).**

```
=== kurulum paketi (WebView2 hariç) ===
  Markdown Editor_0.1.0_x64-setup.exe  2.68 MiB / bütçe 12 MiB → uygun
=== sonuç ===
  kurulum paketi: uygun
```

**Değerlendirme.** 2.68 MiB, 12 MB bütçesinin çok altında (referans: gömülü
`md-editor.exe` ≈ 11.6 MiB; NSIS sıkıştırması paketi küçültüyor). Kriter geçti.

## Tekrar üretme

```powershell
npx vite build                              # dist + .vite/manifest.json
node scripts/check-bundle-budget.mjs        # npm run perf:bundle (giriş + ilk yük + önizleme)
cargo build --release --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml
node scripts/measure-perf.mjs --tabs 5 --runs 3 --max-rss-mib 150   # bellek bütçesi
node scripts/measure-perf.mjs --startup --gate-startup               # sıcak/soğuk + boşta CPU
node scripts/measure-perf.mjs --tabs 20 --runs 3                    # bilgi amaçlı RSS/FCP
npm run tauri:build                         # NSIS kurulum paketi
node scripts/check-installer-budget.mjs     # npm run perf:installer
npx vitest run src/lib/perf/startup-budget.test.ts
```

> **Önemli:** `--features tauri/custom-protocol` atlanmamalıdır (alternatif:
> `npm run tauri:build`). `src-tauri/Cargo.toml` içinde yerel bir
> `custom-protocol` özelliği tanımlı değildir; düz `cargo build --release`
> çalıştırıldığında `tauri/custom-protocol` etkinleşmez, frontend varlıkları
> ikiliye gömülmez ve pencere `devUrl` (`http://localhost:1420`) üzerinden
> açılmaya çalışır. Bu doğrulama `cargo tree -e features` çıktısında
> `custom-protocol` feature'ının hiç görünmemesiyle ve gömülü varlık adlarının
> (`index-*.js`, `EditorPane-*.js`) yalnızca doğru derlenmiş ikilide
> bulunmasıyla teyit edildi. Yanlış ikiliyle ölçüm yapılırsa `measure-perf.mjs`
> geliştirme sunucusu URL'sini görüp hata verir.

`measure-perf.mjs` gerçek kullanıcı oturum dosyasını
(`%APPDATA%\com.mdeditor.app\session.json`) geçici olarak değiştirir; yedekler ve
geri koyar. Kökü `.temp_files/perf-workspace` olan bir oturum, kesintiye uğramış
önceki bir ölçümden kalmış sayılır: gerçek oturum gibi geri konmaz, ölçüm sonunda
silinir ve yedek dosyası da temizlenir. Ölçümü başka işler açıkken çalıştırmak
RSS/FCP sayılarını etkileyebilir; karşılaştırılabilir sonuç için boşta bir
makinede çalıştırın.

> **Ölçümleri serileştirin.** Koşucunun `cleanupAll()` adımı her `md-editor.exe`
> ve ona ait `msedgewebview2.exe` sürecini kapatır. Aynı makinede eşzamanlı iki
> ölçüm başlatılırsa biri diğerinin uygulamasını öldürür; sonuç "süreç ağacı
> kökü çalışma seti sorgusunda yok" hatası ya da yanlış (eksik süreçli) bellek
> örneğidir. Aynı anda tek `measure-perf.mjs` koşusu çalıştırın; CI'da bu adımı
> tek iş olarak kilitleyin.

## Bağımsız yeniden ölçüm

Aynı makinede, aynı araçlarla yapılan ikinci bir ölçüm (2026-11-18, `--runs 3`)
yukarıdaki tabloları doğruladı. Paket bütçesi yeniden ölçüldüğünde aynı sonucu
verdi (42.7 KB başlangıç chunk'ı, 310.4 KB ilk yük JS toplamı, 53.8 KB tembel
önizleme; exit code 0); ilk boya ve RSS değerleri koşular arası normal sapma
içinde kaldı:

| Profil | Medyan süreç → FCP | Medyan Rust `Instant` | Medyan RSS (ham toplam) |
| --- | --- | --- | --- |
| Boşta | 407 ms | 352 ms | 327.4 MiB |
| 20 sekme | 420 ms | 349 ms | 355.9 MiB |

> Bu tablo ham `WorkingSet` toplamıyla (paylaşılan sayfalar çok kez sayılır)
> alınmıştır; özel çalışma seti değerleri §3 ve §5'tedir.

Ham koşular: boşta 407 / 419 / 407 ms, RSS 329.2 / 327.1 / 327.4 MiB; 20 sekme
420 / 422 / 417 ms, RSS 356.4 / 354.4 / 355.9 MiB. Dış ağ isteği: **0**
(`externalRequests: []`). `startup-budget.test.ts`: 7 test geçti.

## Son doğrulama koşusu (tekil)

Aynı gün, aynı release ikilisiyle yapılan tek koşuluk doğrulama
(`node scripts/measure-perf.mjs --tabs 20 --runs 1`). Değerler tek koşudur;
karşılaştırma için yukarıdaki medyanlar kullanılmalıdır.

| Profil | Süreç → FCP | Sayfa FCP | `app:first-paint` | Rust `Instant` | RSS (özel) | Çalışma seti toplamı |
| --- | --- | --- | --- | --- | --- | --- |
| boşta (0 sekme) | 447 ms | 132 ms | 109 ms | 371 ms | **74.4 MiB** | 338.4 MiB |
| 20 sekme | 424 ms | 136 ms | 118 ms | 356 ms | **101.7 MiB** | 379.3 MiB |

- Dış ağ isteği: **0** (`externalRequests: []`); yüklenen tüm kaynaklar
  `http://tauri.localhost` ve `http://ipc.localhost` origin'lerinden.
- Aynı turda `node scripts/check-bundle-budget.mjs`: başlangıç **42.7 KB**,
  ilk yüklenen JS toplamı **310.4 KB**, tembel önizleme **53.8 KB** gzip →
  `exit code 0`. Yüklenen chunk'lar `index-B6CmcUkv.js`,
  `EditorPane-D5L_eoyl.js`, `PreviewPane-BOA_IVf-.js`, `rolldown-runtime-*.js`.
- `cargo test --manifest-path src-tauri/Cargo.toml perf::tests` → 1 test geçti;
  `npx vitest run src/lib/perf/startup-budget.test.ts` → 7 test geçti.

## Bilinen sınırlar

- Sayılar tek bir Windows makinesinde, tek bir release derlemesinde alındı;
  farklı CPU/disk/WebView2 sürümünde değişir.
- İlk boya "süreç başlangıcı → FCP" olarak ölçülür. Sıcak (5 koşu medyanı
  399 ms) ve soğuk (WebView2 ilk kurulum dahil 447 ms) başlatma §2b'de ayrı
  ayrı raporlanır; soğuk ölçüm WebView2 profil dizinini siler, işletim sistemi
  dosya önbelleğini temizleyemez.
- Bellek üç değerle raporlanır: ham çalışma seti toplamı (paylaşılan sayfalar
  her süreçte yeniden sayılır, ~330–380 MiB), özel çalışma seti toplamı
  (uygulamaya özgü sayfalar, ~74–106 MiB) ve indirgenmiş toplam çalışma seti
  (her fiziksel sayfa bir kez, ~112–145 MiB). Bütçe kapısı indirgenmiş toplamı
  kullanır.
- Paket bütçesi tarafında **aşım yoktur**: başlangıç chunk'ı **42.7 KB** gzip
  (≤ 250 KB), ilk yüklenen JS toplamı **310.4 KB** gzip (≤ 320 KB) ve tembel
  önizleme chunk'ı **53.8 KB** gzip (≤ 160 KB). `EditorPane` dinamik chunk'ı
  555.7 KB ham / 189.7 KB gzip'tir; önizleme ayrı bir dinamik girişe taşındığı
  için 160 KB'lık önizleme bütçesine tabi değildir.
- Bellek bütçesi kart kriteri (5 sekme ≤ 150 MB) toplam çalışma setiyle
  **karşılanmaktadır: 144.0 MiB medyan / 145.0 MiB en yüksek** (indirgenmiş
  toplam, 5 × ~31.7 KB belge, `--runs 2`). Pay ~5 MiB'dir; ölçüm makine
  yüküne duyarlıdır (aynı ikilide 143–145 MiB bandı).
- Kurulum paketi bütçesi geçmektedir (2.68 MiB ≤ 12 MB).

## Kabul kriteri → ölçüm eşlemesi

| Kart kriteri | Ölçülen metrik | Kapı komutu |
| --- | --- | --- |
| İlk yüklenen JS gzip toplamı ≤ 320 KB | entry + statik zincir + hemen açılan `EditorPane` zinciri, gzip | `node scripts/check-bundle-budget.mjs` |
| 5 sekme açıkken toplam çalışma seti ≤ 150 MB | **Σ özel sayfalar + Σ (paylaşılan sayfa / ShareCount)** (süreç ağacı, her fiziksel sayfa bir kez) | `node scripts/measure-perf.mjs --tabs 5 --runs 1 --max-rss-mib 150` |
| Kurulum paketi (WebView2 hariç) ≤ 12 MB | NSIS `*-setup.exe` boyutu | `node scripts/check-installer-budget.mjs` |

"Toplam çalışma seti" bu projede **indirgenmiş toplam çalışma seti** olarak
tanımlıdır: özel sayfalar artı paylaşılan sayfaların `1 / ShareCount` payı
(`QueryWorkingSetEx`, PSAPI). Böylece her fiziksel sayfa bir kez sayılır ve
kriterin istediği büyüklük elde edilir. Ham `WorkingSet` toplamı, WebView2/
Chromium çalışma zamanı sayfalarını süreç ağacının her üyesinde yeniden
saydığı için fiziksel bellekte var olmayan bir toplam üretir (0 sekmede bile
~338 MiB); yalnızca özel sayfaları toplamak ise paylaşılan runtime sayfalarını
hiç saymaz. Bu yüzden ham toplam ve özel toplam bütçe metriği değil, yalnızca
tanı olarak raporlanır. Gerekçe `scripts/measure-perf.mjs` içindeki
`MEMORY_METRIC` tanımında ve JSON raporunun `budget.metric` alanında da
yazılıdır.

Bellek örneği okunamazsa (boş CIM yanıtı veya `QueryWorkingSetEx` başarısız)
ölçüm "0 MiB → geçti" sayılmaz: `rssSummary` üç kez dener, kök süreç yine yoksa
çalıştırma hata verir ve bütçe kapısı exit code 2 ile ölçüm eksikliğini
bildirir.

**Son doğrulama (2026-11-18, aynı release ikilisi):**

- `node scripts/check-bundle-budget.mjs` → ilk yük JS toplamı **311 KB gzip**
  (≤ 320 KB), başlangıç 42.6 KB (≤ 250 KB), önizleme 53.8 KB (≤ 160 KB), exit 0.
- `node scripts/check-installer-budget.mjs` → **2.69 MiB** (≤ 12 MiB), exit 0.
- `node scripts/measure-perf.mjs --tabs 5 --runs 2 --max-rss-mib 150` →
  5 sekme **144.0 MiB medyan / 145.0 MiB en yüksek** toplam çalışma seti
  (indirgenmiş, ≤ 150 MiB); tanı: özel toplam 103.8/105.9 MiB, ham `WorkingSet`
  toplamı 380.0/380.5 MiB (bütçe değil), exit 0. Belgeler 5 × ~31.7 KB
  (`measurementDocument`, 45 bölüm).
- `node scripts/measure-budgets.mjs` → üç metrik de PASS, exit 0
  (`budget-report.json`).
