/**
 * Açılış baseline karşılaştırıcısı.
 *
 * `scripts/measure-perf.mjs --startup --json-out <dosya>` çıktısını kayıtlı
 * baseline (`perf/startup-baseline.json`) ile karşılaştırır. Mutlak bütçe
 * kapısı (`--gate-startup`) yalnızca 900/3000 ms ve %1 CPU eşiklerini denetler;
 * bu adım ondan önceki sessiz kaymayı (ör. 419 ms → 850 ms) yakalar.
 *
 * Eşikler: baseline değerin %25 üstü **veya** +100 ms (hangisi büyükse) tolerans
 * sayılır; mutlak bütçe her durumda geçerlidir. Boşta CPU'da baseline + 0.25
 * puan tolerans uygulanır, üst sınır yine %1 makine kapasitesidir.
 *
 * Kullanım:
 *   node scripts/compare-startup-baseline.mjs \
 *     --baseline perf/startup-baseline.json \
 *     --current .temp_files/startup-current.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/** Baseline'a göre izin verilen en yüksek değer: %25 veya +100 ms, büyüğü. */
const TOLERANCE_PERCENT = 1.25;
const TOLERANCE_ABSOLUTE_MS = 100;
/** Boşta CPU için baseline üstüne eklenen tolerans (makine kapasitesi puanı). */
const TOLERANCE_IDLE_PERCENT = 0.25;
/** Mutlak kabul eşikleri (baseline kaydından bağımsız). */
const WARM_BUDGET_MS = 900;
const COLD_BUDGET_MS = 3000;
const IDLE_BUDGET_PERCENT = 1;

/** Açılışta yüklenmemesi gereken tembel chunk'ların dosya adı kalıbı. */
const HEAVY_ASSET_RE = /EditorPane|PreviewPane|highlight|dist-js|core-[A-Za-z0-9_-]+\.js/i;

const baselinePath = argValue('--baseline');
const currentPath = argValue('--current');

if (baselinePath === undefined || currentPath === undefined) {
  console.error(
    'kullanım: node scripts/compare-startup-baseline.mjs --baseline <json> --current <json>',
  );
  process.exit(2);
}

