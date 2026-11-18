//! Açılış performansı ölçümü.
//!
//! Süreç başlangıcı [`mark_process_start`] ile bir `Instant` olarak kaydedilir.
//! Frontend ilk kareyi çizdiğinde `report_first_paint` komutunu çağırır; bu
//! komut süreç başından geçen süreyi hesaplar, loglar ve milisaniye olarak
//! döndürür.
//!
//! Release derlemesi Windows'ta GUI alt sistemiyle (`windows_subsystem =
//! "windows"`) çalıştığı için `eprintln!` çıktısı konsola düşmez; ölçüm
//! koşucusu değeri komutun dönüşünden okur. Log satırı yine de bir konsoldan
//! başlatılan debug çalıştırmalarında görünür.

use std::sync::OnceLock;
use std::time::Instant;

/// Süreç başlangıcı; yalnızca bir kez kurulur.
static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Süreç başlangıcını kaydeder. `run()` içinde, ilk pencere kurulmadan önce
/// çağrılır. Birden fazla çağrı ilk değeri korur.
pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
}

/// Süreç başlangıcından bu yana geçen süre (ms). Başlangıç kaydedilmemişse 0.
pub fn since_start_ms() -> f64 {
    PROCESS_START
        .get()
        .map_or(0.0, |start| start.elapsed().as_secs_f64() * 1000.0)
}

/// Frontend'in ilk boya bildirimi.
///
/// `page_ms` frontend'in `performance.now()` değeridir (yalnızca log bağlamı
/// için). Dönüş değeri Rust `Instant` sayacından okunan süreç süresidir; ölçüm
/// koşucusu bu değeri kullanır.
#[tauri::command]
pub fn report_first_paint(page_ms: f64) -> f64 {
    let process_ms = since_start_ms();
    eprintln!("[perf] first-paint: page={page_ms:.1} ms process={process_ms:.1} ms");
    process_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_start_is_recorded_once_and_time_advances() {
        mark_process_start();
        let first = since_start_ms();
        mark_process_start();
        let second = since_start_ms();

        assert!(first >= 0.0, "geçen süre negatif olamaz");
        assert!(
            second >= first,
            "ikinci okuma ilk okumadan küçük olamaz: {first} -> {second}"
        );
    }
}
