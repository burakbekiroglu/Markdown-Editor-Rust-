/**
 * Paket bütçesi bekçisi.
 *
 * `vite build` çıktısındaki `.vite/manifest.json` dosyasını okur; chunk'ları
 * dosya adı tahminine değil, manifestteki kaynak modül eşlemesine göre tanır.
 * Her JS chunk'ı gzip'lenerek ölçülür (zlib seviye 9) ve iki bütçeyle
 * karşılaştırılır:
 *
 * - Başlangıç (entry) chunk'ı ve statik import zinciri: ≤ 250 KB gzip.
 * - İlk yüklenen JS toplamı (başlangıç zinciri + uygulama açılırken getirilen
 *   `EditorPane` dinamik chunk'ı ve onun dinamik import zinciri): ≤ 320 KB gzip.
 * - Tembel önizleme chunk'ı: ≤ 160 KB gzip.
 *
 * Önizleme henüz ayrı bir dinamik chunk değilse (PreviewPane `EditorPane`
 * içinde statik duruyorsa) ölçüm `EditorPane` dinamik chunk'ı üzerinden
 * yapılır ve bu durum çıktıda açıkça belirtilir. Bütçe aşımı exit code 1'dir.
 *
 * Kullanım:
 *   npm run perf:bundle
 *   node scripts/check-bundle-budget.mjs --dist dist
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Gzip'lenmiş başlangıç bütçesi (KB, 1024 bayt). */
export const INITIAL_BUDGET_KB = 250;
/** Gzip'lenmiş tembel önizleme bütçesi (KB, 1024 bayt). */
export const PREVIEW_BUDGET_KB = 160;
/**
 * İlk yüklenen JS toplam bütçesi (KB, 1024 bayt).
 *
 * Kapsam: entry + statik import zinciri, ayrıca uygulama açılırken hemen
 * getirilen `EditorPane` dinamik girişi ve onun dinamik import zinciri
 * (highlight.js alt kümesi, opener eklentisi). Bu, kullanıcı hiçbir şey
 * yapmadan çalışma zamanına giren JS yüküdür.
 */
export const STARTUP_TOTAL_BUDGET_KB = 320;

const KB = 1024;

function parseArgs(argv) {
  const options = { dist: 'dist', jsonOut: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dist' && argv[index + 1] !== undefined) {
      options.dist = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--json-out' && argv[index + 1] !== undefined) {
      options.jsonOut = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function fail(message) {
  console.error(`paket bütçesi: ${message}`);
  process.exitCode = 1;
}

/** Makine-okunur raporu (varsa) diske yazar. */
function writeReport(jsonOut, report) {
  if (jsonOut === null) return;
  const target = resolve(jsonOut);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** Ölçüm yapılamadığında (build yok, chunk kimliği çözülemedi) rapor. */
function failedReport(message) {
  return {
    metric: 'initial-js-gzip',
    generatedAt: new Date().toISOString(),
    unit: 'KB',
    primary: { id: 'initial-js-gzip-total', value: null, limit: STARTUP_TOTAL_BUDGET_KB, pass: false },
    others: [],
    pass: false,
    error: message,
  };
}

function readManifest(distDirectory) {
  const manifestPath = join(distDirectory, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail(
      `build manifest bulunamadı: ${manifestPath}. Önce "npx vite build" çalıştırın.`,
    );
    return null;
  }
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
}

function fileBytes(distDirectory, relativeFile) {
  const fullPath = join(distDirectory, relativeFile);
  if (!existsSync(fullPath)) {
    throw new Error(`manifestte listelenen dosya yok: ${fullPath}`);
  }
  return readFileSync(fullPath);
}

/**
 * Statik import zincirini (manifestte `_` ile başlayan paylaşılan chunk'lar)
 * toplar. Dinamik import'lar başlangıç yükünün parçası değildir.
 */
function initialChunks(manifest, entryKey) {
  const seen = new Set();
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.pop();
    if (key === undefined || seen.has(key)) continue;
    const chunk = manifest[key];
    if (chunk === undefined) continue;
    seen.add(key);
    for (const imported of chunk.imports ?? []) {
      if (imported.startsWith('_')) queue.push(imported);
    }
  }
  return [...seen];
}

function gzipSize(bytes) {
  return gzipSync(bytes, { level: 9 }).length;
}

function findEntryKey(manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry === true) return key;
  }
  return null;
}

