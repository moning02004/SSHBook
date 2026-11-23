//! `~/.ssh/config`에서 세션으로 옮길 호스트를 읽는다. 파일을 고치지는 않는다.
//! OpenSSH처럼 위에서부터 읽어 처음 나온 값을 쓰고, `Host *` 같은 공통 블록도 반영한다.

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_DEPTH: u8 = 5;
const MAX_FILES: usize = 64;
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

#[derive(Default)]
struct Block {
    patterns: Vec<String>,
    options: Vec<(String, String)>,
}

/// `Key value`, `Key=value`, 따옴표를 나눈다. 주석과 빈 줄은 None.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    let (mut values, mut cur, mut quoted, mut started) = (Vec::new(), String::new(), false, false);
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '#' if !quoted && !started => break,
            c if c.is_whitespace() && !quoted => {
                if started {
                    values.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        values.push(cur);
    }
    Some((key, values))
}

fn wildcard(pattern: &[char], text: &[char]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some(('*', rest)) => (0..=text.len()).any(|i| wildcard(rest, &text[i..])),
        Some(('?', rest)) => !text.is_empty() && wildcard(rest, &text[1..]),
        Some((c, rest)) => text.first().is_some_and(|t| t.eq_ignore_ascii_case(c)) && wildcard(rest, &text[1..]),
    }
}

fn matches(patterns: &[String], alias: &str) -> bool {
    let text: Vec<char> = alias.chars().collect();
    let mut hit = false;
    for p in patterns {
        let (negated, body) = match p.strip_prefix('!') {
            Some(b) => (true, b),
            None => (false, p.as_str()),
        };
        if wildcard(&body.chars().collect::<Vec<_>>(), &text) {
            if negated {
                return false;
            }
            hit = true;
        }
    }
    hit
}

fn parse_blocks(text: &str) -> Vec<Block> {
    // 첫 Host 앞의 값은 모든 호스트에 적용된다.
    let mut blocks = vec![Block {
        patterns: vec!["*".into()],
        options: vec![],
    }];
    for line in text.lines() {
        let Some((key, values)) = split_line(line) else {
            continue;
        };
        match key.as_str() {
            "host" => blocks.push(Block {
                patterns: values,
                options: vec![],
            }),
            // Match 조건은 실행 환경에 달려 있어서 그 블록은 적용하지 않는다.
            "match" => blocks.push(Block::default()),
            _ => {
                if let (Some(b), Some(_)) = (blocks.last_mut(), values.first()) {
                    b.options.push((key, values.join(" ")));
                }
            }
        }
    }
    blocks
}

pub fn parse(text: &str) -> Vec<ConfigHost> {
    let blocks = parse_blocks(text);
    let mut aliases: Vec<String> = Vec::new();
    for b in &blocks {
        for p in &b.patterns {
            if !p.contains(['*', '?', '!']) && !aliases.iter().any(|a| a.eq_ignore_ascii_case(p)) {
                aliases.push(p.clone());
            }
        }
    }
    aliases
        .into_iter()
        .filter_map(|alias| {
            let first = |key: &str| {
                blocks
                    .iter()
                    .filter(|b| matches(&b.patterns, &alias))
                    .flat_map(|b| &b.options)
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.clone())
            };
            let host = first("hostname").unwrap_or_else(|| alias.clone()).replace("%h", &alias);
            // 명령 치환 등 이 앱이 풀 수 없는 값이면 잘못 연결하지 않도록 뺀다.
            if host.contains('%') {
                return None;
            }
            let port = match first("port") {
                Some(p) => p.parse().ok().filter(|p| *p != 0)?,
                None => 22,
            };
            let identity_file = first("identityfile")
                .filter(|f| !f.eq_ignore_ascii_case("none"))
                .map(|f| f.replace("%d", "~"))
                .filter(|f| !f.contains('%'));
            let proxy_jump = first("proxyjump").filter(|j| !j.eq_ignore_ascii_case("none"));
            let user = first("user").filter(|u| !u.contains('%'));
            Some(ConfigHost {
                alias,
                host,
                port,
                user,
                identity_file,
                proxy_jump,
            })
        })
        .collect()
}

