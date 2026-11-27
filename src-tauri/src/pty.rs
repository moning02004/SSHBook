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
    /// 셸을 시작한 폴더. 지금 폴더를 알 수 없을 때 쓴다.
    start_dir: Option<PathBuf>,
}

enum PumpMsg {
    Data(Vec<u8>),
    Exit(Option<u32>),
}

/// 터미널 출력을 화면으로 보내는 통로.
///
/// 출력이 잘게 쏟아지면(전체 화면 앱이 다시 그릴 때 등) 이벤트 하나하나가 웹뷰의
/// 스크립트 실행으로 이어져 화면이 버벅인다. 보내는 동안 쌓인 조각은 한 번에 합쳐 보낸다.
/// 쌓인 것이 없으면 기다리지 않고 바로 보내서 입력 반응은 그대로다.
#[derive(Clone)]
pub struct DataPump(std::sync::mpsc::Sender<PumpMsg>);

/// 한 번에 합쳐 보내는 최대 크기
const PUMP_MAX: usize = 512 * 1024;

impl DataPump {
    pub fn new(app: AppHandle, id: String) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<PumpMsg>();
        std::thread::spawn(move || {
            let mut exit: Option<Option<u32>> = None;
            while exit.is_none() {
                let mut buf = match rx.recv() {
                    Ok(PumpMsg::Data(b)) => b,
                    Ok(PumpMsg::Exit(c)) => {
                        exit = Some(c);
                        Vec::new()
                    }
                    Err(_) => break,
                };
                while exit.is_none() && buf.len() < PUMP_MAX {
                    match rx.try_recv() {
                        Ok(PumpMsg::Data(b)) => buf.extend_from_slice(&b),
                        Ok(PumpMsg::Exit(c)) => exit = Some(c),
                        Err(_) => break,
                    }
                }
                if !buf.is_empty() {
                    let _ = app.emit(
                        "term-data",
                        TermData {
                            id: id.clone(),
                            data: B64.encode(&buf),
                        },
                    );
                }
            }
            if let Some(code) = exit {
                let _ = app.emit("term-exit", TermExit { id, code });
            }
        });
        DataPump(tx)
    }

    pub fn data(&self, b: Vec<u8>) {
        let _ = self.0.send(PumpMsg::Data(b));
    }

    /// 앞서 보낸 출력을 모두 보낸 뒤에 끝났다고 알린다.
    pub fn exit(&self, code: Option<u32>) {
        let _ = self.0.send(PumpMsg::Exit(code));
    }
}

