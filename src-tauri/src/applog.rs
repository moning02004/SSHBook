//! 진단 로그: 연결 실패, 파일 전송 오류, 업데이트 오류처럼 원인을 찾을 때 필요한 것만 남긴다.
//! 비밀번호·키·화면 내용은 남기지 않는다. 앱 데이터 폴더의 logs/sshbook-app.log (내 계정만 읽기).
//! 1MB가 넘으면 .1로 넘기고 새로 쓴다(최대 2개 파일).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_LINE: usize = 2000;

pub fn init(logs_dir: PathBuf) {
    if crate::fsperm::private_dir(&logs_dir).is_ok() {
        *PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(logs_dir.join("sshbook-app.log"));
        info(&format!("앱 시작 · v{}", env!("CARGO_PKG_VERSION")));
    }
}

pub fn info(msg: &str) {
    write("INFO", msg);
}

pub fn warn(msg: &str) {
    write("WARN", msg);
}

pub fn write(level: &str, msg: &str) {
    let guard = PATH.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = guard.as_ref() else {
        return;
    };
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    let Ok(mut f) = crate::fsperm::append_private(path) else {
        return;
    };
    let line: String = msg.replace(['\r', '\n'], " ").chars().take(MAX_LINE).collect();
    let _ = writeln!(
        f,
        "[{}] {level} {line}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
}
