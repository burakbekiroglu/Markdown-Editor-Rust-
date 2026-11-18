# İlk yükleme gzip baseline'ı ve müdahale listesi doğrulaması

Bu belge **yalnızca ölçüm ve doğrulama** çıktısıdır. Hiçbir kaynak dosya
değiştirilmedi, hiçbir bağımlılık eklenmedi/çıkarılmadı.

Üretim derlemesi: `node node_modules/vite/bin/vite.js build` (Vite 8.3.8 /
rolldown), 253 modül, `built in 474ms`, `exit 0`. Manifest zaman damgası
derleme anına aittir.

## 1. Baseline (sayısal)

Aynı `dist/` çıktısı üzerinde iki farklı tanım ölçüldü; ikisi de kaydedildi
çünkü projede iki tanım bir arada kullanılıyor (bkz. §5).

| Ölçüm | Komut | Değer |
| --- | --- | --- |
| **Giriş + statik import zinciri (JS)** | `node scripts/measure-initial-gzip.mjs` | **37.16 KB gzip** (3 chunk, 103.27 KB ham) |
| Giriş HTML | `zlib.gzipSync(dist/index.html, level 9)` | 0.32 KB gzip |
| Giriş CSS (`index-*.css`) | aynı | 3.21 KB gzip |
| **İlk boya statik toplam (HTML + CSS + JS)** | toplam | **40.69 KB gzip** (41 667 B) |
| **Bütçe kapısının "ilk yüklenen JS" toplamı** | `node scripts/check-bundle-budget.mjs` | **310.2 KB gzip / 320 KB** (exit 0, güncel derleme) |

Statik zincir chunk'ları:

| Chunk | Ham | gzip |
| --- | --- | --- |
| `assets/index-mGYZU4KZ.js` (giriş) | 59.47 KB | 20.18 KB |
| `assets/toast.svelte-jwbK9xZP.js` (paylaşılan) | 43.08 KB | 16.56 KB |
| `assets/rolldown-runtime-XKyaHtl9.js` | 0.71 KB | 0.42 KB |

Bütçe kapısı toplamına giren (statik + uygulamanın ilk sekmede hemen açtığı
dinamik girişler) kalemler: `EditorPane` **190.3 KB gzip**,
`PreviewPane` 54.0 KB, hljs `core` 7.8 KB + 9 dil paketi 12.4 KB,
`QuickOpenPanel` 2.7 KB, `ConflictHost` 2.6 KB, `opener` 0.1 KB.
Bütçe başlangıç chunk'ı için 250 KB, ilk yük JS toplamı için 320 KB,
tembel önizleme için 160 KB'dir; üçü de geçti (`exit 0`).

## 2. Madde → dosya eşlemesi (2. adım listesi, mevcut kaynakla doğrulandı)

2. adım listesindeki dört kategori (a) kullanılmayan/tip sızıntısı,
(b) ağır bağımlılığın ilk yüklemede olması, (c) eager→lazy adayı,
(d) çift paketlenmiş kopya — mevcut kaynakta şu durumda:

