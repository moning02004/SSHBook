//! 내 계정만 읽고 쓰는 파일·폴더 (macOS/Linux: 파일 0600, 폴더 0700).
//! Windows는 사용자 프로필 폴더의 기본 권한(본인만)을 그대로 쓴다.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

/// 폴더를 만들고(있으면 그대로) 내 계정만 들어갈 수 있게 한다.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_options() -> OpenOptions {
    let mut o = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o
}

/// 처음부터 0600으로 만들어 쓴다(이미 있던 파일도 0600으로 맞춘다).
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = private_options().write(true).create(true).truncate(true).open(path)?;
    fix_mode(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// 이어 쓰기용으로 연다(없으면 0600으로 만든다).
pub fn append_private(path: &Path) -> std::io::Result<File> {
    let f = private_options().create(true).append(true).open(path)?;
    fix_mode(path)?;
    Ok(f)
}

/// 예전 버전이 만든 파일(0644 등)도 0600으로 맞춘다.
pub fn fix_mode(_path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn files_and_dirs_are_private() {
        let dir = std::env::temp_dir()
            .join(format!("fsperm-{}", uuid::Uuid::new_v4()))
            .join("inner");
        private_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        let f = dir.join("a");
        std::fs::write(&f, b"old").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&f, b"new").unwrap();
        assert_eq!(mode(&f), 0o600);
        assert_eq!(std::fs::read(&f).unwrap(), b"new");
        let g = dir.join("b");
        drop(append_private(&g).unwrap());
        assert_eq!(mode(&g), 0o600);
    }
}
