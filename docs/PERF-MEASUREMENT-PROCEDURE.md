# Toplam çalışma seti ölçüm prosedürü — nihai birleştirilmiş belge

Bu belge, md-editor'ün toplam çalışma seti (MB/MiB) ölçümünü **baştan sona
kopyalanabilir tek prosedür** olarak tanımlar: süreç ağacı toplama kuralı,
tekrar sayısı kuralı, raporlanacak metrikler ve çalıştırılacak komut.

Kapsam sınırı: Bu belge **yalnızca prosedürü** tanımlar. Senaryo adımları
(kaç sekme, hangi gezinti sırası) ve fiili baseline sayıları bu belgede
**yer almaz**; ölçüm de bu görevde çalıştırılmamıştır. Senaryo ayrı belgede
tanımlanır; burada yalnızca "senaryo kuruldu ve yerleşti" ön koşulu kullanılır.

## 1. Metrik tanımı

**Toplam çalışma seti (MB)**:

> Σ `WorkingSet64` (bayt) — `md-editor.exe` kök süreci **ve** tüm
> `msedgewebview2.exe` alt süreçleri; MiB olarak raporlanır
> (1 MiB = 1 048 576 bayt = PowerShell `1MB` sabiti, bu yüzden `WorkingSet64 / 1MB`
> doğrudan doğru değeri verir).

Bu **ham toplamdır**: paylaşılan WebView2/Chromium DLL sayfaları süreç ağacının
her üyesinde yeniden sayıldığı için fiziksel bellekte var olandan büyük
görünür. Ham toplam **tanı/rapor metriğidir**; `≤ 150 MB` bütçesi ise paylaşılan
sayfaları indirgeyen *indirgenmiş* toplam çalışma seti metriğini kullanır
(`scripts/measure-perf.mjs`). İkisi birlikte raporlanacaksa etiketler açık
yazılmalıdır: `ham toplam (WorkingSet64)` ve `indirgenmiş toplam (bütçe metriği)`.

## 2. Tekrar sayısı kuralı

| Kural | Değer |
| --- | --- |
| Ölçülen tekrar sayısı | **3–5**; en az 3, tercihen 5. 3'ten az koşu raporlanmaz. |
| Isınma koşusu | Ölçümlerden önce **1 ısınma koşusu** yapılır ve sonucu **atılır**; sayıya dahil değildir. Amaç WebView2 profilinin ısınmasıdır (koşular arasındaki fark soğuk başlangıç farkı olmasın). |
| Tekrarlar arası bekleme | Her koşu **taze süreç ağacıyla** başlar: uygulama kapatılır, süreç tamamen sonlanana kadar beklenir, **yeniden başlatılır**. Yeniden başlatma sonrasında senaryo yeniden uygulanır ve son işlemden sonra **10 s yerleşme** beklenir; bu bekleme her koşuda tekrarlanır. |
| Koşu başına örnekleme penceresi | **3 s**, örnek aralığı **250 ms** (tipik 8–12 örnek; örnek sayısı raporlanır). |

**Tekrarın geçersiz sayıldığı koşullar** (geçersiz koşu atılır, koşu yeniden
başlatılır; "0 MB" veya "geçti" olarak raporlanmaz):

1. Ölçüm anında `md-editor.exe` **yok** veya **birden fazla** var
   (uygulama tek örnektir; tam olarak bir kök sürecin varlığı şarttır).
2. Toplanan ağaçta **hiç `msedgewebview2.exe` üyesi yok** — WebView2 tarafı
   sayılmamış demektir; pencere yeniden ölçülür.
3. Örnekleme penceresinde **örnek sayısı < 2** — pencere ölçümü kanıtlamaz.
4. Ölçüm sırasında **eşzamanlı ağır iş** (derleme, tarayıcı, başka ölçüm)
   saptanırsa koşu notlanır ve mümkünse tekrarlanır.

## 3. Raporlanacak metrikler ve format

**Koşu başına "toplam MB" değeri, o koşunun örnekleme penceresindeki
örnek toplamlarının aritmetik ortalamasıdır.** Tekrar karşılaştırması bu tek
sayı üzerinden yapılır; **tepe** ayrıca yazılır, çünkü ortalama pencere
içindeki kısa süreli sıçramayı gizler.

Her koşu için (MiB, 0.1 hassasiyetle):

| Alan | Tanım |
| --- | --- |
| Toplam MB (koşu ortalama) | Koşudaki örnek toplamlarının **aritmetik ortalaması** |
| Koşu tepe (peak) | Koşu içindeki örnek toplamlarının **en büyüğü** (süreç başına maksimumların toplamı değil) |
| Örnek / süreç sayısı | Penceredeki örnek sayısı (geçerlilik kanıtı) ve ağaç üye sayısı (min–max) |
| Ana süreç / WebView2 payı | `md-editor.exe` toplamı ve `msedgewebview2.exe` toplamı (tanı) |

**Koşular arası özet** (3–5 ölçülen koşu üzerinden, MiB):

