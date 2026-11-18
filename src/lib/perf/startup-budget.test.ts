/**
 * Açılış bütçesi bekçisi.
 *
 * Sıcak başlatma ≤ 900 ms hedefi, kabuk modül grafiğinin hafif kalmasına
 * bağlıdır: CodeMirror, markdown ve kod vurgulama paketleri açılışta
 * yüklenmemelidir. Bu test, `src/main.ts` ve `src/App.svelte` üzerinden
 * statik `import` grafiğini yürüyerek ağır paketlerin ve tembel yüklenmesi
 * gereken modüllerin giriş grafiğine geri sızmadığını doğrular.
 *
 * Kural: bu paketler yalnızca dinamik `import()` (veya kendisi tembel yüklenen
 * bir bileşenin içinden) çalışma zamanına girebilir.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = join(projectRoot, 'src');

/** Açılışta çalışma zamanına girmemesi gereken paketler. */
const HEAVY_PACKAGES = [
  'markdown-it',
  'dompurify',
  'codemirror',
  '@codemirror/merge',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-markdown',
  '@codemirror/language',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
];

/** Açılış grafiğinde bulunmaması gereken (tembel yüklenen) yerel modüller. */
const LAZY_MODULES = [
  'src/lib/editor/EditorPane.svelte',
  'src/lib/quickopen/QuickOpenPanel.svelte',
  'src/lib/preview/PreviewPane.svelte',
  'src/lib/preview/markdown.ts',
  'src/lib/preview/highlight.ts',
];

const STATIC_FROM_RE = /^[ \t]*import\s+(?!type\b)(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;
const REEXPORT_RE = /^[ \t]*export\s+(?!type\b)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;

function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const pattern of [STATIC_FROM_RE, REEXPORT_RE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.svelte`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface StartupGraph {
  /** Proje köküne göreli yerel modül yolları. */
  files: Set<string>;
  /** Yerel olmayan (paket) importlar. */
  packages: Set<string>;
  /** Statik olarak çözülemeyen yerel importlar. */
  unresolved: string[];
}

/** Statik import grafiğini giriş dosyalarından başlayarak gezer. */
function walkStartupGraph(entries: readonly string[]): StartupGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = entries.map((entry) => join(projectRoot, entry));

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) break;
    if (files.has(file)) continue;
    files.add(file);

    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        const next = resolveRelative(file, specifier);
        if (next === null) unresolved.push(`${relative(projectRoot, file)} -> ${specifier}`);
        else queue.push(next);
      } else {
        packages.add(specifier);
      }
    }
  }

  return {
    files: new Set([...files].map((file) => relative(projectRoot, file).split('\\').join('/'))),
    packages,
    unresolved,
  };
}

function isHeavyPackage(specifier: string): boolean {
  return (
    HEAVY_PACKAGES.includes(specifier) ||
    specifier.startsWith('highlight.js') ||
    specifier.startsWith('@codemirror/')
  );
}

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      result.push(...sourceFiles(full));
    } else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) {
      result.push(full);
    }
  }
  return result;
}

describe('açılış bütçesi', () => {
  const graph = walkStartupGraph(['src/main.ts', 'src/App.svelte']);

  it('statik import grafiği çözülebilir kalır', () => {
    expect(graph.unresolved).toEqual([]);
    expect(graph.files.has('src/App.svelte')).toBe(true);
  });

  it('açılışta ağır paketleri statik olarak yüklemez', () => {
    const heavy = [...graph.packages].filter(isHeavyPackage).sort();
    expect(heavy).toEqual([]);
  });

  it('editör ve önizleme modülleri açılış grafiğinde yer almaz', () => {
    const leaked = LAZY_MODULES.filter((module) => graph.files.has(module));
    expect(leaked).toEqual([]);
  });

  it('açılış grafiğinde tekrar eden zamanlayıcı yoktur', () => {
    const offenders: string[] = [];
    for (const file of graph.files) {
      const text = readFileSync(join(projectRoot, file), 'utf8');
      // Yorum satırlarını kabaca ayıklayıp gerçek `setInterval` çağrısını arar.
      const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/\bsetInterval\s*\(/.test(withoutComments)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('açılış grafiğinde ağ isteği başlatan API yoktur', () => {
    // Açılışta yalnızca yerel `tauri.localhost` varlıkları ve Tauri IPC
    // kullanılabilir; tarayıcı ağ API'leri kabuk modüllerine sızmamalıdır.
    const networkApis = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/;
    const offenders: string[] = [];
    for (const file of graph.files) {
      const text = readFileSync(join(projectRoot, file), 'utf8');
      const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (networkApis.test(withoutComments)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('highlight.js yalnızca tip olarak veya dinamik import ile kullanılır', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      for (const specifier of runtimeSpecifiers(file)) {
        if (specifier === 'highlight.js' || specifier.startsWith('highlight.js/')) {
          offenders.push(`${relative(projectRoot, file).split('\\').join('/')} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('@codemirror/merge statik olarak import edilmez', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      if (runtimeSpecifiers(file).includes('@codemirror/merge')) {
        offenders.push(relative(projectRoot, file).split('\\').join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