/**
 * Tembel önizleme chunk'ı: önce `src/lib/preview/**` kaynaklı dinamik giriş,
 * yoksa önizlemeyi içeren `EditorPane` dinamik girişi (yedek).
 */
function findPreviewChunk(manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isDynamicEntry !== true) continue;
    const source = typeof chunk.src === 'string' ? chunk.src : key;
    if (/src\/lib\/preview\//.test(source)) {
      return { key, chunk, dedicated: true };
    }
  }
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isDynamicEntry !== true) continue;
    const source = typeof chunk.src === 'string' ? chunk.src : key;
    if (/src\/lib\/editor\/EditorPane\.svelte/.test(source)) {
      return { key, chunk, dedicated: false };
    }
  }
  return null;
}

/** Uygulama ilk sekmede hemen `import()` ettiği `EditorPane` dinamik girişi. */
function findEditorChunkKey(manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isDynamicEntry !== true) continue;
    const source = typeof chunk.src === 'string' ? chunk.src : key;
    if (/src\/lib\/editor\/EditorPane\.svelte/.test(source)) return key;
  }
  return null;
}

/**
 * Verilen chunk anahtarlarından başlayıp hem statik (`imports`) hem dinamik
 * (`dynamicImports`) bağımlılıkları izleyerek ulaşılan tüm chunk'ları toplar.
 * Anahtarlar tekil olduğundan aynı dosya iki kez sayılmaz.
 */
function reachableChunks(manifest, startKeys) {
  const seen = new Set();
  const queue = [...startKeys];
  while (queue.length > 0) {
    const key = queue.pop();
    if (key === undefined || seen.has(key)) continue;
    const chunk = manifest[key];
    if (chunk === undefined) continue;
    seen.add(key);
    for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      queue.push(dependency);
    }
  }
  return [...seen];
}

function formatKb(bytes) {
  return (bytes / KB).toFixed(1);
}