/// 셸이 프롬프트를 그릴 때마다 지금 폴더를 알려 주게 한다(OSC 9;9, Windows Terminal과 같은 방식).
/// Windows는 다른 프로세스의 지금 폴더를 바로 읽을 수 없고, PowerShell은 `cd`해도
/// 프로세스 폴더가 바뀌지 않아서 셸이 직접 알려 주는 값을 쓴다.
#[cfg(windows)]
fn add_cwd_reporting(cmd: &mut CommandBuilder, prog: &str) {
    let name = std::path::Path::new(prog.trim_matches('"'))
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "cmd" => {
            let prompt = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
            cmd.env("PROMPT", format!(r"$e]9;9;$P$e\{prompt}"));
        }
        // Git Bash(MSYS2). 시스템 폴더의 bash.exe는 WSL을 띄우는 것이라 건드리지 않는다.
        "bash" if !prog.to_lowercase().contains(r"\system32\") => {
            // 시작 폴더를 지킨다(없으면 /etc/profile이 홈으로 옮긴다).
            cmd.env("CHERE_INVOKING", "1");
            // 프롬프트마다 OSC 7로 지금 폴더(/c/Users/…)를 알린다.
            cmd.env(
                "PROMPT_COMMAND",
                r#"printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD""#,
            );
        }
        "powershell" | "pwsh" => {
            // 사용자 프로필이 정한 프롬프트는 그대로 두고 앞에 알림만 붙인다.
            let script = concat!(
                r"$global:__sshbook_prompt = $function:prompt; ",
                r"function global:prompt { ",
                r"$l = $executionContext.SessionState.Path.CurrentLocation; ",
                r"$o = & $global:__sshbook_prompt; ",
                r#"if ($l.Provider.Name -eq 'FileSystem') { "$([char]27)]9;9;$($l.ProviderPath)$([char]27)\" + $o } else { $o } }"#
            );
            cmd.args(["-NoLogo", "-NoExit", "-Command", script]);
        }
        _ => {}
    }
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

    // "wsl.exe -d Ubuntu"처럼 인자를 붙여 쓸 수 있다.
    let argv = shell.as_deref().map(split_command).filter(|a| !a.is_empty());
    let explicit_cwd = cwd.as_deref().is_some_and(|c| !c.trim().is_empty());
    #[cfg(windows)]
    let mut cmd = {
        // 인자를 붙이려면 기본 셸도 프로그램 이름이 있어야 한다.
        let argv = argv.unwrap_or_else(default_windows_shell);
        let mut c = CommandBuilder::new(&argv[0]);
        c.args(&argv[1..]);
        // WSL은 시작 폴더를 따로 정하지 않았으면 리눅스 홈에서 연다(C:\Users\… 대신).
        if is_wsl(&argv[0]) && !explicit_cwd && !argv.iter().any(|a| a == "--cd") {
            c.args(["--cd", "~"]);
        }
        add_cwd_reporting(&mut c, &argv[0]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = match argv {
        Some(argv) => {
            let _ = explicit_cwd;
            let mut c = CommandBuilder::new(&argv[0]);
            c.args(&argv[1..]);
            c
        }
        None => CommandBuilder::new_default_prog(),
    };
    let dir = cwd
        .as_deref()
        .filter(|c| !c.trim().is_empty())
        .map(expand_home)
        .or_else(home_dir);
    if let Some(dir) = &dir {
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

    let pump = DataPump::new(app, id);
    std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => pump.data(buf[..n].to_vec()),
            }
        }
        pump.exit(None);
    });

    Ok(LocalPty {
        master: pair.master,
        writer,
        child,
        start_dir: dir,
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

    /// 셸의 지금 폴더. Windows는 셸이 알려 준 값(hint)을 쓰고, 모르면 시작한 폴더로 본다.
    pub fn current_dir(&self, hint: Option<&str>) -> Option<PathBuf> {
        #[cfg(not(windows))]
        {
            let _ = hint;
            if let Some(d) = self.child.process_id().and_then(process_cwd) {
                return Some(d);
            }
        }
        #[cfg(windows)]
        if let Some(h) = hint.map(str::trim).filter(|h| !h.is_empty()) {
            return Some(PathBuf::from(msys_to_windows(h)));
        }
        self.start_dir.clone().or_else(home_dir)
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

/// 셸 명령 문자열을 프로그램과 인자로 나눈다. 큰따옴표로 감싸면 공백을 포함한다.
/// (Windows 경로의 `\`는 그대로 둔다)
pub fn split_command(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for ch in s.trim().chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// Git for Windows의 bash.exe. 보통 설치 위치를 보고, 없으면 PATH의 git.exe에서 거슬러 올라가 찾는다
/// (git.exe는 `Git\cmd`나 `Git\ucrt64\bin`처럼 버전마다 위치가 다르다).
#[cfg(windows)]
pub fn git_bash() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|p| PathBuf::from(p).join("Git"))
        .collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join(r"Programs\Git"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("git.exe").is_file() {
                roots.extend(dir.ancestors().skip(1).take(3).map(PathBuf::from));
            }
        }
    }
    roots.into_iter().map(|r| r.join(r"bin\bash.exe")).find(|b| b.is_file())
}

#[cfg(windows)]
fn git_bash_command(bash: &std::path::Path) -> String {
    format!("\"{}\" --login -i", bash.display())
}

/// 셸을 정하지 않았을 때: 리눅스 명령을 쓸 수 있게 Git Bash가 있으면 그것, 없으면 PowerShell
/// (Windows PowerShell은 모든 Windows에 있고 ls·cat·pwd 같은 별칭도 된다).
#[cfg(windows)]
fn default_windows_shell() -> Vec<String> {
    match git_bash() {
        Some(bash) => vec![bash.to_string_lossy().into_owned(), "--login".into(), "-i".into()],
        None => vec!["powershell.exe".into()],
    }
}

/// Git Bash(MSYS) 경로를 Windows 경로로: `/c/Users/me` → `C:\Users\me`. 그 밖의 경로는 그대로.
pub fn msys_to_windows(p: &str) -> String {
    let b = p.as_bytes();
    if b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
        let rest = p[2..].replace('/', "\\");
        return format!(
            "{}:{}",
            (b[1] as char).to_ascii_uppercase(),
            if rest.is_empty() { "\\".into() } else { rest }
        );
    }
    p.to_string()
}

