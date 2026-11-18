# Açılış (warm-start) baseline — ölçüm ve modül dağılımı

Bu belge, açılış yolunun **baseline** sayılarını ve ilk boyaya giden sürenin
hangi istek/modül tarafından harcandığını kaydeder. Ölçüm düzeneği
`scripts/measure-perf.mjs` içindedir ve **yalnızca ölçüm yapar**: hiçbir modülü
ertelemez, hiçbir yükleme sırasını veya davranışı değiştirmez. Buradaki sayılar
sonraki optimizasyon adımlarının karşılaştırma tabanıdır.

## Ölçüm düzeneği

Release ikilisi (`src-tauri/target/release/md-editor.exe`) WebView2 ile açılır,
CDP üzerinden şu değerler okunur:

- `first-contentful-paint` ve `app:first-paint` performance mark'ı
  (`src/lib/perf/firstPaint.ts`),
- Rust `report_first_paint` komutunun döndürdüğü `Instant` süresi,
- `performance.getEntriesByType('resource')` — her açılış isteğinin
  `startTime`, `duration`, `transferSize`, `decodedBodySize` değerleri,
- süreç ağacının boşta CPU'su ve RSS'i.

Koşu profili: **1 soğuk** (WebView2 profil dizini silinmiş → ilk kurulum yolu) +
**1 ısınma** (ölçüme girmez) + **5 sıcak** başlatma. Sıcak başlatmada oturum
dosyası yoktur ve belge açık değildir: ölçülen şey kabuğun (Svelte + Svelte
kabuk chunk'ları) ilk boyasıdır.

```powershell
# baseline (5 sıcak başlatma, JSON çıktılı)
node scripts/measure-perf.mjs --startup --warm-runs 5 --json-out .temp_files/startup-baseline.json

# bütçe kapısıyla (CI/lokal kabul kontrolü)
npm run perf:startup

# bütçe kapısı + kayıtlı baseline ile regresyon karşılaştırması
npm run perf:regression
```

`perf:regression`, ölçümü `.temp_files/startup-current.json` dosyasına yazar ve
`scripts/compare-startup-baseline.mjs` ile `perf/startup-baseline.json`
dosyasındaki kayıtlı sayılarla karşılaştırır. Mutlak kapı 900/3000 ms ve %1
CPU'yu denetler; baseline karşılaştırması bu eşiklerin **altındaki** kaymayı
(ör. 419 ms → 850 ms) de yakalar. Tolerans: baseline'ın %25 üstü veya +100 ms
(hangisi büyükse); boşta CPU'da baseline + 0.25 puan, üst sınır %1. Tek koşunun
en yüksek FCP'si medyan yerine doğrudan 900 ms bütçesiyle denetlenir. Açılışta
dış ağ isteği veya ağır (tembel) chunk yüklenmesi de hatadır.

JSON alanları: `cold`, `warm.runs/medianProcessToFcpMs/medianPageFcpMs`,
`idleCpu`, `externalRequests`, `requests` (açılış istekleri) ve `modules`
(modül bazında medyan süre/başlangıç/boyut).

## Baseline sayıları

Ölçüm tarihi 2026-11-18, Windows `win32 x64` (16 mantıksal çekirdek), release
derlemesi (`dist/` ikiliye gömülü).

| Ölçüm | Değer | Bütçe | Sonuç |
| --- | --- | --- | --- |
| Soğuk açılış — süreç → FCP (WebView2 ilk kurulum) | **545 ms** (sayfa FCP 172 ms) | ≤ 3000 ms | uygun |
| Sıcak açılış — süreç → FCP, 5 koşu medyanı | **456 ms** | ≤ 900 ms | uygun |
| Sıcak koşular (tek tek) | 456 / 444 / 452 / 457 / 469 ms | — | — |
| Sayfa FCP medyanı (sıcak) | 136 ms | bilgi | — |
| `app:first-paint` mark (sıcak koşular) | 110–124 ms | bilgi | — |
| Rust `Instant` süreç süresi (sıcak) | 369–399 ms | bilgi | — |
| Boşta CPU medyanı (5 s pencere) | %0.098 makine (%1.56 çekirdek), kuyruk %0 | ≤ %1 makine | uygun (tek koşu en yüksek %1.719) |
| Açılışta dış origin isteği | **0** (12 isteğin tamamı yerel) | 0 | uygun |

> Bu tablo, `perf/startup-baseline.json` dosyasının yenilendiği ölçümün
> değerleridir. Önceki kayıt kendi içinde tutarsızdı (soğuk `processToFcpMs`
> 164 ms < `pageFcpMs` 180 ms), bu yüzden
> `scripts/compare-startup-baseline.mjs` karşılaştırmayı reddediyordu
> (`baseline geçersiz`). Baseline geçerli bir ölçümle yenilendi; kapı artık
> uçtan uca çalışıyor. Yenileme koşusunun hemen ardından yapılan doğrulama
> koşusu: soğuk 488 ms, sıcak medyan 443 ms, boşta CPU medyanı %0.039
> (en yüksek %0.137, kuyruk %0), dış ağ isteği 0, ağır chunk 0.
> %1.719'luk tek örnek kalıcı değildi (sonraki koşuda en yüksek %0.137) ve
> kuyruk değeri %0 kaldı; eşzamanlı makine yükünün tek pencerelik yansıması
> olarak değerlendirildi — tekrar eden arka plan işi göstergesi değil.

> Süreç → FCP'nin ~350–390 ms'lik kısmı Rust/WebView2 tarafında süreç
> başlangıcıdır; sayfa tarafı (HTML → ilk boya) ~128 ms'tir. Baseline bu
> ayrımı korur; optimizasyon hedefi seçilirken hangi tarafın ölçüldüğü
> karıştırılmamalıdır.

## Hangi istek/modül kaç ms harcıyor

Sıcak koşuların medyanı. `başlangıç`, isteğin sayfa zaman çizelgesindeki başlama
anıdır (ms); `süre`, Resource Timing `duration` değeridir (indirme + çözümleme).

| Modül / istek | Süre | Başlangıç | Boyut | Not |
| --- | --- | --- | --- | --- |
| `IPC: take_startup_warnings` | **18.5 ms** | 29.4 ms | — | Açılışta ilk boyadan **önce** atılan IPC; en pahalı tek adım |
| `IPC: plugin:event|listen` | **17.8 ms** | 30.3 ms | — | Koşu başına 2 kayıt (olay dinleyicileri); ilk boyadan önce |
| giriş kabuğu `index-CIab0ohj.js` | 4.5 ms | 15.4 ms | 125.4 KB | `main.ts` + `App.svelte` (+ kabuk bileşenleri) |
| kabuk stilleri `index-CVF2FXn4.css` | 3.2 ms | 15.6 ms | 19.1 KB | — |
| modül çalışma zamanı `rolldown-runtime-XKyaHtl9.js` | 2.9 ms | 15.6 ms | 0.7 KB | Vite/rolldown runtime |
| `IPC: plugin:store|load` | 1.5 ms | 111.2 ms | — | Oturum okuma, ilk boyadan sonra |
| `IPC: plugin:store|set` | 1.4 ms | 616.9 ms | — | İlk boyadan ~500 ms sonra (oturum yazımı) |
| `IPC: plugin:store|save` | 1.3 ms | 618.5 ms | — | Aynı yazımın kaydet adımı |
| `favicon.ico` | 1.2 ms | 46.3 ms | 0.5 KB | — |
| `IPC: current_workspace` | 1.1 ms | 109.6 ms | — | — |
| `IPC: plugin:store|get` | 1.1 ms | 113.1 ms | — | — |
| `IPC: report_first_paint` | 1.0 ms | 110.7 ms | — | Ölçüm komutunun kendisi |

Toplam 12 istek; hepsi `tauri.localhost` / `ipc.localhost` (yerel). Dış ağ
isteği yok.

**Yorum.** Sayfa tarafındaki ~128 ms'lik ilk boya yolunun yaklaşık **36 ms**'si
(`take_startup_warnings` + `event|listen`) ilk boyadan önce yapılan iki IPC
çağrısıdır; statik varlıkların tamamı (kabuk JS + CSS + runtime) **~11 ms** ve
~15.5 ms'te başlar. Yani sayfa tarafında en pahalı kalem ağ/asset değil, IPC
tur gidiş-dönüşleridir. `store|set`/`store|save` ilk boyadan sonra (~617 ms)
çalışır, ilk boya yolunda değildir.

## Açılışta yüklenmeyen ağır modüller

Sıcak ve soğuk başlatmaların hiçbirinde aşağıdaki chunk'lar istenmedi
(0 istek, 0 ms — tembel):

| Chunk | Modül | Tembel boyut (gzip, `docs/PERFORMANCE.md`) |
| --- | --- | --- |
| `EditorPane-*.js` | Editör paneli — CodeMirror 6 | 242.9 KB |
| `PreviewPane-*.js` | Önizleme — markdown-it + DOMPurify | 53.8 KB |
| `core-*.js`, `dist-js-*.js` | highlight.js çekirdeği + dinamik yükleyici | — |
| `bash|css|javascript|json|markdown|python|rust|typescript|xml-*.js` | highlight.js dil paketleri | — |

Bu davranış `src/lib/perf/startup-budget.test.ts` ile statik olarak da
korunur: ağır paketler giriş grafiğinde statik `import` olarak görünemez.

## Yeniden doğrulama (kabul kapısı)

2026-11-18'de aynı makinede, aynı release ikilisiyle (`npm run perf:regression`,
1 soğuk + 1 ısınma + 5 sıcak) üç kez ölçüldü. Baseline: `perf/startup-baseline.json`.