| Alan | Kural |
| --- | --- |
| Ortalama | Koşu ortalamalarının **aritmetik ortalaması** (`AverageOfMeansMiB`) |
| Tepe | Koşu tepelerinin **en büyüğü** (`PeakMiB`); en düşük koşu tepesi de yayılım için yazılır |
| Yayılım | min–max koşu tepesi; koşular arası fark %10'u aşıyorsa makine yükü not edilir |
| Bağlam | Senaryo tanımı referansı, ikili yolu + derleme profili, WebView2 sürümü, ölçüm tarihi, makine |

**Rapor formatı** (Markdown tablo, örnek şablon — sayılar ölçümle doldurulur):

```markdown
| Koşu | Toplam MB (koşu ortalama) | Koşu tepe (MB) | Örnek sayısı |
| ---- | ------------------------- | -------------- | ------------ |
| 1    | <sayı>                    | <sayı>         | <sayı>       |

- Ortalama (koşu ortalamalarının ortalaması): <sayı> MB
- Tepe (koşu tepelerinin maksimumu): <sayı> MB (yayılım: min <sayı> – max <sayı> MB)
- Bağlam: ikili yolu, derleme profili, WebView2 sürümü, tarih, makine
```

## 4. Süreç ağacı toplama kuralı

1. **Kök:** `md-editor.exe`; ölçüm anında tam olarak bir tane (bkz. §2 geçersizlik 1).
2. **Alt süreç bağı:** `Win32_Process` üzerinden **`ParentProcessId`**; kökten
   başlayıp sabit noktaya kadar **özyinelemeli** toplama. `msedgewebview2.exe`
   tarayıcı süreci kökün doğrudan çocuğu, renderer/GPU/utility süreçleri
   tarayıcı sürecinin çocuklarıdır; tek seviye toplama onları kaçırır.
   Döngü güvenliği PID `HashSet` üyeliğiyle sağlanır.
3. **Ad filtresi:** Ağaç kümesi yalnızca `md-editor.exe` ve
   `msedgewebview2.exe` adlı üyelere indirgenir; ad filtresi her zaman (2)'deki
   ağaç kümesiyle kesişimde uygulanır (makinede başka uygulamanın
   `msedgewebview2.exe` süreçleri de bulunabilir).
4. **Her örnekte yeniden topla:** PID listesi önbelleğe alınmaz; örnekleme
   döngüsünün her adımında ağaç yeniden çözülür (WebView2 çalışırken alt
   süreç doğurur/kapatır).

## 5. Araç ve ön koşullar

- **Araç:** Windows PowerShell 5.1 (`pwsh` varsa da çalışır) + `Get-Process`
  (`WorkingSet64`) + `Get-CimInstance Win32_Process` (`ProcessId`,
  `ParentProcessId`, `Name`). **Yeni bağımlılık yok.**
- **Ölçülen ikili:** release derlemesi (`src-tauri/target/release/md-editor.exe`).
- **Temiz başlangıç:** ölçümden önce çalışan `md-editor.exe` kalmamalıdır.
- **Makine durumu:** boşta, güç bağlı, ağır WebView2/Chromium/tarayıcı işi yok;
  karşılaştırma yalnızca aynı makine + aynı koşul setinde anlamlıdır.
- **Ön koşul:** senaryo kuruldu ve yerleşti (senaryo tanımı ayrı belgededir;
  burada yer almaz).

## 6. Adım adım prosedür (başandan sona)

1. Kalan `md-editor.exe` süreçlerini kapat.
2. Ölçüm için ayrı bir PowerShell oturumu aç ve §7'deki bloğu yapıştırıp
   çalıştır (fonksiyonlar tanımlanır, ölçüm başlamaz).
3. **Isınma koşusu (ölçüme girmez):** uygulamayı başlat, senaryoyu uygula,
   ölçümü bir kez yap ve sonucu **at**.
4. **Ölçülen koşu (× 3–5):** her koşu için:
   1. Uygulamayı kapat, sürecin tamamen sonlanmasını bekle, yeniden başlat.
   2. Senaryoyu yeniden uygula.
   3. Son işlemden sonra **10 s** yerleşme bekle.
   4. Örnekleme penceresi: **3 s**, aralık **250 ms**; her örnekte ağaç
      yeniden toplanır. Örnek sayısı < 2 ise koşu geçersizdir (§2).
   5. Kaydet: örnek sayısı, süreç sayısı (min–max), **koşu ortalama MB**,
      **koşu tepe MB**, ana süreç/WebView2 payı.
5. Geçersiz sayılan koşuları at, 3–5 geçerli koşu toplanana kadar tekrarla.
6. §3'teki özeti hesapla ve bağlam bilgisiyle birlikte kaydet.

## 7. Kopyalanabilir komut (aynen korunmuş)

Elle doğrulama bloğu — Windows PowerShell 5.1 uyumlu (`&&` kullanmaz). Senaryo
kurulduktan ve 10 s bekledikten sonra çalıştırılır:

