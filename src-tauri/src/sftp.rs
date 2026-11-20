//! 파일 주고받기 (SFTP). 열린 SSH 터미널과 같은 연결 위에 SFTP 채널을 하나 더 연다.
//! 처음 쓸 때 열고, 같은 터미널에서는 다시 쓴다.

use crate::ssh::Conn;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// 유닉스 시각(초)
    pub mtime: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// 서버가 정리해 준 절대 경로
    pub path: String,
    pub entries: Vec<Entry>,
}

fn e2s(what: &str, e: impl std::fmt::Display) -> String {
    format!("{what}: {e}")
}

pub async fn session(conn: &Conn) -> Result<Arc<SftpSession>, String> {
    let mut slot = conn.sftp.lock().await;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let ch = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| e2s("SFTP 채널을 열지 못했습니다", e))?;
    ch.request_subsystem(true, "sftp")
        .await
        .map_err(|e| e2s("서버가 SFTP를 지원하지 않습니다", e))?;
    let s = SftpSession::new(ch.into_stream())
        .await
        .map_err(|e| e2s("SFTP를 시작하지 못했습니다", e))?;
    s.set_timeout(30);
    let s = Arc::new(s);
    *slot = Some(s.clone());
    Ok(s)
}

/// 터미널 셸의 지금 폴더를 알아내는 스크립트(POSIX sh, 리눅스 /proc 기준).
///
/// 같은 SSH 연결의 채널들은 서버에서 같은 부모(sshd 세션 프로세스)의 자식이다.
/// 그 부모의 자식 중 터미널(pts/tty)에 붙은 프로세스가 우리 탭의 셸이므로 그 cwd를 읽는다.
/// 사용자의 로그인 셸이 fish 등이어도 돌도록 sh로 바꿔 실행한다(exec라서 부모가 그대로다).
const CWD_SCRIPT: &str = r#"exec sh -c 'me=$$; pp=$PPID; for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$me" ] && continue; s=$(cat "$d/stat" 2>/dev/null) || continue; s=${s##*) }; set -- $s; [ "$2" = "$pp" ] || continue; t=$(readlink "$d/fd/0" 2>/dev/null); case "$t" in /dev/pts/*|/dev/tty*) readlink "$d/cwd" && exit 0;; esac; done; exit 1'"#;

/// 터미널 셸의 지금 폴더. 알 수 없으면(리눅스가 아니거나 권한이 없으면) None.
pub async fn terminal_cwd(conn: &Conn) -> Result<Option<String>, String> {
    let mut ch = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| e2s("서버에 명령 채널을 열지 못했습니다", e))?;
    ch.exec(true, CWD_SCRIPT)
        .await
        .map_err(|e| e2s("지금 폴더를 묻지 못했습니다", e))?;
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(msg) = ch.wait().await {
            if let ChannelMsg::Data { data } = msg {
                out.extend_from_slice(&data);
                if out.len() > 8192 {
                    break;
                }
            }
        }
    })
    .await;
    let _ = ch.close().await;
    Ok(first_abs_line(&String::from_utf8_lossy(&out)))
}

fn first_abs_line(s: &str) -> Option<String> {
    s.lines().map(str::trim).find(|l| l.starts_with('/')).map(String::from)
}

/// 다음 호출에서 새로 열도록 버린다(채널이 끊겼을 때).
pub async fn reset(conn: &Conn) {
    *conn.sftp.lock().await = None;
}

/// path가 비어 있으면 홈 폴더(서버의 ".")를 보여 준다. 폴더가 먼저, 이름순.
pub async fn list(conn: &Conn, path: &str) -> Result<Listing, String> {
    let s = session(conn).await?;
    let path = if path.trim().is_empty() { "." } else { path };
    let abs = s
        .canonicalize(path)
        .await
        .map_err(|e| e2s("경로를 찾지 못했습니다", e))?;
    let dir = s
        .read_dir(abs.clone())
        .await
        .map_err(|e| e2s("폴더를 읽지 못했습니다", e))?;
    let mut entries: Vec<Entry> = dir
        .filter(|d| d.file_name() != "." && d.file_name() != "..")
        .map(|d| {
            let m = d.metadata();
            Entry {
                name: d.file_name(),
                is_dir: m.is_dir(),
                is_link: m.is_symlink(),
                size: m.size.unwrap_or(0),
                mtime: m.mtime,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing { path: abs, entries })
}

/// 원격 경로 하나를 이어 붙인다(서버는 늘 '/' 구분).
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

const CHUNK: usize = 256 * 1024;

pub async fn download(conn: &Conn, remote: &str, local: &Path) -> Result<u64, String> {
    let s = session(conn).await?;
    let mut src = s
        .open(remote)
        .await
        .map_err(|e| e2s("원격 파일을 열지 못했습니다", e))?;
    let tmp = local.with_extension("sshbook-part");
    let mut dst = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e2s("내 PC에 파일을 만들지 못했습니다", e))?;
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = tokio::time::timeout(Duration::from_secs(60), src.read(&mut buf))
            .await
            .map_err(|_| "내려받는 중 응답이 없습니다.".to_string())?
            .map_err(|e| e2s("내려받다가 실패했습니다", e))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| e2s("저장하다가 실패했습니다", e))?;
        total += n as u64;
    }
    dst.flush().await.map_err(|e| e2s("저장하다가 실패했습니다", e))?;
    drop(dst);
    tokio::fs::rename(&tmp, local)
        .await
        .map_err(|e| e2s("저장하다가 실패했습니다", e))?;
    Ok(total)
}