| Ölçüm | Baseline | 1. koşu | 2. koşu | 3. koşu | İzin (tolerans) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- |
| Sıcak başlatma medyanı (süreç → FCP) | 419 ms | 455 ms | **436 ms** | **404 ms** | 524 ms (≤ 900 ms) | uygun |
| Sıcak en yüksek koşu | 424 ms | 478 ms | 527 ms | 428 ms | 900 ms | uygun |
| Soğuk açılış (WebView2 ilk kurulum) | 492 ms | 542 ms | **541 ms** | **485 ms** | 615 ms (≤ 3000 ms) | uygun |
| Sayfa FCP medyanı (sıcak) | 116 ms | 136 ms | 132 ms | 124 ms | 216 ms | uygun |
| Boşta CPU medyanı | %0.117 makine | %0.019 | %0.019 | %0 | %0.367 (≤ %1) | uygun |
| Açılışta dış ağ isteği | 0 | 0 | 0 | 0 | 0 | uygun |
| Açılışta ağır chunk | yok | yok | yok | yok | yok | uygun |

3. koşu (yalnızca ölçüm; optimizasyon içermez) tek tek: soğuk 485 ms; sıcak
404 / 405 / 428 / 404 / 403 ms; sayfa FCP 120–128 ms; Rust `Instant` 334–377 ms;
boşta CPU tüm örneklerde %0 (en yüksek %0.019, kuyruk %0). Boşta CPU'nun tam %0
okunması arka plan işinin yokluğunu gösterir; `maxPercentOfTotal` ve
`medianTailPercentOfTotal` alanları da 0'dır.