/// 프로그램 이름이 WSL인지(wsl, wsl.exe, 전체 경로)
pub fn is_wsl(prog: &str) -> bool {
    std::path::Path::new(prog)
        .file_stem()
        .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("wsl"))
}

/// 이 PC에서 고를 수 있는 셸. (보이는 이름, 셸 칸에 넣을 명령)
#[derive(Serialize, Clone)]
pub struct ShellChoice {
    pub label: String,
    pub command: String,
}

#[cfg(windows)]
pub fn available_shells() -> Vec<ShellChoice> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let run = |prog: &str, args: &[&str]| {
        std::process::Command::new(prog)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .filter(|o| o.status.success())
    };
    let choice = |label: &str, command: String| ShellChoice {
        label: label.to_string(),
        command,
    };
    let mut out = Vec::new();
    if let Some(bash) = git_bash() {
        out.push(choice("Git Bash", git_bash_command(&bash)));
    }
    out.push(choice("명령 프롬프트 (cmd)", "cmd.exe".into()));
    out.push(choice("Windows PowerShell", "powershell.exe".into()));
    if run("where.exe", &["pwsh.exe"]).is_some() {
        out.push(choice("PowerShell 7", "pwsh.exe".into()));
    }
    // `wsl -l -q`는 UTF-16LE로 배포판 이름을 한 줄씩 낸다.
    if let Some(o) = run("wsl.exe", &["-l", "-q"]) {
        let wide: Vec<u16> = o
            .stdout
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes(*b))
            .collect();
        for name in String::from_utf16_lossy(&wide).lines() {
            let name = name.trim().trim_matches('\0');
            if name.is_empty() {
                continue;
            }
            let arg = if name.contains(' ') {
                format!("\"{name}\"")
            } else {
                name.to_string()
            };
            out.push(ShellChoice {
                label: format!("WSL: {name}"),
                command: format!("wsl.exe -d {arg}"),
            });
        }
    }
    out
}

#[cfg(not(windows))]
pub fn available_shells() -> Vec<ShellChoice> {
    let mut out: Vec<ShellChoice> = Vec::new();
    let list = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    for line in list.lines().map(str::trim) {
        if !line.starts_with('/') || !std::path::Path::new(line).exists() {
            continue;
        }
        let name = line.rsplit('/').next().unwrap_or(line).to_string();
        // 같은 이름(/bin/zsh, /usr/bin/zsh)은 처음 것만 둔다.
        if out.iter().any(|c| c.label == name) || matches!(name.as_str(), "nologin" | "false") {
            continue;
        }
        out.push(ShellChoice {
            label: name,
            command: line.to_string(),
        });
    }
    out
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    // 출력 예: "p123", "fcwd", "n/Users/me/work"
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(PathBuf::from))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

/// 네트워크 경로(`\\server\share`, `//server`)인지. 셸 출력으로 들어온 경로라서
/// 열면 다른 PC로 접속하게 될 수 있어 막는다.
pub fn is_network_path(s: &str) -> bool {
    s.starts_with(r"\\") || s.starts_with("//")
}

