//! 마스터 비밀번호 없이 쓰기.
//!
//! 끄면 보관함을 임의의 긴 비밀번호로 다시 암호화하고, 그 값을 보관함 옆 `vault.key`(내 계정만 읽기)에 둔다.
//! 다른 계정과 보관함 파일만 빠져나간 경우는 막지만, 내 계정으로 도는 프로그램은 둘 다 읽을 수 있다.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

pub fn key_path(vault: &Path) -> PathBuf {
    vault.with_extension("key")
}

pub fn is_on(vault: &Path) -> bool {
    key_path(vault).exists()
}

pub fn load(vault: &Path) -> Option<Zeroizing<String>> {
    let s = Zeroizing::new(std::fs::read_to_string(key_path(vault)).ok()?);
    let t = s.trim();
    (!t.is_empty()).then(|| Zeroizing::new(t.to_string()))
}

pub fn generate() -> Result<Zeroizing<String>, String> {
    let mut b = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut b[..]).map_err(|_| "난수를 만들지 못했습니다.".to_string())?;
    Ok(Zeroizing::new(B64.encode(&b[..])))
}

/// 임시 파일에 쓴 뒤 바꿔치기한다(0600).
pub fn save(vault: &Path, secret: &str) -> std::io::Result<()> {
    if let Some(dir) = vault.parent() {
        crate::fsperm::private_dir(dir)?;
    }
    let path = key_path(vault);
    let tmp = path.with_extension("key.tmp");
    crate::fsperm::write_private(&tmp, secret.as_bytes())?;
    std::fs::rename(&tmp, &path)
}

pub fn remove(vault: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(key_path(vault)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// 다른 보관함으로 바뀔 때: 남겨 둔 `.sshv.bak`을 열 수 있게 열쇠를 지우지 않고 옆으로 옮긴다.
pub fn retire(vault: &Path) {
    let p = key_path(vault);
    if p.exists() {
        let _ = std::fs::rename(&p, p.with_extension("key.bak"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_file_life_cycle() {
        let dir = std::env::temp_dir().join(format!("nopass-{}", uuid::Uuid::new_v4()));
        let vault = dir.join("vault.sshv");
        assert!(!is_on(&vault) && load(&vault).is_none());
        let s = generate().unwrap();
        assert!(s.len() >= 43);
        assert_ne!(*s, *generate().unwrap());
        save(&vault, &s).unwrap();
        assert!(is_on(&vault));
        assert_eq!(load(&vault).unwrap().as_str(), s.as_str());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(key_path(&vault)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        retire(&vault);
        assert!(!is_on(&vault) && dir.join("vault.key.bak").exists());
        save(&vault, &s).unwrap();
        remove(&vault).unwrap();
        remove(&vault).unwrap();
        assert!(!is_on(&vault));
    }
}
