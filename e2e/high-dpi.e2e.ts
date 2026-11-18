import { expect, test, type Page } from '@playwright/test';

import { installMockTauri, type MockTauriFixture } from './mock-tauri';

/**
 * Yüksek DPI (Windows %125–%200 ölçekleme) yerleşim doğrulaması.
 *
 * Windows ölçeklemesi WebView2'de `devicePixelRatio` olarak görünür ve aynı
 * fiziksel ekranda CSS görünüm alanını küçültür. Burada her ölçek için gerçekçi
 * bir CSS görünüm alanı kurulur (1600×900 @ %125, 1920×1080 @ %150 ve %200) ve
 * kabuğun taşmadığı, bölgelerin görünüm alanı içinde kaldığı ve CSS ölçülerinin
 * ölçekten bağımsız kaldığı doğrulanır.
 */

/** Uzun bir paragraf: ölçeklemede satır sarma ve taşma davranışını zorlar. */
const longParagraph = Array.from(
  { length: 200 },
  (_, index) => `Ölçekleme satırı ${index + 1}: Türkçe karakterler ğüşiöç İI.`,
).join(' ');

const fixture: MockTauriFixture = {
  root: 'C:\\mock\\notes',
  files: {
    'README.md': `# Yüksek DPI\n\n${longParagraph}\n`,
    'docs/guide.md': '# Kılavuz\n\nKısa belge.\n',
  },
};

/** Görünüm alanına göre ölçülen bir yerleşim kutusu. */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** `page.evaluate` içinde ölçülen yerleşim bilgisi. */
interface Layout {
  dpr: number;
  innerWidth: number;
  innerHeight: number;
  horizontalOverflow: number;
  verticalOverflow: number;
  rootFontSize: string;
  titlebar: Box;
  sidebar: Box;
  workspace: Box;
  statusbar: Box;
  openButton: Box;
}

async function readLayout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (selector: string): Box => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        throw new Error(`missing ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };

    const root = document.documentElement;
    return {
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      verticalOverflow: root.scrollHeight - root.clientHeight,
      rootFontSize: getComputedStyle(root).fontSize,
      titlebar: box('header.titlebar'),
      sidebar: box('aside.sidebar'),
      workspace: box('section.workspace'),
      statusbar: box('footer.statusbar'),
      openButton: box('button.open-workspace'),
    };
  });
}

/** Kabuğun verilen ölçekte bozulmadığını doğrular. */
async function expectLayoutIntact(page: Page, scale: number): Promise<void> {
  const layout = await readLayout(page);

  // Emülasyonun gerçekten istenen ölçekte olduğunu doğrula.
  expect(layout.dpr).toBeCloseTo(scale, 5);

  // CSS ölçüleri ölçekten bağımsızdır: kök yazı boyutu 14 CSS px kalır.
  expect(layout.rootFontSize).toBe('14px');

  // Taşma yok: yatay/dikey kaydırma çubuğu oluşmaz.
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(layout.verticalOverflow).toBeLessThanOrEqual(0);

  const boxes: Record<string, Box> = {
    titlebar: layout.titlebar,
    sidebar: layout.sidebar,
    workspace: layout.workspace,
    statusbar: layout.statusbar,
    openButton: layout.openButton,
  };
  for (const [name, box] of Object.entries(boxes)) {
    expect(box.width, `${name} genişliği`).toBeGreaterThan(0);
    expect(box.height, `${name} yüksekliği`).toBeGreaterThan(0);
    expect(box.left, `${name} sol`).toBeGreaterThanOrEqual(-0.5);
    expect(box.top, `${name} üst`).toBeGreaterThanOrEqual(-0.5);
    expect(box.right, `${name} sağ`).toBeLessThanOrEqual(layout.innerWidth + 0.5);
    expect(box.bottom, `${name} alt`).toBeLessThanOrEqual(layout.innerHeight + 0.5);
  }

  // Bölgeler üst üste binmeden yan yana: kenar çubuğu çalışma alanının solunda.
  expect(layout.sidebar.right).toBeLessThanOrEqual(layout.workspace.left + 0.5);
  // Durum çubuğu gövdenin altında, başlık çubuğu en üstte.
  expect(layout.statusbar.top).toBeGreaterThanOrEqual(layout.titlebar.bottom - 0.5);
  expect(layout.titlebar.top).toBeLessThanOrEqual(0.5);
  expect(layout.statusbar.bottom).toBeCloseTo(layout.innerHeight, 0);
}

/** Uzun bir belge açıp düzenleyicinin görünüm alanı içinde kaldığını doğrular. */
async function expectEditorIntact(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Klasör aç' }).click();
  const readme = page.locator('[role="treeitem"][data-path="README.md"]');
  await expect(readme).toBeVisible();
  await readme.click();

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  const box = await editor.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeGreaterThan(200);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 0.5);

  // Belge yüklendikten sonra da yatay taşma oluşmamalı.
  const layout = await readLayout(page);
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(0);
  await expect(page.locator('.status-tab')).toContainText('README.md');
}

/** Her ölçek için aynı akış: boş kabuk, sonra açılmış belge. */
async function runScaleChecks(page: Page, scale: number): Promise<void> {
  await expectLayoutIntact(page, scale);
  await expectEditorIntact(page);
}

test.describe('%125 ölçekleme (1600×900 fiziksel)', () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.25 });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMockTauri, fixture);
    await page.goto('/');
  });

  test('arayüz bozulmadan yerleşir', async ({ page }) => {
    await runScaleChecks(page, 1.25);
  });
});

test.describe('%150 ölçekleme (1920×1080 fiziksel)', () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMockTauri, fixture);
    await page.goto('/');
  });

  test('arayüz bozulmadan yerleşir', async ({ page }) => {
    await runScaleChecks(page, 1.5);
  });
});

test.describe('%200 ölçekleme (1920×1080 fiziksel)', () => {
  test.use({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMockTauri, fixture);
    await page.goto('/');
  });

  test('arayüz bozulmadan yerleşir', async ({ page }) => {
    await runScaleChecks(page, 2);
  });
});
