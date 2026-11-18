import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Tauri expects a fixed port and prints its own errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tauri rebuilds the Rust side itself.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Env vars with these prefixes are exposed to the frontend.
  envPrefix: ["VITE_", "TAURI_ENV_*"],

  build: {
    // Windows targets WebView2 (Chromium), so a modern baseline is safe.
    target: "chrome105",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Budget measurement (`npm run perf:bundle`) reads the emitted manifest to
    // map chunks back to their source modules; without it chunk identity is
    // guesswork from hashed file names.
    manifest: true,
  },
});