**Yeniden üretme (tekrarlanabilir doğrulama adımı):**

```powershell
npm run perf:regression
```

Komut `scripts/measure-perf.mjs --startup --gate-startup` ile ölçer, JSON'u
`.temp_files/startup-current.json` dosyasına yazar ve
`scripts/compare-startup-baseline.mjs` ile baseline'ı karşılaştırır; çıkış kodu
1 ise regresyon vardır. Ölçüm öncesi **çalışan `md-editor.exe` kalmamalıdır**:
script sabit bir CDP portu (`9337`) kullanır, artık süreç varsa soğuk başlatma
`CDP sayfa hedefi bulunamadı` / `CDP yanıtı zaman aşımına uğradı` hatasıyla
düşer (bu bir ürün regresyonu değil, düzenek çakışmasıdır). Kalan süreçleri
`Get-Process md-editor | Stop-Process -Force` ile kapatıp yeniden çalıştırın.

- Sıcak medyan ilk iki koşuda baseline'a göre **+17…+36 ms** (%4–9), üçüncü
  koşuda **−15 ms**; soğuk açılış **+49 / +50 / −7 ms**. Farklar aynı makinede
  koşular arası normal sapma aralığında ve hedefin (900/3000 ms) çok altında;
  regresyon sayılmaz.
