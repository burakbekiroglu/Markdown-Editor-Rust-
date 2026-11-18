/**
 * Tüm Tauri komut çağrılarının geçtiği tek sarmalayıcı.
 *
 * `invokeCommand` başarılı sonucu olduğu gibi döndürür; her reddi
 * `normalizeAppError` ile `AppError`'a çevirir. Böylece çağıranlar `unknown`
 * ile uğraşmaz ve `code` üzerinde tip güvenli switch yapabilir.
 *
 * Taşıyıcı (`InvokeTransport`) dışarıdan verilebilir: üretimde Tauri köprüsü,
 * testlerde sahte bir fonksiyon. Testler bu yüzden `@tauri-apps/api/core`
 * modülünü mock'lamak zorunda değildir; sarmalayıcının kendi davranışı
 * (argüman iletimi, hata normalizasyonu) doğrudan sınanır.
 */

import { invoke } from '@tauri-apps/api/core';

import { normalizeAppError } from './errors';
import type { CommandArgs, CommandName, CommandResult } from './types';

/**
 * Tauri `invoke` ile aynı imza. Sarmalayıcının tek dış bağımlılığı budur;
 * değiştirilebilir olması enjeksiyon noktasını oluşturur.
 */
export type InvokeTransport = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** Tip imzasını koruyan komut çağırıcı. */
export type InvokeCommand = <K extends CommandName>(
  command: K,
  args: CommandArgs<K>,
) => Promise<CommandResult<K>>;

/**
 * Verilen taşıyıcıya bağlı bir komut çağırıcı üretir.
 *
 * Her red — tipli `{ code, message }` gövdesi, düz metin, tanımsız — burada
 * `AppError`'a normalize edilir; hiçbir hata sessizce yutulmaz veya
 * kaybolmaz.
 */
export function createInvokeCommand(transport: InvokeTransport): InvokeCommand {
  return async function invokeCommand<K extends CommandName>(
    command: K,
    args: CommandArgs<K>,
  ): Promise<CommandResult<K>> {
    try {
      return await transport<CommandResult<K>>(command, args as Record<string, unknown>);
    } catch (error) {
      throw normalizeAppError(error);
    }
  };
}

/** Üretim taşıyıcısı: gerçek Tauri köprüsü. */
const tauriTransport: InvokeTransport = (command, args) => invoke(command, args);

/**
 * Uygulamanın kullandığı varsayılan çağırıcı. `@tauri-apps/api/core`
 * import'u bu dosyayla sınırlıdır; başka hiçbir modül `invoke`'u doğrudan
 * çağırmamalıdır.
 */
export const invokeCommand: InvokeCommand = createInvokeCommand(tauriTransport);
