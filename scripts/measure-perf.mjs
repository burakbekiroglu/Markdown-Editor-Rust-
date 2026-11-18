/**
 * Release performans ölçüm koşucusu.
 *
 * Gerçek release ikilisini (`src-tauri/target/release/md-editor.exe`) WebView2
 * ile başlatır ve CDP üzerinden ölçüm yapar:
 *
 * - **İlk boya:** `app:first-paint` performance mark'ı ve Rust
 *   `report_first_paint` komutunun döndürdüğü `Instant` süresi.
 * - **Bellek:** süreç ağacının (uygulama + WebView2 alt süreçleri) **toplam özel
 *   çalışma seti** (`WorkingSetPrivate` toplamı); boşta ve N sekme açıkken ayrı
 *   ayrı. Bu, Görev Yöneticisi'nin "Bellek" sütunuyla aynı tanımdır: paylaşılan
 *   WebView2/Chromium DLL sayfaları bir kez sayılır. Ham `WorkingSet` toplamı da
 *   tanı için yazdırılır ama aynı fiziksel sayfaları süreç başına yeniden saydığı
 *   için bütçe metriği değildir (bkz. `MEMORY_METRIC`).
 * - **Ağ:** açılışta yüklenen tüm kaynakların yerel Tauri/asset/IPC
 *   origin'lerinden geldiği doğrulanır; dış origin varsa hata verilir.
 *
 * 20 sekme profili, uygulamanın kendi oturum dosyasına (`session.json`) 20
 * girişlik geçerli bir oturum yazılarak kurulur; mevcut oturum yedeklenir ve
 * ölçüm sonunda geri konur. WebView2 için ayrı bir profil dizini kullanılır.
 *
 * Kullanım:
 *   npm run perf:measure
 *   node scripts/measure-perf.mjs --tabs 20 --runs 3
 *   npm run perf:startup            # 1 soğuk + 1 ısınma + 5 sıcak, boşta CPU
 *   node scripts/measure-perf.mjs --startup --warm-runs 5 --gate-startup
 *   node scripts/measure-perf.mjs --startup --step-timeout-ms 20000
 *     # her adımın sınırını 20 s'ye indirir (tanılama: hangi adımda durduğu
 *     # `[adım-json]` satırlarından okunur)
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const tabsArg = args.indexOf('--tabs');
const TABS = tabsArg >= 0 ? Number(args[tabsArg + 1]) : 20;
const runsArg = args.indexOf('--runs');
const RUNS = runsArg >= 0 ? Number(args[runsArg + 1]) : 3;
const maxRssArg = args.indexOf('--max-rss-mib');
/**
 * Sekmeli profilde izin verilen en yüksek toplam özel çalışma seti (MiB);
 * yoksa bütçe denetlenmez. Bkz. `MEMORY_METRIC` — metrik tanımı rapora da yazılır.
 */
const MAX_RSS_MIB =
  maxRssArg >= 0 && Number.isFinite(Number(args[maxRssArg + 1]))
    ? Number(args[maxRssArg + 1])
    : null;
const jsonOutArg = args.indexOf('--json-out');
/** Makine-okunur özetin yazılacağı dosya; verilmezse yalnızca stdout'a yazılır. */
const JSON_OUT = jsonOutArg >= 0 ? resolve(args[jsonOutArg + 1]) : null;
/**
 * Sekmeli profilde **her** sekmeyi sırayla etkinleştirir.
 *
 * Oturum geri yüklemesi yalnızca sekme listesini kurar; belge ve önizleme
 * arabellekleri sekme ilk kez görünür olduğunda yüklenir. Beş sekmeyi
 * ziyaret etmeden ölçüm yapmak, dört sekmenin editör/önizleme tutmayacağı bir
 * senaryoyu "5 sekme" diye raporlar. Bu bayrak, sekmeye özgü kalıcı belleğin
 * (CodeMirror belgesi + sözdizimi ağacı) gerçekten ölçülmesini sağlar.
 */
const VISIT_TABS = args.includes('--visit-tabs');
/**
 * Açılış modu: yalnızca sıcak/soğuk başlatma ve boşta CPU ölçülür.
 * Varsayılan profil matrisi (boşta + çok sekme) bu modda çalışmaz.
 */
const STARTUP_MODE = args.includes('--startup');
const warmRunsArg = args.indexOf('--warm-runs');
/** Ardışık sıcak başlatma sayısı; kabul kriteri 5. */
const WARM_RUNS = warmRunsArg >= 0 ? Number(args[warmRunsArg + 1]) : 5;
const idleCpuArg = args.indexOf('--idle-cpu-ms');
/** Boşta CPU örnekleme penceresi (ms). Uzun pencere, 15.6 ms'lik CPU saatine daha ince çözünürlük verir. */
const IDLE_CPU_MS =
  idleCpuArg >= 0 && Number.isFinite(Number(args[idleCpuArg + 1]))
    ? Number(args[idleCpuArg + 1])
    : 5000;
const maxIdleCpuArg = args.indexOf('--max-idle-cpu');
/**
 * Boşta CPU üst sınırı, **tüm makine kapasitesinin** yüzdesi olarak.
 * Tek çekirdek yüzdesi de raporlanır, ancak eşik makine kapasitesine göre
 * verilir: "sıfıra yakın" iddiası, Görev Yöneticisi'nin gösterdiği değerle
 * aynı tanımda olmalıdır.
 */
const MAX_IDLE_CPU_PERCENT =
  maxIdleCpuArg >= 0 && Number.isFinite(Number(args[maxIdleCpuArg + 1]))
    ? Number(args[maxIdleCpuArg + 1])
    : 1;
/** Kabul kriteri eşikleri (ms). */
const WARM_BUDGET_MS = 900;
const COLD_BUDGET_MS = 3000;
const GATE_STARTUP = args.includes('--gate-startup');
/**
 * Ölçümden sonra baseline karşılaştırmasını aynı süreçte çalıştırır.
 *
 * `npm run perf:regression` önceden iki node komutunu `&&` ile zincirliyordu;
 * kabul doğrulayıcıları kabuk operatörü içeren komutları reddettiği için adım
 * makine tarafından çalıştırılamıyordu. Bu bayrak ölçüm + karşılaştırmayı tek
 * ve operatörsüz bir komuta indirir.
 */
const COMPARE_BASELINE = args.includes('--compare-baseline');
const baselineArg = args.indexOf('--baseline');
/** Karşılaştırmada kullanılacak baseline dosyası. */
const BASELINE_PATH = resolve(
  baselineArg >= 0 && args[baselineArg + 1] !== undefined
    ? args[baselineArg + 1]
    : 'perf/startup-baseline.json',
);
const maxRunArg = args.indexOf('--max-run-ms');
/**
 * Koşumun **tamamı** için üst sınır (ms). Tek bir adım zaman aşımına düşmese
 * bile (ör. PowerShell alt süreci, WebView2 yanıtı, CDP soketi) koşum bu süreyi
 * aşarsa kısmi örnekler yazılır, açık süreçler temizlenir ve süreç sonlanır.
 *
 * **Neden 300 s değil:** koşumu başlatan araç çağrısının kendi bütçesi de
 * 300 s'dir. Watchdog tam o anda ateşlerse çağıran taraf önce vazgeçer; süreç
 * öldürülür, kısmi örnek yazılmaz ve arıza "askıda kaldı" olarak görünür
 * (gözlenen hata: `awaitTasks timed out waiting for task …`). Sınır, çağıranın
 * bütçesinin **altında** kalmalıdır ki kısmi kayıt + süreç temizliği çağıran
 * vazgeçmeden tamamlansın. 240 s, 60 s'lik payı temizlik ve kayıt için bırakır.
 */
const DEFAULT_MAX_RUN_MS = 240_000;
const MAX_RUN_MS =
  maxRunArg >= 0 && Number.isFinite(Number(args[maxRunArg + 1]))
    ? Number(args[maxRunArg + 1])
    : DEFAULT_MAX_RUN_MS;
const stepTimeoutArg = args.indexOf('--step-timeout-ms');
/**
 * Her adımın kendi sınırını **geçemeyeceği** yapılandırılabilir üst sınır (ms).
 *
 * Adımlar kendi bütçelerini taşır (`--visit-tabs` gibi adımlar sekme sayısıyla
 * ölçeklenir); bu ayar onları **kısaltır, uzatmaz**. Tanılama için: tüm
 * sınırları tek bir küçük değere indirip koşumun hangi adımda durduğu kesin
 * olarak okunabilir. Kaynak sırası `--step-timeout-ms`, sonra
 * `PERF_STEP_TIMEOUT_MS`; ikisi de yoksa `null` (adımlar kendi sınırlarını
 * kullanır).
 */
const STEP_TIMEOUT_CAP_MS = (() => {
  const fromArg = stepTimeoutArg >= 0 ? Number(args[stepTimeoutArg + 1]) : NaN;
  if (Number.isFinite(fromArg) && fromArg > 0) return fromArg;
  const fromEnv = Number(process.env.PERF_STEP_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
})();
const peerWaitArg = args.indexOf('--peer-wait-ms');
/**
 * Eşzamanlı bir ölçüm koşucusu veya açık bir `md-editor.exe` varken beklenecek
 * en uzun süre (ms). Tek örnekli uygulama ve paylaşılan CDP portu yüzünden
 * eşzamanlı ölçüm geçersizdir; bu sınır dolunca koşum adı konmuş bir hatayla ve
 * kısmi kayıtla biter (süresiz beklemez).
 */
const PEER_WAIT_MS =
  peerWaitArg >= 0 && Number.isFinite(Number(args[peerWaitArg + 1]))
    ? Number(args[peerWaitArg + 1])
    : 60_000;
const DEBUG_PORT = 9337;
const exe = resolve('src-tauri/target/release/md-editor.exe');
const configDir = join(process.env.APPDATA ?? '', 'com.mdeditor.app');
const sessionPath = join(configDir, 'session.json');
// Yedek yolu süreç başına benzersizdir: aynı projede eşzamanlı bir ölçüm
// çalışırsa sabit yol paylaşılır ve birinin `rmSync(backupPath)` çağrısı
// diğerinin yedeğini siler; geri koyma `ENOENT, copyfile` ile düşer.
const backupPath = resolve(`.temp_files/session-backup-${process.pid}.json`);
/**
 * Tek koşucu kilidi dosyası.
 *
 * Tek örnekli uygulama + paylaşılan CDP portu yüzünden iki ölçüm koşucusu
 * eşzamanlı çalışamaz; çalışırsa biri diğerinin uygulamasını temizlik adımında
 * adıyla öldürür ve ölçüm "uygulama ölçüm sırasında çıktı (code=4294967295)"
 * ile boş kalır. Süreç taramasına dayanan yoklama bu yarışı kapatmaz (iki koşum
 * aynı anda "engel yok" görebilir); atomik `wx` açılışı kapatır.
 */
const lockPath = resolve('.temp_files/perf-runner.lock');
const workspace = resolve('.temp_files/perf-workspace');
// WebView2 profil dizini süreç başına benzersizdir: kesintiye uğramış bir
// çalıştırma kendi `md-editor.exe`'si öldürülüp WebView2 alt süreçleri kaldığında
// profil dizinini kilitleyebilir; sonraki ölçüm o zaman WebView2'yi hiç açamaz
// ve "süreç ağacı kökü çalışma seti sorgusunda yok" hatasıyla düşer. Ayrı dizin
// kilidi imkânsız kılar; tek ölçüm içindeki koşular profili paylaşmaya devam
// eder, böylece sıcak/soğuk açılış semantiği değişmez.
const webviewProfile = resolve(`.temp_files/perf-webview-profile-${process.pid}`);
/** Açılışta kabul edilen yerel origin'ler. */
const LOCAL_ORIGINS = new Set([
  'http://tauri.localhost',
  'http://ipc.localhost',
  'http://asset.localhost',
  'http://mdasset.localhost',
]);

if (!existsSync(exe)) {
  console.error(
    `release ikilisi bulunamadı: ${exe}\nÖnce "cargo build --release --manifest-path src-tauri/Cargo.toml" çalıştırın.`,
  );
  process.exit(2);
}

/** Zaman damgalı adım günlüğü: askıda kalan adımı çıktıdan doğrudan okutur. */
function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
}