| # | Madde (kategori) | Dosya / satır / import | Mevcut durum | Beklenen kazanç (gzip, tahmin) | Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | CodeMirror markdown dil yığını — `lang-markdown`'ın zorunlu `lang-html` + `@lezer/html` + (onların da zorunlu) `lang-css`/`@lezer/css` + `lang-javascript`/`@lezer/javascript` (HTML blok ayrıştırma + gömülü CSS/JS vurgusu) (b/c) | `src/lib/editor/session.ts:21` (`markdown` import), `:361` (`markdown()`) | `EditorPane` chunk'ı içinde, ilk sekmede yükleniyor | **~34.9 KB gzip** (ölçülen, bkz. §2.1) | Orta-yüksek: HTML/CSS/JS blok vurgusu davranışı değişir; `node_modules/@codemirror/lang-markdown/dist/index.js` `lang-html`'i koşulsuz import eder, `lang-html` de css/js dillerini |
| 2 | `@codemirror/search` uzantısı eager kuruluyor (c) | `src/lib/editor/session.ts:22-27` (import), `:362` (`search({ top: true })`) | `EditorPane` chunk'ı içinde | **~7.2 KB gzip** (ölçülen, bkz. §2.1) | Orta: arama panelinin tembel bir `Compartment` ile kurulması gerekir |
| 3 | `@lezer/markdown` çekirdek ayrıştırıcı (b) | `src/lib/editor/session.ts:21` üzerinden | Yüklü; kaldırılamaz | **12.5 KB gzip** (ölçülen) — **kazanç yok**, markdown ayrıştırma için zorunlu | — |
| 4 | `@tauri-apps/api/window` eager import (c) | `src/lib/app/theme.ts:74` | **Zaten çözüldü**: `@tauri-apps/api/event` → `listen(TauriEvent.WINDOW_THEME_CHANGED)` dinamik import; `window-*.js` chunk'ı bu derlemede üretilmedi | 3.1 KB **zaten kazanıldı** | — |
| 5 | `QuickOpenPanel` eager (c) | `src/App.svelte:102-106` (`loadQuickOpenPanel` → `import()`), kullanım `:291-295` | **Zaten çözüldü**: ayrı `QuickOpenPanel-j8H22DeS.js` chunk'ı (2.74 KB), statik zincirde değil | 2.74 KB **zaten kazanıldı** | — |
| 6 | `markdown-it` + `DOMPurify` (b) | `src/lib/preview/markdown.ts:20-21` | Zaten tembel (`PreviewPane` dinamik girişi) | Ek kazanç yok (54.0 KB zaten ilk boya yolunda değil) | — |
| 7 | highlight.js çekirdek + 9 dil (b) | `src/lib/preview/highlight.ts:13, 21-30` | Zaten dil-başına `import()`; yalnız gereken dil yükleniyor | Ek kazanç yok (yalnız etkileşimde) | — |
| 8 | Kullanılmayan bağımlılık bildirimleri (a) | `package.json`: `codemirror`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs` — `src/` içinde import yok | Paketlenmiyor | **0 KB gzip** (yalnız kurulum/paket boyutu) | Düşük, ama bu görevin kazancı yok |
| 9 | Çift paketlenmiş kopya (d) | — | Bulunamadı (`@codemirror/*`, `@lezer/*` tek sürüm) | 0 KB | — |

**Düzeltme:** Önceki notta "kullanılmayan" sayılan `@codemirror/autocomplete`
aslında kullanılmıyor değil — `@codemirror/lang-markdown`'ın zorunlu
bağımlılığı olarak `EditorPane` chunk'ına giriyor (bkz. madde 1). `src/`
içinde doğrudan import yok, bu yüzden "doğrudan import yok" ≠ "pakette yok".

### 2.1. Modül bazlı doğrulanmış ölçüm (tahmin değil)

Aynı `dist/` çıktısı, geçici bir rolldown `generateBundle` plugin'i ile modül
modül ölçüldü (`.temp_files/module-sizes.json`, `.temp_files/analyze.vite.config.ts`).
`EditorPane-DjgCoAx5.js` için rendered→gzip oranı **0.2113** (900.6 KB ham →
190.3 KB gzip). Chunk katkısı = grup rendered baytı × 0.2113:

| Grup | Modüller | Rendered | Tahmini chunk gzip |
| --- | --- | --- | --- |
| Madde 1 — HTML/CSS/JS dil yığını | `lang-html` 21.5 + `@lezer/html` 19.7 + `lang-css` 14.5 + `@lezer/css` 19.3 + `lang-javascript` 10.8 + `@lezer/javascript` 79.3 KB | 165.0 KB | **34.9 KB** |
| Madde 2 — arama | `@codemirror/search` | 34.3 KB | **7.2 KB** |
| Madde 1'in tamamlayıcısı — otomatik tamamlama | `@codemirror/autocomplete` | 13.4 KB | **2.8 KB** |
| `lang-markdown` kabuğu | `@codemirror/lang-markdown` | 15.2 KB | 3.2 KB |
| `@lezer/markdown` çekirdeği | `@lezer/markdown` | 59.0 KB | 12.5 KB (kazanç yok) |

Madde 1 + otomatik tamamlama birlikte **~37.7 KB gzip** eder; bütçedeki
9.8 KB headroom'un çok üstünde. Madde 2 tek başına **~7.2 KB** ile headroom'un
büyük kısmını kapatır (7.2 < 9.8 olduğu için bütçeyi tek başına aşmaz).

### En yüksek kazanç/düşük risk sıralaması (bu doğrulamaya göre)

1. **Madde 1** — en büyük tekil kazanç (~20–30 KB gerçekçi), fakat davranış
   değişikliği içerdiği için "düşük risk" değil.
2. **Madde 2** — ~8–11 KB, orta risk.
3. Düşük riskli maddeler (4 ve 5) **hâlihazırda uygulanmış**; listede kalan
   düşük riskli ve kazançlı bir madde yok.

## 3. Doğrulama

```
node node_modules/vite/bin/vite.js build   → exit 0, 474 ms, uyarı: chunk >500 kB (bilgi)
node scripts/measure-initial-gzip.mjs      → toplam 37.16 KB gzip (3 chunk)
node scripts/check-bundle-budget.mjs       → 37.2 / 250, 310.2 / 320, 54.0 / 160; exit 0
```

Tekrar üretilebilirlik: yeniden derlemede chunk hash'leri aynı kaldı
(`index-mGYZU4KZ.js`, `toast.svelte-jwbK9xZP.js`, `rolldown-runtime-XKyaHtl9.js`,
`EditorPane-DjgCoAx5.js`, `PreviewPane-CX1FLIN3.js`), dolayısıyla §1'deki
sayılar aynı build çıktısının sayılarıdır. Vite'ın kendi raporu gzip'i
varsayılan seviyeyle verir (`index` 20.85 kB); §1'deki değerler `zlib` seviye 9
ile ölçülür (`index` 20.18 kB) — bütçe kapısı da seviye 9 kullanır.

Derleme uyarıları (kaynak değişikliği gerektirmez, bilgi):
`[INEFFECTIVE_DYNAMIC_IMPORT] @tauri-apps/api/event` — `theme.ts` dinamik
import ediyor ama `src/lib/ipc/events.ts` ve `@tauri-apps/plugin-store`
statik import ediyor; modül zaten giriş chunk'ında, ek chunk oluşmuyor.

## 4. Yorum

- Statik ilk boya yolu **40.69 KB gzip**'tir; ağır JS yoktur.
- `310.2 KB` rakamı "ilk boya" değil, "ilk sekmede hemen açılan editör +
  önizleme dahil ulaşılabilir tüm chunk'lar" tanımıdır. İkisi karıştırılmamalı.
- Bütçeye göre headroom **9.8 KB** (320 − 310.2). Madde 2 (~7.2 KB) tek
  başına bu boşluğu kapatabilir; madde 1 (~34.9 KB) daha büyük ama davranış
  riski taşır ve tek başına bütçeyi rahatlatmaktan çok aşar.

## 5. Bilinen sınırlar

- Kazanç tahminleri paket `dist` dosyalarının bağımsız gzip boyutlarından
  türetilmiştir; minify + tree-shaking sonrası gerçek katkı daha düşüktür.
  Kesin değer ancak müdahale uygulanıp yeniden derlenerek ölçülür. §2.1'deki
  sayılar modül bazlı rendered baytından ölçülen oranla türetilmiştir, yine
  de üst sınır sayılmalıdır (kaldırılan kodun paylaşılan sözlük etkisi düşer).
- Sayılar tek makinede, tek derlemede alındı; Vite/rolldown sürümü veya
  bağımlılık ağacı değişince kayar.
- `measure-initial-gzip.mjs` yalnız JS statik zincirini sayar; CSS ve HTML
  ayrıca ölçülüp §1'de toplandı.

## 6. Bağımsız yeniden doğrulama (temiz `dist/` üzerinde)

Belgedeki sayılar, `dist/` silinip yeniden derlenerek bağımsız olarak tekrar
ölçüldü. Chunk hash'leri birebir aynı çıktı (`index-BYat3cGs.js`,
`toast.svelte-jwbK9xZP.js`, `rolldown-runtime-XKyaHtl9.js`,
`EditorPane-sbp9frCq.js`, `PreviewPane-Do86TpGp.js`), dolayısıyla §1 ve §2.1
değerleri bu derleme için de geçerli.

```
node node_modules/vite/bin/vite.js build          → exit 0, "built in 513ms", 253 modül (bilgi: >500 kB chunk uyarısı)
node scripts/measure-initial-gzip.mjs             → 3 chunk, raw 103.27 KB, gzip 37.16 KB
node scripts/check-bundle-budget.mjs              → 37.2/250, 310.2/320, 54.0/160; exit 0
zlib level-9 (index.html + index-*.css)           → 324 B + 3 288 B; ilk boya toplamı 41 668 B = 40.69 KB
```

Bağımlılık zinciri `package.json` üzerinden doğrulandı (madde 1'in kaynağı):

| Paket | Sürüm | Bağımlılıkları |
| --- | --- | --- |
| `@codemirror/lang-markdown` | 6.5.2 | `@codemirror/lang-html`, `@codemirror/autocomplete`, `@lezer/markdown` |
| `@codemirror/lang-html` | 6.4.12 | `@codemirror/lang-css`, `@codemirror/lang-javascript`, `@lezer/html`, `@lezer/css` |
| `@codemirror/lang-javascript` | 6.2.5 | `@lezer/javascript`, `@codemirror/lint` |
| `@codemirror/search` | 6.7.2 | `@codemirror/state`, `@codemirror/view`, `crelt` |
| `@lezer/markdown` | 1.8.1 | `@lezer/common`, `@lezer/highlight` |

`node_modules/@codemirror/lang-markdown/dist/index.js` `html` ve
`htmlCompletionSource`'ı **koşulsuz** import eder; bu yüzden HTML/CSS/JS dil
yığını (madde 1) `markdown()` kullanıldığı sürece `EditorPane` chunk'ındadır.
`dist/.vite/manifest.json` doğrulaması: giriş chunk'ı yalnız
`_rolldown-runtime` + `_toast.svelte` statik import eder (`QuickOpenPanel`,
`ConflictHost`, `EditorPane` dinamik), `EditorPane` ise yalnız `PreviewPane`'i
dinamik import eder — yani §1'deki iki ayrı tanım (37.16 KB statik zincir /
310.7 KB ilk sekmede ulaşılabilir toplam) kaynakta da bu şekilde ayrışıyor.
