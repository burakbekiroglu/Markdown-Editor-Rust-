import { expect, test, type Page } from '@playwright/test';

import { installMockTauri, type MockSnapshot, type MockTauriFixture } from './mock-tauri';

/**
 * Temel klavye kısayollarının gerçek penceredeki davranışı.
 *
 * Merkezi katman (`src/lib/app/shortcuts.ts`) tek bir `window` dinleyicisi
 * kullanır; CodeMirror keymap'inde tekrar eden `Mod-*` bağları yoktur. Bu
 * dosya, çift çalışma olmadığını gözlenebilir çıktı üzerinden doğrular:
 * Ctrl+B iki kez işlenseydi `****` yerine `********` oluşurdu, Ctrl+P iki kez
 * işlenseydi palet açılıp hemen kapanırdı.
 */

const fixture: MockTauriFixture = {
  root: 'C:\\mock\\notes',
  files: {
    'README.md': '# Readme\n\nline one\n',
  },
};

async function snapshot(page: Page): Promise<MockSnapshot> {
  return page.evaluate(() => window.__MD_EDITOR_MOCK__.snapshot());
}

async function openReadme(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Klasör aç' }).click();
  await expect(page.locator('.status-root')).toHaveText('notes');
  await page.locator('[role="treeitem"][data-path="README.md"]').click();
  await expect(page.locator('.cm-content')).toContainText('line one');
  await expect(page.locator('.tabbar [role="tab"]')).toHaveCount(1);
}

/** Editör içeriğini düz metin olarak döner. */
async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-content').innerText();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, fixture);
  await page.goto('/');
});

test('Ctrl+S dirty olmayan sekmede yazmaz', async ({ page }) => {
  await openReadme(page);
  await page.locator('.cm-content').click();

  // İki kez basmak, gecikmeli bir yazma olsaydı ikinci isteği de tetiklerdi.
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+s');

  await expect(page.locator('.status-tab')).toHaveText('README.md — Kaydedildi');
  expect((await snapshot(page)).writes).toEqual([]);
});

test('Ctrl+S dirty sekmeyi bir kez expectedHash ile yazar ve dirty temizlenir', async ({
  page,
}) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nikinci satir');
  await expect(page.locator('.tabbar .tab .dot')).toHaveCount(1);

  await page.keyboard.press('Control+s');

  await expect(page.locator('.status-tab')).toHaveText('README.md — Kaydedildi');
  await expect(page.locator('.tabbar .tab .dot')).toHaveCount(0);

  const result = await snapshot(page);
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0].path).toBe('README.md');
  expect(result.writes[0].contents).toContain('ikinci satir');
  // Yazma diske gerçekten uygulandı; sekme hash'i yeni içerikle eşleşir.
  expect(result.files['README.md']).toBe(result.writes[0].contents);
});

test('yazma sürerken ikinci Ctrl+S ikinci bir yazma üretmez', async ({ page }) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nyavas yazma');
  // Yazmayı uzat: ilk istek sürerken ikinci tuş vuruşu kilide çarpmalı.
  await page.evaluate(() => window.__MD_EDITOR_MOCK__.setWriteDelay(800));

  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+s');

  await expect(page.locator('.status-tab')).toHaveText('README.md — Kaydedildi');
  const result = await snapshot(page);
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0].contents).toContain('yavas yazma');
});

test('disk değiştiyse Ctrl+S reddedilir, sekme dirty kalır ve çakışma bandı açılır', async ({
  page,
}) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nbenim satirim');
  // Dış değişiklik: diskteki hash artık sekmenin `expectedHash`'i ile eşleşmez.
  await page.evaluate(() =>
    window.__MD_EDITOR_MOCK__.writeExternal('README.md', '# Readme\n\ndis degisikligi\n'),
  );

  await page.keyboard.press('Control+s');

  const banner = page.getByRole('alert', { name: 'Dış değişiklik çakışması' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('README.md');
  // Reddedilen yazma diske hiç dokunmadı; editör içeriği ve dirty korunur.
  expect((await snapshot(page)).writes).toEqual([]);
  await expect(page.locator('.status-tab')).toHaveText('README.md — Kaydedilmedi');
  expect(await editorText(page)).toContain('benim satirim');
});

test('Ctrl+B seçim yokken tek boş işaretçi ekler', async ({ page }) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+b');

  const text = await editorText(page);
  // Çift çalışma `********` üretirdi; tek işaretçi tam olarak bir kez var.
  expect(text).not.toContain('********');
  expect(text.match(/\*{4}/g)?.length).toBe(1);
});

test('Ctrl+B seçimi kalınlaştırır', async ({ page }) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+b');

  // Seçim `**` ile sarılır ve iç metin seçili kalır.
  expect(await editorText(page)).toContain('**beta**');
});

test('Ctrl+F arama panelini açar', async ({ page }) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+f');

  await expect(page.locator('.cm-panel.cm-search')).toBeVisible();
  await expect(page.locator('.cm-panel.cm-search input[name="search"]')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-panel.cm-search')).toBeHidden();
});

test('Ctrl+W temiz sekmeyi kapatır ve pencereyi kapatmaz', async ({ page }) => {
  await openReadme(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+w');

  await expect(page.locator('.tabbar [role="tab"]')).toHaveCount(0);
  expect((await snapshot(page)).closed).toBe(false);
});

test('Ctrl+P hem editör hem genel odakta tek kez açılır', async ({ page }) => {
  await openReadme(page);
  const dialog = page.getByRole('dialog', { name: 'Hızlı dosya geçişi' });

  // Editör odaklıyken: iki dinleyici olsaydı aç-kapa aynı tuşta olurdu.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+p');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Odak editörde değilken de aynı tek davranış.
  await page.locator('.status-root').click();
  await page.keyboard.press('Control+p');
  await expect(dialog).toBeVisible();
});