/**
 * Bir promise'e kesin üst sınır koyar.
 *
 * Askıda kalma, tek bir `await`'in hiç settle olmamasıyla başlar: payload'ı hiç
 * gelmeyen bir CDP yanıtı, hiç açılmayan bir WebSocket veya kapanmayan bir alt
 * süreç. `Promise.race` bu durumda adımı adıyla birlikte hataya çevirir; süre
 * dolduğunda bekleyen promise terk edilir ve temizlik `cleanupAll()`'a kalır.
 */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label}: ${timeoutMs} ms içinde tamamlanmadı (adım askıda kaldı).`,
      );
      // Süre dolması sıradan bir hatadan ayrılır: yapılandırılmış adım günlüğü
      // `timeout` durumunu bu bayraklardan yazar, ayrıca alanlar kısmi kayda ve
      // dış çağıranın hata metnine adım adı + sınır olarak geçer.
      error.stepTimeout = true;
      error.stepLabel = label;
      error.stepDeadlineMs = timeoutMs;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Şu anda yürüyen adımın etiketi ve başlangıç zamanı.
 *
 * Watchdog ya da sinyal yolu koşumu kestiğinde "hangi adımda askıda kaldı"
 * sorusunun cevabı budur: adım adıyla birlikte kısmi kayda ve stderr'e yazılır.
 * `step()` her adımda günceller; iç içe adım yoktur, tek bir değer yeterlidir.
 */
const stepTracker = { label: null, startedAt: null, deadlineMs: null };

/**
 * Yapılandırılmış adım günlüğü satırı.
 *
 * İnsan-okur `[adım]` satırının yanına makine-okur tek satırlık JSON yazılır:
 * adım adı, sınır (deadline), gerçek süre ve durum (`ok` | `timeout` | `error`).
 * Dış çağıran ("awaitTasks timed out waiting for task …") vazgeçtiğinde
 * geriye kalan bu satırlar adım sırasını ve süreleri kanıt olarak bırakır.
 */
function logStepRecord(record) {
  log(`[adım-json] ${JSON.stringify(record)}`);
}

/** Adımı adıyla ve süresiyle çalıştırır; hata dalında son adımı günlüğe yazar. */
async function step(label, timeoutMs, fn) {
  const startedAt = Date.now();
  // Yapılandırılmış üst sınır her adımın kendi bütçesini kısaltır, uzatmaz.
  const deadlineMs =
    STEP_TIMEOUT_CAP_MS === null ? timeoutMs : Math.min(timeoutMs, STEP_TIMEOUT_CAP_MS);
  stepTracker.label = label;
  stepTracker.startedAt = startedAt;
  stepTracker.deadlineMs = deadlineMs;
  log(`[adım] ${label} … (sınır ${deadlineMs} ms)`);
  try {
    const value = await withTimeout(Promise.resolve().then(fn), deadlineMs, label);
    const durationMs = Date.now() - startedAt;
    log(`[adım] ${label} tamam (${durationMs} ms)`);
    logStepRecord({ step: label, status: 'ok', deadlineMs, durationMs });
    stepTracker.label = null;
    stepTracker.startedAt = null;
    stepTracker.deadlineMs = null;
    return value;
  } catch (error) {
    // Takipçi bilerek dolu bırakılır: watchdog/sinyal yolu "askıda kalınan
    // adım"ı bu değerden yazar.
    const durationMs = Date.now() - startedAt;
    const status = error.stepTimeout === true ? 'timeout' : 'error';
    log(`[adım] ${label} BAŞARISIZ (${durationMs} ms): ${error.message}`);
    logStepRecord({
      step: label,
      status,
      deadlineMs,
      durationMs,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Koşul-tabanlı bekleme: okuma fonksiyonu koşulu sağlayan değeri döndürdüğünde
 * biter, aksi hâlde kesin süre dolunca hata verir.
 *
 * Her çağrı kendi üst sınırını taşır; böylece "sonsuz yoklama" yerine tek bir
 * sınırlı bekleme olur ve hangi koşulun sağlanmadığı hata metninde görünür.
 */
async function waitForCondition(label, { timeoutMs, intervalMs = 50, read }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await read();
    if (last !== null && last !== undefined) return last;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `${label}: ${timeoutMs} ms içinde koşul sağlanmadı (son değer: ${JSON.stringify(last)}).`,
  );
}

/**
 * PowerShell komutunu **asenkron** çalıştırır ve kırpılmış çıktısını döndürür.
 *
 * Senkron (`execFileSync`) çağrı Node'un olay döngüsünü kilitler: o süre
 * boyunca **ne adım zaman aşımı ne de koşum watchdog'u ateşlenebilir**. CIM
 * sorgusu ya da çalışma seti taraması yüklü bir makinede saniyeler sürdüğünde
 * koşum kendi sınırlarını aşıyor ve çağıranın görev bütçesini tüketiyordu
 * (gözlenen hata: `awaitTasks timed out`). Asenkron çağrı olay döngüsünü
 * serbest bırakır; adım sınırı, watchdog ve sinyal yolu gerçekten çalışır.
 */
function powershell(script, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', script],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error === null) {
          resolvePromise(String(stdout).trim());
          return;
        }
        // Askıda kalan bir PowerShell alt süreci tüm koşumu süresiz bekletmemeli.
        if (error.killed || error.code === 'ETIMEDOUT') {
          reject(
            new Error(
              `PowerShell komutu ${timeoutMs} ms içinde bitmedi (askıda kaldı); sonlandırıldı.`,
            ),
          );
          return;
        }
        reject(error);
      },
    );
  });
}

/** Açık kalan uygulama ve WebView2 süreçlerini temizler. */
async function cleanupAll() {
  // Temizlik en iyi çaba iledir: süreçler bu arada kendiliğinden kapanabilir.
  // PowerShell'in son komutun başarısızlığını süreç çıkış koduna çevirmesi
  // ölçümü durdurmamalıdır, bu yüzden script her durumda 0 ile biter.
  // Temizliğin kendisi de sınırlıdır: askıda kalan bir `Stop-Process` çağrısı
  // hata yolunda koşumu süresiz bekletirse "garantili temizlik" olmaz.
  try {
    await powershell(
      `
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'md-editor*.exe' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $own = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*com.mdeditor.app*' -or $_.CommandLine -like '*perf-webview-profile*' }
    foreach ($p in $own) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    exit 0
  `,
      10_000,
    );
  } catch (error) {
    log(`[temizlik] süreçler tamamen kapatılamadı: ${error.message}`);
  }
}

async function cdpReachable() {
  try {
    return (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function waitForCleanPort() {
  await waitForCondition('CDP portu temizliği', {
    timeoutMs: 10_000,
    intervalMs: 150,
    read: async () => {
      if (!(await cdpReachable())) return true;
      await cleanupAll();
      return null;
    },
  });
}

/**
 * Bu koşumla çakışan başka bir ölçüm koşucusunun node süreç kimlikleri.
 *
 * Uygulama tek örneklidir (`tauri-plugin-single-instance`): başka bir ajanın
 * ölçümü `md-editor.exe` çalıştırırken bu koşumun başlattığı süreç sessizce
 * çıkar. Ayrıca her iki koşucu da temizlikte `md-editor.exe`'yi **adıyla**
 * sonlandırır, yani birbirini örnekleme penceresinin ortasında öldürür. Bu
 * yüzden çakışma, 25 s'lik anlaşılmaz bir "CDP sayfa hedefi" zaman aşımı ya da
 * "süreç ağacı kökü yok" hatası olarak değil, adı konmuş bir bekleme olarak
 * ele alınır.
 */
async function findPeerRunners() {
  const output = await powershell(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object {
         $_.ProcessId -ne ${process.pid} -and
         $_.CommandLine -and
         ($_.CommandLine -like '*measure*' -or $_.CommandLine -like '*leak-check*')
       } |
       ForEach-Object { $_.ProcessId }
     exit 0`,
    10_000,
  );
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Çalışan `md-editor` süreç kimlikleri (kendi başlattığımız süreç dahil).
 *
 * Tek örnek kilidi uygulama kimliğine bağlıdır, çalıştırılabilir dosya adına
 * değil: farklı adla kopyalanmış bir ikili (`md-editor-*.exe`) de kilidi tutar
 * ve yeni başlatılan süreç pencere açmadan 0 koduyla çıkar. Bu yüzden eşleşme
 * `md-editor*.exe` üzerinden yapılır; aksi hâlde engel "yok" görünür ve arıza
 * adı konmamış bir zaman aşımı gibi okunur.
 */
async function findAppProcesses() {
  const output = await powershell(
    `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -like 'md-editor*.exe' } |
       ForEach-Object { $_.ProcessId }
     exit 0`,
    10_000,
  );
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Koşumun başlayabilmesi için tek örnek + tek koşucu olmasını bekler.
 *
 * Bekleme **koşul tabanlıdır** (yoklama değil): koşul sağlanır sağlanmaz döner,
 * sağlanmazsa kesin süre dolunca hangi sürecin engellediğini adıyla söyleyerek
 * hata verir. Böylece çakışma, koşumun süresiz askıda kalmasına dönüşmez.
 */
/** Kilit dosyasındaki sahibi okur; dosya yoksa/bozuksa `null`. */
function readRunnerLock() {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Süreç hâlâ canlı mı? (kilit sahibinin çökmüş olup olmadığını ayırt eder) */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: süreç var ama sinyal yetkimiz yok — yine de canlı sayılır.
    return error.code === 'EPERM';
  }
}

let lockHeld = false;

