/**
 * Oturum kalıcılığının IPC yüzeyi.
 *
 * Oturum `tauri-plugin-store` ile app-data dizinindeki `session.json`
 * dosyasında **JSON nesnesi** olarak saklanır: dosyanın kökü
 * `{ "session": { "version": 1, ... } }` biçimindedir, yani sürüm alanı
 * belgenin içindedir. `loadSession` değeri tekrar JSON metnine çevirir;
 * böylece şema doğrulaması (`schema.ts::parseSession`) transport'tan
 * bağımsız kalır.
 *
 * Bozuk dosya uygulamayı kilitlemez: Rust `setup` sırasında plugin'in
 * yükleyemediği dosyayı `session.json.corrupt` olarak kenara taşır. Yine de
 * çalışma zamanında bir yükleme hatası olursa `loadSession` `null` döner ve
 * uygulama temiz bir oturumla açılır.
 *
 * `fileExists` geri yükleme sırasında "diskte var mı?" sorusunu metadata
 * komutuyla yanıtlar: içerik okumak yerine yalnızca varlık kontrolü yapılır.
 */
import { load as loadStore, type Store } from '@tauri-apps/plugin-store';

import { invokeCommand } from '../ipc/client';
import { isAppError } from '../ipc/errors';
import type { WorkspaceInfo } from '../ipc/types';

/** App-data dizini içindeki depo dosyası; plugin yolu oraya göre çözer. */
export const SESSION_STORE_PATH = 'session.json';

/** Depodaki oturum kaydının anahtarı. */
export const SESSION_STORE_KEY = 'session';

/**
 * Açılmış depo tek örnektir: plugin aynı dosyayı ikinci kez yüklemeyi
 * reddeder ve her `set` sonrası ayrı bir kayıt planlamak gereksizdir
 * (yazmalar `SessionPersister` tarafından zaten debounce edilir).
 */
let storePromise: Promise<Store> | null = null;

function openStore(): Promise<Store> {
  storePromise ??= loadStore(SESSION_STORE_PATH, { autoSave: false }).catch(
    (error: unknown) => {
      // Başarısız yükleme önbelleğe alınmaz: sonraki deneme (ör. karantinadan
      // sonraki çalıştırma) yeni bir yükleme başlatabilir.
      storePromise = null;
      throw error;
    },
  );
  return storePromise;
}

/**
 * Kalıcı oturum belgesi; hiç yazılmadıysa veya depo okunamıyorsa `null`.
 *
 * `null` "temiz başlangıç" demektir: çağıran varsayılan görünümle açılır.
 */
export async function loadSession(): Promise<string | null> {
  let store: Store;
  try {
    store = await openStore();
  } catch {
    return null;
  }
  try {
    const value = await store.get<unknown>(SESSION_STORE_KEY);
    return value === undefined || value === null ? null : JSON.stringify(value);
  } catch {
    // Okuma hatası da bozuk/erişilemez oturum sayılır; uygulama açılmaya devam eder.
    return null;
  }
}

/**
 * Oturum belgesini depoya yazar ve diske indirir.
 *
 * `contents` `serializeSession` çıktısıdır (geçerli JSON). Depoya nesne olarak
 * konur; böylece dosya okunabilir bir JSON belgesi olur. Hata yutulmaz:
 * çağıran (`SessionPersister`) kullanıcıya bildirir.
 */
export async function saveSession(contents: string): Promise<void> {
  const payload: unknown = JSON.parse(contents);
  const store = await openStore();
  await store.set(SESSION_STORE_KEY, payload);
  await store.save();
}

/**
 * Kayıtlı mutlak çalışma kökünü dialog göstermeden açar. Kök artık yoksa veya
 * erişilemiyorsa tipli `AppError` reddedilir; çağıran boş oturuma düşer.
 */
export function openWorkspacePath(path: string): Promise<WorkspaceInfo> {
  return invokeCommand('open_workspace_path', { path });
}

/**
 * Yol çalışma kökünde var mı? Yalnızca `NotFound` "yok" sayılır; diğer
 * hatalarda (izin, ikili dosya, boyut) sekme açılır ve gerçek hata editörde
 * görünür — yanlışlıkla "eksik dosya" damgası vurulmaz.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await invokeCommand('fs_metadata', { path });
    return true;
  } catch (error) {
    return !(isAppError(error) && error.code === 'NotFound');
  }
}