- Her üç koşuda da `highlight.js`, `EditorPane` (CodeMirror 6), `PreviewPane`
  (markdown-it + DOMPurify) chunk'ları istenmedi; açılış 12 istekle sınırlı ve
  tamamı `tauri.localhost` / `ipc.localhost`.
- Boşta CPU kuyruk değeri (ikinci yarı pencere) her koşuda %0 — tekrar eden
  arka plan zamanlayıcısı yok. `src/lib/perf/startup-budget.test.ts` (7 test)
  `setInterval` ve ağ API'lerinin kabuk grafiğine sızmadığını statik olarak
  doğruluyor.
- **Ölçüm düzeltmesi:** `scripts/measure-perf.mjs` içindeki `sampleIdleCpu`
  önceden süreç ağacının **toplam** CPU'sunu örnekliyordu; WebView2 alt
  süreçleri işini bitirip ağaçtan çıkınca toplam geriye gidiyor ve negatif
  yüzdeler (ör. −%1.5) raporlanabiliyordu. Örnekleme artık pid bazında
  (`cpuByTreePid`) yapılıyor ve `cpuDeltaSeconds` yalnızca artışları topluyor;
  boşta CPU değerleri negatife düşemez. Bu bir ölçüm düzeltmesidir, ürün
  davranışı değişmez.

### 4. koşu — kapanış ölçümü (güncel derleme)

Performans görevinin kabul kontrolü için o günkü kaynaktan yeniden derlenen
release ikilisiyle (`npm run tauri -- build --no-bundle`, `dist/` gömülü) bir
kez daha ölçüldü:

```powershell
node scripts/measure-perf.mjs --startup --warm-runs 5 --gate-startup --json-out .temp_files/startup-current.json
node scripts/compare-startup-baseline.mjs --baseline perf/startup-baseline.json --current .temp_files/startup-current.json
```

| Ölçüm | Baseline | 4. koşu | Bütçe | Sonuç |
| --- | --- | --- | --- | --- |
| Sıcak başlatma medyanı (süreç → FCP) | 456 ms | **442 ms** (441/453/442/409/494) | ≤ 900 ms | uygun |
| Sıcak en yüksek koşu | 469 ms | 494 ms | 900 ms | uygun |
| Soğuk açılış (WebView2 ilk kurulum) | 545 ms | **526 ms** | ≤ 3000 ms | uygun |
| Sayfa FCP medyanı (sıcak) | 136 ms | 132 ms | bilgi | — |
| Boşta CPU medyanı | %0.098 | **%0.039** (en yüksek %0.098, kuyruk %0) | ≤ %1 | uygun |
| Açılışta dış ağ isteği | 0 | 0 (12 isteğin tamamı yerel) | 0 | uygun |
| Açılışta ağır chunk | yok | yok (`EditorPane`, `PreviewPane`, `core`/`hljs` istenmedi) | yok | uygun |

Karşılaştırma scripti "regresyon yok" döndürdü (çıkış kodu 0). Boşta CPU'nun
kuyruk değerinin %0 olması arka plan zamanlayıcısı olmadığını gösterir; bu
`src/lib/perf/startup-budget.test.ts` tarafından (`setInterval` ve ağ API'leri
için) statik olarak da korunur.

## Bilinen sınırlar

- Sayılar tek makinede, tek release derlemesinde alındı; CPU/disk/WebView2
  sürümü değişince kayar. Karşılaştırma için aynı makinede, boşta koşulmalıdır.
- `performance` kaynak zamanlaması WebView2'nin Resource Timing tamponuna
  bağlıdır; ölçüm ilk boyadan sonra okunur, tampon taşması beklenmez (12 giriş).
- Soğuk ölçüm WebView2 profil dizinini siler; işletim sistemi dosya önbelleği
  temizlenemez, yani "soğuk" yalnızca ilk-kurulum yolunu temsil eder.
- Modül etiketleri Vite'ın 8 karakterlik içerik karması atılarak türetilir;
  tanınmayan chunk kendi dosya adıyla raporlanır (sessizce gizlenmez).
