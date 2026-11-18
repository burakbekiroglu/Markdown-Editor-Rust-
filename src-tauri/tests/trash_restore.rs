//! Windows Geri Dönüşüm Kutusu geri yükleme doğrulaması.
//!
//! Kart kriteri silmenin geri alınabilir olduğunu, yani öğenin gerçek Geri
//! Dönüşüm Kutusu'ndan içeriği bozulmadan geri yüklenebildiğini ister. Bu test
//! kullanıcının gerçek Geri Dönüşüm Kutusu'nu kullandığı için varsayılan olarak
//! çalışmaz; elle, açıkça isteyerek çalıştırılır:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test trash_restore -- --ignored --nocapture
//! ```
//!
//! Test yalnızca kendi oluşturduğu öğeyi geri yükler (`restore_all` süzülmüş
//! tek öğe alır), başka hiçbir çöp öğesine dokunmaz.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_lib::fs_ops::delete_entry_at;
use tempfile::TempDir;
use trash::os_limited::{list, restore_all};
use trash::TrashItem;

const CONTENT: &str = "onaylı içerik — geri yükleme sonrası bozulmamalı";

fn root_of(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical root")
}

/// Windows yolları büyük/küçük harf duyarsızdır ve `canonicalize` `\\?\`
/// önekini ekler; çöp öğesinin kaydettiği özgün konum bu öneki taşımaz.
fn same_path(left: &Path, right: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    }
    normalized(left) == normalized(right)
}

#[test]
#[ignore = "elle doğrulama: gerçek Windows Geri Dönüşüm Kutusu'nu kullanır (--ignored ile çalıştırın)"]
fn deleted_entry_can_be_restored_from_the_recycle_bin() {
    let dir = TempDir::new().expect("temp workspace");
    let root = root_of(&dir);
    let file = root.join("kurtarilacak.md");
    fs::write(&file, CONTENT).expect("fixture");

    delete_entry_at(&root, "kurtarilacak.md").expect("delete to recycle bin");
    assert!(
        !file.exists(),
        "silinen öğe çalışma alanından kalkmış olmalı"
    );

    let item: TrashItem = list()
        .expect("recycle bin listelenemedi")
        .into_iter()
        .find(|candidate| same_path(&candidate.original_path(), &file))
        .expect("silinen öğe Geri Dönüşüm Kutusu'nda bulunamadı");

    restore_all([item]).expect("geri yükleme başarısız");

    assert!(file.is_file(), "öğe özgün konumuna geri gelmeli");
    assert_eq!(
        fs::read_to_string(&file).expect("restored file"),
        CONTENT,
        "geri yüklenen içerik bozulmamalı"
    );
}
