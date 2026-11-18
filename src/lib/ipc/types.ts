/**
 * Tauri komut yüzeyinin tek kaynak tip tanımı.
 *
 * Rust tarafındaki `AppErrorCode` (`src-tauri/src/error.rs`) ile buradaki
 * `APP_ERROR_CODES` birebir aynı dizeleri taşır; iki dosya birlikte
 * değiştirilmelidir. Rust tarafındaki `error.rs` testleri de aynı listeyi
 * doğrular.
 *
 * Komut argümanları Tauri v2 varsayılanı gereği camelCase'tir: Rust
 * `parent_rel` -> `parentRel`, `new_name` -> `newName`.
 */

/** Rust `AppErrorCode` enum'unun serde (PascalCase) karşılığı. */
export const APP_ERROR_CODES = [
  'InvalidPath',
  'PathEscape',
  'SymlinkEscape',
  'NotFound',
  'PermissionDenied',
  'BinaryFile',
  'OpenUnsupported',
  'TooLarge',
  'ConflictDetected',
  'SaveFailed',
  'WatcherFailed',
  'Internal',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** Çalışma zamanı doğrulaması için; `AppErrorCode` ile senkron kalır. */
export const APP_ERROR_CODE_SET: ReadonlySet<string> = new Set(APP_ERROR_CODES);

/**
 * Rust `AppError` serde temsili. Her komut reddi bu şekle normalize edilir;
 * `code` üzerinde switch edilir, `message` kullanıcıya/loga gider.
 */
export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
}

/** `fs_ops.rs::EntryInfo` / `workspace_commands.rs::DirEntryInfo`. */
export interface EntryInfo {
  name: string;
  /** Çalışma köküne göreli yol; `/` ayırıcısı, kök `''`. */
  relativePath: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Bayt cinsinden boyut; klasörler için `0`. */
  size?: number;
  /** Unix epoch'tan itibaren milisaniye; bilinmiyorsa `null`. */
  modifiedMs?: number | null;
}

/** `fs/index.rs::IndexEntry`. */
export interface IndexEntry {
  name: string;
  relativePath: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
}

/** `fs/index.rs::IndexResult`. */
export interface IndexResult {
  root: string;
  entries: IndexEntry[];
  /** Girdi/derinlik sınırı veya okunamayan alt ağaç nedeniyle eksik. */
  truncated: boolean;
  skippedHidden: number;
  skippedLarge: number;
  skippedSymlinks: number;
  skippedUnreadable: number;
}

/** `fs/metadata.rs::FileMetadata`. */
export interface FileMetadata {
  name: string;
  relativePath: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  readOnly: boolean;
  size: number;
  modifiedMs: number | null;
  createdMs: number | null;
}

/** `workspace_commands.rs::WorkspaceInfo`. */
export interface WorkspaceInfo {
  /** Kanonik kök (Windows `\\?\` öneki olmadan). */
  root: string;
  /** Kök klasörün görünen adı. */
  name: string;
  /**
   * İzleyici başlatılamadıysa dönen, ölümcül olmayan hata.
   * Klasör yine de açılır; kullanıcıya toast ile bildirilir.
   */
  watcherError?: AppErrorPayload | null;
}

/** `fs/read.rs::DocumentText`. */
export interface DocumentText {
  /** UTF-8 decoded text; BOM stripped, binary/oversize rejected. */
  contents: string;
  /** Hash of the raw on-disk bytes; pass back as `expectedHash` on save. */
  hash: string;
}

/** `fs/write.rs::SaveResult`. */
export interface SaveResult {
  /** Hash of the exact bytes written; use as the next `expectedHash`. */
  hash: string;
}

/**
 * Komut imzaları: anahtar Rust komut adı; `args` Tauri'ye gönderilen nesne,
 * `result` başarılı çözümlemenin tipi (Rust `Result` hatası ayrıca
 * `AppError` olarak reddedilir).
 */
