import { expect, test, type Page } from '@playwright/test';

import { installMockTauri, type MockTauriFixture } from './mock-tauri';

/**
 * Çevrimdışı çalışma uçtan uca doğrulaması.
 *
 * Kapsanan kabul ölçütleri:
 * 1. Önizleme uzak görselleri yüklemez: uzak `img` adresi hiç istenmez,
 *    yerine yer tutucu gösterilir.
 * 2. Arayüz hiçbir dış ağ isteği başlatmaz; yerel olmayan her istek engellenir
 *    ve testin sonunda engellenen istek listesinin boş olduğu doğrulanır.
 * 3. Ağ kapalıyken (tarayıcı offline) klasör açma, düzenleme ve kaydetme aynı
 *    şekilde çalışır.
 */

/** Uzak görsel ve uzak bağlantı içeren belge. */
const offlineDocument = [
  '# Çevrimdışı Belge',
  '',
  '![uzak görsel](https://example.com/gorsel.png)',
  '',
  '[harici bağlantı](https://example.com/sayfa)',
  '',
].join('\n');

const fixture: MockTauriFixture = {
  root: 'C:\\mock\\notes',
  files: {
    'cevrimdisi.md': offlineDocument,
  },
};

/** Yerel geliştirme sunucusu ve uygulama içi şemalar dışındaki her isteği engeller. */
async function blockExternalRequests(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://localhost:1420')) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  return blocked;
}

async function openDocument(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Klasör aç' }).click();
  await page.locator('[role="treeitem"][data-path="cevrimdisi.md"]').click();
  await expect(page.locator('.cm-content')).toContainText('Çevrimdışı Belge');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, fixture);
});

test('önizleme uzak görselleri yüklemez ve dış istek başlatmaz', async ({ page }) => {
  const blocked = await blockExternalRequests(page);
  await page.goto('/');
  await openDocument(page);

  await page.getByRole('radio', { name: 'Önizleme' }).click();
  await expect(page.locator('.preview-column')).toBeVisible();

  // Uzak görsel yer tutucuya dönüşür; `src` taşıyan bir `img` üretilmez.
  await expect(page.locator('.preview-pane .md-image-blocked')).toContainText('uzak görsel');
  const remoteImages = await page.locator('.preview-pane img[src]').evaluateAll((images) =>
    images
      .map((image) => image.getAttribute('src') ?? '')
      .filter(
        (src) =>
          !src.startsWith('mdasset://localhost/') && !src.startsWith('http://mdasset.localhost/'),
      ),
  );
  expect(remoteImages).toEqual([]);

  // Önizleme çizildikten sonra dış istek yok.
  expect(blocked).toEqual([]);
});

test('ağ kapalıyken düzenleme ve kaydetme çalışır', async ({ page, context }) => {
  await page.goto('/');
  await openDocument(page);
  await context.setOffline(true);

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('çevrimdışı düzenleme');
  await page.keyboard.press('Control+s');

  await expect
    .poll(() => page.evaluate(() => window.__MD_EDITOR_MOCK__.snapshot().writes))
    .not.toEqual([]);
  const writes = await page.evaluate(() => window.__MD_EDITOR_MOCK__.snapshot().writes);
  expect(writes[0]?.contents).toContain('çevrimdışı düzenleme');
  await expect(page.locator('.status-tab')).toContainText('cevrimdisi.md');
});
