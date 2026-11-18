/**
 * Çevrimdışı çalışma bekçisi.
 *
 * Ürün gereği uygulama ağ olmadan aynı şekilde çalışır: telemetri, otomatik
 * güncelleme denetimi, uzak içerik ya da uzak görsel yüklemesi yoktur. Bu test
 * kuralı yapılandırma ve kaynak düzeyinde sabitler; bir sonraki değişiklik
 * sessizce bir ağ bağımlılığı eklediğinde burada kırmızıya döner.
 *
 * Denetlenenler:
 * - `tauri.conf.json`: güncelleyici yapılandırması yok; CSP `connect-src`
 *   yalnızca kendi origin'i ve Tauri IPC'ye, `img-src` yalnızca yerel
 *   varlıklara izin verir.
 * - `src-tauri/Cargo.toml` / `package.json`: güncelleyici, HTTP veya telemetri
 *   eklentisi/paketi bağımlılık olarak eklenmemiştir.
 * - `src/` altındaki çalışma zamanı dosyaları tarayıcı ağ API'lerini kullanmaz.
 * - `@tauri-apps/plugin-opener` yalnızca kullanıcı tıklamasıyla çalışan
 *   `preview/links.ts` içinden yüklenir (harici bağlantı tek çıkış yolu).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = join(projectRoot, 'src');

/** Tarayıcıda ağ isteği başlatan çalışma zamanı API'leri. */
const NETWORK_APIS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\bnew\s+Image\s*\(/;

/** `connect-src` için izinli kaynaklar: kendi origin'i ve Tauri IPC. */
const ALLOWED_CONNECT_SRC = new Set(["'self'", 'ipc:', 'http://ipc.localhost']);

/** `img-src` için izinli şema/kaynak önekleri. */
const ALLOWED_IMG_SRC_PREFIXES = [
  "'self'",
  'data:',
  'blob:',
  'asset:',
  'mdasset:',
  'http://asset.localhost',
  'http://mdasset.localhost',
];

function readText(...segments: string[]): string {
  return readFileSync(join(projectRoot, ...segments), 'utf8');
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readText(...segments)) as T;
}

/** Çalışma zamanı kaynak dosyaları (test dosyaları hariç). */
function runtimeSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...runtimeSources(full));
    } else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Yorumları kabaca ayıklayıp gerçek çağrıları arar. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** CSP metnini direktif → kaynak listesi haritasına çevirir. */
function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name !== undefined) directives.set(name, sources);
  }
  return directives;
}

describe('çevrimdışı çalışma', () => {
  interface TauriConfig {
    plugins?: Record<string, unknown>;
    app?: { withGlobalTauri?: boolean; security?: { csp?: string } };
    bundle?: { createUpdaterArtifacts?: boolean };
  }

  const config = readJson<TauriConfig>('src-tauri', 'tauri.conf.json');

  it('güncelleyici yapılandırması içermez', () => {
    expect(config.plugins?.updater).toBeUndefined();
    expect(config.bundle?.createUpdaterArtifacts).not.toBe(true);
  });

  it('CSP yalnızca yerel kaynaklara bağlanmaya ve görsel yüklemeye izin verir', () => {
    const csp = config.app?.security?.csp;
    expect(csp).toBeTypeOf('string');
    const directives = parseCsp(csp ?? '');

    const connectSrc = directives.get('connect-src') ?? [];
    expect(connectSrc.length).toBeGreaterThan(0);
    for (const source of connectSrc) {
      expect(ALLOWED_CONNECT_SRC.has(source), `connect-src içinde uzak kaynak: ${source}`).toBe(
        true,
      );
    }

    const imgSrc = directives.get('img-src') ?? [];
    expect(imgSrc.length).toBeGreaterThan(0);
    for (const source of imgSrc) {
      expect(
        ALLOWED_IMG_SRC_PREFIXES.some(
          (allowed) => source === allowed || source.startsWith(`${allowed}/`),
        ),
        `img-src içinde uzak kaynak: ${source}`,
      ).toBe(true);
    }
  });

  it('güncelleyici, HTTP veya telemetri bağımlılığı taşımaz', () => {
    const cargo = readText('src-tauri', 'Cargo.toml');
    const packageJson = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>('package.json');

    const cargoForbidden = [
      'tauri-plugin-updater',
      'tauri-plugin-http',
      'reqwest',
      'hyper',
      'ureq',
      'sentry',
      'opentelemetry',
    ];
    for (const dependency of cargoForbidden) {
      expect(cargo, `Cargo.toml bağımlılığı yasak: ${dependency}`).not.toMatch(
        new RegExp(`^\\s*${dependency}\\s*=`, 'm'),
      );
    }

    const npmForbidden = [
      '@tauri-apps/plugin-updater',
      '@tauri-apps/plugin-http',
      '@sentry/',
      'posthog',
      'mixpanel',
      'amplitude',
    ];
    const declared = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    for (const name of declared) {
      expect(
        npmForbidden.some((forbidden) => name === forbidden || name.startsWith(forbidden)),
        `package.json bağımlılığı yasak: ${name}`,
      ).toBe(false);
    }
  });

  it('çalışma zamanı kaynakları ağ API çağırmaz', () => {
    const offenders: string[] = [];
    for (const file of runtimeSources(sourceRoot)) {
      if (NETWORK_APIS.test(withoutComments(readFileSync(file, 'utf8')))) {
        offenders.push(relative(projectRoot, file).split('\\').join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('harici bağlantı yalnızca kullanıcı tıklamasıyla, opener üzerinden açılır', () => {
    const openerUsers: string[] = [];
    for (const file of runtimeSources(sourceRoot)) {
      if (withoutComments(readFileSync(file, 'utf8')).includes('@tauri-apps/plugin-opener')) {
        openerUsers.push(relative(projectRoot, file).split('\\').join('/'));
      }
    }
    expect(openerUsers).toEqual(['src/lib/preview/links.ts']);
  });
});
