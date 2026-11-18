/**
 * Bütçe ölçüm koşum takımı.
 *
 * Üç kabul kriterini **tek komutla** ölçer, her adımı ayrı bir alt süreçte
 * kesin bir zaman aşımıyla çalıştırır ve makine-okunur bir rapor üretir:
 *
 * 1. **İlk yüklenen JS toplamı (gzip):** üretim derlemesinin gerçek çıktısı
 *    (`dist/`) üzerinden manifest tabanlı chunk ölçümü —
 *    `scripts/check-bundle-budget.mjs`.
 * 2. **5 sekme açıkken çalışma seti:** release ikilisi WebView2 ile açılır,
 *    oturuma 5 sekme yazılır, süreç ağacının çalışma seti okunur —
 *    `scripts/measure-perf.mjs --tabs 5 --runs 1 --max-rss-mib 150`.
 * 3. **Kurulum paketi boyutu (WebView2 hariç):** NSIS kurulum artefaktı —
 *    `scripts/check-installer-budget.mjs`.
 *
 * Alt süreçler `--json-out` ile kendi raporlarını yazar; bu koşum takımı
 * bunları toplar, PASS/FAIL ve limite uzaklığı hesaplar, `budget-report.json`
 * (makine-okunur) ve istenirse `budget-baseline.md` (insan-okunur) üretir.
 *
 * Kullanım:
 *   npm run budget:measure
 *   node scripts/measure-budgets.mjs --write-baseline
 *   node scripts/measure-budgets.mjs --only js,installer
 *   node scripts/measure-budgets.mjs --build
 *
 * Çıkış kodları:
 *   0 → üç metrik de ölçüldü ve bütçe içinde
 *   1 → ölçüm yapıldı ama en az bir metrik bütçeyi aştı
 *   2 → en az bir metrik ölçülemedi (build/ikili/artefakt yok, zaman aşımı)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 5 sekme profilinde izin verilen en yüksek özel çalışma seti (MiB). */
const MEMORY_BUDGET_MIB = 150;

/**
 * Her adım: çalıştırılacak betik, ek argümanlar ve kesin zaman aşımı.
 * Zaman aşımları ölçülen sürelerin üzerinde geniş tutuldu; takılan bir adım
 * sessizce beklemesin diye alt süreç SIGKILL ile sonlandırılır.
 */
const STEPS = {
  js: {
    label: 'İlk yüklenen JS toplamı (gzip)',
    script: 'scripts/check-bundle-budget.mjs',
    args: [],
    timeoutMs: 180_000,
  },
  memory: {
    label: '5 sekme açıkken toplam çalışma seti (indirgenmiş toplam çalışma seti)',
    script: 'scripts/measure-perf.mjs',
    args: ['--tabs', '5', '--runs', '1', '--max-rss-mib', String(MEMORY_BUDGET_MIB)],
    timeoutMs: 420_000,
  },
  installer: {
    label: 'Kurulum paketi boyutu (WebView2 hariç)',
    script: 'scripts/check-installer-budget.mjs',
    args: [],
    timeoutMs: 60_000,
  },
};

const STEP_IDS = Object.keys(STEPS);
const REPORT_DIR = resolve('.temp_files/budget');

function parseArgs(argv) {
  const options = {
    only: [...STEP_IDS],
    out: 'budget-report.json',
    baseline: 'budget-baseline.md',
    writeBaseline: false,
    build: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--only' && value !== undefined) {
      const requested = value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const unknown = requested.filter((id) => !STEP_IDS.includes(id));
      if (unknown.length > 0) {
        throw new Error(
          `bilinmeyen adım: ${unknown.join(', ')} (geçerli: ${STEP_IDS.join(', ')})`,
        );
      }
      options.only = requested;
      index += 1;
    } else if (argv[index] === '--out' && value !== undefined) {
      options.out = value;
      index += 1;
    } else if (argv[index] === '--baseline' && value !== undefined) {
      options.baseline = value;
      index += 1;
    } else if (argv[index] === '--write-baseline') {
      options.writeBaseline = true;
    } else if (argv[index] === '--build') {
      options.build = true;
    } else {
      throw new Error(`bilinmeyen argüman: ${argv[index]}`);
    }
  }
  return options;
}