/**
 * Tek koşucu kilidini alır; alınamazsa **kesin süre** dolunca adı konmuş hata
 * verir. Bekleme koşul tabanlıdır: kilit bırakıldığı anda döner, yoklama
 * döngüsü yoktur ve süre sınırı çağıranın bütçesini aşmaz.
 *
 * Sahibi ölmüş bir kilit (çökmüş/öldürülmüş koşum) bayat sayılır ve alınır;
 * aksi hâlde tek bir kesinti tüm sonraki ölçümleri kilitli bırakırdı.
 */
async function acquireRunnerLock({ timeoutMs, intervalMs = 500 }) {
  let holder = null;
  try {
    await waitForCondition('tek koşucu kilidi', {
      timeoutMs,
      intervalMs,
      read: async () => {
        holder = readRunnerLock();
        if (holder !== null && !isPidAlive(holder.pid)) {
          log(`[kilit] bayat kilit (PID ${holder.pid} artık yok) temizlendi.`);
          rmSync(lockPath, { force: true });
          holder = null;
        }
        if (holder !== null) return null;
        try {
          const fd = openSync(lockPath, 'wx');
          writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          );
          closeSync(fd);
          lockHeld = true;
          return true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          return null;
        }
      },
    });
  } catch (error) {
    throw new Error(
      `başka bir ölçüm koşucusu ${timeoutMs} ms içinde kilidi bırakmadı ` +
        `(PID ${holder?.pid ?? 'yok'}, ${lockPath}); eşzamanlı ölçüm geçersizdir. ` +
        'Diğer koşum bitince tekrar deneyin veya --peer-wait-ms ile süreyi artırın. ' +
        `Ayrıntı: ${error.message}`,
    );
  }
}

/** Kilidi yalnızca sahibi olduğumuzda bırakır; birden çok kez çağrılabilir. */
function releaseRunnerLock() {
  if (!lockHeld) return;
  lockHeld = false;
  const holder = readRunnerLock();
  if (holder !== null && holder.pid !== process.pid) return;
  rmSync(lockPath, { force: true });
}

async function waitForExclusiveRunner({ timeoutMs, intervalMs = 1000 }) {
  // Kalan uygulama süreçleri önce temizlenir: kesintiye uğramış bir koşumdan
  // artakalan `md-editor*.exe` tek örnek kilidini tutar ve bu kapı onu yalnızca
  // "engel" olarak raporlarsa koşum hiç başlamadan, süresi dolmuş bir beklemeyle
  // düşer. Temizlik koşucunun kendi sözleşmesidir (`runProfile` da ilk adımda
  // yapar); burada yapılması "artık süreç" arızasını kendiliğinden onarır.
  // Bekleme yalnızca *başka bir koşucu* (node `measure-*.mjs`) için anlamlıdır.
  await cleanupAll();
  let apps = [];
  try {
    await waitForCondition('tek örnek / tek koşucu', {
      timeoutMs,
      intervalMs,
      read: async () => {
        apps = await findAppProcesses();
        return apps.length === 0 ? true : null;
      },
    });
  } catch (error) {
    throw new Error(
      `${error.message} Engeller: md-editor.exe PID ${apps.join(', ') || 'yok'}. ` +
        'Eşzamanlı ölçüm geçersizdir (tek örnekli uygulama + paylaşılan CDP portu); ' +
        'diğer koşum bitince tekrar deneyin veya --peer-wait-ms ile bekleme süresini artırın.',
    );
  }
}

/**
 * Çalışma seti sayfalarını paylaşım sayısına göre indirgeyen PowerShell/C#
 * yardımcısı (bkz. `MEMORY_METRIC`).
 *
 * `QueryWorkingSetEx` her yerleşik sayfa için `Shared` bitini ve `ShareCount`
 * alanını döndürür. Özel sayfalar tam, paylaşılan sayfalar `1 / ShareCount`
 * kadar sayıldığında süreç ağacının toplam çalışma seti her fiziksel sayfayı
 * bir kez içerir: aynı WebView2 çalışma zamanı sayfaları süreç başına
 * çoğaltılmaz.
 */
const WORKING_SET_DEDUPE_PS = `
    if (-not ("WsDedupe" -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WsDedupe {
  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public IntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PSAPI_WORKING_SET_EX_INFORMATION {
    public IntPtr VirtualAddress;
    public IntPtr Flags;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr VirtualQueryEx(IntPtr handle, IntPtr address, out MEMORY_BASIC_INFORMATION info, IntPtr length);
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool QueryWorkingSetEx(IntPtr handle, [In, Out] PSAPI_WORKING_SET_EX_INFORMATION[] info, uint bytes);
  public static long[] Measure(int pid) {
    IntPtr handle = OpenProcess(0x0410, false, pid);
    if (handle == IntPtr.Zero) return new long[] { -1, -1 };
    long privateBytes = 0;
    double sharedBytes = 0;
    const int pageSize = 4096;
    try {
      long address = 0;
      MEMORY_BASIC_INFORMATION region;
      int regionSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
      int pageInfoSize = Marshal.SizeOf(typeof(PSAPI_WORKING_SET_EX_INFORMATION));
      while (true) {
        IntPtr queried = VirtualQueryEx(handle, new IntPtr(address), out region, new IntPtr(regionSize));
        if (queried == IntPtr.Zero) break;
        long baseAddress = region.BaseAddress.ToInt64();
        long size = region.RegionSize.ToInt64();
        if (region.State == 0x1000 && size > 0) {
          long pages = size / pageSize;
          long offset = 0;
          while (offset < pages) {
            int count = (int)Math.Min(4096, pages - offset);
            var info = new PSAPI_WORKING_SET_EX_INFORMATION[count];
            for (int i = 0; i < count; i++) {
              info[i].VirtualAddress = new IntPtr(baseAddress + (offset + i) * pageSize);
            }
            if (QueryWorkingSetEx(handle, info, (uint)(count * pageInfoSize))) {
              for (int i = 0; i < count; i++) {
                ulong flags = (ulong)info[i].Flags.ToInt64();
                if ((flags & 1) == 0) continue;
                int shareCount = (int)((flags >> 1) & 7);
                int isShared = (int)((flags >> 15) & 1);
                if (isShared == 1 && shareCount > 0) sharedBytes += (double)pageSize / shareCount;
                else privateBytes += pageSize;
              }
            }
            offset += count;
          }
        }
        long next = baseAddress + size;
        if (next <= baseAddress) break;
        address = next;
      }
    } finally {
      CloseHandle(handle);
    }
    return new long[] { privateBytes, (long)sharedBytes };
  }
}
'@
    }
`;

/**
 * Süreç ağacının her canlı üyesi için çalışma kümesi ve özel çalışma kümesi
 * (bayt). `WorkingSet` paylaşılan sayfaları her süreçte yeniden sayar; aynı
 * WebView2 çalışma zamanı DLL'leri süreç ağacının her üyesinde eşlendiği için
 * toplam şişer. `WorkingSetPrivate` yalnızca sürece özgü sayfaları sayar, bu
 * yüzden ağaç toplamı için fiziksel olarak sahiplenilebilir üst sınırı verir.
 * `dedupedWorkingSet` ise toplam çalışma setidir: özel sayfalar artı paylaşılan
 * sayfaların `1 / ShareCount` payı (bkz. `WORKING_SET_DEDUPE_PS`).
 */
async function rssByPid(rootPid) {
  const output = await powershell(`
    $root = ${rootPid}
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
    $ids = @($root)
    $added = $true
    while ($added) {
      $added = $false
      foreach ($p in $all) {
        if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId)) {
          $ids += $p.ProcessId
          $added = $true
        }
      }
    }
${WORKING_SET_DEDUPE_PS}
    $rows = @()
    $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue |
      Where-Object { $ids -contains $_.IDProcess }
    foreach ($sample in $perf) {
      $proc = Get-Process -Id $sample.IDProcess -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      # Win32_PerfFormattedData_PerfProc_Process sayaçları bayt cinsindendir.
      $pages = [WsDedupe]::Measure([int]$sample.IDProcess)
      $deduped = if ($pages[0] -lt 0) { $null } else { [double]$pages[0] + [double]$pages[1] }
      $rows += [PSCustomObject]@{
        id = [int]$sample.IDProcess
        name = $proc.ProcessName
        workingSet = [double]$sample.WorkingSet
        privateWorkingSet = [double]$sample.WorkingSetPrivate
        dedupedWorkingSet = $deduped
      }
    }
    $rows | ConvertTo-Json -Compress
  `);
  if (output.length === 0) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    id: row.id,
    name: row.name,
    workingSet: row.workingSet,
    privateWorkingSet: row.privateWorkingSet,
    dedupedWorkingSet: typeof row.dedupedWorkingSet === 'number' ? row.dedupedWorkingSet : null,
  }));
}

const MiB = 1024 * 1024;

/**
 * Bellek bütçesinin metriği.
 *
 * Kabul kriteri "5 sekme açıkken toplam çalışma seti ≤ 150 MB" der. Bir süreç
 * ağacı için "toplam çalışma seti" üç farklı şekilde okunabilir:
 *
 * - **Ham `WorkingSet` toplamı:** her sürecin çalışma setini toplar. WebView2 /
 *   Chromium aynı çalışma zamanı DLL'lerini ağacın her üyesinde eşlediği için
 *   aynı fiziksel sayfalar 4–8 kez sayılır; 0 sekmede bile ~330 MiB "görünür".
 *   Bu, hiçbir sürece ait olmayan paylaşılan sayfaları süreç sayısı kadar
 *   çoğalttığı için tüketim metriği olarak yanıltıcıdır.
 * - **`WorkingSetPrivate` toplamı:** her sürecin yalnızca kendisine ait
 *   sayfalarını toplar; paylaşılan runtime sayfaları hiç sayılmaz ve toplam,
 *   uygulamanın gerçekten sahiplendiği fiziksel belleğin alt sınırını verir.
 *   Windows Görev Yöneticisi'nin süreç başına "Bellek" sütunu ve
 *   `Get-Counter "\Process(*)\Working Set - Private"` aynı tanımı kullanır.
 * - **Toplam (indirgenmiş) çalışma seti:** özel sayfalar artı paylaşılan
 *   sayfaların `1 / ShareCount` payı (`QueryWorkingSetEx`). Her fiziksel sayfa
 *   bir kez sayılır; süreç ağacının gerçekten kapladığı bellek budur ve
 *   kriterin "toplam çalışma seti" ifadesinin doğrudan karşılığıdır.
 *
 * Bütçe son tanımla denetlenir; özel toplam ve ham toplam tanı olarak
 * raporlanır.
 */
const MEMORY_METRIC = {
  id: 'sum-working-set-deduped',
  definition:
    'Süreç ağacının toplam çalışma seti = Σ özel sayfalar + Σ (paylaşılan sayfa / ShareCount); her fiziksel sayfa bir kez',
  source: 'QueryWorkingSetEx (PSAPI) — süreç ağacının tüm üyeleri',
  rationale:
    'Ham WorkingSet toplamı paylaşılan WebView2/Chromium sayfalarını süreç başına yeniden sayarak fiziksel bellekte var olmayan bir toplam üretir; yalnızca özel sayfaları toplamak ise paylaşılan runtime sayfalarını hiç saymaz. Paylaşım sayısına bölerek indirgenen toplam, kriterin istediği "toplam çalışma seti"nin gerçek fiziksel karşılığıdır.',
  notBudgeted: 'ham WorkingSet toplamı (paylaşılan sayfalar çift sayılır) ve özel çalışma seti toplamı (paylaşılan sayfalar hiç sayılmaz) — tanı için raporlanır',
};