function readJson(path, label) {
  const full = resolve(path);
  if (!existsSync(full)) {
    console.error(`${label} bulunamadı: ${full}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    console.error(`${label} JSON olarak okunamadı: ${full} — ${error.message}`);
    process.exit(2);
  }
}

const baseline = readJson(baselinePath, 'baseline');
const current = readJson(currentPath, 'güncel ölçüm');

/**
 * Baseline tutarlılık denetimi.
 *
 * `processToFcpMs` süreç başlangıcından, `pageFcpMs` ise sayfa
 * navigasyonundan ilk boyaya kadar ölçülür; süreç → FCP her zaman sayfa
 * FCP'sinden büyük olmak zorundadır. İlişki bozuksa baseline kendi içinde
 * çelişkilidir (farklı koşulardan karışmış veya elle düzenlenmiş) ve
 * karşılaştırma sessizce anlamsız bir "regresyon" üretir. Böyle bir durumda
 * ürün değil baseline düzeltilmelidir; bu yüzden karşılaştırma yapılmaz.
 */
function assertBaselineConsistent(record) {
  const problems = [];
  const pairs = [
    ['soğuk', record.cold?.processToFcpMs, record.cold?.pageFcpMs],
    ['sıcak medyan', record.warm?.medianProcessToFcpMs, record.warm?.medianPageFcpMs],
  ];
  for (const [label, processMs, pageMs] of pairs) {
    if (!Number.isFinite(processMs) || !Number.isFinite(pageMs)) {
      problems.push(`${label}: processToFcpMs/pageFcpMs eksik veya sayı değil`);
      continue;
    }
    if (processMs <= 0 || pageMs < 0) {
      problems.push(`${label}: geçersiz süre (süreç ${processMs} ms, sayfa ${pageMs} ms)`);
      continue;
    }
    if (pageMs > processMs) {
      problems.push(
        `${label}: sayfa FCP ${pageMs} ms > süreç → FCP ${processMs} ms — bu ilişki imkânsız`,
      );
    }
  }
  if (problems.length === 0) return;
  console.error(`baseline geçersiz: ${resolve(baselinePath)}`);
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    'Karşılaştırma yapılmadı: baseline kendi içinde tutarsız, üretilen sayı regresyon kanıtı değildir.',
  );
  console.error(
    'Geçerli bir ölçümle yenileyin: node scripts/measure-perf.mjs --startup --json-out perf/startup-baseline.json',
  );
  process.exit(2);
}

assertBaselineConsistent(baseline);

/** Baseline değeri için toleranslı üst sınır. */
const allowedMs = (baselineMs) =>
  Math.round(Math.max(baselineMs * TOLERANCE_PERCENT, baselineMs + TOLERANCE_ABSOLUTE_MS));

const failures = [];
const warnings = [];
const rows = [];

/** Bir ölçümü baseline ile karşılaştırır ve sonucu satır olarak kaydeder. */
function compareMs(label, baselineMs, currentMs, budgetMs, useAbsoluteLimit = false) {
  if (!Number.isFinite(currentMs)) {
    failures.push(`${label}: ölçüm okunamadı`);
    return;
  }
  // Tek koşunun en yüksek değeri dağılım ucu olduğundan baseline toleransı
  // yerine doğrudan mutlak kabul eşiğiyle denetlenir; regresyon sinyali medyanda.
  const limit = useAbsoluteLimit ? budgetMs : Math.min(allowedMs(baselineMs), budgetMs);
  const delta = currentMs - baselineMs;
  const pass = currentMs <= limit;
  rows.push({
    metric: label,
    baselineMs,
    currentMs,
    deltaMs: delta,
    limitMs: limit,
    pass,
  });
  if (!pass) {
    failures.push(`${label}: ${currentMs} ms > izin ${limit} ms (baseline ${baselineMs} ms)`);
  }
}

compareMs(
  'sıcak başlatma medyanı (süreç → FCP)',
  baseline.warm?.medianProcessToFcpMs,
  current.warm?.medianProcessToFcpMs,
  WARM_BUDGET_MS,
);
const warmRunValues = (current.warm?.runs ?? []).map((run) => run.processToFcpMs);
const baselineWarmRunValues = (baseline.warm?.runs ?? []).map((run) => run.processToFcpMs);
compareMs(
  'sıcak başlatma en yüksek koşu',
  (baselineWarmRunValues.length > 0
    ? Math.max(...baselineWarmRunValues)
    : baseline.warm?.medianProcessToFcpMs) ?? Number.NaN,
  warmRunValues.length > 0 ? Math.max(...warmRunValues) : Number.NaN,
  WARM_BUDGET_MS,
  true,
);
compareMs(
  'soğuk açılış (WebView2 ilk kurulum)',
  baseline.cold?.processToFcpMs,
  current.cold?.processToFcpMs,
  COLD_BUDGET_MS,
);
compareMs(
  'sayfa FCP medyanı (sıcak)',
  baseline.warm?.medianPageFcpMs,
  current.warm?.medianPageFcpMs,
  WARM_BUDGET_MS,
);

// Boşta CPU: baseline + tolerans, mutlak %1 makine kapasitesi sınırının altında.
const idleBaseline = baseline.idleCpu?.medianPercentOfTotal ?? 0;
const idleCurrent = current.idleCpu?.medianPercentOfTotal;
const idleLimit = Math.min(idleBaseline + TOLERANCE_IDLE_PERCENT, IDLE_BUDGET_PERCENT);
if (!Number.isFinite(idleCurrent)) {
  failures.push('boşta CPU medyanı: ölçüm okunamadı');
} else {
  const pass = idleCurrent <= idleLimit;
  rows.push({
    metric: 'boşta CPU medyanı (%)',
    baselineMs: idleBaseline,
    currentMs: idleCurrent,
    deltaMs: Number((idleCurrent - idleBaseline).toFixed(3)),
    limitMs: Number(idleLimit.toFixed(3)),
    pass,
  });
  if (!pass) {
    failures.push(
      `boşta CPU: %${idleCurrent} > izin %${idleLimit.toFixed(3)} (baseline %${idleBaseline})`,
    );
  }
}

// Kuyruk (ikinci yarı pencere) tekrar eden arka plan işini gösterir; baseline 0.
const idleTail = current.idleCpu?.medianTailPercentOfTotal;
if (!Number.isFinite(idleTail) || idleTail > TOLERANCE_IDLE_PERCENT) {
  failures.push(`boşta CPU kuyruğu: %${idleTail} — tekrar eden arka plan işi şüphesi`);
}

// Açılışta dış ağ isteği olmamalı.
const external = current.externalRequests ?? [];
if (external.length > 0) {
  failures.push(`açılışta ${external.length} dış ağ isteği: ${external.map((r) => r.url).join(', ')}`);
}

// Ağır (tembel) chunk'lar açılışta yüklenmemeli.
const heavyLoaded = (current.resources ?? []).filter((url) => HEAVY_ASSET_RE.test(url));
if (heavyLoaded.length > 0) {
  failures.push(`açılışta ağır chunk yüklendi: ${heavyLoaded.join(', ')}`);
}

// Negatif CPU örnekleri gerçek tüketim değil, süreç ağacı değişimi artefaktıdır;
// kapıyı düşürmez ama ölçüm güvenilirliği için raporlanır.
const idleRuns = (current.warm?.runs ?? []).length;
if (idleRuns > 0 && idleCurrent !== undefined && (current.idleCpu?.maxPercentOfTotal ?? 0) > IDLE_BUDGET_PERCENT) {
  warnings.push(
    `boşta CPU en yüksek örnek %${current.idleCpu.maxPercentOfTotal} — tek koşu bütçeyi aşıyor`,
  );
}
if ((current.idleCpu?.medianPercentOfTotal ?? 0) < 0) {
  warnings.push(
    'boşta CPU medyanı negatif: süreç ağacından çıkan WebView2 alt süreci ölçümü aşağı çekti',
  );
}

const pad = (value, width) => String(value).padStart(width);
console.log('=== açılış baseline karşılaştırması ===');
console.log(
  `${'ölçüm'.padEnd(38)} ${pad('baseline', 10)} ${pad('güncel', 10)} ${pad('fark', 9)} ${pad('izin', 9)}  sonuç`,
);
for (const row of rows) {
  const delta = `${row.deltaMs > 0 ? '+' : ''}${row.deltaMs}`;
  console.log(
    `${row.metric.padEnd(38)} ${pad(row.baselineMs, 10)} ${pad(row.currentMs, 10)} ${pad(delta, 9)} ${pad(row.limitMs, 9)}  ${row.pass ? 'uygun' : 'AŞIM'}`,
  );
}
console.log(`dış ağ isteği: ${external.length} | ağır chunk: ${heavyLoaded.length}`);

for (const warning of warnings) console.warn(`[uyarı] ${warning}`);

if (failures.length > 0) {
  console.error('=== baseline regresyonu ===');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('=== baseline uygun: kayıtlı sayılara göre regresyon yok ===');
}
