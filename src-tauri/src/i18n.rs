//! 터미널에 직접 쓰는 문구와 macOS 메뉴의 언어.
//! 문구표는 화면과 같은 `src/i18n/en.json`을 쓴다.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static ENGLISH: AtomicBool = AtomicBool::new(false);
static TABLE: OnceLock<HashMap<String, String>> = OnceLock::new();

fn table() -> &'static HashMap<String, String> {
    TABLE.get_or_init(|| serde_json::from_str(include_str!("../../src/i18n/en.json")).unwrap_or_default())
}

pub fn set_language(lang: &str) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

/// 저장된 언어를 읽는다(앱을 켤 때).
pub fn load(path: &Path) {
    if let Ok(s) = std::fs::read_to_string(path) {
        set_language(s.trim());
    }
}

/// `{}` 자리를 뺀 글자들이 순서대로 맞으면 그 자리의 값을 돌려준다.
fn captures<'a>(pattern: &str, text: &'a str) -> Option<Vec<&'a str>> {
    let parts: Vec<&str> = pattern.split("{}").collect();
    let mut rest = text.strip_prefix(parts[0])?;
    let mut values = Vec::new();
    for (i, part) in parts.iter().enumerate().skip(1) {
        if i == parts.len() - 1 {
            let v = if part.is_empty() {
                rest
            } else {
                rest.strip_suffix(part)?
            };
            values.push(v);
            rest = "";
        } else {
            let at = rest.find(part)?;
            values.push(&rest[..at]);
            rest = &rest[at + part.len()..];
        }
    }
    rest.is_empty().then_some(values)
}

fn translate(text: &str, depth: u8) -> String {
    if depth > 3 {
        return text.to_string();
    }
    let t = table();
    if let Some(v) = t.get(text) {
        return v.clone();
    }
    let mut best: Option<(&String, &String, Vec<&str>)> = None;
    for (k, v) in t.iter().filter(|(k, _)| k.contains("{}")) {
        if let Some(values) = captures(k, text) {
            if best.as_ref().is_none_or(|(b, _, _)| k.len() > b.len()) {
                best = Some((k, v, values));
            }
        }
    }
    let Some((_, en, values)) = best else {
        return text.to_string();
    };
    let mut out = String::new();
    let mut parts = en.split("{}");
    out.push_str(parts.next().unwrap_or(""));
    for (part, value) in parts.zip(values) {
        out.push_str(&translate(value, depth + 1));
        out.push_str(part);
    }
    out
}

/// 영어로 쓰는 중이면 번역한다. 모르는 문장은 그대로 둔다.
pub fn tr(text: &str) -> String {
    if ENGLISH.load(Ordering::Relaxed) {
        translate(text, 0)
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_nested_values() {
        assert_eq!(translate("파일", 0), "File");
        assert_eq!(
            translate("내 PC 127.0.0.1:8000 → db:5432", 0),
            "This PC 127.0.0.1:8000 → db:5432"
        );
        assert_eq!(
            translate(
                "내 PC 127.0.0.1:8000 → db:5432 — 열지 못했습니다: 포트 8000를 열지 못했습니다 (busy)",
                0
            ),
            "This PC 127.0.0.1:8000 → db:5432 — could not open: Could not open port 8000 (busy)"
        );
        assert_eq!(translate("unknown", 0), "unknown");
    }
}
