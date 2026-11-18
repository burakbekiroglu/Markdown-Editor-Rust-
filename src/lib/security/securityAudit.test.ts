// @vitest-environment jsdom
/**
 * Güvenlik doğrulaması: sanitizer + CSP + yetki (capability) denetimi.
 *
 * Bu dosya üç iddiayı birlikte kanıtlar:
 *
 * 1. Zararlı markdown payload'ları sanitizer'dan etkin bir vektör bırakmadan
 *    çıkar (script, `on*`, `javascript:`/`data:`/`vbscript:` adresleri,
 *    style/iframe/object).
 * 2. Sanitizer'ın tek başına bırakabileceği sınıflar (satır içi betik, uzak
 *    çerçeve/nesne, form gönderimi, `<base>` ele geçirmesi, uzak görsel)
 *    üretim CSP'si tarafından ikinci katmanda kapatılır. CSP burada
 *    `tauri.conf.json` içinden okunur; iddia yapılandırmanın kendisine
 *    bağlanır, koda değil.
 * 3. Yetki listesi minimumdur: yalnızca opener (http/https), pencere
 *    yok etme ve oturum deposunun dört işlemi; fs/shell/process gibi geniş
 *    yetki yoktur.
 *
 * Yapılandırma dosyaları kaynak kabul edilir (`src-tauri/...`); testler
 * proje kökünden çalıştığı için yollar göreli verilir.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderPreview, sanitizeHtml } from '../preview/markdown';

// --- yapılandırma okuma yardımcıları -------------------------------------

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: nesne bekleniyordu`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label}: string dizisi bekleniyordu`);
  }
  return value as string[];
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${label}.${key}: string bekleniyordu`);
  return value;
}

/** CSP metnini `yönerge -> değerler` haritasına çevirir. */
function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name.length > 0) map.set(name.toLowerCase(), values);
  }
  return map;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const tauriConfig = asRecord(readJson('src-tauri/tauri.conf.json'), 'tauri.conf.json');
const appConfig = asRecord(tauriConfig['app'], 'app');
const securityConfig = asRecord(appConfig['security'], 'app.security');
const assetProtocol = asRecord(securityConfig['assetProtocol'], 'app.security.assetProtocol');

const productionCsp = directives(stringField(securityConfig, 'csp', 'app.security'));
const developmentCsp = directives(stringField(securityConfig, 'devCsp', 'app.security'));

const capability = asRecord(
  readJson('src-tauri/capabilities/default.json'),
  'capabilities/default.json',
);
const permissions = Array.isArray(capability['permissions'])
  ? capability['permissions']
  : [];

function permissionIdentifier(entry: unknown): { id: string; entry: Record<string, unknown> } {
  const record = asRecord(entry, 'permission');
  return { id: stringField(record, 'identifier', 'permission'), entry: record };
}

const permissionEntries = permissions.map(permissionIdentifier);
const permissionIds = permissionEntries.map((item) => item.id).sort();

/** Kaynaktan yorumları çıkarır: iddialar yorum satırına değil gerçek koda bağlanır. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

const appSource = withoutComments(readFileSync('src-tauri/src/lib.rs', 'utf8'));
const workspaceSource = withoutComments(
  readFileSync('src-tauri/src/workspace_commands.rs', 'utf8'),
);
const securitySource = withoutComments(readFileSync('src-tauri/src/security.rs', 'utf8'));

// --- zararlı payload seti -------------------------------------------------

/** Etkin URL taşıyabilecek öznitelikler. */
const URL_ATTRS = ['href', 'src', 'srcset', 'formaction', 'action', 'xlink:href'];
const DANGEROUS_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];

function parseHtml(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

function activeVectors(html: string): string[] {
  const container = parseHtml(html);
  const vectors: string[] = [];
  for (const element of container.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (['script', 'iframe', 'object', 'embed', 'style', 'form', 'svg', 'math'].includes(tag)) {
      vectors.push(`düğüm:${tag}`);
    }
    for (const attr of element.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) vectors.push(`olay:${tag}.${name}`);
      if (!URL_ATTRS.includes(name)) continue;
      const value = attr.value.trim().toLowerCase().replace(/[\u0000-\u0020]/g, '');
      for (const scheme of DANGEROUS_SCHEMES) {
        if (value.startsWith(scheme)) vectors.push(`şema:${tag}.${name}=${scheme}`);
      }
    }
  }
  return vectors;
}

