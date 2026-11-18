/**
 * Oturum yazımının debounce'lu, sıralı taşıyıcısı.
 *
 * Her değişiklikte diske yazmak istemeyiz: imleç ve scroll neredeyse her karede
 * değişir. [`SessionPersister`] gelen anlık görüntüleri 500 ms boyunca
 * birleştirir ve yalnızca son hâli yazar. Yazmalar zincirlenir; yavaş bir yazma
 * sürerken yeni bir yazma başlatılırsa dosya sırası karışmaz.
 *
 * Atomiklik (geçici dosya + rename) Rust tarafındadır; bu modül yalnızca
 * "kaç kez ve hangi sırayla" sorusunu yanıtlar. Taşıyıcı enjekte edilebilir,
 * böylece debounce davranışı gerçek dosya sistemi olmadan sınanır.
 */
import { serializeSession, type SessionData } from './schema';

export const SAVE_DEBOUNCE_MS = 500;

/** JSON belgesini kalıcı hâle getirir (üretimde `ipc.ts::saveSession`, plugin-store). */
export type SessionWriter = (json: string) => Promise<void>;

export interface SessionPersisterOptions {
  delayMs?: number;
  onError?: (error: unknown) => void;
}

export class SessionPersister {
  #writer: SessionWriter;
  #delayMs: number;
  #onError: ((error: unknown) => void) | null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: string | null = null;
  /** Yazmalar bu zincire eklenir; hiçbiri diğerini geçmez. */
  #writing: Promise<void> = Promise.resolve();

  constructor(writer: SessionWriter, options: SessionPersisterOptions = {}) {
    this.#writer = writer;
    this.#delayMs = options.delayMs ?? SAVE_DEBOUNCE_MS;
    this.#onError = options.onError ?? null;
  }

  /** Anlık görüntüyü sıraya alır; pencere içindeki önceki çağrıları ezer. */
  schedule(data: SessionData): void {
    this.#pending = serializeSession(data);
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#commit();
    }, this.#delayMs);
  }

  /** Bekleyen yazmayı beklemeden gönderir (pencere kapanırken kullanılır). */
  flush(): Promise<void> {
    this.#clearTimer();
    return this.#commit();
  }

  /** Bekleyen zamanlayıcıyı bırakır; sırada yazma varsa kaybolmaz. */
  cancel(): void {
    this.#clearTimer();
    this.#pending = null;
  }

  /** Testler ve bileşen sökümü için: zamanlayıcıyı bırakır, zinciri bekletir. */
  dispose(): void {
    this.#clearTimer();
    this.#pending = null;
  }

  #commit(): Promise<void> {
    const json = this.#pending;
    this.#pending = null;
    if (json === null) return this.#writing;
    this.#writing = this.#writing.then(async () => {
      try {
        await this.#writer(json);
      } catch (error) {
        this.#onError?.(error);
      }
    });
    return this.#writing;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
