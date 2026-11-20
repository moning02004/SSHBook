//! 파일 주고받기 (SFTP). 열린 SSH 터미널과 같은 연결 위에 SFTP 채널을 하나 더 연다.
//! 처음 쓸 때 열고, 같은 터미널에서는 다시 쓴다.

use crate::ssh::Conn;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
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
const STALL: Duration = Duration::from_secs(60);

/// 전송 진행률(화면에 보낸다)
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    /// 지금 옮기는 파일(상대 경로)
    pub file: String,
    pub files_done: u32,
    pub files_total: u32,
}

/// 전송 한 번: 취소 표시와 진행률 콜백
pub struct Transfer {
    pub cancel: Arc<AtomicBool>,
    pub on_progress: Box<dyn Fn(&Progress) + Send + Sync>,
}

impl Transfer {
    /// 진행률을 받지 않는 전송(테스트용)
    #[cfg(test)]
    pub fn quiet() -> Self {
        Transfer {
            cancel: Arc::new(AtomicBool::new(false)),
            on_progress: Box::new(|_| {}),
        }
    }

    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}

pub const CANCELLED: &str = "전송을 취소했습니다.";

/// 진행률을 모아 0.1초에 한 번쯤 보낸다.
struct Meter<'a> {
    t: &'a Transfer,
    p: Progress,
    last: Instant,
}

impl<'a> Meter<'a> {
    fn new(t: &'a Transfer, total: u64, files_total: u32) -> Self {
        let m = Meter {
            t,
            p: Progress {
                total,
                files_total,
                ..Default::default()
            },
            last: Instant::now(),
        };
        (m.t.on_progress)(&m.p);
        m
    }
    fn file(&mut self, name: &str) {
        self.p.file = name.into();
        self.flush();
    }
    fn add(&mut self, n: u64) {
        self.p.done += n;
        if self.last.elapsed() >= Duration::from_millis(100) {
            self.flush();
        }
    }
    fn file_done(&mut self) {
        self.p.files_done += 1;
        self.flush();
    }
    fn flush(&mut self) {
        self.last = Instant::now();
        (self.t.on_progress)(&self.p);
    }
}

fn base_name(remote: &str) -> String {
    remote
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .to_string()
}

/// (원격 경로, 내 PC 경로, 크기)
type DownPlan = (Vec<(String, PathBuf, u64)>, Vec<PathBuf>);
/// (내 PC 경로, 원격 경로, 크기)와 만들 원격 폴더
type UpPlan = (Vec<(PathBuf, String, u64)>, Vec<String>);

/// 원격 폴더 안의 파일(원격 경로, 내 PC 경로, 크기)과 만들 폴더들. 심볼릭 링크는 건너뛴다(순환 방지).
async fn walk_remote(s: &SftpSession, root_remote: &str, root_local: &Path, t: &Transfer) -> Result<DownPlan, String> {
    let mut files = vec![];
    let mut dirs = vec![root_local.to_path_buf()];
    let mut stack = vec![(root_remote.to_string(), root_local.to_path_buf())];
    while let Some((rdir, ldir)) = stack.pop() {
        t.check()?;
        let rd = s
            .read_dir(rdir.clone())
            .await
            .map_err(|e| e2s(&format!("폴더를 읽지 못했습니다 ({rdir})"), e))?;
        for d in rd {
            let name = d.file_name();
            if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
                continue;
            }
            let m = d.metadata();
            if m.is_symlink() {
                continue;
            }
            let r = join(&rdir, &name);
            let l = ldir.join(&name);
            if m.is_dir() {
                dirs.push(l.clone());
                stack.push((r, l));
            } else {
                files.push((r, l, m.size.unwrap_or(0)));
            }
        }
    }
    Ok((files, dirs))
}

async fn copy_down(s: &SftpSession, remote: &str, local: &Path, m: &mut Meter<'_>) -> Result<(), String> {
    let mut src = s
        .open(remote)
        .await
        .map_err(|e| e2s(&format!("원격 파일을 열지 못했습니다 ({remote})"), e))?;
    let tmp = local.with_extension("sshbook-part");
    let mut dst = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e2s("내 PC에 파일을 만들지 못했습니다", e))?;
    let mut buf = vec![0u8; CHUNK];
    let result: Result<(), String> = async {
        loop {
            m.t.check()?;
            let n = tokio::time::timeout(STALL, src.read(&mut buf))
                .await
                .map_err(|_| "내려받는 중 응답이 없습니다.".to_string())?
                .map_err(|e| e2s("내려받다가 실패했습니다", e))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])
                .await
                .map_err(|e| e2s("저장하다가 실패했습니다", e))?;
            m.add(n as u64);
        }
        dst.flush().await.map_err(|e| e2s("저장하다가 실패했습니다", e))
    }
    .await;
    drop(dst);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    tokio::fs::rename(&tmp, local)
        .await
        .map_err(|e| e2s("저장하다가 실패했습니다", e))
}

/// 내려받기. 파일이면 local이 저장할 파일 경로, 폴더면 local 폴더 안에 같은 이름으로 만든다.
/// 돌려주는 값은 옮긴 바이트 수.
pub async fn download(conn: &Conn, remote: &str, local: &Path, is_dir: bool, t: &Transfer) -> Result<u64, String> {
    let s = session(conn).await?;
    let (files, dirs) = if is_dir {
        walk_remote(&s, remote, &local.join(base_name(remote)), t).await?
    } else {
        let size = s.metadata(remote).await.ok().and_then(|m| m.size).unwrap_or(0);
        (vec![(remote.to_string(), local.to_path_buf(), size)], vec![])
    };
    for d in &dirs {
        tokio::fs::create_dir_all(d)
            .await
            .map_err(|e| e2s("내 PC에 폴더를 만들지 못했습니다", e))?;
    }
    let total = files.iter().map(|f| f.2).sum();
    let mut m = Meter::new(t, total, files.len() as u32);
    let prefix = local.to_path_buf();
    for (r, l, _) in &files {
        let shown = l.strip_prefix(&prefix).unwrap_or(l).display().to_string();
        m.file(if shown.is_empty() { r } else { &shown });
        copy_down(&s, r, l, &mut m).await?;
        m.file_done();
    }
    Ok(m.p.done)
}