function newestMtime(directory) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  if (existsSync(directory)) walk(directory);
  return newest;
}

function runCommand(command, args, timeoutMs) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
}

/** Üretim ön yüz derlemesini tazeler (isteğe bağlı `--build`). */
function buildFrontend() {
  console.log('[budget] ön yüz derlemesi çalıştırılıyor: npm run build');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = runCommand(npm, ['run', 'build'], 300_000);
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error('npm run build zaman aşımına uğradı (300000 ms).');
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
    throw new Error(`npm run build başarısız (exit ${result.status}):\n${output}`);
  }
}

function readChildReport(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { parseError: String(error) };
  }
}

function tail(text, lines = 12) {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return '';
  return trimmed.split('\n').slice(-lines).join('\n');
}

/** Limit yakınlığını tek satırda ifade eder: kalan pay ve yüzde. */
function describeHeadroom(value, limit) {
  const remaining = Number((limit - value).toFixed(2));
  const ratio = limit === 0 ? 0 : (value / limit) * 100;
  return {
    remaining,
    usedPercent: Number(ratio.toFixed(1)),
    text: remaining >= 0
      ? `limite ${remaining} ${''}kaldı (%${ratio.toFixed(1)} kullanıldı)`.replace('  ', ' ')
      : `limit ${Math.abs(remaining)} aşıldı (%${ratio.toFixed(1)} kullanıldı)`,
  };
}

function runStep(id) {
  const step = STEPS[id];
  const reportPath = join(REPORT_DIR, `${id}.json`);
  rmSync(reportPath, { force: true });
  mkdirSync(REPORT_DIR, { recursive: true });

  const scriptPath = resolve(step.script);
  const args = [scriptPath, ...step.args, '--json-out', reportPath];
  const commandLine = `node ${step.script} ${[...step.args, '--json-out', reportPath].join(' ')}`;

  console.log(`[budget] ${id}: ${commandLine} (zaman aşımı ${step.timeoutMs} ms)`);
  const startedAt = Date.now();
  const result = runCommand(process.execPath, args, step.timeoutMs);
  const durationMs = Date.now() - startedAt;

  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL') {
    console.error(
      `[budget] ${id}: ZAMAN AŞIMI (${step.timeoutMs} ms) — ${commandLine}\n` +
        `[budget] ${id}: adım ölçüm yapmadan sonlandırıldı.`,
    );
    return {
      id,
      label: step.label,
      status: 'timeout',
      durationMs,
      error: `zaman aşımı: ${step.timeoutMs} ms`,
      command: commandLine,
    };
  }

  const report = readChildReport(reportPath);
  if (report === null) {
    console.error(
      `[budget] ${id}: rapor üretilmedi (exit ${result.status}); son çıktı:\n${tail(result.stderr)}`,
    );
    return {
      id,
      label: step.label,
      status: 'error',
      durationMs,
      exitCode: result.status,
      error: `rapor dosyası oluşmadı: ${reportPath}`,
      stderr: tail(result.stderr),
      command: commandLine,
    };
  }
  if (report.parseError !== undefined) {
    return {
      id,
      label: step.label,
      status: 'error',
      durationMs,
      error: `rapor okunamadı: ${report.parseError}`,
      command: commandLine,
    };
  }

  return normalize(id, step, report, { durationMs, exitCode: result.status, command: commandLine });
}

