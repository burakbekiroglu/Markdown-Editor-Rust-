import { defineConfig, devices } from '@playwright/test';

/**
 * Uçtan uca test yapılandırması.
 *
 * Testler gerçek Vite geliştirme sunucusunu (port 1420) kullanır; Tauri
 * köprüsü `e2e/mock-tauri.ts` ile sayfa içinde sahte olarak kurulur. Bu yüzden
 * Rust tarafı veya WebView2 gerekmez ve akış CI'da headless çalışır.
 */
const isCI = process.env.CI !== undefined && process.env.CI !== '';

export default defineConfig({
  testDir: './e2e',
  // Vitest varsayılan deseni (`*.test.*`, `*.spec.*`) bu dosyaları toplamasın.
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:1420',
    headless: true,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
