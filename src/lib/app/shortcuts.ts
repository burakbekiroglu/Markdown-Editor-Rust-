/**
 * Merkezi klavye kısayolu katmanı.
 *
 * Tek bir `window` `keydown` dinleyicisi tuşları **komut kimliklerine** çevirir
 * ve kayıtlı işleyiciye yönlendirir. CodeMirror keymap'inde tekrar eden
 * `Mod-s` / `Mod-f` bağları kaldırıldığı için aynı tuş iki kez çalışmaz.
 *
 * İşleyiciler bileşenler tarafından kaydedilir (`save`, `bold`, `find`
 * `EditorPane`; `close-tab` `TabBar`; `quick-open` `App`). Kayıt yoksa tuş
 * yine de `preventDefault` ile yutulur: WebView'da Ctrl+P yazdırma, Ctrl+S
 * kaydetme iletişim kutusu gibi tarayıcı varsayılanları açılmaz.
 */

/** Kısayol katmanının yönlendirdiği komutlar. */
export type CommandId = 'save' | 'bold' | 'close-tab' | 'find' | 'quick-open';

/** İşleyici `true` dönerse komut gerçekten işlendi sayılır. */
export type CommandHandler = () => boolean;

const KEY_COMMANDS: Readonly<Record<string, CommandId>> = {
  s: 'save',
  b: 'bold',
  w: 'close-tab',
  f: 'find',
  p: 'quick-open',
};

/** Kısayol eşleştirmesinin ihtiyaç duyduğu `KeyboardEvent` alanları. */
export interface ShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

/** Komut kimliği → tek işleyici. Son kayıt öncekini geçersiz kılar. */
export class CommandRegistry {
  #handlers = new Map<CommandId, CommandHandler>();

  /** İşleyiciyi kaydeder; dönen fonksiyon kaydı yalnızca hâlâ sahibiyse siler. */
  register(id: CommandId, handler: CommandHandler): () => void {
    this.#handlers.set(id, handler);
    return () => {
      if (this.#handlers.get(id) === handler) this.#handlers.delete(id);
    };
  }

  /** İşleyici varsa çalıştırır; işlendi bilgisini döner. */
  run(id: CommandId): boolean {
    const handler = this.#handlers.get(id);
    return handler === undefined ? false : handler();
  }

  has(id: CommandId): boolean {
    return this.#handlers.has(id);
  }
}

export const commands = new CommandRegistry();

/**
 * Metin girişi alanı mı? CodeMirror'ın `contenteditable` yüzeyi **hariç**
 * tutulur; editör içinde Ctrl+B/Ctrl+F çalışmaya devam eder.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as Partial<HTMLElement>;
  if (typeof element.closest !== 'function') return false;
  if (element.closest('.cm-editor') !== null) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Olayı komut kimliğine çevirir; kısayol değilse `null`.
 *
 * Ctrl (Windows/Linux) ve Cmd (macOS) eşdeğerdir. Shift/Alt ile birleşimler
 * ve zaten işlenmiş olaylar yok sayılır. Metin alanında yalnızca imleç
 * biçimlendirme ve arama kısayolları bastırılır; kaydetme/kapatma/geçiş
 * çalışmaya devam eder.
 */
export function shortcutFor(event: ShortcutEvent): CommandId | null {
  if (event.altKey === true || event.shiftKey === true) return null;
  if (event.defaultPrevented === true) return null;
  if (event.ctrlKey !== true && event.metaKey !== true) return null;

  const id = KEY_COMMANDS[event.key.toLowerCase()];
  if (id === undefined) return null;
  if ((id === 'bold' || id === 'find') && isTextEntryTarget(event.target ?? null)) {
    return null;
  }
  return id;
}

/**
 * Kısayol dinleyicisini kurar. Dönen fonksiyon dinleyiciyi kaldırır.
 *
 * Eşleşen tuş için varsayılan davranış her zaman engellenir (tarayıcı
 * yazdırma/kaydetme pencereleri açılmasın); işleyici yoksa yalnızca yutulur.
 */
export function installShortcuts(
  runCommand: (id: CommandId) => boolean = (id) => commands.run(id),
  target: Window | null = typeof window === 'undefined' ? null : window,
): () => void {
  if (target === null) return () => undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    const id = shortcutFor(event);
    if (id === null) return;
    event.preventDefault();
    runCommand(id);
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