function main() {
  const { dist, jsonOut } = parseArgs(process.argv.slice(2));
  const distDirectory = resolve(dist);
  const loaded = readManifest(distDirectory);
  if (loaded === null) {
    writeReport(jsonOut, failedReport(`build manifest bulunamadı: ${distDirectory}`));
    process.exitCode = 2;
    return;
  }
  const { manifest } = loaded;

  const entryKey = findEntryKey(manifest);
  if (entryKey === null) {
    fail('manifestte `isEntry` işaretli giriş chunk bulunamadı.');
    writeReport(jsonOut, failedReport('manifestte `isEntry` işaretli giriş chunk bulunamadı.'));
    process.exitCode = 2;
    return;
  }

  const initialKeys = initialChunks(manifest, entryKey);
  const initial = initialKeys.map((key) => {
    const chunk = manifest[key];
    const bytes = fileBytes(distDirectory, chunk.file);
    return { key, file: chunk.file, raw: bytes.length, gzip: gzipSize(bytes) };
  });
  const initialGzip = initial.reduce((sum, chunk) => sum + chunk.gzip, 0);
  const initialLimit = INITIAL_BUDGET_KB * KB;

  const editorKey = findEditorChunkKey(manifest);
  const startupLimit = STARTUP_TOTAL_BUDGET_KB * KB;
  let startup = [];
  let startupGzip = null;
  if (editorKey === null) {
    fail('`EditorPane` dinamik girişi manifestte bulunamadı; ilk yük JS toplamı ölçülemedi.');
    writeReport(jsonOut, failedReport(
      '`EditorPane` dinamik girişi manifestte bulunamadı; ilk yük JS toplamı ölçülemedi.',
    ));
    process.exitCode = 2;
    return;
  } else {
    startup = reachableChunks(manifest, [...initialKeys, editorKey])
      .sort()
      .map((key) => {
        const chunk = manifest[key];
        const bytes = fileBytes(distDirectory, chunk.file);
        return { file: chunk.file, raw: bytes.length, gzip: gzipSize(bytes) };
      });
    startupGzip = startup.reduce((sum, chunk) => sum + chunk.gzip, 0);
  }

  const preview = findPreviewChunk(manifest);
  const previewLimit = PREVIEW_BUDGET_KB * KB;
  let previewGzip = null;
  let previewLabel = 'yok';

  console.log('=== başlangıç chunk\'ları (statik) ===');
  for (const chunk of initial) {
    console.log(
      `  ${chunk.file}  raw ${formatKb(chunk.raw)} KB  gzip ${formatKb(chunk.gzip)} KB`,
    );
  }
  console.log(
    `  toplam gzip ${formatKb(initialGzip)} KB / bütçe ${INITIAL_BUDGET_KB} KB`,
  );

  if (startupGzip !== null) {
    console.log('=== ilk yüklenen JS (başlangıç + hemen açılan editör) ===');
    for (const chunk of startup) {
      console.log(
        `  ${chunk.file}  raw ${formatKb(chunk.raw)} KB  gzip ${formatKb(chunk.gzip)} KB`,
      );
    }
    console.log(
      `  toplam gzip ${formatKb(startupGzip)} KB / bütçe ${STARTUP_TOTAL_BUDGET_KB} KB`,
    );
  }

  if (preview === null) {
    fail('tembel önizleme chunk\'ı manifestte bulunamadı.');
  } else {
    const bytes = fileBytes(distDirectory, preview.chunk.file);
    previewGzip = gzipSize(bytes);
    previewLabel = preview.chunk.file;
    console.log('=== tembel önizleme chunk\'ı ===');
    console.log(
      `  ${preview.chunk.file}  raw ${formatKb(bytes.length)} KB  gzip ${formatKb(previewGzip)} KB / bütçe ${PREVIEW_BUDGET_KB} KB`,
    );
    if (!preview.dedicated) {
      console.log(
        '  not: ayrı bir `src/lib/preview/**` dinamik chunk yok; önizleme `EditorPane` chunk\'ı içinde ölçüldü.',
      );
    }
  }

  const overInitial = initialGzip > initialLimit;
  const overStartup = startupGzip !== null && startupGzip > startupLimit;
  const overPreview = previewGzip !== null && previewGzip > previewLimit;

  console.log('=== sonuç ===');
  console.log(
    `  başlangıç: ${overInitial ? 'AŞIM' : 'uygun'} (${formatKb(initialGzip)} KB gzip)`,
  );
  if (startupGzip !== null) {
    console.log(
      `  ilk yük JS toplamı: ${overStartup ? 'AŞIM' : 'uygun'} (${formatKb(startupGzip)} KB gzip)`,
    );
  }
  if (previewGzip !== null) {
    console.log(
      `  önizleme (${previewLabel}): ${overPreview ? 'AŞIM' : 'uygun'} (${formatKb(previewGzip)} KB gzip)`,
    );
  }

  if (overInitial || overStartup || overPreview) process.exitCode = 1;

  writeReport(jsonOut, {
    metric: 'initial-js-gzip',
    generatedAt: new Date().toISOString(),
    unit: 'KB',
    primary: {
      id: 'initial-js-gzip-total',
      value: startupGzip === null ? null : Number(formatKb(startupGzip)),
      limit: STARTUP_TOTAL_BUDGET_KB,
      pass: startupGzip !== null && !overStartup,
    },
    others: [
      {
        id: 'initial-entry-gzip',
        value: Number(formatKb(initialGzip)),
        limit: INITIAL_BUDGET_KB,
        pass: !overInitial,
      },
      {
        id: 'preview-gzip',
        value: previewGzip === null ? null : Number(formatKb(previewGzip)),
        limit: PREVIEW_BUDGET_KB,
        pass: previewGzip !== null && !overPreview,
      },
    ],
    pass: !overInitial && !overStartup && !overPreview,
    detail: {
      dist: distDirectory,
      initialChunks: initial.map((chunk) => ({
        file: chunk.file,
        rawKb: Number(formatKb(chunk.raw)),
        gzipKb: Number(formatKb(chunk.gzip)),
      })),
      startupChunks: startup.map((chunk) => ({
        file: chunk.file,
        rawKb: Number(formatKb(chunk.raw)),
        gzipKb: Number(formatKb(chunk.gzip)),
      })),
      previewChunk: preview === null ? null : previewLabel,
      previewDedicated: preview === null ? false : preview.dedicated,
    },
  });
}

main();
