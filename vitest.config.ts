import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Svelte bileşenleri tarayıcı derlemesini gerektirir; testler Node altında
// çalıştığı için `svelte` paketinin `browser` koşulu ayrıca eklenir. Aksi
// halde `mount(...)` sunucu derlemesinden gelir ve kullanılamaz.
export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
});