/** Alt süreç raporlarını tek biçime indirger. */
function normalize(id, step, report, meta) {
  const base = {
    id,
    label: step.label,
    durationMs: meta.durationMs,
    exitCode: meta.exitCode,
    command: meta.command,
  };

  if (id === 'js') {
    const primary = report.primary ?? {};
    if (typeof primary.value !== 'number') {
      return { ...base, status: 'unmeasured', error: report.error ?? 'ilk yük JS toplamı okunamadı' };
    }
    return {
      ...base,
      status: 'measured',
      unit: report.unit ?? 'KB',
      value: primary.value,
      limit: primary.limit,
      pass: report.pass === true,
      detail: report.detail ?? {},
      others: report.others ?? [],
    };
  }

  if (id === 'installer') {
    const primary = report.primary ?? {};
    if (typeof primary.value !== 'number') {
      return { ...base, status: 'unmeasured', error: report.error ?? 'kurulum artefaktı bulunamadı' };
    }
    return {
      ...base,
      status: 'measured',
      unit: report.unit ?? 'MiB',
      value: primary.value,
      limit: primary.limit,
      pass: report.pass === true,
      detail: { installers: report.installers ?? [] },
    };
  }

  // memory
  const budget = report.budget;
  if (budget === undefined || typeof budget.measuredMaxDedupedMiB !== 'number') {
    return { ...base, status: 'unmeasured', error: 'bellek ölçümü tamamlanmadı (toplam çalışma seti okunamadı)' };
  }
  return {
    ...base,
    status: 'measured',
    unit: 'MiB',
    value: budget.measuredMaxDedupedMiB,
    limit: budget.limitMiB,
    pass: budget.pass === true,
    detail: {
      tabs: budget.tabs,
      metric: budget.metric ?? null,
      privateMiB: budget.measuredMaxPrivateMiB,
      naiveSumMiB: budget.measuredMaxNaiveSumMiB,
      idlePrivateMiB: report.idle?.medianRssMiB ?? null,
      externalRequests: report.externalRequests ?? [],
    },
  };
}

function formatValue(result) {
  if (result.status !== 'measured') return '—';
  return `${result.value} ${result.unit}`;
}