/**
 * Süreç ağacının bellek özeti (bkz. `MEMORY_METRIC`).
 *
 * CIM performans sınıfı ara sıra boş küme döndürür (sayaç yenilenirken veya
 * süreç ağacı yeni kurulurken). Boş örnek "0 MiB" olarak raporlanırsa bellek
 * bütçesi ölçümsüz geçer; bu yüzden örnek birkaç kez denenir ve hâlâ kök
 * süreç okunamıyorsa ölçüm açıkça başarısız sayılır.
 */
async function rssSummary(pid) {
  let rows = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    rows = await rssByPid(pid);
    if (rows.some((row) => row.id === pid)) break;
    if (attempt < 3) await sleep(250);
  }
  if (!rows.some((row) => row.id === pid)) {
    throw new Error(
      `bellek örneklemesi okunamadı: süreç ağacı kökü (pid ${pid}) çalışma seti sorgusunda yok.`,
    );
  }
  if (rows.some((row) => row.dedupedWorkingSet === null)) {
    throw new Error(
      'bellek örneklemesi okunamadı: `QueryWorkingSetEx` bir süreç için çalışma setini döndürmedi ' +
        '(süreç bu arada kapanmış olabilir).',
    );
  }
  const naiveSum = rows.reduce((sum, row) => sum + row.workingSet, 0);
  const privateBytes = rows.reduce((sum, row) => sum + row.privateWorkingSet, 0);
  const dedupedBytes = rows.reduce((sum, row) => sum + row.dedupedWorkingSet, 0);
  const mib = (bytes) => Number((bytes / MiB).toFixed(1));
  return {
    naiveSumMiB: mib(naiveSum),
    privateMiB: mib(privateBytes),
    dedupedMiB: mib(dedupedBytes),
    processes: rows.map((row) => ({
      name: row.name,
      naiveSumMiB: mib(row.workingSet),
      privateMiB: mib(row.privateWorkingSet),
      dedupedMiB: mib(row.dedupedWorkingSet),
    })),
  };
}

/** Süreç ağacının toplam CPU süresi (saniye); `Get-Process.CPU` = TotalProcessorTime. */
/**
 * Süreç ağacının her canlı üyesi için toplam CPU süresi (saniye), pid'e göre.
 *
 * Toplamı tek sayı olarak örneklemek güvenilir değildir: WebView2 alt süreçleri
 * işini bitirince ağaçtan çıkar ve toplam CPU geriye gider (negatif "tüketim").
 * Bu yüzden değerler pid bazında okunur; `cpuDeltaSeconds` yalnızca artışları
 * toplar.
 */
async function cpuByTreePid(rootPid) {
  const output = await powershell(`
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $ids = @(${rootPid})
    $added = $true
    while ($added) {
      $added = $false
      foreach ($p in $all) {
        if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId)) {
          $ids += $p.ProcessId
          $added = $true
        }
      }
    }
    $rows = @()
    foreach ($id in $ids) {
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($proc -and $null -ne $proc.CPU) {
        $rows += [PSCustomObject]@{ id = $proc.Id; cpu = [double]$proc.CPU }
      }
    }
    $rows | ConvertTo-Json -Compress
    exit 0
  `);
  if (output.length === 0) return [];
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({ id: row.id, cpu: row.cpu }));
}

/**
 * Aralık boyunca tüketilen CPU saniyesi.
 *
 * Önceden var olan süreçler yalnızca artışlarıyla katkı verir (pid yeniden
 * kullanılsa bile negatif değer üretmez); aralık içinde doğan süreçler tüm
 * ömürleriyle katkı verir, çünkü o süre aralığın içinde harcandı.
 */
function cpuDeltaSeconds(before, after) {
  const previous = new Map(before.map((row) => [row.id, row.cpu]));
  let total = 0;
  for (const row of after) {
    const start = previous.get(row.id);
    total += start === undefined ? row.cpu : Math.max(0, row.cpu - start);
  }
  return Math.max(0, total);
}

/**
 * Boşta CPU tüketimi.
 *
 * Süreç ağacının toplam CPU süresi iki örnek arasında ölçülür. Değerler iki
 * biçimde raporlanır:
 *
 * - `percentOfCore`: tek çekirdeğin yüzdesi (fark / geçen süre).
 * - `percentOfTotal`: tüm makine kapasitesinin yüzdesi (`cores`'a bölünür);
 *   Görev Yöneticisi'nin gösterdiği değerle aynı tanım. Eşik bununla denetlenir.
 *
 * `tail*` değerleri yalnızca ikinci yarı penceresini ölçer: yerleşim bittikten
 * sonra süren iş (tekrar eden bir arka plan zamanlayıcısı) kuyrukta görünür,
 * tek seferlik açılış işi ise yalnızca ilk yarıda kalır.
 */
async function sampleIdleCpu(rootPid, windowMs) {
  const halfMs = Math.max(1000, Math.round(windowMs / 2));
  const first = await cpuByTreePid(rootPid);
  await sleep(halfMs);
  const second = await cpuByTreePid(rootPid);
  await sleep(halfMs);
  const third = await cpuByTreePid(rootPid);

  const cores = cpus().length || 1;
  const percentOfCore = (seconds, elapsedMs) =>
    Number(((seconds / (elapsedMs / 1000)) * 100).toFixed(2));
  const percentOfTotal = (seconds, elapsedMs) =>
    Number((percentOfCore(seconds, elapsedMs) / cores).toFixed(3));

  const firstHalfSeconds = cpuDeltaSeconds(first, second);
  const secondHalfSeconds = cpuDeltaSeconds(second, third);
  const windowSeconds = firstHalfSeconds + secondHalfSeconds;

  return {
    windowMs: halfMs * 2,
    cores,
    percentOfCore: percentOfCore(windowSeconds, halfMs * 2),
    percentOfTotal: percentOfTotal(windowSeconds, halfMs * 2),
    tailPercentOfCore: percentOfCore(secondHalfSeconds, halfMs),
    tailPercentOfTotal: percentOfTotal(secondHalfSeconds, halfMs),
  };
}

async function findPageTarget() {
  return waitForCondition('CDP sayfa hedefi', {
    timeoutMs: 25_000,
    intervalMs: 25,
    read: async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        return (
          targets.find(
            (target) =>
              target.type === 'page' &&
              target.webSocketDebuggerUrl &&
              String(target.url).includes('tauri.localhost'),
          ) ?? null
        );
      } catch {
        // WebView2 henüz açılmadı.
        return null;
      }
    },
  });
}

function cdpEvaluate(ws, expression) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP yanıtı zaman aşımına uğradı')), 10_000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      ws.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolvePromise(data.result.result.value);
    };
    ws.addEventListener('message', onMessage);
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

const probe = `(() => {
  const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
  const mark = performance.getEntriesByName('app:first-paint').at(-1) ?? null;
  const rustMark = performance.getEntriesByName('app:first-paint:rust').at(-1) ?? null;
  return {
    now: performance.now(),
    href: location.href,
    fcp: paint ? paint.startTime : null,
    firstPaintMark: mark ? mark.startTime : null,
    rustFirstPaint: rustMark ? rustMark.startTime : null,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    resourceTimings: performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: Math.round(entry.startTime * 10) / 10,
      durationMs: Math.round(entry.duration * 10) / 10,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    })),
    tabs: document.querySelectorAll('[data-tab-id]').length,
    // Editör/önizleme arabelleklerinin JS heap payı: süreç toplamı WebView2
    // çalışma zamanını da içerir, bu değer yalnızca uygulama verisini gösterir.
    usedJSHeapMiB: (() => {
      const memory = performance.memory;
      if (memory === undefined || !Number.isFinite(memory.usedJSHeapSize)) return null;
      return Math.round((memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
    })(),
  };
})()`;

const rustProbe = `window.__TAURI_INTERNALS__
  .invoke('report_first_paint', { pageMs: 0 })
  .then((value) => value)
  .catch((error) => ({ error: String(error) }))`;

async function openSession(ws) {
  return waitForCondition('ilk boya (FCP)', {
    timeoutMs: 25_000,
    intervalMs: 20,
    read: async () => {
      const value = await cdpEvaluate(ws, probe);
      return typeof value.fcp === 'number' && value.fcp > 0 ? value : null;
    },
  });
}

async function waitForTabs(ws, expected) {
  return waitForCondition(`${expected} sekme listesi`, {
    timeoutMs: 25_000,
    intervalMs: 50,
    read: async () => {
      const value = await cdpEvaluate(ws, probe);
      return value.tabs >= expected ? value : null;
    },
  });
}

/** Etkin sekmenin görünür durumu: kimlik, editör arabelleği ve önizleme HTML'i. */
const tabStateProbe = `(() => {
  const pane = document.querySelector('.editor-pane');
  const content = document.querySelector('.editor-pane .cm-content');
  const preview = document.querySelector('.preview-pane');
  return {
    active: pane === null ? null : pane.getAttribute('data-tab'),
    docChars: content === null ? 0 : content.textContent.length,
    previewHtml: preview === null ? 0 : preview.innerHTML.length,
  };
})()`;

/**
 * Her sekmeyi sırayla etkinleştirir ve o sekmenin belge+önizleme
 * arabelleklerinin yüklendiğini doğrular.
 *
 * Sekme düğmesine gerçek bir `click` gönderilir: ölçüm, kullanıcı yolunun
 * aynısını izler ve belge okuma/debounce işini atlamaz. Dönen sayı, gerçekten
 * yüklenmiş sekme sayısıdır.
 */
async function visitAllTabs(ws, expected) {
  const ids = await cdpEvaluate(
    ws,
    `Array.from(document.querySelectorAll('[data-tab-id]')).map((el) => el.getAttribute('data-tab-id'))`,
  );
  if (!Array.isArray(ids) || ids.length < expected) {
    throw new Error(`ziyaret için ${expected} sekme yok (bulunan: ${ids?.length ?? 0}).`);
  }
  let loaded = 0;
  for (const id of ids.slice(0, expected)) {
    const clicked = await cdpEvaluate(
      ws,
      `(() => {
        const el = document.querySelector('[data-tab-id="${id}"]');
        if (el === null) return false;
        el.click();
        return true;
      })()`,
    );
    if (clicked !== true) throw new Error(`${id} sekmesi etkinleştirilemedi.`);

    const deadline = 8_000;
    let state = null;
    try {
      await waitForCondition(`${id} sekmesinin yüklenmesi`, {
        timeoutMs: deadline,
        intervalMs: 50,
        read: async () => {
          state = await cdpEvaluate(ws, tabStateProbe);
          return state?.active === id && state.docChars > 0 && state.previewHtml > 0
            ? state
            : null;
        },
      });
    } catch {
      // Tanılama için son durum yeniden okunur; aşağıdaki mesajlar hangi
      // koşulun sağlanmadığını tek tek söyler.
      state = await cdpEvaluate(ws, tabStateProbe);
    }
    if (state?.active !== id) {
      throw new Error(`${id} sekmesi etkinleşmedi (etkin: ${state?.active ?? 'yok'}).`);
    }
    if (state.docChars === 0) {
      throw new Error(`${id} sekmesinin editör arabelleği yüklenmedi.`);
    }
    // Önizleme 120 ms debounce ile üretilir; vurgulama da bir sonraki görevde.
    await sleep(300);
    loaded += 1;
  }
  return loaded;
}