/// 폴더를 Finder·탐색기로 연다. 이 PC에 있는 폴더만 연다(파일을 넘기면 실행될 수 있다).
pub fn reveal_dir(dir: &std::path::Path) -> Result<(), String> {
    let s = dir.to_string_lossy();
    if !dir.is_absolute() || is_network_path(&s) {
        return Err("열 수 없는 경로입니다.".into());
    }
    if !dir.is_dir() {
        return Err(format!("폴더를 찾을 수 없습니다: {s}"));
    }
    let prog = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(prog)
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("폴더를 열지 못했습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_commands_split_into_args() {
        assert_eq!(
            split_command("wsl.exe -d Ubuntu-24.04"),
            ["wsl.exe", "-d", "Ubuntu-24.04"]
        );
        assert_eq!(split_command("  zsh  "), ["zsh"]);
        assert_eq!(
            split_command(r#""C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo"#),
            [r"C:\Program Files\PowerShell\7\pwsh.exe", "-NoLogo"]
        );
        assert_eq!(split_command(r#"wsl -d "My Distro""#), ["wsl", "-d", "My Distro"]);
        assert!(split_command("   ").is_empty());
        assert!(is_wsl("wsl.exe") && is_wsl("WSL") && is_wsl(r"C:\Windows\System32\wsl.exe"));
        assert!(!is_wsl("bash"));
    }

    /// 이 PC의 셸 목록을 보여 준다(WSL이 있으면 배포판도 나온다).
    #[test]
    #[ignore]
    fn print_available_shells() {
        for c in available_shells() {
            println!("{} => {}", c.label, c.command);
        }
    }

    #[test]
    fn network_paths_are_refused() {
        assert!(is_network_path(r"\\evil\share"));
        assert!(is_network_path("//evil/share"));
        assert!(!is_network_path(r"C:\Users"));
        assert!(!is_network_path("/Users/me"));
        assert!(reveal_dir(std::path::Path::new("relative/dir")).is_err());
    }

    /// 셸 프롬프트가 지금 폴더를 OSC 9;9로 알려 주는지 실제 ConPTY로 확인한다.
    #[cfg(windows)]
    fn prompt_reports_cwd(prog: &str) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new(prog);
        add_cwd_reporting(&mut cmd, prog);
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let want = "\x1b]9;9;C:\\\x1b\\";
        let mut seen = Vec::new();
        let mut sent = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                // ConPTY는 처음에 커서 위치를 묻고 답을 기다린다(앱에서는 xterm이 답한다).
                if b.windows(4).any(|w| w == b"\x1b[6n") {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                }
                seen.extend(b);
            }
            let text = String::from_utf8_lossy(&seen);
            if !sent && text.contains("\x1b]9;9;") {
                writer.write_all(b"cd C:\\\r").unwrap();
                sent = true;
            }
            if text.contains(want) {
                break;
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&seen);
        assert!(text.contains(want), "{prog}: OSC 9;9로 C:\\를 알리지 않음: {text:?}");
    }

    #[test]
    fn msys_paths_become_windows_paths() {
        assert_eq!(msys_to_windows("/c/Users/me"), r"C:\Users\me");
        assert_eq!(msys_to_windows("/d"), r"D:\");
        assert_eq!(msys_to_windows(r"C:\Users"), r"C:\Users");
        assert_eq!(msys_to_windows("/home/me"), "/home/me");
        assert_eq!(msys_to_windows("/usr"), "/usr");
    }

    /// Git Bash가 있으면 기본 셸이 되고, 프롬프트가 지금 폴더를 OSC 7로 알린다.
    #[cfg(windows)]
    #[test]
    fn git_bash_is_default_and_reports_cwd() {
        let Some(bash) = git_bash() else {
            eprintln!("Git Bash가 없어 건너뜀");
            return;
        };
        let argv = default_windows_shell();
        assert_eq!(PathBuf::from(&argv[0]), bash);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new(&argv[0]);
        cmd.args(&argv[1..]);
        add_cwd_reporting(&mut cmd, &argv[0]);
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut seen = Vec::new();
        let mut sent = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let want = "/c\x1b\\";
        while std::time::Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                if b.windows(4).any(|w| w == b"\x1b[6n") {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                }
                seen.extend(b);
            }
            let text = String::from_utf8_lossy(&seen);
            if !sent && text.contains("\x1b]7;file://") {
                writer.write_all(b"cd /c && ls -d /c/Windows\r").unwrap();
                sent = true;
            }
            if sent && text.contains(want) && text.contains("/c/Windows") {
                break;
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&seen);
        assert!(text.contains(want), "OSC 7로 /c를 알리지 않음: {text:?}");
        assert!(text.contains("/c/Windows"), "ls가 동작하지 않음: {text:?}");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_prompt_reports_cwd() {
        prompt_reports_cwd("cmd.exe");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_prompt_reports_cwd() {
        prompt_reports_cwd("powershell.exe");
    }
}
