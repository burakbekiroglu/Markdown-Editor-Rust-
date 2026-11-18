// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { highlightCodeBlocks, resetHighlighterForTests } from './highlight';

beforeEach(() => {
  resetHighlighterForTests();
});

describe('highlightCodeBlocks', () => {
  it('alt küme yüklenene kadar sade kod gösterir, sonra vurgular', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML =
      '<pre class="md-code"><code class="language-js">const x = 1;</code></pre>';
    const code = root.querySelector('code');
    if (code === null) throw new Error('code element missing');

    const pending = highlightCodeBlocks(root);

    // Alt küme henüz yüklenmedi: sade `<pre><code>` görünümü korunur.
    expect(code.textContent).toBe('const x = 1;');
    expect(code.classList.contains('hljs')).toBe(false);

    await pending;

    expect(code.dataset.highlighted).toBe('true');
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.innerHTML).toContain('hljs-keyword');
  });

  it('alt küme dışındaki dili sade bırakır', async () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<pre class="md-code"><code class="language-brainfuck">+++.</code></pre>';
    const code = root.querySelector('code');
    if (code === null) throw new Error('code element missing');

    await highlightCodeBlocks(root);

    expect(code.textContent).toBe('+++.');
    expect(code.dataset.highlighted).toBeUndefined();
    expect(code.classList.contains('hljs')).toBe(false);
  });

  it('aynı bloğu ikinci kez işlemez', async () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<pre class="md-code"><code class="language-json">{"a":1}</code></pre>';
    const code = root.querySelector('code');
    if (code === null) throw new Error('code element missing');

    await highlightCodeBlocks(root);
    const first = code.innerHTML;
    await highlightCodeBlocks(root);

    expect(code.innerHTML).toBe(first);
  });
});