```powershell
$ErrorActionPreference = 'Stop'

# Kök süreç + tüm msedgewebview2.exe alt süreçlerinin çalışma setleri (MiB).
function Get-AppTreeWorkingSet {
  param([string]$RootName = 'md-editor')

  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
  $roots = @($all | Where-Object { $_.Name -ieq ($RootName + '.exe') })
  if ($roots.Count -eq 0) { throw "Calisan $RootName.exe yok; once uygulamayi baslatin." }
  if ($roots.Count -gt 1) {
    throw ("Birden fazla $RootName.exe var (PID: {0}); artik surecleri kapatip yeniden deneyin." -f (($roots.ProcessId) -join ', '))
  }

  # ParentProcessId ile sabit noktaya kadar ozyineleme (PID kumesi donguyu keser).
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add([int]$roots[0].ProcessId)
  do {
    $added = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId)
        $added = $true
      }
    }
  } while ($added)

  $tree = @($all | Where-Object {
      $ids.Contains([int]$_.ProcessId) -and
      ($_.Name -ieq ($RootName + '.exe') -or $_.Name -ieq 'msedgewebview2.exe')
    })

  foreach ($p in $tree) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    [pscustomobject]@{
      Pid           = [int]$p.ProcessId
      Name          = $p.Name
      WorkingSetMiB = $proc.WorkingSet64 / 1MB
    }
  }
}

# Ornekleme penceresi: her ornekte agac yeniden toplanir.
function Measure-TotalWorkingSet {
  param([int]$Seconds = 3, [int]$IntervalMs = 250)

  $totals = New-Object 'System.Collections.Generic.List[double]'
  $counts = New-Object 'System.Collections.Generic.List[int]'
  $webviews = New-Object 'System.Collections.Generic.List[int]'
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $procs = @(Get-AppTreeWorkingSet)
    $counts.Add($procs.Count)
    $webviews.Add(@($procs | Where-Object { $_.Name -ieq 'msedgewebview2.exe' }).Count)
    $totals.Add((($procs | Measure-Object WorkingSetMiB -Sum).Sum))
    Start-Sleep -Milliseconds $IntervalMs
  }
  # Gecersizlik kurali: 2'den az ornek pencereyi kanitlamaz.
  if ($totals.Count -lt 2) { throw ('Yalnizca {0} ornek alinabildi; olcum gecersiz, pencereyi tekrarlayin.' -f $totals.Count) }

  # Pencere boyunca hic msedgewebview2.exe gorulmediyse WebView2 tarafi
  # sayilmamis demektir; gecersizlik kurali geregi kosu reddedilir.
  if ((($webviews | Measure-Object -Maximum).Maximum) -eq 0) {
    throw 'Agacta msedgewebview2.exe yok; WebView2 tarafi sayilmadi, kosu gecersiz.'
  }

  [pscustomobject]@{
    Samples       = $totals.Count
    ProcessesMin  = ($counts | Measure-Object -Minimum).Minimum
    ProcessesMax  = ($counts | Measure-Object -Maximum).Maximum
    WebViewsMin   = ($webviews | Measure-Object -Minimum).Minimum
    WebViewsMax   = ($webviews | Measure-Object -Maximum).Maximum
    PeakMiB       = [math]::Round(($totals | Measure-Object -Maximum).Maximum, 1)
    MeanMiB       = [math]::Round(($totals | Measure-Object -Average).Average, 1)
    RawSamples    = $totals
  }
}

# Senaryo kurulduktan sonra:
Start-Sleep -Seconds 10
$r = Measure-TotalWorkingSet -Seconds 3 -IntervalMs 250
'{0}-{1} surec ({2}-{3} WebView2), {4} ornek, tepe {5} MiB, ortalama {6} MiB' -f $r.ProcessesMin, $r.ProcessesMax, $r.WebViewsMin, $r.WebViewsMax, $r.Samples, $r.PeakMiB, $r.MeanMiB
```

İsteğe bağlı tanı (süreç bazında döküm):

```powershell
Get-AppTreeWorkingSet | Sort-Object WorkingSetMiB -Descending |
  Format-Table Pid, Name, @{ n = 'MiB'; e = { [math]::Round($_.WorkingSetMiB, 1) } } -AutoSize
```

Uçtan uca otomasyon (ısınma + N koşu + tepe/ortalama, §2–§4 kuralları dahil) —
script senaryo kurulumunu da yapar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-working-set.ps1 -Runs 3
```

> Bu ortamda `pwsh` PATH'te değildir (yalnızca Windows PowerShell 5.1 kurulu);
> `pwsh` varsa aynı komut `pwsh -NoProfile -File scripts/measure-working-set.ps1 -Runs 3`
> şeklinde çalışır.

> Elle bloklar **ham toplamı** ölçer. Bütçe kapısı bu blok değil,
> `node scripts/measure-perf.mjs --tabs 5 --runs 1 --max-rss-mib 150`
> komutudur (indirgenmiş toplam metriği, §1).
