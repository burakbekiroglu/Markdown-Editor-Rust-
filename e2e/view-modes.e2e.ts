import { expect, test, type Page } from '@playwright/test';

import { installMockTauri, type MockTauriFixture } from './mock-tauri';

/**
 * Görünüm modu (editör / önizleme / bölünmüş) uçtan uca doğrulaması.
 *
 * Kapsanan kabul ölçütleri:
 * 1. Mod değişimi aktif sekmeyi ve imleci kaybetmez.
 * 2. Bölünmüş modda senkron kaydırma `data-source-line` eşlemesiyle çalışır ve
 *    geri besleme döngüsü üretmez.
 * 3. Mod seçimi oturumda (localStorage) saklanır.
 */

/** Kaydırmanın anlamlı olması için uzun, düzgün bloklu bir belge. */
const longDocument = [
  '# Uzun Belge',
  '',
  ...Array.from({ length: 120 }, (_, index) => [
    `## Bölüm ${index + 1}`,
    '',
    `paragraf ${index + 1}`,
    '',
  ]).flat(),
].join('\n');

const fixture: MockTauriFixture = {
  root: 'C:\\mock\\notes',
  files: {
    'uzun.md': longDocument,
  },
};

async function openDocument(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Klasör aç' }).click();
  await page.locator('[role="treeitem"][data-path="uzun.md"]').click();
  await expect(page.locator('.cm-content')).toContainText('Uzun Belge');
}

/** Editör ile önizlemenin en üstte gösterdiği blok metinleri. */
async function topBlocks(page: Page): Promise<{ editor: string; preview: string }> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller') as HTMLElement | null;
    const pane = document.querySelector('.preview-pane') as HTMLElement | null;
    if (scroller === null || pane === null) return { editor: '', preview: '' };
    const box = scroller.getBoundingClientRect();
    // CodeMirror yalnızca görünür aralığı DOM'da tutar; ölçüt görünür kutu.
    const line = [...document.querySelectorAll('.cm-line')].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > box.top + 2 && rect.top < box.bottom;
    });
    const anchors = [...pane.querySelectorAll<HTMLElement>('[data-source-line]')]
      .filter((element) => element.offsetTop >= pane.scrollTop - 2)
      .sort((a, b) => a.offsetTop - b.offsetTop);
    return {
      editor: line?.textContent?.trim() ?? '',
      preview: anchors[0]?.textContent?.trim() ?? '',
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, fixture);
  await page.goto('/');
  await openDocument(page);
});

test('mod değişimi aktif sekmeyi ve imleci kaybetmez', async ({ page }) => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('SON');

  // Editör → önizleme: sekme seçili kalır, editör sökülmez yalnızca gizlenir.
  await page.getByRole('radio', { name: 'Önizleme' }).click();
  await expect(page.locator('.editor-column')).toBeHidden();
  await expect(page.locator('.preview-column')).toBeVisible();
  await expect(page.locator('.tabbar [role="tab"]', { hasText: 'uzun.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.status-tab')).toContainText('uzun.md');

  // Önizleme → editör: belge ve imleç yerinde; yazılan metin belgenin sonuna
  // eklenir, yani imleç mod değişiminde korunmuştur.
  await page.getByRole('radio', { name: 'Editör' }).click();
  await expect(page.locator('.preview-column')).toBeHidden();
  await expect(page.locator('.editor-column')).toBeVisible();
  await page.locator('.cm-content').focus();
  await page.keyboard.type('!');
  await expect(page.locator('.cm-content')).toContainText('SON!');
  await expect(page.locator('.status-tab')).toContainText('Kaydedilmedi');
});

test('mod seçimi oturumda saklanır', async ({ page }) => {
  await page.getByRole('radio', { name: 'Editör' }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('md-editor:view-mode')))
    .toBe('editor');

  await page.reload();
  await page.getByRole('button', { name: 'Klasör aç' }).click();
  await page.locator('[role="treeitem"][data-path="uzun.md"]').click();

  await expect(page.getByRole('radio', { name: 'Editör' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('.preview-column')).toBeHidden();
});

test('bölünmüş modda senkron kaydırma satır eşlemesiyle çalışır', async ({ page }) => {
  await page.getByRole('radio', { name: 'Bölünmüş' }).click();
  await expect(page.locator('.preview-pane [data-source-line]').first()).toBeVisible();

  // Editörü kaydır: önizleme aynı kaynak satırına gelir.
  await page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller') as HTMLElement;
    scroller.scrollTop = 2400;
  });
  await expect
    .poll(async () => {
      const top = await topBlocks(page);
      return top.preview.length > 0 && top.editor.replace(/^#+\s*/, '') === top.preview;
    })
    .toBe(true);

  // Geri besleme döngüsü yok: iki taraf da kendi konumunda durur.
  const positions = () =>
    page.evaluate(() => ({
      editor: (document.querySelector('.cm-scroller') as HTMLElement).scrollTop,
      preview: (document.querySelector('.preview-pane') as HTMLElement).scrollTop,
    }));
  const first = await positions();
  await page.waitForTimeout(300);
  const second = await positions();
  expect(Math.abs(second.editor - first.editor)).toBeLessThan(2);
  expect(Math.abs(second.preview - first.preview)).toBeLessThan(2);

  // Ters yön: önizlemeyi başa alınca editör de başa döner.
  await page.evaluate(() => {
    const pane = document.querySelector('.preview-pane') as HTMLElement;
    pane.scrollTop = 0;
  });
  await expect
    .poll(() =>
      page.evaluate(() => (document.querySelector('.cm-scroller') as HTMLElement).scrollTop),
    )
    .toBeLessThan(2);
});