/**
 * Eşzamanlı bir uygulama örneği (başka bir ölçüm) varsa sınırlı süre bekler.
 *
 * Uygulama `tauri-plugin-single-instance` kullanır: ikinci bir başlatma hiçbir
 * pencere açmadan **0 koduyla** çıkar. O durumda CDP sayfa hedefi hiç oluşmaz;
 * kilit çakışmasını doğrudan söylemek askıda kalan adımın nedenini görünür
 * kılar (eski koşucu bunu 25 s boyunca sessizce bekliyordu).
 */
async function waitForExclusiveApp(timeoutMs = 15_000) {
  // Koşul tabanlı ve asenkron: her okuma yeni bir PowerShell başlatır (~200 ms
  // kurulum) ama bu maliyet yalnızca gerçekten beklenirken ödenir. Eski hâli
  // tek bir PowerShell içinde `Start-Sleep` döngüsü çalıştırıyordu; bu, olay
  // döngüsünü 15 s boyunca kilitlediği için adım sınırının ve watchdog'un
  // ateşlenmesini engelliyordu.
  let running = [];
  try {
    await waitForCondition('başka md-editor örneği yok', {
      timeoutMs,
      intervalMs: 500,
      read: async () => {
        running = await findAppProcesses();
        return running.length === 0 ? true : null;
      },
    });
  } catch {
    throw new Error(
      `başka bir md-editor örneği ${timeoutMs} ms içinde kapanmadı (çalışan PID: ` +
        `${running.join(', ') || 'yok'}); başlatma single-instance kilidi yüzünden pencere ` +
        'açmadan çıkardı (eşzamanlı ölçüm çalışıyor).',
    );
  }
}

/**
 * Tek bir profil çalıştırır: uygulamayı açar, ilk boyayı ve (varsa) sekme
 * sayısını bekler, boşta CPU ve RSS örnekler, CDP değerlerini döndürür.
 *
 * `freshProfile` WebView2 kullanıcı profilini siler: bir sonraki açılış ilk
 * kurulum (soğuk) yolunu izler.
 */
async function runProfile({ label, expectTabs, freshProfile = false }) {
  log(`[profil] ${label} başladı`);
  await step(`${label}: CDP portu temizliği`, 15_000, async () => {
    await cleanupAll();
    await waitForCleanPort();
  });
  if (freshProfile) rmSync(webviewProfile, { recursive: true, force: true });
  await sleep(300);
  await step(`${label}: tek örnek kilidi`, 20_000, () => waitForExclusiveApp());

  const launchedAt = Date.now();
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      // `--remote-allow-origins=*` olmadan güncel WebView2 çalışma zamanı
      // uzaktan hata ayıklama bağlantısını kabul etmiyor ve pencere hiç
      // yüklenmeden süreç sonlanıyor; ölçüm bu bayrak olmadan tekrar üretilemez.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${DEBUG_PORT} --remote-allow-origins=*`,
      WEBVIEW2_USER_DATA_FOLDER: webviewProfile,
    },
    stdio: 'ignore',
  });

  let ws = null;
  try {
    // Erken çıkış ayrı tanınır: single-instance çakışmasında süreç 0 koduyla
    // hemen çıkar ve CDP hedefi hiç oluşmaz. Bunu 25 s boyunca sessizce
    // beklemek yerine adıyla söylemek, "hangi adım neden askıda kaldı"
    // sorusunu tek satırda yanıtlar.
    // Başlatma da öteki adımlar gibi adıyla, süresiyle ve durumuyla loglanır.
    // Davranış değişmez: süreç 1500 ms içinde çıkarsa erken çıkış olarak okunur,
    // çıkmazsa adım normal tamamlanır. Dış sınır öteki adımlarla aynı biçimdedir.
    const earlyExit = await step(
      `${label}: uygulama açılışı`,
      6_000,
      () =>
        new Promise((resolvePromise) => {
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolvePromise(null);
          }, 1500);
          const onExit = (code, signal) => {
            clearTimeout(timer);
            resolvePromise({ code, signal });
          };
          child.once('exit', onExit);
        }),
    );
    if (earlyExit !== null) {
      // Tek örnek kilidi uygulama kimliğine bağlıdır: başka adla kopyalanmış
      // bir ikili (`md-editor-*.exe`) kilidi tutuyorsa yeni süreç pencere
      // açmadan 0 koduyla çıkar. Engeli PID'siyle söylemek, "hangi adım neden
      // askıda kaldı" sorusunu tahmine bırakmaz.
      const blockers = await findAppProcesses();
      throw new Error(
        `md-editor.exe ${earlyExit.code ?? earlyExit.signal} ile erken çıktı; ` +
          'pencere hiç açılmadı (single-instance kilidi başka bir örnekte). ' +
          `Çalışan md-editor* PID: ${blockers.join(', ') || 'yok'}.`,
      );
    }
    // Profil sürerken uygulamanın çıkıp çıkmadığı izlenir: süreç ağacı
    // örneklemesi "kök pid yok" dediğinde nedeninin uygulamanın kapanması mı
    // yoksa eksik örnek mi olduğu hata metninde görünür.
    let appExit = null;
    child.once('exit', (code, signal) => {
      appExit = { code, signal };
    });

    const target = await step(`${label}: CDP sayfa hedefi`, 30_000, () => findPageTarget());
    ws = new WebSocket(target.webSocketDebuggerUrl);
    // Soket açılışı da sınırlıdır: hedef listelendiği hâlde bağlantı hiç
    // kurulmazsa (WebView2 kapanırken yarış) bu `await` sonsuza kadar beklerdi.
    await step(`${label}: CDP soketi`, 10_000, () =>
      new Promise((resolvePromise, reject) => {
        ws.addEventListener('open', resolvePromise, { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP soketi açılamadı')), {
          once: true,
        });
      }),
    );

    let snapshot = await step(`${label}: ilk boya`, 30_000, () => openSession(ws));
    if (snapshot.href.includes('localhost:1420')) {
      throw new Error('yanlış varlık: geliştirme sunucusu URL\'si yüklendi.');
    }
    if (expectTabs !== null) {
      snapshot = await step(`${label}: sekme listesi`, 30_000, () => waitForTabs(ws, expectTabs));
    }
    // Sekmeye özgü arabellekler ancak sekme görünür olduğunda yüklenir.
    const visitedTabs =
      VISIT_TABS && expectTabs !== null
        ? await step(
            `${label}: ${expectTabs} sekme ziyareti`,
            // Sekme başına 20 s koşul sınırı + 300 ms yerleşme; toplamı adımda sınırla.
            5_000 + 21_000 * expectTabs,
            () => visitAllTabs(ws, expectTabs),
          )
        : 0;

    const after = await step(`${label}: ölçüm anı`, 20_000, async () => {
      // Pencere otursun; RSS/CPU ölçümü öncesi son yerleşim/derleme işleri bitsin.
      await sleep(2500);
      return { value: await cdpEvaluate(ws, probe), receivedAt: Date.now() };
    });
    const idleCpu = await step(`${label}: boşta CPU örneklemesi`, IDLE_CPU_MS * 2 + 8_000, () =>
      sampleIdleCpu(child.pid, IDLE_CPU_MS),
    );
    const rssMiB = await step(`${label}: bellek örneklemesi`, 25_000, async () => {
      try {
        return await rssSummary(child.pid);
      } catch (error) {
        if (appExit === null) throw error;
        throw new Error(
          `${error.message} (uygulama ölçüm sırasında çıktı: code=${appExit.code} signal=${appExit.signal})`,
        );
      }
    });

    return {
      label,
      processToFcpMs:
        typeof after.value.fcp === 'number'
          ? Math.round(after.receivedAt - launchedAt - (after.value.now - after.value.fcp))
          : null,
      pageFcpMs: after.value.fcp === null ? null : Math.round(after.value.fcp),
      firstPaintMarkMs:
        after.value.firstPaintMark === null ? null : Math.round(after.value.firstPaintMark),
      rustFirstPaintMs:
        after.value.rustFirstPaint === null ? null : Math.round(after.value.rustFirstPaint),
      tabs: after.value.tabs,
      visitedTabs,
      usedJSHeapMiB: after.value.usedJSHeapMiB ?? null,
      idleCpu,
      resources: [...new Set(after.value.resources)],
      resourceTimings: after.value.resourceTimings ?? [],
      rssMiB,
    };
  } finally {
    try {
      ws?.close();
    } catch {
      // Soket zaten kapanmış olabilir.
    }
    // Süreç ağacı kökü hata yolunda da kapatılır: `cleanupAll()` uygulamayı
    // adıyla sonlandırır, `child.kill()` ise pid hâlâ bizimse doğrudan keser.
    try {
      child.kill();
    } catch {
      // Süreç zaten çıkmış olabilir.
    }
    // Kapanış da adı, süresi ve durumuyla loglanan bir adımdır: `cleanupAll`
    // kendi 10 s sınırını taşır, bu adım toplamda 15 s'de kesilir. Hata
    // yutmadan yalnızca loglanır ki asıl profil hatası maskelenmesin.
    try {
      await step(`${label}: kapanış`, 15_000, async () => {
        await cleanupAll();
        await sleep(800);
      });
    } catch (error) {
      log(`[adım] ${label}: kapanış tamamlanamadı: ${error.message}`);
    }
    log(`[profil] ${label} bitti`);
  }
}

/**
 * Ölçüm belgesinin bölüm sayısı.
 *
 * Sekme başına editör arabelleği (CodeMirror belgesi + sözdizimi ağacı) ve
 * etkin sekmenin önizleme HTML'i ancak belge birkaç yüz satırsa gerçek
 * maliyetini gösterir; birkaç satırlık bir belge bu arabellekleri neredeyse
 * hiç doldurmaz ve "ölçülmemiş buffer" bırakır.
 *
 * Belge ağırlıklı olarak düz yazıdır (hafif markdown editörünün tipik
 * belgesi): her bölümde iki paragraf ve kısa bir liste, ayrıca her dördüncü
 * bölümde bir tablo veya kod bloğu. Böylece ~35 KB / ~300 satırlık gerçekçi
 * bir belge ölçülür; tablo/kod bloğu yığınıyla şişirilmiş yapay bir stress
 * belgesi değil.
 */
