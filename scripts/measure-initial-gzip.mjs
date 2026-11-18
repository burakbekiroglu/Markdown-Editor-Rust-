/**
 * İlk yükleme JS chunk'ları için tek seferlik gzip ölçüm betiği.
 *
 * Mevcut üretim derlemesinin çıktısını (`dist/.vite/manifest.json` + `assets/`)
 * **yalnızca okur** ve ilk yüklemede çekilen JS chunk'larını listeler:
 * `isEntry` işaretli giriş chunk'ı ve onun **statik** import zinciri
 * (`imports` içinde `_` ile başlayan paylaşılan chunk'lar). Dinamik import'lar
 * ilk yüklemenin parçası değildir; bu yüzden ölçüme katılmaz.
 *
 * Her chunk için ham bayt ve gzip (zlib seviye 9) boyutu yazdırılır, sonda
 * toplam gzip KB basılır. Betik kaynak kodu değiştirmez, yeni bağımlılık
 * eklemez ve deterministiktir: aynı build için her çalıştırmada aynı sayısal
 * çıktıyı verir (zaman damgası vb. basılmaz).
 *
 * Kullanım:
 *   node scripts/measure-initial-gzip.mjs
 *   node scripts/measure-initial-gzip.mjs --dist dist
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1024;

function parseArgs(argv) {
  const options = { dist: 'dist' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dist' && argv[index + 1] !== undefined) {
      options.dist = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`bilinmeyen argüman: ${argv[index]}`);
    }
  }
  return options;
}

function readManifest(distDirectory) {
  const manifestPath = join(distDirectory, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `build manifest bulunamadı: ${manifestPath}. Önce "npx vite build" çalıştırın.`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function findEntryKey(manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry === true) return key;
  }
  return null;
}

/**
 * Giriş chunk'ından başlayıp yalnızca statik `imports` bağlantılarını izler.
 * `dynamicImports` bilinçli olarak atlanır: bunlar ilk yüklemede değil,
 * sonradan `import()` edilir.
 */
function staticChunks(manifest, entryKey) {
  const seen = new Set();
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.pop();
    if (key === undefined || seen.has(key)) continue;
    const chunk = manifest[key];
    if (chunk === undefined) continue;
    seen.add(key);
    for (const imported of chunk.imports ?? []) {
      queue.push(imported);
    }
  }
  return [...seen];
}

function formatKb(bytes) {
  return (bytes / KB).toFixed(2);
}

function main() {
  const { dist } = parseArgs(process.argv.slice(2));
  const distDirectory = resolve(dist);
  const manifest = readManifest(distDirectory);

  const entryKey = findEntryKey(manifest);
  if (entryKey === null) {
    throw new Error('manifestte `isEntry` işaretli giriş chunk bulunamadı.');
  }

  const rows = staticChunks(manifest, entryKey)
    .map((key) => {
      const file = manifest[key].file;
      const fullPath = join(distDirectory, file);
      if (!existsSync(fullPath)) {
        throw new Error(`manifestte listelenen dosya yok: ${fullPath}`);
      }
      const bytes = readFileSync(fullPath);
      return {
        file,
        raw: bytes.length,
        gzip: gzipSync(bytes, { level: 9 }).length,
      };
    })
    // Bayt sırasına göre sırala: `localeCompare` yerel ayara duyarlı olduğundan
    // farklı makinelerde satır sırasını değiştirebilirdi; çıktı deterministik kalmalı.
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const totalRaw = rows.reduce((sum, row) => sum + row.raw, 0);
  const totalGzip = rows.reduce((sum, row) => sum + row.gzip, 0);

  console.log('=== ilk yükleme JS chunk\'ları (giriş + statik import zinciri) ===');
  for (const row of rows) {
    console.log(
      `  ${row.file}  raw ${row.raw} B (${formatKb(row.raw)} KB)  gzip ${row.gzip} B (${formatKb(row.gzip)} KB)`,
    );
  }
  console.log(
    `  toplam: ${rows.length} chunk, raw ${formatKb(totalRaw)} KB, gzip ${formatKb(totalGzip)} KB`,
  );
}

main();