/// `Include`의 경로를 파일 목록으로 푼다. 와일드카드는 마지막 조각만 지원한다.
fn include_paths(value: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let expanded = crate::pty::expand_home(value);
    let path = if expanded.is_absolute() {
        expanded
    } else {
        ssh_dir.join(expanded)
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else { return vec![] };
    let pattern: Vec<char> = name.chars().collect();
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| wildcard(&pattern, &e.file_name().to_string_lossy().chars().collect::<Vec<_>>()))
        .map(|e| e.path())
        .collect();
    found.sort();
    found
}

fn read_with_includes(path: &Path, ssh_dir: &Path, depth: u8, files: &mut usize, out: &mut String) {
    if depth > MAX_DEPTH || *files >= MAX_FILES {
        return;
    }
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    *files += 1;
    for line in text.lines() {
        match split_line(line) {
            Some((key, values)) if key == "include" => {
                for v in values {
                    for p in include_paths(&v, ssh_dir) {
                        read_with_includes(&p, ssh_dir, depth + 1, files, out);
                    }
                }
            }
            _ => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
}

/// 파일이 없으면 빈 목록. 사용자가 없으면 OpenSSH처럼 지금 OS 계정을 쓴다.
pub fn load(path: &Path) -> Vec<ConfigHost> {
    let ssh_dir = path.parent().unwrap_or(Path::new("."));
    let (mut text, mut files) = (String::new(), 0);
    read_with_includes(path, ssh_dir, 0, &mut files, &mut text);
    let me = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok();
    let mut hosts = parse(&text);
    for h in &mut hosts {
        if h.user.is_none() {
            h.user = me.clone();
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# 공통
User base
Host prod prod2
  HostName=10.0.0.1
  Port 2200
  IdentityFile ~/.ssh/id_prod   # 끝 주석은 값이 아님
  ProxyJump bastion
Host bastion
  HostName bastion.example.com
  User "ops user"
Host *.internal !skip.internal
  User internal
Host db.internal
  Port 5432
Host *
  User late
  IdentityFile none
Match host foo
  User ignored
Host weird
  HostName %x.example
"#;

    #[test]
    fn reads_hosts_with_first_value_wins() {
        let hosts = parse(SAMPLE);
        let get = |a: &str| hosts.iter().find(|h| h.alias == a);
        let prod = get("prod").unwrap();
        assert_eq!((prod.host.as_str(), prod.port), ("10.0.0.1", 2200));
        assert_eq!(prod.user.as_deref(), Some("base"));
        assert_eq!(prod.proxy_jump.as_deref(), Some("bastion"));
        assert!(prod.identity_file.as_deref().unwrap().ends_with("id_prod"));
        assert_eq!(get("prod2").unwrap().host, "10.0.0.1");
        assert_eq!(get("bastion").unwrap().user.as_deref(), Some("base"));
        assert_eq!(get("db.internal").unwrap().port, 5432);
    }

    #[test]
    fn skips_patterns_and_unresolvable_hosts() {
        let hosts = parse(SAMPLE);
        assert!(hosts.iter().all(|h| !h.alias.contains('*') && !h.alias.contains('!')));
        assert!(hosts.iter().all(|h| h.alias != "weird"));
        assert!(parse("Host x\n Port nope\n").is_empty());
    }

    #[test]
    fn negated_pattern_excludes() {
        let p = vec!["*.internal".to_string(), "!skip.internal".to_string()];
        assert!(matches(&p, "a.internal"));
        assert!(!matches(&p, "skip.internal"));
    }

    #[test]
    fn follows_includes_without_looping() {
        let dir = std::env::temp_dir().join(format!("sshconfig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        let main = dir.join("config");
        std::fs::write(&main, "Include conf.d/*.conf\nInclude config\nHost one\n  User a\n").unwrap();
        std::fs::write(dir.join("conf.d/b.conf"), "Host two\n  User b\n").unwrap();
        let hosts = load(&main);
        assert!(hosts.iter().any(|h| h.alias == "one"));
        assert!(hosts.iter().any(|h| h.alias == "two"));
        assert!(load(&dir.join("missing")).is_empty());
    }
}
