# Markdown Editor — Hafif Windows Markdown Editörü

Tauri v2 + Svelte 5 + CodeMirror 6 üzerine kurulu, Windows'a odaklı hafif bir Markdown editörü. Dosya ağacı, sekmeli çoklu belge, canlı önizleme, dış değişiklik izleme ve çakışma koruması içerir.

## Özellikler

- Çalışma klasörü açma, özyinelemeli dosya ağacı (gizli/ignore/symlink atlanır)
- CodeMirror 6 editör + markdown-it/DOMPurify önizleme
- Atomik kaydetme (çarpışma korumalı `expectedHash` kontrolü)
- Harici değişiklik izleyici (150 ms debounce, self-write echo dedup)
- BOM ve satır sonu (CRLF/LF) korunumu
- Oturum geri yükleme, pencere kapatma onayı, merkezi klavye kısayolları

## Gereksinimler

- Windows 10 1809+ veya Windows 11 (WebView2 runtime gerektirir; Windows 11'de varsayılan olarak yüklüdür)
- Node.js 22+ (veya `package.json` → `engines` izleyin) ve pnpm/npm
- Rust toolchain (stable, `rustup` ile) + MSVC Build Tools
- Windows'ta uzun yol desteği için `\\?\` önekli yollar Rust tarafında `dunce` ile normalleştirilir; ek kurulum gerekmez

## Kurulum

```bash
npm install          # veya pnpm install
```

Rust bağımlılıkları ilk `tauri dev` çağrısında derlenir (ilk derleme birkaç dakika sürebilir).

## Geliştirme

```bash
npm run tauri:dev    # Vite + Tauri geliştirici penceresi (http://localhost:1420)
```

Yalnızca frontend üzerinde çalışıyorsanız: `npm run dev` (tauri penceresi olmadan tarayıcıda çalışmaz; `invoke` köprüsü mocklanmadan çalıştırılmamalıdır).

### Test ve kalite kontrolleri

```bash
npm run check        # svelte-check + TypeScript
npm run test         # vitest birim testleri
npm run test:e2e     # Playwright E2E (mock Tauri köprüsü ile, e2e/mock-tauri.ts)
npm run lint         # varsa yapılandırılmış linter
```

Rust tarafı:

```bash
cd src-tauri && cargo test        # path confinement, atomic write, encoding, watcher dedup
cargo test --test path_confinement  # tek test seti
```

## Üretim derlemesi

```bash
npm run tauri:build  # NSIS kurulum paketi (src-tauri/target/release/bundle)
```

- Bundle hedefi: `nsis` (`src-tauri/tauri.conf.json` → `bundle.targets`)
- WebView2 yoksa kurulum `downloadBootstrapper` moduyla WebView2'yi indirir (`bundle.windows.webviewInstallMode`)
- Derleme öncesi `npm run build` otomatik çalışır (svelte-check + vite build)

### Bütçe ölçümleri

```bash
npm run perf:bundle        # paket boyutu bütçesi
npm run perf:startup       # ilk boyama gecikmesi
npm run perf:installer     # kurulum paketi boyutu
npm run perf:memory        # 5 sekmeli çalışma kümesi
```

## Klavye kısayolları

| Kısayol | Komut |
|---------|-------|
| Ctrl+S  | Kaydet |
| Ctrl+B  | Kalın |
| Ctrl+W  | Sekmeyi kapat |
| Ctrl+F  | Bul |
| Ctrl+P  | Hızlı aç |

Kısayollar tek bir `keydown` dinleyicisinden komutlara çevrilir (`src/lib/app/shortcuts.ts`); tarayıcı varsayılanları (Ctrl+P yazdırma, Ctrl+S iletişim kutusu) `preventDefault` ile bastırılır.

## Dokümantasyon

- `docs/ARCHITECTURE.md` — IPC komut sözleşmesi, path güvenliği, atomik yazma, watcher dedup
- `docs/QA-WINDOWS.md` — Windows 10/11 QA checklist, WebView2 yok senaryosu, encoding/EOL testleri
- `docs/PERFORMANCE.md`, `docs/STARTUP-BASELINE.md` — performans ölçüm prosedürleri

## Depo yapısı

```
src/            Svelte 5 + CodeMirror frontend (lib/ipc, lib/editor, lib/tree, lib/preview, lib/save, lib/session, lib/watch, lib/app)
src-tauri/      Rust arka planı (fs_ops, paths.rs confinement, fs/atomic.rs, watcher.rs, workspace_commands.rs)
e2e/            Playwright E2E + mock Tauri köprüsü
scripts/        Bütçe/perf ölçüm komutları
docs/           Mimari ve QA dokümantasyonu
```
