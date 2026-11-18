import { expect, test, type Page } from '@playwright/test';

import { installMockTauri, type MockSnapshot, type MockTauriFixture } from './mock-tauri';

/**
 * Uçtan uca duman testi: sahte Tauri köprüsü üzerinde gerçek arayüz.
 *
 * Akış: klasör aç → ağaçta gezin → dosya aç → düzenle (dirty nokta) → Ctrl+S →
 * ikinci sekme → Ctrl+P ile geçiş → kirli sekmede kapatma onayı.
 *
 * Köprü `addInitScript` ile sayfa kodundan önce kurulur; üretim kodu Tauri'ye
 * gerçekten bağlıymış gibi çalışır.
 */

const fixture: MockTauriFixture = {
  root: 'C:\\mock\\notes',
  files: {
    'README.md': '# Mock Workspace\n\nWelcome to the mock workspace.\n',
    'docs/guide.md': '# Guide\n\nStep by step.\n',
    'docs/advanced/tips.md': '# Tips\n\nAdvanced tips.\n',
  },
};

async function snapshot(page: Page): Promise<MockSnapshot> {
  return page.evaluate(() => window.__MD_EDITOR_MOCK__.snapshot());
}

/** Metni belgenin sonuna ekler; içerik değişimi dirty işaretini tetikler. */
async function appendToEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, fixture);
  await page.goto('/');
});

test('klasör aç → gezin → düzenle → kaydet → Ctrl+P → kapatma onayı', async ({ page }) => {
  // 1) Boş durum: çalışma alanı açık değil.
  await expect(page.getByText('Başlamak için bir çalışma klasörü açın.').first()).toBeVisible();
  await expect(page.locator('.status-root')).toHaveText('Çalışma alanı açık değil');

  // 2) Klasör aç: kök ve ilk seviye ağaç satırları görünür.
  await page.getByRole('button', { name: 'Klasör aç' }).click();
  await expect(page.locator('.status-root')).toHaveText('notes');
  const docsRow = page.locator('[role="treeitem"][data-path="docs"]');
  const readmeRow = page.locator('[role="treeitem"][data-path="README.md"]');
  await expect(docsRow).toBeVisible();
  await expect(readmeRow).toBeVisible();
  await expect(docsRow).toHaveAttribute('aria-expanded', 'false');

  // 3) Ağaçta gezin: klasörü aç, içindeki dosyayı aç.
  await docsRow.click();
  await expect(docsRow).toHaveAttribute('aria-expanded', 'true');
  const guideRow = page.locator('[role="treeitem"][data-path="docs/guide.md"]');
  await expect(guideRow).toBeVisible();
  await guideRow.click();

  const guideTab = page.locator('.tabbar [role="tab"]', { hasText: 'guide.md' });
  await expect(guideTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.cm-content')).toContainText('Step by step.');
  await expect(page.locator('.status-tab')).toHaveText('guide.md — Kaydedildi');

  // 4) Düzenle: dirty noktası ve durum çubuğu güncellenir.
  await appendToEditor(page, ' Edited.');
  await expect(guideTab.locator('.dot')).toBeVisible();
  await expect(page.locator('.status-tab')).toHaveText('guide.md — Kaydedilmedi');

  // 5) Ctrl+S: içerik diske yazılır, dirty noktası kalkar.
  await page.keyboard.press('Control+s');
  await expect(guideTab.locator('.dot')).toHaveCount(0);
  await expect(page.locator('.status-tab')).toHaveText('guide.md — Kaydedildi');
  await expect
    .poll(async () => (await snapshot(page)).files['docs/guide.md'])
    .toContain('Edited.');
  expect((await snapshot(page)).writes).toContainEqual({
    path: 'docs/guide.md',
    contents: '# Guide\n\nStep by step.\n Edited.',
  });

  // 6) İkinci sekme: README.md açılır, iki sekme görünür.
  await readmeRow.click();
  const readmeTab = page.locator('.tabbar [role="tab"]', { hasText: 'README.md' });
  await expect(readmeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tabbar [role="tab"]')).toHaveCount(2);
  await expect(page.locator('.cm-content')).toContainText('Welcome to the mock workspace.');

  // 7) Ctrl+P: indeksten guide.md seçilir, sekme geçişi yapılır.
  await page.keyboard.press('Control+p');
  const quickOpen = page.getByRole('dialog', { name: 'Hızlı dosya geçişi' });
  await expect(quickOpen).toBeVisible();
  const search = page.getByRole('combobox', { name: 'Dosya adı ara' });
  await search.fill('guide');
  await search.press('Enter');
  await expect(quickOpen).toBeHidden();
  await expect(guideTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.status-tab')).toHaveText('guide.md — Kaydedildi');
  await expect(page.locator('.tabbar [role="tab"]')).toHaveCount(2);

  // 8) Kirli sekmede kapatma onayı: Rust olayı sahte köprüden yayılır.
  await appendToEditor(page, ' More.');
  await expect(guideTab.locator('.dot')).toBeVisible();
  await page.evaluate(() => window.__MD_EDITOR_MOCK__.emit('app:close-requested'));

  const closeDialog = page.getByRole('alertdialog');
  await expect(closeDialog).toBeVisible();
  await expect(closeDialog).toContainText('Kaydedilmemiş değişiklikler');
  await expect(closeDialog).toContainText('“guide.md” dosyasında kaydedilmemiş değişiklik var.');

  // 8a) Vazgeç: pencere kapanmaz, içerik korunur.
  await closeDialog.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(closeDialog).toBeHidden();
  expect((await snapshot(page)).closed).toBe(false);

  // 8b) Kaydetmeden kapat: pencere yok edilir, yeni düzenleme yazılmaz.
  await page.evaluate(() => window.__MD_EDITOR_MOCK__.emit('app:close-requested'));
  await expect(closeDialog).toBeVisible();
  await closeDialog.getByRole('button', { name: 'Kaydetmeden Kapat' }).click();
  await expect.poll(async () => (await snapshot(page)).closed).toBe(true);
  expect((await snapshot(page)).writes.map((write) => write.contents)).not.toContain(
    '# Guide\n\nStep by step.\n Edited. More.',
  );

  // Sahte köprüde eksik komut kalmadı: uygulamanın tüm IPC yüzeyi kapsandı.
  expect((await snapshot(page)).unknownCommands).toEqual([]);
});
