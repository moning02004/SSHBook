//! 로컬 셸. Windows는 ConPTY, macOS/Linux는 openpty를 쓴다(portable-pty).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct TermData {
    pub id: String,
    /// 원본 바이트를 base64로. UTF-8 조각이 잘려도 xterm이 이어 붙인다.
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct TermExit {
    pub id: String,
    pub code: Option<u32>,
}

pub struct LocalPty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// "~" 또는 "~/..."를 홈 폴더로 바꾼다.
pub fn expand_home(p: &str) -> PathBuf {
    let p = p.trim();
    if p == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(p));
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn spawn(
    app: AppHandle,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<LocalPty, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("터미널을 만들지 못했습니다: {e}"))?;

    let mut cmd = match shell.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => CommandBuilder::new(s),
        _ => CommandBuilder::new_default_prog(),
    };
    let dir = cwd
        .as_deref()
        .filter(|c| !c.trim().is_empty())
        .map(expand_home)
        .or_else(home_dir);
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("셸을 실행하지 못했습니다: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(e2s)?;
    let writer = pair.master.take_writer().map_err(e2s)?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit(
                        "term-data",
                        TermData {
                            id: id.clone(),
                            data: B64.encode(&buf[..n]),
                        },
                    );
                }
            }
        }
        let _ = app.emit("term-exit", TermExit { id, code: None });
    });

    Ok(LocalPty {
        master: pair.master,
        writer,
        child,
    })
}

impl LocalPty {
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer.write_all(data.as_bytes()).map_err(e2s)?;
        self.writer.flush().map_err(e2s)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(e2s)
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}