/**
 * Her satır bir saldırı sınıfıdır: payload sanitize edilir ve hiçbir etkin
 * vektör kalmadığı doğrulanır. Etiketlerin çoğu markdown-it'te `html: false`
 * yüzünden zaten metne kaçırılır; sanitizer ikinci katman olarak ham HTML
 * girdisinde de aynı sonucu garanti etmelidir.
 */
const ATTACKS: ReadonlyArray<readonly [string, string]> = [
  ['script', '<script>alert(1)</script>'],
  ['script (nitelikli)', '<script src="https://evil.test/x.js"></script>'],
  ['img onerror', '<img src="x" onerror="alert(1)">'],
  ['img onload srcset', '<img src="x" onload="alert(1)" srcset="https://evil.test/a 1x">'],
  ['javascript: bağlantı', '<a href="javascript:alert(1)">tık</a>'],
  ['javascript: (sekme ile)', '<a href="jav\tascript:alert(1)">tık</a>'],
  ['javascript: (varlıkla)', '<a href="&#106;avascript:alert(1)">tık</a>'],
  ['data: bağlantı', '<a href="data:text/html,<script>alert(1)</script>">tık</a>'],
  ['data: betik', '<a href="data:text/javascript,alert(2)">tık</a>'],
  ['vbscript: bağlantı', '<a href="vbscript:msgbox(1)">tık</a>'],
  ['file: bağlantı', '<a href="file:///C:/Windows/win.ini">tık</a>'],
  ['protokol-göreli', '<a href="//evil.test/x">tık</a>'],
  ['style etiketi', '<style>body{display:none}</style>'],
  ['style özniteliği', '<p style="position:fixed;inset:0">kaplama</p>'],
  ['iframe', '<iframe src="https://evil.test"></iframe>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['object', '<object data="https://evil.test/x"></object>'],
  ['embed', '<embed src="https://evil.test/x" type="text/html">'],
  ['form', '<form action="https://evil.test/post"><button>Git</button></form>'],
  ['svg onload + xlink', '<svg onload="alert(1)"><a xlink:href="javascript:alert(1)">s</a></svg>'],
  ['math mXSS', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>'],
  ['form/math mXSS', '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>'],
  ['noscript mXSS', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['template', '<template><script>alert(1)</script></template>'],
  ['base', '<base href="https://evil.test/">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ['details ontoggle', '<details open ontoggle="alert(1)">x</details>'],
  ['input autofocus onfocus', '<input autofocus onfocus="alert(1)">'],
  ['video source onerror', '<video><source onerror="alert(1)"></video>'],
  ['blob görsel', '<img src="blob:https://evil.test/x" alt="b">'],
  ['uzak görsel', '<img src="https://evil.test/takip.png" alt="uzak">'],
  ['asset görsel', '<img src="asset://localhost/C:/gizli.png" alt="a">'],
];

describe('zararlı payload seti + sanitizer', () => {
  it('her saldırı sınıfından sonra etkin vektör bırakmaz', () => {
    for (const [label, payload] of ATTACKS) {
      const html = sanitizeHtml(payload);
      expect(activeVectors(html), `${label}: ${html}`).toEqual([]);
    }
  });

  it('markdown üzerinden gelen payload setini de aynı şekilde kapatır', () => {
    for (const [label, payload] of ATTACKS) {
      const html = renderPreview(payload, 'guvenlik/not.md');
      expect(activeVectors(html), `${label}: ${html}`).toEqual([]);
    }
  });

  it('güvenli içeriği korur (aşırı sanitize yok)', () => {
    const html = renderPreview(
      ['# Başlık', '', 'Güvenli **metin** ve [bağlantı](https://example.com).'].join('\n'),
      'guvenlik/not.md',
    );
    const container = parseHtml(html);

    expect(container.querySelector('h1')?.textContent).toBe('Başlık');
    expect(container.querySelector('strong')?.textContent).toBe('metin');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });
});

describe('üretim CSP politikası', () => {
  it('satır içi betiği ve eval’i yasaklar', () => {
    expect(productionCsp.get('script-src')).toEqual(["'self'"]);
    expect(productionCsp.get('script-src-elem')).toBeUndefined();
    expect(productionCsp.get('default-src')).toEqual(["'self'"]);
  });

  it('çerçeve, nesne, worker ve form gönderimini kapatır', () => {
    expect(productionCsp.get('object-src')).toEqual(["'none'"]);
    expect(productionCsp.get('frame-src')).toEqual(["'none'"]);
    expect(productionCsp.get('child-src')).toEqual(["'none'"]);
    expect(productionCsp.get('worker-src')).toEqual(["'none'"]);
    expect(productionCsp.get('form-action')).toEqual(["'none'"]);
    expect(productionCsp.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('base ele geçirmesini ve betik dışı yabancı kaynakları sınırlar', () => {
    expect(productionCsp.get('base-uri')).toEqual(["'self'"]);

    const imageSources = productionCsp.get('img-src') ?? [];
    expect(imageSources).toContain("'self'");
    expect(imageSources).toContain('mdasset:');
    expect(imageSources).toContain('http://mdasset.localhost');
    // Uzak bir görsel sunucusuna izin veren joker olmamalı.
    for (const source of imageSources) {
      expect(source.includes('*')).toBe(false);
      // Yerel protokol kökenleri (asset/mdasset) disinda uzak http(s) kaynagi yok.
      expect(/^https?:\/\/(?!(?:asset|mdasset)\.localhost)/i.test(source)).toBe(false);
    }
  });

  it('geliştirme CSP’si yalnızca eval ve dev sunucusu için gevşer', () => {
    const devScript = developmentCsp.get('script-src') ?? [];
    expect(devScript).toContain("'self'");
    expect(devScript).toContain("'unsafe-eval'");
    // Satır içi betik üretimde de geliştirmede de kapalı kalmalı.
    expect(devScript).not.toContain("'unsafe-inline'");
    expect(productionCsp.get('script-src')).not.toContain("'unsafe-eval'");

    // Gevşeme yalnızca script-src ve connect-src ile sınırlıdır.
    for (const [name, values] of developmentCsp) {
      if (name === 'script-src' || name === 'connect-src') continue;
      expect(values, name).toEqual(productionCsp.get(name));
    }
    expect(developmentCsp.get('connect-src')).toContain('ws://localhost:1420');
  });

  it('asset protokolü kapsamı boş ve global Tauri kapalıdır', () => {
    expect(assetProtocol['enable']).toBe(true);
    expect(assetProtocol['scope']).toEqual([]);
    expect(appConfig['withGlobalTauri']).toBe(false);
  });
});

describe('CSP ile sanitizer birlikte', () => {
  const scriptless = !(productionCsp.get('script-src') ?? []).includes("'unsafe-inline'");

  it('sanitizer’ın bırakabileceği satır içi betik sınıfı CSP ile kapanır', () => {
    // `javascript:` adresleri ve `on*` öznitelikleri satır içi betik sayılır;
    // script-src 'unsafe-inline' içermediği için yürütülemez.
    expect(scriptless).toBe(true);
    expect(activeVectors(sanitizeHtml('<a href="javascript:alert(1)">t</a>'))).toEqual([]);
  });

  it('uzak çerçeve, nesne ve form gönderimi iki katmanda da kapalıdır', () => {
    expect(productionCsp.get('frame-src')).toEqual(["'none'"]);
    expect(productionCsp.get('object-src')).toEqual(["'none'"]);
    expect(productionCsp.get('form-action')).toEqual(["'none'"]);
    expect(activeVectors(sanitizeHtml('<iframe src="https://evil.test"></iframe>'))).toEqual([]);
  });

  it('uzak görsel iki katmanda da istenmez', () => {
    // Sanitizer görseli yer tutucuya çevirir; CSP ayrıca uzak kaynağa izin vermez.
    expect(sanitizeHtml('<img src="https://evil.test/x.png" alt="x">')).not.toContain('evil.test');
    expect(productionCsp.get('img-src') ?? []).not.toContain('https:');
  });
});

describe('yetki (capability) listesi', () => {
  it('yalnızca tek pencereyi hedefler', () => {
    expect(stringArray(capability['windows'], 'windows')).toEqual(['main']);
  });

  it('beklenen minimal izin kümesini aşmaz', () => {
    expect(permissionIds).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'opener:allow-open-url',
      'store:allow-get',
      'store:allow-load',
      'store:allow-save',
      'store:allow-set',
    ]);
  });

  it('dosya sistemi, kabuk, süreç ve ağ eklentilerine izin vermez', () => {
    const forbiddenPrefixes = [
      'fs:',
      'shell:',
      'process:',
      'dialog:',
      'http:',
      'websocket:',
      'clipboard-',
      'notification:',
      'global-shortcut:',
      'upload:',
      'download:',
    ];
    for (const id of permissionIds) {
      for (const prefix of forbiddenPrefixes) {
        expect(id.startsWith(prefix), `${id} geniş yetki taşıyor`).toBe(false);
      }
    }
  });

  it('opener yalnızca http ve https adreslerini açar', () => {
    const opener = permissionEntries.find((item) => item.id === 'opener:allow-open-url');
    expect(opener).toBeDefined();
    const allow = opener?.entry['allow'];
    expect(Array.isArray(allow)).toBe(true);
    const urls = (allow as unknown[]).map((item) =>
      stringField(asRecord(item, 'opener.allow'), 'url', 'opener.allow'),
    );
    expect(urls.sort()).toEqual(['http://*', 'https://*']);
  });

  it('store izinleri yalnızca oturum dosyasının dört işlemiyle sınırlıdır', () => {
    const storeIds = permissionIds.filter((id) => id.startsWith('store:'));
    expect(storeIds).toEqual([
      'store:allow-get',
      'store:allow-load',
      'store:allow-save',
      'store:allow-set',
    ]);
  });

  it('webview pencere yok etme/ kapama yetkisi taşımaz', () => {
    // Kapatma Rust tarafındaki `app_close_window` komutuyla yapılır; uygulama
    // komutları ACL'ye tabi olmadığı için webview'e `core:window:allow-destroy`
    // veya `core:window:allow-close` verilmesi gerekmez. Verilen tek çekirdek
    // izin olay aboneliğidir: Rust her CloseRequested'ı `prevent_close` ile
    // durdurup kapatma kararını `app:close-requested` olayıyla webview'e
    // bıraktığı için dinleyici izni olmadan pencere hiç kapanmaz.
    const coreIds = permissionIds.filter((id) => id.startsWith('core:'));
    expect(coreIds).toEqual(['core:event:allow-listen', 'core:event:allow-unlisten']);
    expect(permissionIds.some((id) => id.includes('window'))).toBe(false);
  });
});

describe('pencere sertleştirmesi (webview kurulumu)', () => {
  it('pencereyi yapılandırmada değil, kancalarla birlikte Rust tarafında oluşturur', () => {
    // `tauri.conf.json` içinde tanımlı bir pencereye `on_navigation` /
    // `on_new_window` takılamaz; kural sessizce devre dışı kalırdı.
    expect(appConfig['windows']).toEqual([]);
    expect(appSource).toContain('fn create_main_window');
    // Tek bir webview kurulur: ikinci, kancasız bir pencere açılmamalı.
    expect(appSource.match(/WebviewWindowBuilder::new/g)).toHaveLength(1);
  });

  it('ana pencereye navigasyon allow-list ve yeni pencere reddi takar', () => {
    const createWindow = appSource.slice(appSource.indexOf('fn create_main_window'));
    expect(createWindow).toContain('.on_navigation(security::is_allowed_navigation)');
    expect(createWindow).toContain('NewWindowResponse::Deny');
    // Kancalar ancak pencere kurucusu gerçekten çağrılırsa etkindir; ölü bir
    // `create_main_window` sessizce korumasız pencere bırakırdı.
    expect(appSource).toContain('create_main_window(app)?');
  });

  it('klasör açma webview dialog yetkisi olmadan Rust tarafında yapılır', () => {
    // Dialog izni webview'e verilmez: seçim Rust'taki native eklentiyle
    // yapılır, böylece webview kendi başına klasör seçemez.
    expect(permissionIds.some((id) => id.startsWith('dialog:'))).toBe(false);
    expect(appSource).toContain('tauri_plugin_dialog::init()');
    expect(workspaceSource).toContain('app.dialog()');
    expect(workspaceSource).toContain('.pick_folder(');
  });
});

/**
 * AC2 metni ("izin kümesi tam olarak dialog+store+opener") ile uygulanan
 * sertleştirilmiş yapılandırma arasındaki farkı bilinçli bir karar olarak
 * sabitler. Fark keyfî değildir: klasör seçimi Rust tarafında yapıldığı için
 * webview'e `dialog:` izni verilmez; buna karşılık Rust her kapatma isteğini
 * `prevent_close` ile durdurup kararı webview'e bıraktığı için `core:event`
 * aboneliği zorunludur. Aşağıdaki birebir assertion'lar bu kümeyi kilitler:
 * bir izin düşerse ya da fazladan bir izin (ör. `dialog:`, `fs:`) eklenirse
 * test kırmızıya döner, böylece sapma sessizce yapılandırmaya sızmaz.
 */
describe('AC2: izin kümesi birebir', () => {
  it('izin aileleri tam olarak core + opener + store kümesidir', () => {
    const families = [...new Set(permissionIds.map((id) => id.split(':')[0]))].sort();
    expect(families).toEqual(['core', 'opener', 'store']);
  });

  it('dialog izni yoktur (klasör seçimi Rust tarafında yapılır)', () => {
    expect(permissionIds.filter((id) => id.startsWith('dialog:'))).toEqual([]);
  });

  it('opener dışındaki hiçbir aile URL şeması yetkisi taşımaz', () => {
    for (const { id, entry } of permissionEntries) {
      if (id === 'opener:allow-open-url') continue;
      expect(entry['allow'], `${id} kapsam (allow) taşıyor`).toBeUndefined();
    }
  });
});

describe('regresyon: CSP uzak betik kaynağı taşımaz', () => {
  it('betik yürüten yönergeler yalnızca anahtar kelime kaynağı içerir', () => {
    // 'self' / 'none' gibi anahtar kelimeler tırnak içindedir; uzak bir kaynak
    // (https://evil.test, data:, *) tırnaksız gelir ve burada yakalanır.
    for (const name of [
      'default-src',
      'script-src',
      'script-src-elem',
      'script-src-attr',
      'worker-src',
    ]) {
      for (const source of productionCsp.get(name) ?? []) {
        expect(source.startsWith("'"), `${name}: ${source}`).toBe(true);
      }
    }
    expect(productionCsp.has('script-src')).toBe(true);
    expect(productionCsp.has('default-src')).toBe(true);
  });

  it('hiçbir yönergede joker kaynak yoktur', () => {
    for (const [name, values] of productionCsp) {
      expect(values, name).not.toContain('*');
      for (const value of values) {
        expect(value.includes('*'), `${name}: ${value}`).toBe(false);
      }
    }
  });
});

describe('regresyon: navigasyon ve yeni pencere engeli kayıtlı', () => {
  it('allow-list politikası security.rs içinde saf bir fonksiyon olarak durur', () => {
    expect(securitySource).toContain('pub fn is_allowed_navigation');
    // Politika yalnızca uygulamanın kendi kökenine izin verir; uzak sayfalar
    // ve web dışı şemalar reddedilir (bkz. security.rs testleri).
    expect(securitySource).toContain('tauri.localhost');
  });

  it('yeni pencere isteği hiçbir yerde onaylanmaz', () => {
    expect(appSource).not.toContain('NewWindowResponse::Allow');
    expect(appSource).toContain('NewWindowResponse::Deny');
  });
});