function buildBaselineMarkdown(report) {
  const lines = [];
  lines.push('# Bütçe Başlangıç Değerleri (budget-baseline)');
  lines.push('');
  lines.push(
    'Bu dosya `npm run budget:measure` tarafından üretilir; üç kabul kriterinin ' +
      'ölçülen değerini, bütçe limitini, PASS/FAIL durumunu ve limite uzaklığı kaydeder.',
  );
  lines.push('');
  lines.push(`- **Ölçüm tarihi:** ${report.generatedAt}`);
  lines.push(`- **Platform:** ${report.platform}`);
  lines.push(`- **Node.js:** ${report.node}`);
  lines.push(`- **Komut:** \`${report.command}\``);
  lines.push('');
  lines.push('| Metrik | Ölçülen | Limit | Sonuç | Limite uzaklık |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const metric of report.metrics) {
    if (metric.status !== 'measured') {
      lines.push(
        `| ${metric.label} | ölçülemedi | — | ÖLÇÜLEMEDİ | ${metric.error ?? 'bilinmeyen hata'} |`,
      );
      continue;
    }
    const headroom = describeHeadroom(metric.value, metric.limit);
    lines.push(
      `| ${metric.label} | **${metric.value} ${metric.unit}** | ≤ ${metric.limit} ${metric.unit} | ${metric.pass ? 'PASS' : 'FAIL'} | ${headroom.text} |`,
    );
  }
  lines.push('');
  lines.push('## Ayrıntılar');
  lines.push('');
  for (const metric of report.metrics) {
    lines.push(`### ${metric.label}`);
    lines.push('');
    if (metric.status !== 'measured') {
      lines.push(`- Durum: **ÖLÇÜLEMEDİ** (${metric.error ?? 'bilinmeyen hata'})`);
      lines.push(`- Komut: \`${metric.command}\``);
      lines.push('');
      continue;
    }
    lines.push(`- Durum: **${metric.pass ? 'PASS' : 'FAIL'}**`);
    lines.push(`- Ölçülen: ${metric.value} ${metric.unit} / limit ${metric.limit} ${metric.unit}`);
    lines.push(`- Komut: \`${metric.command}\``);
    if (metric.id === 'js') {
      for (const other of metric.others ?? []) {
        if (typeof other.value === 'number') {
          lines.push(
            `- Alt bütçe \`${other.id}\`: ${other.value} KB / limit ${other.limit} KB → ${other.pass ? 'PASS' : 'FAIL'}`,
          );
        }
      }
      lines.push(`- Ölçülen chunk sayısı: ${(metric.detail?.startupChunks ?? []).length}`);
    }
    if (metric.id === 'memory') {
      if (metric.detail?.metric) {
        lines.push(`- Metrik: ${metric.detail.metric.definition}`);
        lines.push(`- Kaynak: \`${metric.detail.metric.source}\``);
        lines.push(`- Gerekçe: ${metric.detail.metric.rationale}`);
      }
      lines.push(
        `- Ham WorkingSet toplamı (paylaşılan sayfalar çift sayılır, bütçe değil): ${metric.detail?.naiveSumMiB ?? '—'} MiB`,
      );
      lines.push(
        `- Özel çalışma seti toplamı (tanı, paylaşılan sayfalar hariç): ${metric.detail?.privateMiB ?? '—'} MiB`,
      );
      lines.push(`- Boşta özel çalışma seti: ${metric.detail?.idlePrivateMiB ?? '—'} MiB`);
    }
    if (metric.id === 'installer') {
      for (const installer of metric.detail?.installers ?? []) {
        lines.push(`- \`${installer.name}\`: ${installer.mib} MiB`);
      }
      lines.push('- WebView2 çalışma zamanı pakete gömülmez (`downloadBootstrapper`).');
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[budget] argüman hatası: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (options.build) buildFrontend();

  const distManifest = resolve('dist/.vite/manifest.json');
  const distNewest = existsSync(distManifest) ? statSync(distManifest).mtimeMs : 0;
  const srcNewest = newestMtime(resolve('src'));
  if (distNewest > 0 && srcNewest > distNewest) {
    console.warn(
      '[budget] uyarı: üretim derlemesi kaynaklardan eski (`dist/` yeniden derlenmeli: `npm run build`). ' +
        'JS ölçümü eski çıktıyı yansıtabilir.',
    );
  }

  const results = options.only.map((id) => runStep(id));

  const metrics = results.map((result) => {
    if (result.status !== 'measured') return { ...result };
    const headroom = describeHeadroom(result.value, result.limit);
    return {
      ...result,
      headroom: { remaining: headroom.remaining, usedPercent: headroom.usedPercent },
    };
  });

  const allMeasured = metrics.every((metric) => metric.status === 'measured');
  const allPass = allMeasured && metrics.every((metric) => metric.pass === true);
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    command: 'npm run budget:measure',
    allMeasured,
    ok: allPass,
    metrics,
  };

  const outPath = resolve(options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\n=== bütçe ölçüm sonuçları ===');
  for (const metric of metrics) {
    if (metric.status !== 'measured') {
      console.log(
        `  ${metric.label}: ÖLÇÜLEMEDİ (${metric.error ?? metric.status})`,
      );
      continue;
    }
    const headroom = describeHeadroom(metric.value, metric.limit);
    console.log(
      `  ${metric.label}: ${formatValue(metric)} / limit ${metric.limit} ${metric.unit} → ${metric.pass ? 'PASS' : 'FAIL'} | ${headroom.text}`,
    );
  }
  console.log(`  rapor: ${outPath}`);

  if (options.writeBaseline) {
    const baselinePath = resolve(options.baseline);
    writeFileSync(baselinePath, buildBaselineMarkdown(report), 'utf8');
    console.log(`  başlangıç belgesi: ${baselinePath}`);
  }

  if (!allMeasured) process.exitCode = 2;
  else if (!allPass) process.exitCode = 1;
}

main();
