// @vitest-environment jsdom
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderPreview, sanitizeHtml } from './markdown';

const maliciousMarkdown = readFileSync(
  'src/lib/preview/fixtures/malicious.md',
  'utf8',
);

/** Etkin bir URL taşıyabilecek öznitelikler; şema taraması bunlarla sınırlıdır. */
const URL_ATTRS = ['href', 'src', 'srcset', 'formaction', 'action', 'xlink:href'];

/** Bir HTML parçasındaki tüm etkin URL öznitelik değerlerini toplar. */
function urlAttributeValues(html: string): string[] {
  const container = document.createElement('div');
  container.innerHTML = html;
  const values: string[] = [];
  for (const element of container.querySelectorAll('*')) {
    for (const attr of element.attributes) {
      if (URL_ATTRS.includes(attr.name.toLowerCase())) {
        values.push(attr.value.trim().toLowerCase());
      }
    }
  }
  return values;
}

describe('sanitizeHtml', () => {
  it('script, iframe ve olay işleyicilerini etkisizleştirir', () => {
    const html = sanitizeHtml(
      [
        '<p onclick="alert(1)">metin</p>',
        '<script>alert(2)</script>',
        '<iframe src="https://example.com"></iframe>',
        '<object data="https://example.com/obj"></object>',
        '<embed src="https://example.com/emb" type="text/html">',
        '<form action="https://example.com/post"><input name="alan"><button>Git</button></form>',
        '<img src="https://example.com/x.png" onerror="alert(3)">',
        '<a href="javascript:alert(4)">tık</a>',
        '<style>body{display:none}</style>',
      ].join(''),
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<object');
    expect(html).not.toContain('<embed');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('metin');
    expect(html).toContain('tık');
  });

  it('meta refresh, svg onload ve form eylemlerini etkisizleştirir', () => {
    const html = sanitizeHtml(
      [
        '<meta http-equiv="refresh" content="0;url=https://evil.test/refresh">',
        '<svg onload="alert(1)"><a xlink:href="javascript:alert(2)">svg</a></svg>',
        '<form action="https://evil.test/post"><button formaction="https://evil.test/x">gönder</button></form>',
        '<img src="x" srcset="https://evil.test/a.png 1x" alt="srcset">',
      ].join(''),
    );

    expect(html).not.toContain('<meta');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('srcset=');
    expect(html).not.toContain('formaction=');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('xlink:href');
    expect(urlAttributeValues(html)).not.toContain('https://evil.test/refresh');
  });

  it('data:, vbscript: ve varlık-kodlu javascript: şemalarını düşürür', () => {
    const html = sanitizeHtml(
      [
        '<a href="data:text/html,<script>alert(1)</script>">veri</a>',
        '<a href="data:text/javascript,alert(2)">veri betiği</a>',
        '<img src="data:image/svg+xml,<svg onload=alert(3)>" alt="veri görsel">',
        '<a href="vbscript:msgbox(4)">vbscript</a>',
        '<a href="&#106;avascript:alert(5)">varlık</a>',
        '<a href="javas&#99;ript:alert(6)">varlık iki</a>',
      ].join(''),
    );

    expect(html).toContain('veri');
    for (const value of urlAttributeValues(html)) {
      expect(value.startsWith('javascript:')).toBe(false);
      expect(value.startsWith('data:')).toBe(false);
      expect(value.startsWith('vbscript:')).toBe(false);
    }
    expect(html).not.toContain('<svg');
  });

  it('uzak görseli yüklemeden yer tutucuya dönüştürür', () => {
    const html = sanitizeHtml('<img src="https://example.com/takip.png" alt="uzak">');

    expect(html).not.toContain('example.com');
    expect(html).toContain('md-image-blocked');
    expect(html).toContain('uzak');
  });

  it('yerel mdasset görselini korur', () => {
    const html = sanitizeHtml(
      '<img src="mdasset://localhost/notes/a.png" alt="yerel" loading="lazy">',
    );

    expect(html).toContain('src="mdasset://localhost/notes/a.png"');
    expect(html).toContain('alt="yerel"');
  });

  it('yalnızca satır eşlemesi veri özniteliğine izin verir', () => {
    const html = sanitizeHtml('<p data-source-line="2" data-evil="x">metin</p>');

    expect(html).toContain('data-source-line="2"');
    expect(html).not.toContain('data-evil');
  });
});

describe('zararlı markdown dosyası', () => {
  it('iki katmanlı savunmayla tehlikeli düğüm ve öznitelik bırakmaz', () => {
    const html = renderPreview(maliciousMarkdown, 'guvenlik/malicious.md');
    const container = document.createElement('div');
    container.innerHTML = html;

    for (const tag of [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'svg',
      'style',
      'math',
      'meta',
      'base',
      'link',
    ]) {
      expect(container.querySelector(tag)).toBeNull();
    }
    // Çıktıda hiçbir on* olay işleyici özniteliği kalmamalı.
    for (const element of container.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
      }
    }
    // Hiçbir etkin URL özniteliğinde tehlikeli şema kalmaz.
    for (const value of urlAttributeValues(html)) {
      expect(value.startsWith('javascript:')).toBe(false);
      expect(value.startsWith('data:')).toBe(false);
      expect(value.startsWith('vbscript:')).toBe(false);
    }
    for (const element of container.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        expect(attr.name.toLowerCase()).not.toBe('srcset');
        expect(attr.name.toLowerCase()).not.toBe('formaction');
      }
    }
    // Güvenli metin korunur.
    expect(container.textContent).toContain('Güvenli metin burada kalır.');
  });
});

describe('renderPreview', () => {
  it('render ve sanitize adımlarını birleştirir', () => {
    const html = renderPreview(
      '<script>alert(1)</script>\n\n| a |\n| - |\n| 1 |',
      'notlar/not.md',
    );

    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<table');
    // Kaynak satırı eşlemesi sanitize'dan sağ çıkar (tablo 3. satırda başlar).
    expect(html).toContain('data-source-line="3"');
  });
});