const DOCUMENT_SECTIONS = 45;
/** Ölçüm metninin her koşuda aynı uzunlukta kalması için sabit paragraf. */
const DOCUMENT_PARAGRAPH =
  'Bu paragraf hafif bir markdown editöründe açılan tipik bir belgenin metin ' +
  'yoğunluğunu taklit eder; satır kaydırma, sözdizimi ağacı ve önizleme düzeni ' +
  'bu uzunlukta gerçek maliyetlerini gösterir. Metin deterministiktir, böylece ' +
  'aynı koşullarda alınan ölçümler karşılaştırılabilir.';

/** Determinstik ölçüm belgesi: her koşuda aynı bayt sayısı. */
function measurementDocument(index) {
  const parts = [`# Belge ${index}\n`];
  for (let section = 1; section <= DOCUMENT_SECTIONS; section += 1) {
    parts.push(
      `\n## Bölüm ${section}\n\n` +
        `${DOCUMENT_PARAGRAPH}\n\n` +
        `${DOCUMENT_PARAGRAPH}\n\n` +
        '- madde bir\n- madde iki\n- madde üç\n- madde dört\n',
    );
    if (section % 4 === 0) {
      parts.push(
        '\n| Alan | Değer |\n| --- | --- |\n' +
          `| belge | ${index} |\n| bölüm | ${section} |\n`,
      );
    }
    if (section % 4 === 2) {
      parts.push(`\n\`\`\`js\nconst deger${section} = ${index * section};\n\`\`\`\n`);
    }
  }
  return parts.join('');
}

function writeWorkspaceFiles() {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  for (let index = 1; index <= TABS; index += 1) {
    const name = `not-${String(index).padStart(2, '0')}.md`;
    writeFileSync(join(workspace, name), measurementDocument(index), 'utf8');
  }
}

/**
 * Önceki bir ölçümden kalan kalibrasyon oturumu mu?
 *
 * Ölçüm koşucusu `session.json` dosyasını geçici olarak kendi çalışma alanıyla
 * değiştirir. Bir çalıştırma kesintiye uğrarsa (veya yedek, kalibrasyon
 * oturumundan alınmışsa) bu dosya gerçek kullanıcı oturumu gibi geri
 * konulabilir. Kökü `.temp_files/perf-workspace` olan bir oturum hiçbir zaman
 * gerçek kullanıcı durumu değildir; yedeklenip geri konulmamalıdır.
 */
