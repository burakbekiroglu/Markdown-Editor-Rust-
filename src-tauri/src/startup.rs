//! Açılış sırasında oluşan, uygulamayı durdurmayan hataların kullanıcıya
//! taşınması.
//!
//! Bazı hatalar pencere açılmadan önce oluşur (bozuk oturum dosyası, oturum
//! dizininin bulunamaması). Bunlar uygulamayı başlatmayı engellemez, ama
//! kullanıcının bilmesi gereken gerçek hatalardır: yalnızca konsola yazmak
//! Windows'ta görünmez bir sessiz başarısızlık olur.
//!
//! Tauri olayı burada işe yaramaz: hata oluştuğunda webview henüz dinlemiyor.
//! Bu yüzden hatalar [`StartupWarnings`] içinde biriktirilir ve frontend
//! hazır olduğunda [`take_startup_warnings`] komutuyla **bir kez** çekilir.
//! Çekilen liste boşaltılır; aynı uyarı iki kez gösterilmez.

use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::State;

use crate::error::{AppError, AppResult};

/// Açılış uyarılarının süreç ömrü boyunca tutulduğu kuyruk.
///
/// Uyarılar küçük ve azdır; bu yüzden kuyruk sabit kapasiteli değil, tekilleme
/// yapan bir listedir.
#[derive(Debug, Default)]
pub struct StartupWarnings {
    warnings: Mutex<Vec<AppError>>,
}

impl StartupWarnings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kuyruğa bir uyarı ekler; aynı hata zaten varsa yinelenmez.
    ///
    /// Kilit zehirlenmiş olsa bile (başka bir iş parçacığı panic'ledi) içerik
    /// kullanılabilir durumdadır; uyarıyı kaybetmek yerine içeriği alırız.
    pub fn record(&self, error: AppError) {
        let mut warnings = self.lock();
        if !warnings.contains(&error) {
            warnings.push(error);
        }
    }

    /// Birikmiş uyarıları döndürür ve kuyruğu boşaltır.
    ///
    /// Boşaltma sayesinde her uyarı kullanıcıya bir kez gösterilir; frontend
    /// yeniden yüklenirse gösterilecek bir şey kalmaz.
    pub fn take(&self) -> Vec<AppError> {
        let mut warnings = self.lock();
        std::mem::take(&mut *warnings)
    }

    fn lock(&self) -> MutexGuard<'_, Vec<AppError>> {
        self.warnings.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Açılış uyarılarını teslim eder; her çağrı kuyruğu boşaltır.
///
/// Frontend bu komutu ilk boyamadan sonra bir kez çağırır ve dönen her uyarıyı
/// tipli hata olarak (`{ code, message }`) toast ile gösterir.
#[tauri::command]
pub fn take_startup_warnings(state: State<'_, StartupWarnings>) -> AppResult<Vec<AppError>> {
    Ok(state.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppErrorCode;

    #[test]
    fn warnings_are_delivered_once_and_then_drained() {
        let state = StartupWarnings::new();
        state.record(AppError::internal("oturum dosyası kurtarılamadı"));

        let first = state.take();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].code(), AppErrorCode::Internal);
        assert_eq!(first[0].detail(), "oturum dosyası kurtarılamadı");
        // Kuyruk boşaltıldı: uyarı ikinci kez gösterilmez.
        assert!(state.take().is_empty());
    }

    #[test]
    fn the_same_warning_is_recorded_only_once() {
        let state = StartupWarnings::new();
        state.record(AppError::internal("aynı hata"));
        state.record(AppError::internal("aynı hata"));
        state.record(AppError::internal("başka hata"));

        let warnings = state.take();
        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[0].detail(), "aynı hata");
        assert_eq!(warnings[1].detail(), "başka hata");
    }

    #[test]
    fn an_empty_queue_serialises_as_an_empty_list() {
        let state = StartupWarnings::new();

        let value = serde_json::to_value(state.take()).expect("serialize warnings");
        assert_eq!(value, serde_json::json!([]));
    }

    #[test]
    fn warnings_serialise_with_their_typed_code_and_message() {
        let state = StartupWarnings::new();
        state.record(AppError::save_failed("oturum dosyası taşınamadı"));

        let value = serde_json::to_value(state.take()).expect("serialize warnings");
        assert_eq!(value[0]["code"], "SaveFailed");
        assert_eq!(value[0]["message"], "oturum dosyası taşınamadı");
    }
}