/// 내 PC 폴더 안의 파일(내 PC 경로, 원격 경로, 크기)과 만들 원격 폴더들. 심볼릭 링크는 건너뛴다.
fn walk_local(root: &Path, remote_root: &str) -> Result<UpPlan, String> {
    let mut files = vec![];
    let mut dirs = vec![remote_root.to_string()];
    let mut stack = vec![(root.to_path_buf(), remote_root.to_string())];
    while let Some((ldir, rdir)) = stack.pop() {
        let rd =
            std::fs::read_dir(&ldir).map_err(|e| e2s(&format!("폴더를 읽지 못했습니다 ({})", ldir.display()), e))?;
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let r = join(&rdir, &name);
            if ft.is_dir() {
                dirs.push(r.clone());
                stack.push((entry.path(), r));
            } else if ft.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push((entry.path(), r, size));
            }
        }
    }
    Ok((files, dirs))
}

async fn copy_up(s: &SftpSession, local: &Path, remote: &str, m: &mut Meter<'_>) -> Result<(), String> {
    let mut src = tokio::fs::File::open(local)
        .await
        .map_err(|e| e2s("파일을 읽지 못했습니다", e))?;
    let mut dst = s
        .create(remote.to_string())
        .await
        .map_err(|e| e2s(&format!("원격에 파일을 만들지 못했습니다 ({remote})"), e))?;
    let mut buf = vec![0u8; CHUNK];
    let result: Result<(), String> = async {
        loop {
            m.t.check()?;
            let n = src.read(&mut buf).await.map_err(|e| e2s("파일을 읽지 못했습니다", e))?;
            if n == 0 {
                break;
            }
            tokio::time::timeout(STALL, dst.write_all(&buf[..n]))
                .await
                .map_err(|_| "올리는 중 응답이 없습니다.".to_string())?
                .map_err(|e| e2s("올리다가 실패했습니다", e))?;
            m.add(n as u64);
        }
        dst.shutdown().await.map_err(|e| e2s("올리다가 실패했습니다", e))
    }
    .await;
    if let Err(e) = result {
        drop(dst);
        // 쓰다 만 원격 파일은 지운다.
        let _ = s.remove_file(remote.to_string()).await;
        return Err(e);
    }
    Ok(())
}

/// 파일·폴더들을 원격 폴더로 올린다. 폴더는 안의 것까지 모두. 돌려주는 값은 올린 파일 수.
pub async fn upload(conn: &Conn, locals: &[PathBuf], remote_dir: &str, t: &Transfer) -> Result<u32, String> {
    let s = session(conn).await?;
    let mut files = vec![];
    let mut dirs = vec![];
    for p in locals {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("파일 이름이 없습니다.")?;
        let meta = std::fs::metadata(p).map_err(|e| e2s(&format!("파일을 읽지 못했습니다 ({name})"), e))?;
        let remote = join(remote_dir, &name);
        if meta.is_dir() {
            let (f, d) = walk_local(p, &remote)?;
            files.extend(f);
            dirs.extend(d);
        } else {
            files.push((p.clone(), remote, meta.len()));
        }
    }
    for d in &dirs {
        t.check()?;
        if !s.try_exists(d.clone()).await.unwrap_or(false) {
            s.create_dir(d.clone())
                .await
                .map_err(|e| e2s(&format!("원격 폴더를 만들지 못했습니다 ({d})"), e))?;
        }
    }
    let total = files.iter().map(|f| f.2).sum();
    let mut m = Meter::new(t, total, files.len() as u32);
    for (l, r, _) in &files {
        let shown = r
            .strip_prefix(remote_dir)
            .unwrap_or(r)
            .trim_start_matches('/')
            .to_string();
        m.file(&shown);
        copy_up(&s, l, r, &mut m).await?;
        m.file_done();
    }
    Ok(m.p.files_done)
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
    fn remote_base_name() {
        assert_eq!(super::base_name("/var/log/"), "log");
        assert_eq!(super::base_name("/srv/app/a.txt"), "a.txt");
    }

    #[test]
    fn walks_local_folders_without_symlinks() {
        let root = std::env::temp_dir()
            .join(format!("walk-{}", uuid::Uuid::new_v4()))
            .join("proj");
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::write(root.join("a.txt"), b"12345").unwrap();
        std::fs::write(root.join("sub/deep/b.txt"), b"xy").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("sub/loop")).unwrap();
        let (files, dirs) = super::walk_local(&root, "/srv/proj").unwrap();
        let mut remotes: Vec<_> = files.iter().map(|f| f.1.clone()).collect();
        remotes.sort();
        assert_eq!(remotes, vec!["/srv/proj/a.txt", "/srv/proj/sub/deep/b.txt"]);
        assert_eq!(files.iter().map(|f| f.2).sum::<u64>(), 7);
        let mut dirs = dirs;
        dirs.sort();
        assert_eq!(dirs, vec!["/srv/proj", "/srv/proj/sub", "/srv/proj/sub/deep"]);
    }

    #[test]
    fn joins_remote_paths() {
        assert_eq!(join("/srv", "a.txt"), "/srv/a.txt");
        assert_eq!(join("/", "etc"), "/etc");
    }
}
