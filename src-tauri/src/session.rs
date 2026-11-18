//! Oturum deposunun bozulma koruması.
//!
//! Oturum `tauri-plugin-store` ile app-data dizinindeki `session.json`
//! dosyasında JSON olarak tutulur. Plugin, ayrıştıramadığı bir dosyayı
//! yüklemeyi reddeder; bu dosya yerinde bırakılırsa her açılışta oturum
//! geri yüklemesi başarısız olur ve kayıt hiç çalışmaz. Bu modül, webview
//! plugin'ten yükleme istemeden **önce** çalışır: geçersiz dosyayı
//! `session.json.corrupt` olarak kenara taşır, böylece uygulama her zaman
//! temiz bir oturumla açılır ve yeni oturum yazılabilir.
//!
//! Doğrulama yalnızca taşıma katmanını kapsar: geçerli JSON ama yanlış şema
//! frontend'de (`src/lib/session/schema.ts::parseSession`) reddedilir.
//! Burada amaç, plugin'in hiç yükleyemediği dosyayı kurtarmaktır.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::fs::read::read_bounded;

/// App-data dizini içindeki depo dosyası adı.
pub const SESSION_FILE_NAME: &str = "session.json";

/// Bozuk dosyanın taşındığı ad: `session.json.corrupt`.
pub const QUARANTINE_SUFFIX: &str = "corrupt";

/// Kabul edilen en büyük oturum belgesi (1 MiB). Binlerce sekmelik bir oturum
/// bile bunun çok altındadır; üstü bozulma kabul edilir.
pub const MAX_SESSION_BYTES: usize = 1_048_576;

/// `directory` içindeki oturum dosyasının yolu.
pub fn session_file_in(directory: &Path) -> PathBuf {
    directory.join(SESSION_FILE_NAME)
}

/// Karantina dosyasının yolu; uzantı korunur (`session.json.corrupt`).
fn quarantine_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(QUARANTINE_SUFFIX);
    path.with_file_name(name)
}

/// Plugin'in yükleyebileceği bir dosya mı? UTF-8 + geçerli JSON + boyut sınırı.
fn is_loadable_store(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_SESSION_BYTES && serde_json::from_slice::<serde_json::Value>(bytes).is_ok()
}

/// Bozuk oturum dosyasını kenara taşır; taşındıysa `true` döner.
///
/// Dosya yoksa `false` döner (ilk çalıştırma normaldir). Okuma hatası gerçek
/// bir hata olarak yükselir; yalnızca "bozuk içerik" kurtarılır.
pub fn quarantine_corrupt_store(path: &Path) -> AppResult<bool> {
    // Okuma kendisi sınırlı: depo dosyası sınırdan büyükse zaten yüklenemez,
    // tam boyutunu belleğe almadan karantina yolu yeterli.
    let bytes = match read_bounded(path, MAX_SESSION_BYTES as u64) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::from(error)),
    };
    if bytes.len() <= MAX_SESSION_BYTES && is_loadable_store(&bytes) {
        return Ok(false);
    }

    let target = quarantine_path(path);
    // Windows'ta var olan hedefin üzerine rename yapılamaz; önceki karantina
    // yeni bozulmadan sonra işe yaramaz, bu yüzden değiştirilir.
    match fs::remove_file(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(AppError::from(error)),
    }
    fs::rename(path, &target)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_missing_store_is_not_an_error() {
        let dir = TempDir::new().expect("temp dir");
        let path = session_file_in(dir.path());

        assert!(!quarantine_corrupt_store(&path).expect("read"));
    }

    #[test]
    fn a_valid_store_is_left_in_place() {
        let dir = TempDir::new().expect("temp dir");
        let path = session_file_in(dir.path());
        let contents = r#"{"session":{"version":1,"root":"C:/notlar","tabs":[]}}"#;
        fs::write(&path, contents).expect("write");

        assert!(!quarantine_corrupt_store(&path).expect("check"));
        assert_eq!(fs::read_to_string(&path).expect("read"), contents);
        assert!(!quarantine_path(&path).exists());
    }

    #[test]
    fn malformed_json_is_quarantined_so_the_store_can_load() {
        let dir = TempDir::new().expect("temp dir");
        let path = session_file_in(dir.path());
        fs::write(&path, r#"{"session":{"version":1"#).expect("write");

        assert!(quarantine_corrupt_store(&path).expect("check"));
        assert!(!path.exists(), "bozuk dosya yerinde kalmamalı");
        let target = quarantine_path(&path);
        assert_eq!(
            target.file_name().and_then(|name| name.to_str()),
            Some("session.json.corrupt")
        );
        assert!(target.exists());
    }

    #[test]
    fn invalid_utf8_is_quarantined() {
        let dir = TempDir::new().expect("temp dir");
        let path = session_file_in(dir.path());
        fs::write(&path, [0xff, 0xfe, 0xfd]).expect("write bytes");

        assert!(quarantine_corrupt_store(&path).expect("check"));
        assert!(!path.exists());
    }

    #[test]
    fn an_oversized_store_is_quarantined() {
        let dir = TempDir::new().expect("temp dir");
        let path = session_file_in(dir.path());
        let oversized = format!("\"{}\"", "x".repeat(MAX_SESSION_BYTES));
        fs::write(&path, oversized).expect("write");

        assert!(quarantine_corrupt_store(&path).expect("check"));
        assert!(!path.exists());
    }

    #[test]
    fn a_read_failure_is_a_typed_error_not_a_silent_pass() {
        let dir = TempDir::new().expect("temp dir");
        // Depo yolu bir klasör: içerik okunamaz. Bu "bozuk dosya" değil,
        // kurtarılamayan gerçek bir hatadır ve yutulmadan yükselmelidir.
        let path = session_file_in(dir.path());
        fs::create_dir(&path).expect("create dir");

        let error = quarantine_corrupt_store(&path).expect_err("read must fail");
        assert!(!error.detail().is_empty(), "{error}");
        assert!(
            matches!(
                error.code(),
                crate::error::AppErrorCode::PermissionDenied | crate::error::AppErrorCode::Internal
            ),
            "{error:?}"
        );
        // Klasör yerinde kalır: hata bildirildi, hiçbir şey taşınmadı.
        assert!(path.exists());
    }
}
