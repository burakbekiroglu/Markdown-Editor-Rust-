/**
 * Editör performans işaretleri.
 *
 * Büyük belgelerde (>= 1 MB) sekme değişimi ve durum kurulumu gecikmeli olarak
 * ölçülebilsin diye iki kanal birden beslenir:
 *
 * - `performance.mark/measure`: DevTools zaman çizelgesinde `editor:*`
 *   adlarıyla görünür; ölçüm sonradan, iş bittikten sonra okunabilir.
 * - Küçük bir halka tamponu: işaretler çalışma zamanında sorgulanabilir
 *   (`readPerfEntries`), testler eşik kontrolünü buna dayandırır.
 *
 * Modül CodeMirror'a bağlı değildir; bu yüzden editör yüklenmeden de
 * kullanılabilir ve kendi başına test edilir.
 */

export interface PerfEntry {
  /** Ölçüm adı, örn. `state-swap`. */
  name: string;
  /** Milisaniye cinsinden süre. */
  durationMs: number;
  /** Ölçümün bittiği an (epoch ms). */
  at: number;
}

/** Zaman çizelgesinde çakışmayı önleyen ad alanı. */
export const PERF_PREFIX = 'editor';

/** Tamponda tutulan en fazla ölçüm; eski kayıtlar düşer. */
const HISTORY_LIMIT = 64;

const history: PerfEntry[] = [];

function clock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function timelineName(name: string): string {
  return `${PERF_PREFIX}:${name}`;
}

function timelineAvailable(): boolean {
  return (
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function' &&
    typeof performance.measure === 'function'
  );
}

/**
 * Zaman çizelgesine anlık işaret koyar. Gerçek bir iş yapmaz; süre ölçümü
 * `measureSync` içinde başlangıç/bitiş işaretleri arasında alınır.
 */
export function markPerf(name: string): void {
  if (!timelineAvailable()) return;
  try {
    performance.mark(timelineName(name));
  } catch {
    // Aynı ad yeniden işaretlenirse veya zaman çizelgesi kapalıysa ölçüm
    // yine de tampon üzerinden çalışır; editör davranışı etkilenmez.
  }
}

/** Eşik aşımı raporlanırken kullanılan sınır; testler de bunu okur. */
export const SLOW_SWAP_MS = 250;

/**
 * `run` çağrısını ölçer ve süresini tampona yazar. Süre her durumda kaydedilir
 * (hata fırlatan iş dahil), böylece başarısız bir swap da görünür olur.
 */
export function measurePerf<T>(name: string, run: () => T): T {
  const startedAt = clock();
  const startedWall = Date.now();
  markPerf(`${name}:start`);
  try {
    return run();
  } finally {
    const durationMs = clock() - startedAt;
    record({ name, durationMs, at: startedWall });
    if (timelineAvailable()) {
      try {
        performance.mark(timelineName(`${name}:end`));
        performance.measure(
          timelineName(name),
          timelineName(`${name}:start`),
          timelineName(`${name}:end`),
        );
      } catch {
        // Zaman çizelgesi reddederse halka tamponu tek kaynak olarak kalır.
      }
    }
  }
}

function record(entry: PerfEntry): void {
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

/** Kayıtlı ölçümlerin kopyası; çağıran koleksiyonu değiştiremez. */
export function readPerfEntries(): readonly PerfEntry[] {
  return [...history];
}

/** Belirli bir ölçümün son kaydı; yok ise `null`. */
export function lastPerfEntry(name: string): PerfEntry | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry !== undefined && entry.name === name) return entry;
  }
  return null;
}

/** Testler ve uzun oturumlar için tamponu boşaltır. */
export function resetPerfEntries(): void {
  history.length = 0;
}
