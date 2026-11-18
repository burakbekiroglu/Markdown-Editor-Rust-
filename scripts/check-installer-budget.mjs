/**
 * Kurulum paketi bütçesi bekçisi.
 *
 * `npm run tauri:build` sonrası NSIS kurulum dosyasını
 * (`src-tauri/target/release/bundle/nsis/*.exe`) diskten okur ve boyutunu
 * bütçeyle karşılaştırır. WebView2 çalışma zamanı paket içine gömülmez
 * (`tauri.conf.json` → `bundle.windows.webviewInstallMode.type =
 * "downloadBootstrapper"`), bu yüzden ölçülen boyut WebView2 hariç kurulum
 * paketidir.
 *
 * Kurulum dosyası yoksa (henüz `tauri build` çalıştırılmadıysa) bu bir ölçüm
 * eksikliğidir ve script exit code 2 ile bunu bildirir; sessizce "geçti"
 * demez.
 *
 * Kullanım:
 *   npm run perf:installer
 *   node scripts/check-installer-budget.mjs --bundle src-tauri/target/release/bundle/nsis
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Kurulum paketi üst sınırı (MiB; WebView2 çalışma zamanı hariç). */
export const INSTALLER_BUDGET_MIB = 12;

const MIB = 1024 * 1024;

function parseArgs(argv) {
  const options = {
    bundle: 'src-tauri/target/release/bundle/nsis',
    maxMiB: INSTALLER_BUDGET_MIB,
    jsonOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--bundle' && value !== undefined) {
      options.bundle = value;
      index += 1;
    } else if (argv[index] === '--max-mib' && value !== undefined && Number.isFinite(Number(value))) {
      options.maxMiB = Number(value);
      index += 1;
    } else if (argv[index] === '--json-out' && value !== undefined) {
      options.jsonOut = value;
      index += 1;
    }
  }
  return options;
}

/** Makine-okunur raporu (varsa) diske yazar. */
function writeReport(jsonOut, report) {
  if (jsonOut === null) return;
  const target = resolve(jsonOut);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** Dizindeki kurulum dosyalarını (`.exe`) bulur. */
function installerFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => {
      const path = join(directory, name);
      return { name, path, size: statSync(path).size };
    });
}

function formatMiB(bytes) {
  return (bytes / MIB).toFixed(2);
}

function main() {
  const { bundle, maxMiB, jsonOut } = parseArgs(process.argv.slice(2));
  const directory = resolve(bundle);
  const installers = installerFiles(directory);

  if (installers.length === 0) {
    const message =
      `${directory} içinde kurulum dosyası bulunamadı. Önce "npm run tauri:build" çalıştırın.`;
    console.error(`kurulum paketi bekçisi: ${message}`);
    writeReport(jsonOut, {
      metric: 'installer-size',
      generatedAt: new Date().toISOString(),
      unit: 'MiB',
      primary: { id: 'installer-size-mib', value: null, limit: maxMiB, pass: false },
      installers: [],
      pass: false,
      error: message,
    });
    process.exitCode = 2;
    return;
  }

  const limit = maxMiB * MIB;
  let over = false;
  console.log('=== kurulum paketi (WebView2 hariç) ===');
  for (const installer of installers) {
    const ok = installer.size <= limit;
    if (!ok) over = true;
    console.log(
      `  ${installer.name}  ${formatMiB(installer.size)} MiB / bütçe ${maxMiB} MiB → ${ok ? 'uygun' : 'AŞIM'}`,
    );
  }

  // En büyük kurulum dosyası bütçeyi temsil eder (birden çok artefakt varsa).
  const largest = installers.reduce((max, installer) =>
    installer.size > max.size ? installer : max,
  );

  console.log('=== sonuç ===');
  console.log(`  kurulum paketi: ${over ? 'AŞIM' : 'uygun'}`);
  if (over) process.exitCode = 1;

  writeReport(jsonOut, {
    metric: 'installer-size',
    generatedAt: new Date().toISOString(),
    unit: 'MiB',
    primary: {
      id: 'installer-size-mib',
      value: Number(formatMiB(largest.size)),
      limit: maxMiB,
      pass: !over,
    },
    installers: installers.map((installer) => ({
      name: installer.name,
      mib: Number(formatMiB(installer.size)),
      bytes: installer.size,
    })),
    pass: !over,
    detail: { directory, webview2: 'excluded (downloadBootstrapper)' },
  });
}

// Dosya gövdesi doğrudan çalıştırılıyorsa ölçüm yapılır; içe aktarıldığında
// yalnızca sabitler kullanılabilir kalır.
main();
