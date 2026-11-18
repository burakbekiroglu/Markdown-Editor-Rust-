# Toplam çalışma seti ölçüm prosedürü (ana süreç + WebView2 alt süreçleri)

Bu belge, 5 sekme açıkken **toplam çalışma seti**nin nasıl ölçüleceğini adım adım
tanımlar: hangi süreçlerin toplandığı, alt süreçlerin ana sürece nasıl
bağlandığı, kullanılan araç ve tam komut, tekrar sayısı ve raporlanacak
metrikler.

Kapsam sınırı: bu görev yalnızca **prosedürü** tanımlar. Senaryo adımları,
baseline sayıları ve fiili ölçüm bu belgenin konusu değildir; **bu prosedür bu
görevde çalıştırılmamıştır.**

## 1. Metrik tanımı

**Toplam çalışma seti** bu prosedürde şu şekilde tanımlıdır:

> Σ `WorkingSet64` (bayt) — `md-editor.exe` kök süreci **ve** onun tüm
> `msedgewebview2.exe` alt süreçleri; MiB olarak (1 MiB = 1 048 576 bayt).

Görev metninde "MB" geçtiğinde kastedilen bu MiB değeridir: PowerShell'in `1MB`
sabiti de 1 048 576 bayttır, yani `WorkingSet64 / 1MB` doğrudan MiB üretir
(belgede tüm sayılar MiB'dir).

Bu **ham toplam**dır. WebView2/Chromium çalışma zamanı sayfaları (paylaşılan
DLL sayfaları) süreç ağacının her üyesinde yeniden sayıldığı için ham toplam,
fiziksel bellekte var olandan büyük bir sayı üretir. Bu yüzden:

- Ham toplam **tanı/rapor metriğidir**; bütçe kapısı değildir.
- `docs/PERFORMANCE.md` içindeki **≤ 150 MB bütçesi**, paylaşılan sayfaları
  `1 / ShareCount` ile indirgeyen *indirgenmiş* toplam çalışma setini kullanır
  (`scripts/measure-perf.mjs`, `QueryWorkingSetEx`). Ham toplam o eşikle
  karşılaştırılmaz ve "bütçe aşıldı/geçti" sonucu üretmez.

İki metrik aynı belgede raporlanacaksa etiketleri açık yazılmalıdır:
`ham toplam (WorkingSet64)` ve `indirgenmiş toplam (bütçe metriği)`.

## 2. Süreç ağacı toplama kuralı

1. **Kök:** `md-editor.exe`. Uygulama tek örnektir (single-instance); ölçüm
   anında **tam olarak bir** `md-editor.exe` olmalıdır. Birden fazlaysa ölçüm
   geçersizdir (artık süreç kapatılır, koşu yeniden başlatılır).
2. **Alt süreç bağı:** `Win32_Process` üzerinden **`ParentProcessId`**.
   Toplama, kökten başlayıp sabit noktaya kadar **özyinelemeli** yapılır:
   her turda `ParentProcessId`'si kümede olan süreçler kümeye eklenir; yeni
   süreç eklenmediğinde durulur. Döngü güvenliği PID'lerin `HashSet` üyeliğiyle
   sağlanır (PID yeniden kullanımı yeni üye gibi sayılmaz, aynı PID ikinci kez
   eklenmez).
   - Neden özyineleme: `msedgewebview2.exe` tarayıcı süreci doğrudan
     `md-editor.exe`'nin çocuğudur, ancak renderer/GPU/utility süreçleri
     **tarayıcı sürecinin** çocuklarıdır. Tek seviye toplama bunları kaçırır.
3. **Ad filtresi:** Toplanan küme yalnızca `md-editor.exe` ve
   `msedgewebview2.exe` adlı üyelere indirgenir. Chromium'un tüm alt süreç
   türleri (renderer, GPU, utility, network) `msedgewebview2.exe` adını taşır;
   ayrı ad kuralı gerekmez.
   - Yalnızca ada göre filtrelemek **yanlıştır**: makinede başka bir
     WebView2/Edge tabanlı uygulamanın `msedgewebview2.exe` süreçleri de
     bulunabilir. Ad filtresi her zaman (2)'deki ağaç kümesiyle kesişimde
     uygulanır.
4. **Her örnekte yeniden topla:** WebView2 çalışma sırasında alt süreç
   doğurur/kapatır. PID listesi koşu başında bir kez önbelleğe alınmaz;
   örnekleme döngüsünün **her adımında** ağaç yeniden çözülür.
5. **Yedek bağ anahtarı (yalnızca doğrulanırsa):** `ParentProcessId` kopmuşsa
   (ebeveyn beklenmedik şekilde sonlanmış/relaunch olmuş) aday süreçler, komut
   satırındaki bu uygulamaya ait WebView2 profil dizini (`--user-data-dir=…`)
   ile eşleştirilebilir. Bu, varsayılan yol değildir: kullanmadan önce
   `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
   Select ProcessId, ParentProcessId, CommandLine` çıktısında ilgili profil
   yolunun gerçekten göründüğü **teyit edilmelidir**. Teyit yoksa yalnızca (2)
   ve (3) uygulanır ve koşu geçersiz sayılır.

## 3. Araç ve ön koşullar

- **Araç:** Windows PowerShell 5.1 (veya `pwsh`) + `Get-Process`
  (`WorkingSet64`) + `Get-CimInstance Win32_Process` (`ProcessId`,
  `ParentProcessId`, `Name`). **Yeni bağımlılık yok**; harici sayaç, ETW veya
  profiler gerekmez.
  - Neden iki cmdlet: çalışma seti değeri **yalnızca** `Get-Process`
    `WorkingSet64` üzerinden okunur (toplam bu değerlerin toplamıdır).
    Windows PowerShell 5.1'de `Get-Process` çıktısı `ParentProcessId`
    içermez (bu ortamda doğrulandı), süreç ağacı ise yalnızca işletim sistemiyle
    birlikte gelen WMI sağlayıcısından (`Get-CimInstance Win32_Process`) alınır.
    Her ikisi de Windows'un parçasıdır; kurulum/indirme gerekmez.
- **Ölçülen ikili:** release derlemesi
  (`src-tauri/target/release/md-editor.exe`, `dist/` gömülü).
- **Temiz başlangıç:** Ölçümden önce çalışan `md-editor.exe` kalmamalıdır.
  Kalan süreç: `Get-Process md-editor -ErrorAction SilentlyContinue |
  Stop-Process -Force`.
- **Makine durumu:** boşta, güç bağlı, ağır WebView2/Chromium/tarayıcı işi yok.
  Karşılaştırma yalnızca aynı makinede ve aynı koşul setinde anlamlıdır.
- **Durum:** Ölçüm, senaryo kurulduktan (sekmeler açılıp gezildikten) ve
  yerleşme beklendikten **sonra** yapılır.

## 4. Adım adım prosedür

1. Kalan `md-editor.exe` süreçlerini kapat (§3).
2. Ölçüm için ayrı bir PowerShell oturumu aç ve §5'teki bloğu yapıştırıp
   çalıştır (fonksiyonlar tanımlanır, ölçüm başlamaz).
3. **Isınma koşusu (ölçüme girmez):** uygulamayı başlat, senaryoyu uygula,
   ölçümü bir kez yap ve sonucu **at**. Amaç WebView2 profilinin ısınması;
   böylece koşular arasındaki fark soğuk başlangıç farkı olmaz.
4. **Ölçülen koşu (× 3–5):** her koşu için:
   1. Uygulamayı kapat, yeniden başlat (her koşu taze süreç ağacıyla başlar).
   2. Senaryoyu yeniden uygula (aynı sekme sayısı/gezinti sırası).
   3. Son sekme etkinleştirildikten sonra **10 s** yerleşme bekle.
   4. Örnekleme penceresi: **3 s**, örnek aralığı **250 ms** (tur başına
      `Get-CimInstance` gideri ~50–100 ms olduğu için tipik olarak **8–12 örnek**;
      örnek sayısı raporlanır ve 2'nin altındaysa koşu geçersizdir). Her örnekte
      ağaç yeniden toplanır.
   5. Koşu için kaydet: örnek sayısı, süreç sayısı, **tepe (peak)** ve
      **ortalama (mean)** MiB.
5. Tekrar sayısı: **en az 3, tercihen 5**. Üçten az koşu raporlanmaz
   (varyans görülemez); 5 koşu medyan/tepe davranışını gösterir. Isınma koşusu
   sayıya dahil değildir.
6. Özet (§6) hesaplanır ve koşul setiyle (ikili yolu, derleme profili, sekme
   sayısı, WebView2 sürümü, ölçüm tarihi, makine) birlikte kaydedilir.

## 5. Kopyalanabilir komut

Aşağıdaki blok Windows PowerShell 5.1 ile uyumludur (`&&` kullanmaz). Önce
uygulamayı senaryo durumuna getirip 10 s bekleyin, sonra tek ölçümü çalıştırın:

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
  # §6 gecersizlik kurali: 2'den az ornek pencereyi kanitlamaz.
  if ($totals.Count -lt 2) { throw ('Yalnizca {0} ornek alinabildi; olcum gecersiz, pencereyi tekrarlayin.' -f $totals.Count) }

  # Pencere boyunca hic msedgewebview2.exe gorulmediyse WebView2 tarafi
  # sayilmamis demektir; §6 gecersizlik kurali geregi kosu reddedilir.
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

# 5 sekme senaryosu kurulduktan sonra:
Start-Sleep -Seconds 10
$r = Measure-TotalWorkingSet -Seconds 3 -IntervalMs 250
'{0}-{1} surec ({2}-{3} WebView2), {4} ornek, tepe {5} MiB, ortalama {6} MiB' -f $r.ProcessesMin, $r.ProcessesMax, $r.WebViewsMin, $r.WebViewsMax, $r.Samples, $r.PeakMiB, $r.MeanMiB
```

İsteğe bağlı tanı: süreç bazında döküm (hangi alt süreç ne kadar tutuyor):

```powershell
Get-AppTreeWorkingSet | Sort-Object WorkingSetMiB -Descending |
  Format-Table Pid, Name, @{ n = 'MiB'; e = { [math]::Round($_.WorkingSetMiB, 1) } } -AutoSize
```

> Bu bloklar (2)–(4) kurallarını uygular ve **ham toplamı** ölçer. Bütçe kapısı
> bu blok değil, `node scripts/measure-perf.mjs --tabs 5 --runs 1 --max-rss-mib 150`
> komutudur (§1).

## 6. Raporlanacak metrikler ve kuralları

Her tekrar (koşu) için raporlanan **"toplam MB" değeri, o koşunun örnekleme
penceresindeki toplamların aritmetik ortalamasıdır** (aşağıdaki *koşu ortalama*
satırı). Tekrar karşılaştırması bu tek sayı üzerinden yapılır; **tepe** ayrıca
yazılır çünkü ortalama, pencere içindeki kısa süreli sıçramayı gizler.

Her koşu için (MiB, 0.1 hassasiyetle):

| Alan | Tanım |
| --- | --- |
| Koşu tepe (peak) | Koşu içindeki örnek toplamlarının **en büyüğü** (süreç başına maksimumların toplamı değil) |
| Koşu ortalama (mean) | Koşudaki örnek toplamlarının **aritmetik ortalaması** |
| Süreç / örnek sayısı | Ağaç üye sayısı (örnekleme penceresi boyunca min–max) ve penceredeki örnek sayısı (ölçüm geçerliliği kanıtı) |
| Ana süreç / WebView2 payı | `md-editor.exe` toplamı ve `msedgewebview2.exe` toplamı (tanı) |

Koşular arası özet:

| Alan | Kural |
| --- | --- |
| Tekrar sayısı | 3–5 ölçülen koşu (+1 ısınma, sayılmaz) |
| Ortalama | Koşu ortalamalarının ortalaması (`AverageOfMeansMiB`) |
| Tepe | Koşu tepelerinin en büyüğü (`PeakMiB`); en düşük koşu tepesi de yayılım için yazılır |
| Yayılım | min–max koşu tepesi; koşular arası fark %10'u aşıyorsa makine yükü not edilir |
| Bağlam | Sekme sayısı, ikili yolu ve derleme profili, WebView2 sürümü, ölçüm tarihi, makine |

Geçersizlik kuralları (sayı "0 MiB" veya "geçti" olarak raporlanmaz):

- Ölçüm anında `md-editor.exe` yok veya birden fazla var → koşu geçersiz.
- Ağaçta hiç `msedgewebview2.exe` üyesi yok → WebView2 tarafı sayılmamış
  demektir; koşu geçersiz, pencere yeniden ölçülür.
- Örnek sayısı < 2 → pencere yetersiz; koşu tekrarlanır.
- Ölçüm sırasında eşzamanlı ağır iş (derleme, tarayıcı, başka ölçüm) varsa koşu
  notlanır ve mümkünse tekrarlanır.

## 7. Mevcut otomasyon

Aynı ölçümü (kök + alt süreçler, `WorkingSet64`, ısınma + N koşu, tepe/ortalama)
uçtan uca yürüten script: `scripts/measure-working-set.ps1`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-working-set.ps1 -Runs 3
```

> Bu ortamda `pwsh` PATH'te değildir (yalnızca Windows PowerShell 5.1 kurulu);
> `pwsh` varsa aynı komut `pwsh -NoProfile -File scripts/measure-working-set.ps1 -Runs 3`
> şeklinde çalışır.

Script senaryo kurulumunu da yapar; bu belgedeki §3–§6 kuralları (tek örnek
kontrolü, `ParentProcessId` ile özyineleme, ad filtresiyle kesişim, ısınmanın
sayılmaması, tepe/ortalama) onun da temelidir. Elle doğrulama veya script
olmadan ölçüm için §5'teki blok kullanılır.
