// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  PREVIEW_DEBOUNCE_MS,
  mdAssetUrl,
  renderMarkdown,
  renderPreview,
  resolveRelativeAssetPath,
  sanitizeHtml,
} from './markdown';

function parse(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('preview debounce', () => {
  it('reflects the active tab content after 120 ms', () => {
    expect(PREVIEW_DEBOUNCE_MS).toBe(120);
  });
});

describe('GFM rendering', () => {
  it('renders tables', () => {
    const html = renderPreview('| a | b |\n| - | - |\n| 1 | 2 |');
    const container = parse(html);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders task list checkboxes', () => {
    const html = renderPreview('- [x] yapıldı\n- [ ] yapılacak');
    const container = parse(html);
    const boxes = container.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
    expect(boxes[0]?.disabled).toBe(true);
  });

  it('renders strikethrough', () => {
    const html = renderPreview('eski ~~silindi~~ metin');
    expect(parse(html).querySelector('del')?.textContent).toBe('silindi');
  });

  it('links bare URLs automatically', () => {
    const html = renderPreview('bakınız https://example.com/yol');
    const link = parse(html).querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/yol');
  });

  it('renders fenced code blocks with their language', () => {
    const html = renderPreview('```ts\nconst x: number = 1;\n```');
    const code = parse(html).querySelector('pre.md-code > code.language-ts');
    expect(code?.textContent).toBe('const x: number = 1;\n');
  });

  it('leaves unsupported code languages unlabelled', () => {
    const html = renderPreview('```bilinmeyen\nmetin\n```');
    const code = parse(html).querySelector('pre.md-code > code');
    expect(code?.className).toBe('');
  });
});

describe('sanitisation', () => {
  it('escapes raw HTML instead of interpreting it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<iframe src="x"></iframe>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;iframe');
  });

  it('neutralises event handlers and dangerous tags in the rendered output', () => {
    const html = renderPreview(
      '<img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<a href="javascript:alert(3)">x</a>',
    );
    const container = parse(html);
    // Ham HTML kaçırıldığı için hiçbir etkin düğüm oluşmaz.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;');
    expect(container.textContent).toContain('javascript:alert(3)');
  });

  it('keeps the sanitizer as a second layer for hostile input', () => {
    const cleaned = sanitizeHtml(
      '<p onclick="alert(1)">a</p><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">b</a><a href="data:text/html,<script>alert(1)</script>">c</a>',
    );
    expect(cleaned).not.toContain('iframe');
    expect(cleaned).not.toContain('onclick');
    expect(cleaned).not.toContain('javascript:');
    expect(cleaned).not.toContain('data:text/html');
  });
});

describe('images', () => {
  it('routes relative images through the mdasset protocol', () => {
    const html = renderPreview('![logo](gorseller/logo.png)', 'notlar/README.md');
    const image = parse(html).querySelector('img');
    expect(image?.getAttribute('src')).toBe(mdAssetUrl('notlar/gorseller/logo.png'));
    expect(image?.getAttribute('alt')).toBe('logo');
  });

  it('does not load remote images', () => {
    const html = renderPreview('![uzak](https://example.com/a.png)', 'README.md');
    expect(parse(html).querySelector('img')).toBeNull();
    expect(html).not.toContain('https://example.com/a.png');
    expect(parse(html).querySelector('.md-image-blocked')?.textContent).toBe('uzak');
  });

  it('does not load absolute or escaping paths', () => {
    expect(resolveRelativeAssetPath('/etc/passwd', 'README.md')).toBeNull();
    expect(resolveRelativeAssetPath('C:/gizli.png', 'README.md')).toBeNull();
    expect(resolveRelativeAssetPath('../../../gizli.png', 'a/b/c.md')).toBeNull();
    expect(resolveRelativeAssetPath('data:image/png;base64,AAAA', 'README.md')).toBeNull();
    expect(resolveRelativeAssetPath('../ust.png', 'klasor/alt.md')).toBe('ust.png');
  });

  it('rejects empty query-only and malformed percent targets', () => {
    // Sorgu/çapa ayıklanır, ama tek başına kalan boş yol yüklenmez.
    expect(resolveRelativeAssetPath('?x=1', 'README.md')).toBeNull();
    expect(resolveRelativeAssetPath('#bolum', 'README.md')).toBeNull();
    expect(resolveRelativeAssetPath('%FF.png', 'README.md')).toBeNull();
    expect(resolveRelativeAssetPath('gorseller/logo.png?raw=1', 'notlar/README.md')).toBe(
      'notlar/gorseller/logo.png',
    );
  });

  it('builds platform-correct mdasset URLs', () => {
    expect(mdAssetUrl('a/b c.png', true)).toBe(
      'http://mdasset.localhost/a/b%20c.png',
    );
    expect(mdAssetUrl('a/b c.png', false)).toBe('mdasset://localhost/a/b%20c.png');
  });
});

describe('source line mapping', () => {
  it('annotates every block with its 1-based source line', () => {
    const markdown = [
      '# Başlık',
      '',
      'paragraf',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '- madde',
    ].join('\n');
    const container = parse(renderPreview(markdown));

    expect(container.querySelector('h1')?.getAttribute('data-source-line')).toBe('1');
    expect(container.querySelector('p')?.getAttribute('data-source-line')).toBe('3');
    expect(container.querySelector('pre')?.getAttribute('data-source-line')).toBe('5');
    expect(container.querySelector('ul')?.getAttribute('data-source-line')).toBe('9');
    expect(container.querySelector('li')?.getAttribute('data-source-line')).toBe('9');
    // Kapanış etiketleri öznitelik taşımaz: fazladan bağlantı üretilmez.
    expect(container.querySelector('[data-source-line="10"]')).toBeNull();
  });
});