export interface CommandSignatures {
  /** Yerel klasör seçici; kullanıcı iptal ederse `null`. */
  open_workspace: { args: Record<string, never>; result: WorkspaceInfo | null };
  /** Kayıtlı mutlak yolu (oturum geri yükleme) dialog olmadan açar. */
  open_workspace_path: { args: { path: string }; result: WorkspaceInfo };
  /** Oturumdaki çalışma kökü; açık klasör yoksa `null`. */
  current_workspace: { args: Record<string, never>; result: WorkspaceInfo | null };
  /** Kökü serbest bırakır; kapanan kökü döndürür. */
  close_workspace: { args: Record<string, never>; result: WorkspaceInfo | null };
  /** `path` köke göreli; `''`/`undefined` kökü listeler. */
  list_workspace_dir: { args: { path?: string | null }; result: EntryInfo[] };
  /** Meta veri zengin dizin listesi; klasörler önce, ada göre. */
  fs_list_dir: { args: { path?: string | null }; result: EntryInfo[] };
  /** Özyinelemeli çalışma alanı indeksi; gizli/ignore/symlink atlanır. */
  fs_index: { args: { path?: string | null }; result: IndexResult };
  /** Tek öğe için meta veri; kök dışına çıkan yollar reddedilir. */
  fs_metadata: { args: { path: string }; result: FileMetadata };
  /** Ad uzantısızsa `.md` eklenir; var olan öğe asla ezilmez. */
  fs_create_file: { args: { parentRel?: string | null; name: string }; result: EntryInfo };
  fs_create_folder: { args: { parentRel?: string | null; name: string }; result: EntryInfo };
  fs_rename_entry: { args: { rel: string; newName: string }; result: EntryInfo };
  /** Öğeyi adını koruyarak `targetDirRel` klasörüne taşır; var olan hedef ezilmez. */
  fs_move: { args: { rel: string; targetDirRel?: string | null }; result: EntryInfo };
  /** Öğeyi Geri Dönüşüm Kutusu'na taşır. */
  fs_delete_entry: { args: { rel: string }; result: void };
  /**
   * Pencere açılmadan önce oluşan, uygulamayı durdurmayan hatalar
   * (bozuk oturum dosyası gibi). Her çağrı kuyruğu boşaltır.
   */
  take_startup_warnings: { args: Record<string, never>; result: AppErrorPayload[] };
  /** Atomik kaydetme; hata durumunda dosya değişmez. */
  fs_write_file_atomic: {
    args: { path: string; contents: string; expectedHash?: string | null };
    result: SaveResult;
  };
  /** Belgeyi UTF-8 metin olarak okur; ikili ve aşırı büyük dosyalar reddedilir. */
  fs_read_file: { args: { path: string }; result: string };
  /** Belgeyi metin + içerik hash'i olarak okur (kaydetme çakışma kontrolü). */
  fs_read_document: { args: { path: string }; result: DocumentText };
  /**
   * İlk boya anını Rust tarafına bildirir. Rust, süreç başından bu yana geçen
   * `Instant` süresini loglar ve milisaniye olarak döndürür.
   */
  report_first_paint: { args: { pageMs: number }; result: number };
  /**
   * Kapatma onayı verildikten sonra ana pencereyi Rust tarafında yok eder.
   * `destroy`/`close` webview'de ACL izni ister; uygulama komutları ACL'ye tabi
   * olmadığı için pencere yok etme yetkisi webview'e hiç verilmez. `destroy`
   * yeni bir `CloseRequested` üretmediğinden Rust'taki `prevent_close` ile
   * döngü oluşmaz.
   */
  app_close_window: { args: Record<string, never>; result: void };
}

export type CommandName = keyof CommandSignatures;
export type CommandArgs<K extends CommandName> = CommandSignatures[K]['args'];
export type CommandResult<K extends CommandName> = CommandSignatures[K]['result'];