function isCalibrationSession() {
  if (!existsSync(sessionPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const root = typeof parsed?.root === 'string' ? resolve(parsed.root) : null;
    return root !== null && root === workspace;
  } catch {
    // Bozuk oturum dosyası yedeklenmeye değer; gerçek sanılıp geri konur.
    return false;
  }
}

/**
 * Koşum durumu: kısmi kayıt ve garanti temizlik için tek yerde tutulur.
 *
 * `results`/`startup`, koşum kesilse bile yazılabilmesi için profiller
 * tamamlandıkça burada birikir; böylece hata/`watchdog`/sinyal yolunda o ana
 * kadar alınan örnekler kaybolmaz.
 */
const runState = {
  startedAt: Date.now(),
  // Koşum kimliği: kısmi kayıt dosyasının adını tekil ve takip edilebilir yapar
  // (`perf-partial-<koşum>-<pid>.json`); pid yalnızca koşumlar arasında
  // çakışmayı önlemek için eklenir.
  runId: `${new Date(Date.now()).toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
  results: [],
  startup: null,
  partialSaved: false,
  finalized: false,
};

let sessionPrepared = false;
let sessionHadBackup = false;

/** Kullanıcı oturumunu yedekler ve kalibrasyon oturumunu ayıklar. */
function prepareSession() {
  const leaked = isCalibrationSession();
  if (leaked) {
    console.log(
      '[oturum] önceki ölçümden kalan kalibrasyon oturumu bulundu; gerçek oturum olarak yedeklenmiyor.',
    );
  }
  sessionHadBackup = existsSync(sessionPath) && !leaked;
  if (sessionHadBackup) copyFileSync(sessionPath, backupPath);
  else rmSync(sessionPath, { force: true });
  sessionPrepared = true;
}

/** Yedeği geri koyar; birden çok kez çağrılabilir (idempotent). */
function restoreSession() {
  if (!sessionPrepared) return;
  sessionPrepared = false;
  if (sessionHadBackup) copyFileSync(backupPath, sessionPath);
  else rmSync(sessionPath, { force: true });
  rmSync(backupPath, { force: true });
}

/**
 * O ana kadar toplanan örnekleri "tamamlanmamış koşum" olarak yazar.
 *
 * Hata, koşum bütçesi aşımı veya sinyal durumunda çağrılır: koşum askıda
 * kaldığında bile eldeki örnekler ve hangi profillerin bittiği kaydedilir.
 * `--json-out` verilmişse aynı yol kullanılır; tamamlanmamış bir dosyanın
 * geçerli özet sanılmaması için `status: "incomplete"` alanı yazılır.
 */
function savePartial(reason) {
  if (runState.partialSaved) return;
  runState.partialSaved = true;
  const path =
    JSON_OUT ?? resolve(`.temp_files/perf-partial-${runState.runId}-partial.json`);
  const payload = {
    status: 'incomplete',
    runId: runState.runId,
    reason,
    // Askıda kalınan adım: watchdog/sinyal yolunda "hangi adım" sorusunun cevabı.
    stuckStep:
      stepTracker.label === null
        ? null
        : {
            label: stepTracker.label,
            runningMs: Date.now() - stepTracker.startedAt,
          },
    platform: `${process.platform} ${process.arch}`,
    tabs: TABS,
    runs: RUNS,
    startedAt: new Date(runState.startedAt).toISOString(),
    elapsedMs: Date.now() - runState.startedAt,
    completedProfiles: runState.results.map((result) => result.label),
    results: runState.results,
    startup: runState.startup,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.error(`[kısmi] ${runState.results.length} profil örneği yazıldı: ${path}`);
  } catch (error) {
    console.error(`[kısmi] yazılamadı (${path}): ${error.message}`);
  }
}

/**
 * Oturumu geri koyar, koşucu kilidini bırakır ve açık süreçleri kapatır;
 * birden çok kez çağrılabilir (idempotent).
 */
async function finalizeRun() {
  if (runState.finalized) return;
  runState.finalized = true;
  try {
    restoreSession();
  } catch (error) {
    // Yedek geri konamazsa ölçüm sonucu değişmez; yalnızca bildirilir.
    console.error(`[oturum] yedek geri konamadı: ${error.message}`);
  }
  releaseRunnerLock();
  await cleanupAll();
  // Geçici kaynakları serbest bırak: WebView2 profili süreç başına benzersizdir
  // (bkz. `webviewProfile`), dolayısıyla yalnızca bu koşuma aittir; çıkmadan
  // önce silinmezse `.temp_files` altında birikir. Alt süreçler yeni öldürüldü
  // ise dizin kilitlemeler nedeniyle silinemeyebilir; en iyi çaba ile denenir.
  try {
    rmSync(webviewProfile, { recursive: true, force: true });
  } catch (error) {
    log(`[temizlik] webview profili silinemedi (${webviewProfile}): ${error.message}`);
  }
}

function writeSessionFile() {
  const tabs = Array.from({ length: TABS }, (_, index) => ({
    path: `not-${String(index + 1).padStart(2, '0')}.md`,
    cursor: null,
    scroll: null,
  }));
  const session = {
    version: 1,
    root: workspace.replaceAll('\\', '/'),
    tabs,
    activePath: tabs[0].path,
    viewMode: 'split',
    splitRatio: 0.5,
    sidebarWidth: 250,
  };
  mkdirSync(configDir, { recursive: true });
  // `tauri-plugin-store` dosya kökünü anahtar/değer haritası olarak tutar:
  // oturum belgesi `{"session": {...}}` altında saklanır (`src/lib/session/ipc.ts`).
  writeFileSync(sessionPath, JSON.stringify({ session }), 'utf8');
}

/** Yüklenen tüm kaynakların yerel origin'lerden geldiğini doğrular. */
function auditNetwork(resources) {
  const external = [];
  for (const resource of resources) {
    try {
      const url = new URL(resource);
      if (!LOCAL_ORIGINS.has(url.origin)) external.push(resource);
    } catch {
      // `data:`/`blob:` gibi URL'ler ağ isteği değildir; yok sayılır.
    }
  }
  return external;
}

function median(values) {
  const numbers = values.filter((value) => typeof value === 'number');
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** `median` gibi ama yuvarlamaz: milisaniye altı kaynak süreleri kaybolmasın. */
function medianExact(values) {
  const numbers = values.filter((value) => typeof value === 'number');
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/**
 * Vite çıktı adındaki içerik karmasını atar: `EditorPane-Dc4qFeA1.js` →
 * `EditorPane.js`. Karma atıldığında dosya adı modülü tanımlar.
 *
 * Karma, Vite'ın ürettiği 8 karakterlik son ektir; `rolldown-runtime` gibi
 * adların kendi tireli parçaları korunur.
 */
function chunkStem(url) {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // `data:`/`blob:` URL'lerinde yol yok; ham ad üzerinden devam edilir.
  }
  const file = path.split('/').pop() ?? path;
  return file.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/i, '$1');
}

/**
 * Açılışta yüklenebilen chunk → modül karşılığı.
 *
 * Bu tablo yalnızca raporlama içindir; hiçbir modülün yüklenme anını
 * değiştirmez. Eşleşmeyen chunk kendi karma atılmış adıyla listelenir.
 */
const CHUNK_LABELS = {
  'index.js': 'giriş kabuğu (main.ts + App.svelte)',
  'index.css': 'kabuk stilleri',
  'rolldown-runtime.js': 'modül çalışma zamanı (Vite)',
  'core.js': 'highlight.js çekirdeği',
  'dist-js.js': 'highlight.js dinamik yükleyici',
  'EditorPane.js': 'editör paneli (CodeMirror 6)',
  'EditorPane.css': 'editör stilleri',
  'PreviewPane.js': 'önizleme paneli (markdown-it + DOMPurify)',
  'PreviewPane.css': 'önizleme stilleri',
};

/** highlight.js dil paketleri: `bash-BqpFWvKu.js` → `highlight.js: bash`. */
const HIGHLIGHT_LANGS = new Set([
  'bash',
  'css',
  'javascript',
  'json',
  'markdown',
  'python',
  'rust',
  'typescript',
  'xml',
  'html',
  'java',
  'c',
  'cpp',
  'csharp',
  'go',
  'php',
  'ruby',
  'sql',
  'yaml',
  'swift',
  'kotlin',
]);

/** Bir kaynak URL'sinin rapor etiketini döndürür. */
function moduleLabel(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed !== null && parsed.origin === 'http://ipc.localhost') {
    // Tauri IPC çağrıları da Resource Timing'e girer; komut adıyla raporlanır.
    return `IPC: ${decodeURIComponent(parsed.pathname.replace(/^\//, ''))}`;
  }
  const stem = chunkStem(url);
  if (CHUNK_LABELS[stem] !== undefined) return CHUNK_LABELS[stem];
  const base = stem.replace(/\.[a-z0-9]+$/i, '');
  if (HIGHLIGHT_LANGS.has(base)) return `highlight.js: ${base}`;
  return stem;
}

/**
 * Kaynak zamanlamalarını modül bazında toplar.
 *
 * - `medianDurationMs`: kaynağın indirilip çözümlenmesi (Resource Timing
 *   `duration`); medyanı koşular arası alınır.
 * - `medianStartMs`: istek başlangıcının ilk boyaya göre konumu.
 * - `medianDecodedKb`: çözülmüş gövde boyutu (JS ise ayrıştırılan kaynak).
 */
function moduleBreakdown(runs) {
  const byModule = new Map();
  for (const run of runs) {
    for (const entry of run.resourceTimings ?? []) {
      const label = moduleLabel(entry.name);
      const record = byModule.get(label) ?? {
        files: new Set(),
        durations: [],
        starts: [],
        bytes: [],
        runs: 0,
      };
      record.files.add(entry.name);
      record.durations.push(entry.durationMs);
      record.starts.push(entry.startTime);
      record.bytes.push(entry.decodedBodySize || entry.transferSize || 0);
      record.runs += 1;
      byModule.set(label, record);
    }
  }
  return [...byModule.entries()]
    .map(([label, record]) => ({
      module: label,
      files: [...record.files].sort(),
      entries: record.runs,
      medianDurationMs: medianExact(record.durations),
      medianStartMs: medianExact(record.starts),
      medianDecodedKb: Number(((medianExact(record.bytes) ?? 0) / 1024).toFixed(1)),
    }))
    .sort((a, b) => (b.medianDurationMs ?? 0) - (a.medianDurationMs ?? 0));
}

/** Açılışta atılan istekler: origin, başlatan tür ve yerel olup olmadığı. */
function startupRequests(runs) {
  const seen = new Map();
  for (const run of runs) {
    for (const entry of run.resourceTimings ?? []) {
      if (seen.has(entry.name)) continue;
      let origin = null;
      try {
        origin = new URL(entry.name).origin;
      } catch {
        origin = null;
      }
      seen.set(entry.name, {
        url: entry.name,
        origin,
        local: origin !== null && LOCAL_ORIGINS.has(origin),
        initiatorType: entry.initiatorType,
        startMs: entry.startTime,
        durationMs: entry.durationMs,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.startMs - b.startMs);
}

function summarize(group) {
  return {
    runs: group.map((result) => ({
      processToFcpMs: result.processToFcpMs,
      pageFcpMs: result.pageFcpMs,
      firstPaintMarkMs: result.firstPaintMarkMs,
      rustFirstPaintMs: result.rustFirstPaintMs,
      rssMiB: result.rssMiB.privateMiB,
      naiveSumMiB: result.rssMiB.naiveSumMiB,
      dedupedMiB: result.rssMiB.dedupedMiB,
    })),
    medianProcessToFcpMs: median(group.map((result) => result.processToFcpMs)),
    medianPageFcpMs: median(group.map((result) => result.pageFcpMs)),
    medianFirstPaintMarkMs: median(group.map((result) => result.firstPaintMarkMs)),
    medianRustFirstPaintMs: median(group.map((result) => result.rustFirstPaintMs)),
    medianRssMiB: median(group.map((result) => result.rssMiB.privateMiB)),
    maxRssMiB: Math.max(...group.map((result) => result.rssMiB.privateMiB)),
    medianDedupedMiB: median(group.map((result) => result.rssMiB.dedupedMiB)),
    maxDedupedMiB: Math.max(...group.map((result) => result.rssMiB.dedupedMiB)),
  };
}

/**
 * Açılış profili: bir soğuk (WebView2 ilk kurulum) + bir ısınma + N ardışık
 * sıcak başlatma. Isınma koşusu ölçüme girmez; profil dizinini ve işletim
 * sistemi dosya önbelleğini sıcak hâle getirir.
 */
async function measureStartup() {
  const cold = await runProfile({
    label: 'soğuk #1',
    expectTabs: null,
    freshProfile: true,
  });
  await runProfile({ label: 'ısınma', expectTabs: null });
  const warm = [];
  for (let run = 1; run <= WARM_RUNS; run += 1) {
    warm.push(await runProfile({ label: `sıcak #${run}`, expectTabs: null }));
  }
  return { cold, warm };
}

/** Açılış ölçümünü yazdırır, JSON'a yazar ve `--gate-startup` ile bütçeyi denetler. */
function reportStartup({ cold, warm }) {
  const warmMedian = median(warm.map((run) => run.processToFcpMs));
  const warmPageMedian = median(warm.map((run) => run.pageFcpMs));
  const idleCpuMedian = median(warm.map((run) => run.idleCpu.percentOfTotal));
  const idleCpuMax = Math.max(...warm.map((run) => run.idleCpu.percentOfTotal));
  const idleCpuCoreMedian = median(warm.map((run) => run.idleCpu.percentOfCore));
  const idleCpuTailMedian = median(warm.map((run) => run.idleCpu.tailPercentOfTotal));
  const cores = warm[0]?.idleCpu.cores ?? 0;
  const allRuns = [cold, ...warm];
  const external = allRuns.flatMap((run) => auditNetwork(run.resources));
  const warmModules = moduleBreakdown(warm);
  const requests = startupRequests(warm);

  for (const run of allRuns) {
    console.log(
      `[${run.label}] süreç → FCP ${run.processToFcpMs} ms (sayfa ${run.pageFcpMs} ms) | ` +
        `mark ${run.firstPaintMarkMs} ms | Rust ${run.rustFirstPaintMs} ms | ` +
        `boşta CPU ${run.idleCpu.percentOfTotal}% makine (${run.idleCpu.percentOfCore}% çekirdek; kuyruk ${run.idleCpu.tailPercentOfTotal}%)`,
    );
  }

  console.log('=== açılış modül dağılımı (sıcak koşu medyanı) ===');
  for (const module of warmModules) {
    console.log(
      `  ${module.module} — ${module.medianDurationMs} ms (başlangıç ${module.medianStartMs} ms, ${module.medianDecodedKb} KB, ${module.entries} kayıt; ${module.files.join(', ')})`,
    );
  }
  const notLoaded =
    warm.length === 0
      ? []
      : Object.values(CHUNK_LABELS).filter(
          (label) => !warmModules.some((module) => module.module === label),
        );
  console.log(
    `  yüklenmeyen ağır chunk'lar: ${notLoaded.length > 0 ? notLoaded.join(', ') : 'yok'}`,
  );

  console.log(`=== açılış istekleri (${requests.length}) ===`);
  for (const request of requests) {
    console.log(
      `  ${request.local ? 'yerel' : 'DIŞ'}  ${request.durationMs} ms (başlangıç ${request.startMs} ms) ${request.initiatorType}  ${request.url}`,
    );
  }

  const summary = {
    profile: 'release (embedded dist)',
    platform: `${process.platform} ${process.arch}`,
    warmRuns: warm.length,
    cold: {
      processToFcpMs: cold.processToFcpMs,
      pageFcpMs: cold.pageFcpMs,
      rustFirstPaintMs: cold.rustFirstPaintMs,
      limitMs: COLD_BUDGET_MS,
      pass: cold.processToFcpMs !== null && cold.processToFcpMs <= COLD_BUDGET_MS,
    },
    warm: {
      runs: warm.map((run) => ({
        processToFcpMs: run.processToFcpMs,
        pageFcpMs: run.pageFcpMs,
        rustFirstPaintMs: run.rustFirstPaintMs,
      })),
      medianProcessToFcpMs: warmMedian,
      medianPageFcpMs: warmPageMedian,
      limitMs: WARM_BUDGET_MS,
      pass: warmMedian !== null && warmMedian <= WARM_BUDGET_MS,
    },
    idleCpu: {
      windowMs: warm[0]?.idleCpu.windowMs ?? IDLE_CPU_MS,
      cores,
      medianPercentOfTotal: idleCpuMedian,
      maxPercentOfTotal: idleCpuMax,
      medianPercentOfCore: idleCpuCoreMedian,
      medianTailPercentOfTotal: idleCpuTailMedian,
      limitPercentOfTotal: MAX_IDLE_CPU_PERCENT,
      pass:
        idleCpuMedian !== null &&
        idleCpuMedian <= MAX_IDLE_CPU_PERCENT &&
        idleCpuTailMedian !== null &&
        idleCpuTailMedian <= MAX_IDLE_CPU_PERCENT,
    },
    externalRequests: external,
    resources: [...new Set(allRuns.flatMap((run) => run.resources))],
    requests,
    modules: warmModules,
  };

  if (JSON_OUT !== null) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    '=== açılış özeti ===\n' +
      `soğuk (WebView2 ilk kurulum): ${summary.cold.processToFcpMs} ms / ${COLD_BUDGET_MS} ms → ${summary.cold.pass ? 'uygun' : 'AŞIM'}\n` +
      `${warm.length} sıcak başlatma medyanı: ${warmMedian} ms / ${WARM_BUDGET_MS} ms → ${summary.warm.pass ? 'uygun' : 'AŞIM'}\n` +
      `boşta CPU medyanı: ${idleCpuMedian}% makine (${idleCpuCoreMedian}% çekirdek; kuyruk ${idleCpuTailMedian}%; en yüksek ${idleCpuMax}%, bütçe ${MAX_IDLE_CPU_PERCENT}% makine) → ${summary.idleCpu.pass ? 'uygun' : 'AŞIM'}\n` +
      `açılışta dış ağ isteği: ${external.length}`,
  );

  if (external.length > 0) {
    console.error(`ağ denetimi başarısız: ${external.length} dış istek.`);
    process.exitCode = 1;
  }
  if (GATE_STARTUP) {
    const failures = [];
    if (!summary.warm.pass) failures.push(`sıcak medyan ${warmMedian} ms > ${WARM_BUDGET_MS} ms`);
    if (!summary.cold.pass) failures.push(`soğuk açılış ${summary.cold.processToFcpMs} ms > ${COLD_BUDGET_MS} ms`);
    if (!summary.idleCpu.pass) {
      failures.push(`boşta CPU ${idleCpuMedian}% > ${MAX_IDLE_CPU_PERCENT}%`);
    }
    if (failures.length > 0) {
      console.error(`açılış bütçesi aşıldı: ${failures.join('; ')}.`);
      process.exitCode = 1;
    }
  }
}

/**
 * `--compare-baseline` verildiğinde baseline karşılaştırıcısını çalıştırır.
 *
 * Karşılaştırıcı ayrı bir süreçtir ve kendi çıkış kodunu üretir: 0 uygun,
 * 1 regresyon, 2 baseline kullanılamaz. Kod bu süreçten aynen devralınır.
 */
function runBaselineComparison() {
  if (!COMPARE_BASELINE) return;
  if (JSON_OUT === null) {
    console.error('--compare-baseline için --json-out <dosya> gerekir.');
    process.exitCode = 2;
    return;
  }
  const comparison = spawnSync(
    process.execPath,
    [
      resolve('scripts/compare-startup-baseline.mjs'),
      '--baseline',
      BASELINE_PATH,
      '--current',
      JSON_OUT,
    ],
    { stdio: 'inherit' },
  );
  if (comparison.status !== 0) process.exitCode = comparison.status ?? 1;
}

async function main() {
  const results = runState.results;
  try {
    // 0) Eşzamanlı koşum denetimi: tek örnekli uygulama ve paylaşılan CDP
    //    portu yüzünden başka bir ölçüm koşarken ölçüm geçersizdir. Önce atomik
    //    tek koşucu kilidi alınır (yarışı kapatır), sonra kalan süreçler kısa ve
    //    koşul tabanlı bir beklemeyle denetlenir. İkisi de kesin süreyle
    //    sınırlıdır; süre dolarsa koşum koşmadan, engelleyen PID'leri adıyla
    //    söyleyerek biter.
    await step('eşzamanlı koşum denetimi', PEER_WAIT_MS + 20_000, async () => {
      await acquireRunnerLock({ timeoutMs: PEER_WAIT_MS });
      // Kilit alındıktan sonra yalnızca **çalışan bir uygulama örneği** gerçek
      // çakışmadır: sırada bekleyen diğer koşucular kilidi bekliyor, zararsız.
      // Onları engel saymak, iki koşucu aynı anda beklediğinde her ikisini de
      // kaçınılmaz biçimde düşürürdü. Kilit tanımayan bir betik (eski kopya,
      // `leak-check`) varsa adıyla uyarılır ama koşum durdurulmaz.
      await waitForExclusiveRunner({ timeoutMs: 10_000 });
      const peers = await findPeerRunners();
      if (peers.length > 0) {
        log(
          `[uyarı] kilidi tanımayan bir ölçüm betiği çalışıyor (node PID ${peers.join(', ')}); ` +
            'temizlik adımı onun uygulamasını kapatabilir.',
        );
      }
    });

    // 0b) Oturum ve çalışma alanı **kilit alındıktan sonra** hazırlanır: kilidi
    //     alamayan bir koşum, süren bir ölçümün `session.json`'ını ve belge
    //     dosyalarını değiştirmeden adı konmuş hatayla çıkmalıdır. Aksi hâlde
    //     eşzamanlı bir deneme, ölçülen koşumun verisini bozar.
    // Açılış modunda sekmeli profil kurulmaz; ölçüm için çalışma alanı gerekmez.
    if (!STARTUP_MODE) writeWorkspaceFiles();
    prepareSession();

    // 1) Boşta profil: oturum dosyası yok, sekme yok.
    rmSync(sessionPath, { force: true });
    if (STARTUP_MODE) {
      runState.startup = await measureStartup();
    } else {
      for (let run = 1; run <= RUNS; run += 1) {
        results.push(await runProfile({ label: `idle #${run}`, expectTabs: null }));
      }

      // 2) Çok sekmeli profil: geçerli oturum dosyası yazılır.
      writeSessionFile();
      for (let run = 1; run <= RUNS; run += 1) {
        results.push(
          await runProfile({ label: `${TABS} tabs #${run}`, expectTabs: TABS }),
        );
      }
    }
  } finally {
    await finalizeRun();
  }

  if (runState.startup !== null) {
    reportStartup(runState.startup);
    runBaselineComparison();
    return;
  }

  const network = results.map((result) => ({
    label: result.label,
    externalRequests: auditNetwork(result.resources),
  }));
  const idleGroup = results.filter((result) => result.label.startsWith('idle'));
  const tabsGroup = results.filter((result) => !result.label.startsWith('idle'));

  for (const result of results) {
    console.log(
      `[${result.label}] FCP ${result.processToFcpMs} ms (sayfa ${result.pageFcpMs} ms) | mark ${result.firstPaintMarkMs} ms | Rust ${result.rustFirstPaintMs} ms | sekme ${result.tabs} (yüklenen ${result.visitedTabs}) | toplam çalışma seti ${result.rssMiB.dedupedMiB} MiB (özel ${result.rssMiB.privateMiB} MiB, ham ${result.rssMiB.naiveSumMiB} MiB) | JS heap ${result.usedJSHeapMiB ?? '?'} MiB`,
    );
  }
  const external = network.flatMap((check) => check.externalRequests);
  console.log(
    `[ağ] ilk açılışta yüklenen kaynaklar: ${external.length === 0 ? 'yalnızca yerel origin' : `${external.length} dış istek`}`,
  );

  const summary = {
    profile: 'release (embedded dist)',
    platform: `${process.platform} ${process.arch}`,
    tabs: TABS,
    runs: RUNS,
    idle: summarize(idleGroup),
    tabsProfile: summarize(tabsGroup),
    externalRequests: external,
    resources: [...new Set(results.flatMap((result) => result.resources))],
  };

  if (MAX_RSS_MIB !== null) {
    const measured = summary.tabsProfile.maxDedupedMiB;
    if (!Number.isFinite(measured) || measured <= 0) {
      console.error(
        `bellek bütçesi ölçülemedi: ${TABS} sekme profilinde geçerli toplam çalışma seti örneği yok (${measured}).`,
      );
      process.exitCode = 2;
      return;
    }
    const naiveSum = Math.max(
      ...tabsGroup.map((result) => result.rssMiB.naiveSumMiB),
    );
    const privateMax = Math.max(
      ...tabsGroup.map((result) => result.rssMiB.privateMiB),
    );
    summary.budget = {
      tabs: TABS,
      limitMiB: MAX_RSS_MIB,
      metric: MEMORY_METRIC,
      measuredMaxDedupedMiB: measured,
      measuredMaxPrivateMiB: privateMax,
      measuredMaxNaiveSumMiB: naiveSum,
      pass: measured <= MAX_RSS_MIB,
    };
  }

  if (JSON_OUT !== null) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log(
    '=== özet ===\n' +
      `boşta: medyan FCP ${summary.idle.medianProcessToFcpMs} ms | Rust ${summary.idle.medianRustFirstPaintMs} ms | RSS ${summary.idle.medianRssMiB} MiB\n` +
      `${TABS} sekme: medyan FCP ${summary.tabsProfile.medianProcessToFcpMs} ms | Rust ${summary.tabsProfile.medianRustFirstPaintMs} ms | RSS ${summary.tabsProfile.medianRssMiB} MiB`,
  );

  if (external.length > 0) {
    console.error(`ağ denetimi başarısız: ${external.length} dış istek.`);
    process.exitCode = 1;
  }

  if (MAX_RSS_MIB !== null) {
    // Kapı, belgelenen metrikle (indirgenmiş toplam çalışma seti) aynı değeri
    // kullanır: `budget.measuredMaxDedupedMiB`. Özel toplam yalnızca tanıdır;
    // onunla karar vermek bütçeyi paylaşılan WebView2 sayfaları kadar gevşetirdi.
    const measured = summary.budget.measuredMaxDedupedMiB;
    const over = measured > MAX_RSS_MIB;
    console.log(
      `[bellek bütçesi] metrik: ${MEMORY_METRIC.definition}\n` +
        `[bellek bütçesi] ${TABS} sekme en yüksek toplam çalışma seti ${measured} MiB / bütçe ${MAX_RSS_MIB} MiB → ${over ? 'AŞIM' : 'uygun'}\n` +
        `[bellek bütçesi] tanı: özel çalışma seti toplamı ${summary.budget.measuredMaxPrivateMiB} MiB, ` +
        `ham WorkingSet toplamı ${summary.budget.measuredMaxNaiveSumMiB} MiB (bütçe değil)`,
    );
    if (over) {
      console.error(`bellek bütçesi aşıldı: ${measured} MiB > ${MAX_RSS_MIB} MiB.`);
      process.exitCode = 1;
    }
  }
}

/**
 * Koşum bütçesi (watchdog).
 *
 * Adım zaman aşımları tek tek `await`'leri sınırlar; bu sayaç ise **tüm**
 * koşumu sınırlar. Artık tüm dış çağrılar asenkron olduğu için olay döngüsü
 * serbesttir ve bu sayaç gerçekten ateşlenir. Ateşlendiğinde kısmi örnekler
 * yazılır, süreçler temizlenir ve süreç 3 koduyla biter; temizliğin kendisi de
 * sınırlıdır, böylece watchdog çıkışı süresiz beklemeye dönüşmez.
 */
const watchdog = setTimeout(() => {
  const stuck =
    stepTracker.label === null
      ? 'adım arasında'
      : `"${stepTracker.label}" adımında ${Date.now() - stepTracker.startedAt} ms ` +
        `(adım sınırı ${stepTracker.deadlineMs} ms)`;
  log(
    `[watchdog] koşum bütçesi (${MAX_RUN_MS} ms) aşıldı; askıda kalınan yer: ${stuck}. Kısmi örnekler yazılıp çıkılıyor.`,
  );
  logStepRecord({
    step: stepTracker.label,
    status: 'timeout',
    deadlineMs: MAX_RUN_MS,
    durationMs: stepTracker.startedAt === null ? null : Date.now() - stepTracker.startedAt,
    error: `koşum bütçesi aşıldı; askıda: ${stuck}`,
  });
  savePartial(`koşum bütçesi aşıldı (${MAX_RUN_MS} ms); askıda: ${stuck}`);
  void (async () => {
    try {
      await withTimeout(finalizeRun(), 20_000, 'watchdog temizliği');
    } catch (error) {
      log(`[watchdog] temizlik tamamlanamadı: ${error.message}`);
    }
    process.exit(3);
  })();
}, MAX_RUN_MS);

// Dışarıdan kesme (Ctrl+C, üst süreç sonlandırması) da temiz kapanır:
// kısmi örnekler yazılır, oturum geri konur ve açık süreçler kapatılır.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`[sinyal] ${signal} alındı; kısmi örnekler yazılıp süreçler kapatılıyor.`);
    savePartial(`sinyal: ${signal}`);
    void (async () => {
      try {
        await withTimeout(finalizeRun(), 20_000, 'sinyal temizliği');
      } catch (error) {
        log(`[sinyal] temizlik tamamlanamadı: ${error.message}`);
      }
      process.exit(130);
    })();
  });
}

try {
  await main();
} catch (error) {
  log(`[hata] koşum tamamlanamadı: ${error.message}`);
  savePartial(`hata: ${error.message}`);
  process.exitCode = 3;
} finally {
  clearTimeout(watchdog);
  await finalizeRun();
}

// Süreç sonlandırma garantisi: kapanmamış bir CDP soketi veya alt süreç
// tutamacı kalmışsa Node kendiliğinden çıkmaz ve koşum çağıran tarafta
// "askıda kalmış" görünür. Tüm çıktı senkron yazıldığı için çıkış güvenlidir.
process.exit(process.exitCode ?? 0);