pub async fn upload(conn: &Conn, local: &Path, remote_dir: &str) -> Result<String, String> {
    let s = session(conn).await?;
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("파일 이름이 없습니다.")?;
    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| e2s("파일을 읽지 못했습니다", e))?;
    if meta.is_dir() {
        return Err(format!("'{name}'은 폴더입니다. 지금은 파일만 올릴 수 있습니다."));
    }
    let remote = join(remote_dir, &name);
    let mut src = tokio::fs::File::open(local)
        .await
        .map_err(|e| e2s("파일을 읽지 못했습니다", e))?;
    let mut dst = s
        .create(remote.clone())
        .await
        .map_err(|e| e2s("원격에 파일을 만들지 못했습니다", e))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = src.read(&mut buf).await.map_err(|e| e2s("파일을 읽지 못했습니다", e))?;
        if n == 0 {
            break;
        }
        tokio::time::timeout(Duration::from_secs(60), dst.write_all(&buf[..n]))
            .await
            .map_err(|_| "올리는 중 응답이 없습니다.".to_string())?
            .map_err(|e| e2s("올리다가 실패했습니다", e))?;
    }
    dst.shutdown().await.map_err(|e| e2s("올리다가 실패했습니다", e))?;
    Ok(remote)
}

pub async fn mkdir(conn: &Conn, path: &str) -> Result<(), String> {
    let s = session(conn).await?;
    s.create_dir(path).await.map_err(|e| e2s("폴더를 만들지 못했습니다", e))
}

pub async fn remove(conn: &Conn, path: &str, is_dir: bool) -> Result<(), String> {
    let s = session(conn).await?;
    if is_dir {
        s.remove_dir(path)
            .await
            .map_err(|e| e2s("폴더를 지우지 못했습니다 (빈 폴더만 지울 수 있습니다)", e))
    } else {
        s.remove_file(path)
            .await
            .map_err(|e| e2s("파일을 지우지 못했습니다", e))
    }
}

pub async fn rename(conn: &Conn, from: &str, to: &str) -> Result<(), String> {
    let s = session(conn).await?;
    s.rename(from, to).await.map_err(|e| e2s("이름을 바꾸지 못했습니다", e))
}

#[cfg(test)]
mod tests {
    use super::{first_abs_line, join, CWD_SCRIPT};

    #[test]
    fn picks_the_path_line() {
        assert_eq!(first_abs_line("/srv/app\n"), Some("/srv/app".into()));
        assert_eq!(first_abs_line("motd noise\n/home/me\n"), Some("/home/me".into()));
        assert_eq!(first_abs_line(""), None);
    }

    /// 스크립트가 sh 문법으로 맞는지 이 PC의 sh로 확인한다(실행은 하지 않는다).
    #[test]
    fn cwd_script_is_valid_sh() {
        let inner = CWD_SCRIPT
            .strip_prefix("exec sh -c '")
            .and_then(|s| s.strip_suffix('\''))
            .expect("sh -c '...' 형태");
        assert!(
            !inner.contains('\''),
            "안쪽에 작은따옴표가 있으면 감싼 따옴표가 깨집니다"
        );
        let ok = std::process::Command::new("sh")
            .args(["-n", "-c", inner])
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }

    #[test]
    fn joins_remote_paths() {
        assert_eq!(join("/srv", "a.txt"), "/srv/a.txt");
        assert_eq!(join("/", "etc"), "/etc");
    }
}
