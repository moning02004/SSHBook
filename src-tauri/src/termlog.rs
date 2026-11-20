//! 세션 기록: 터미널 출력을 줄마다 시각을 붙여 텍스트 파일로 남긴다.
//!
//! 색·커서 이동 같은 제어 문자(ANSI escape)는 빼고 글자만 남긴다.
//! 파일은 앱 데이터 폴더의 logs/ 아래에 "세션이름_날짜-시각.log"로 만든다.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub fn log_path(dir: &Path, session_name: &str) -> PathBuf {
    let safe: String = session_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    dir.join(format!(
        "{}_{stamp}.log",
        if safe.is_empty() { "session" } else { &safe }
    ))
}

/// ESC 시퀀스를 걷어 내는 상태
#[derive(Clone, Copy, PartialEq)]
enum Esc {
    None,
    /// ESC 바로 다음
    Start,
    /// CSI: ESC [ … 끝 글자(0x40~0x7e)까지
    Csi,
    /// OSC: ESC ] … BEL 또는 ESC \ 까지
    Osc,
    OscEnd,
}

pub struct TermLog {
    out: BufWriter<File>,
    line_start: bool,
    esc: Esc,
}

impl TermLog {
    pub fn create(path: &Path, header: &str) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            crate::fsperm::private_dir(dir)?;
        }
        let file = crate::fsperm::append_private(path)?;
        let mut log = TermLog {
            out: BufWriter::new(file),
            line_start: true,
            esc: Esc::None,
        };
        writeln!(log.out, "# {header}")?;
        log.out.flush()?;
        Ok(log)
    }

    fn stamp(&mut self) -> std::io::Result<()> {
        write!(self.out, "[{}] ", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
    }

    /// 받은 바이트를 걸러서 쓴다. 한 덩어리가 끝날 때마다 내보낸다(앱이 죽어도 남도록).
    pub fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        let text = String::from_utf8_lossy(data);
        for ch in text.chars() {
            match self.esc {
                Esc::Start => {
                    self.esc = match ch {
                        '[' => Esc::Csi,
                        ']' => Esc::Osc,
                        _ => Esc::None,
                    };
                    continue;
                }
                Esc::Csi => {
                    if ('\u{40}'..='\u{7e}').contains(&ch) {
                        self.esc = Esc::None;
                    }
                    continue;
                }
                Esc::Osc => {
                    if ch == '\u{7}' {
                        self.esc = Esc::None;
                    } else if ch == '\u{1b}' {
                        self.esc = Esc::OscEnd;
                    }
                    continue;
                }
                Esc::OscEnd => {
                    self.esc = Esc::None;
                    continue;
                }
                Esc::None => {}
            }
            match ch {
                '\u{1b}' => self.esc = Esc::Start,
                '\n' => {
                    if self.line_start {
                        self.stamp()?;
                    }
                    self.out.write_all(b"\n")?;
                    self.line_start = true;
                }
                // 줄바꿈 앞의 \r과 그 밖의 제어 문자는 버린다(탭은 남긴다).
                c if c.is_control() && c != '\t' => {}
                c => {
                    if self.line_start {
                        self.stamp()?;
                        self.line_start = false;
                    }
                    let mut buf = [0u8; 4];
                    self.out.write_all(c.encode_utf8(&mut buf).as_bytes())?;
                }
            }
        }
        self.out.flush()
    }

    pub fn finish(&mut self, note: &str) {
        if !self.line_start {
            let _ = self.out.write_all(b"\n");
        }
        let _ = writeln!(
            self.out,
            "# {note} ({})",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        let _ = self.out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_back(chunks: &[&[u8]]) -> String {
        let dir = std::env::temp_dir().join(format!("termlog-{}", uuid::Uuid::new_v4()));
        let path = dir.join("t.log");
        let mut log = TermLog::create(&path, "start").unwrap();
        for c in chunks {
            log.write(c).unwrap();
        }
        log.finish("end");
        std::fs::read_to_string(&path).unwrap()
    }

    #[test]
    fn strips_escape_codes_and_stamps_lines() {
        let got = read_back(&[
            b"\x1b[32muser@host\x1b[0m:~$ ls\r\n",
            b"a.txt  b\x1b]0;title\x07.txt\r\n",
        ]);
        let lines: Vec<&str> = got.lines().collect();
        assert_eq!(lines[0], "# start");
        assert!(
            lines[1].starts_with('[') && lines[1].ends_with("] user@host:~$ ls"),
            "{got}"
        );
        assert!(lines[2].ends_with("] a.txt  b.txt"), "{got}");
        assert!(lines[3].starts_with("# end"), "{got}");
    }

    #[test]
    fn escape_split_across_chunks() {
        let got = read_back(&[b"ok\x1b[3", b"1mred\x1b[0m\n"]);
        assert!(got.lines().nth(1).unwrap().ends_with("] okred"), "{got}");
    }

    #[test]
    fn file_name_is_safe() {
        let p = log_path(Path::new("/tmp/logs"), "prod/web 01");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("prod_web_01_") && name.ends_with(".log"), "{name}");
    }
}
