import { expect, test, type Page } from '@playwright/test';

import { installMockTauri, type MockTauriFixture } from './mock-tauri';

/**
 * Kabuk (sol ağaç + sekmeli orta alan + durum çubuğu) ve tema uçtan uca
 * doğrulaması.
 *
 * Kapsanan kabul ölçütleri:
 * 1. İlk açılışta boş durum ekranı çalışma klasörü açmayı önerir ve eylemi
 *    doğrudan çalıştırır (başlık çubuğundaki düğmeye gitmek gerekmez).
 * 2. Tema sistem koyu/açık tercihini izler: ilk karede doğru set uygulanır ve
 *    çalışma anındaki tercih değişimi de yansır.
 */

const fixture: MockTauriFixture = {
  root: 'C:\\mock\\notes',
  files: {
    'README.md': '# Tema\n\nMetin.\n',
  },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, fixture);
});

/** Kök elemanın hesaplanmış arka plan rengi; token setinin uygulandığını gösterir. */
async function rootBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

test('boş durum ekranı çalışma klasörü açmayı önerir ve açar', async ({ page }) => {
  await page.goto('/');

  const emptyState = page.locator('.empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('Başlamak için bir çalışma klasörü açın.');

  await page.getByRole('button', { name: 'Çalışma klasörü aç' }).click();
  await expect(page.locator('.status-root')).toHaveText('notes');
  await expect(page.locator('[role="treeitem"][data-path="README.md"]')).toBeVisible();
  await expect(emptyState).toHaveCount(0);
});

test('ilk kare sistem açık tercihiyle boyanır', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => rootBackground(page)).toBe('rgb(255, 255, 255)');
});

test('sistem tercihi çalışma anında değişirse tema izler', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => rootBackground(page)).toBe('rgb(30, 30, 30)');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => rootBackground(page)).toBe('rgb(255, 255, 255)');
});
