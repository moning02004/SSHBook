//! 무료 터미널 글꼴을 앱 안에서 내려받아 이 사용자 계정에 설치한다(관리자 권한 없이).
//!
//! 내려받는 주소와 파일의 SHA-256을 여기에 고정해 두고, 값이 다르면 설치하지 않는다.
//! 압축 파일 안에서도 정해 둔 글꼴 파일만 꺼낸다.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct FontPack {
    /// 화면 목록에 보이는 글꼴 이름(글꼴 파일 안의 이름과 같다)
    pub family: &'static str,
    url: &'static str,
    sha256: &'static str,
    /// 압축 파일 안의 경로, Windows 글꼴 목록에 쓸 이름
    files: &'static [(&'static str, &'static str)],
}

pub const PACKS: &[FontPack] = &[
    FontPack {
        family: "D2Coding",
        url: "https://github.com/naver/d2-coding-font/releases/download/VER1.4.0/D2Coding-Ver1.4.0-20261003.zip",
        sha256: "17e2da5e2879006eb725b87943f7988736ef8b6c9f8b84bc8e3bdbcb8dd46744",
        files: &[
            ("D2Coding/D2Coding-Ver1.4.0-20261003.ttf", "D2Coding"),
            ("D2Coding/D2CodingBold-Ver1.4.0-20261003.ttf", "D2Coding Bold"),
        ],
    },
    FontPack {
        family: "JetBrains Mono",
        url: "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip",
        sha256: "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf",
        files: &[
            ("fonts/ttf/JetBrainsMono-Regular.ttf", "JetBrains Mono Regular"),
            ("fonts/ttf/JetBrainsMono-Bold.ttf", "JetBrains Mono Bold"),
            ("fonts/ttf/JetBrainsMono-Italic.ttf", "JetBrains Mono Italic"),
            ("fonts/ttf/JetBrainsMono-BoldItalic.ttf", "JetBrains Mono Bold Italic"),
        ],
    },
    FontPack {
        family: "Fira Code",
        url: "https://github.com/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip",
        sha256: "0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79",
        files: &[
            ("ttf/FiraCode-Regular.ttf", "Fira Code Regular"),
            ("ttf/FiraCode-Bold.ttf", "Fira Code Bold"),
        ],
    },
    FontPack {
        family: "Source Code Pro",
        url: "https://github.com/adobe-fonts/source-code-pro/releases/download/2.042R-u/1.062R-i/1.026R-vf/TTF-source-code-pro-2.042R-u_1.062R-i.zip",
        sha256: "0c85bac90d15c040b82939aa92bc8404420fccc02e37bbcb9c93a7f21abb52c6",
        files: &[
            ("TTF/SourceCodePro-Regular.ttf", "Source Code Pro"),
            ("TTF/SourceCodePro-Bold.ttf", "Source Code Pro Bold"),
            ("TTF/SourceCodePro-It.ttf", "Source Code Pro Italic"),
            ("TTF/SourceCodePro-BoldIt.ttf", "Source Code Pro Bold Italic"),
        ],
    },
];

/// 압축 파일 크기 상한. 고정한 파일은 모두 30MB 아래다.
const MAX_DOWNLOAD: usize = 64 * 1024 * 1024;

pub fn pack(family: &str) -> Option<&'static FontPack> {
    PACKS.iter().find(|p| p.family == family)
}

/// 내려받아 확인하고 설치한다.
pub async fn install(pack: &FontPack) -> Result<(), String> {
    let zip = download(pack.url).await?;
    let data = verified(pack, zip)?;
    let dir = user_font_dir().ok_or("글꼴 폴더를 찾지 못했습니다.")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("글꼴 폴더를 만들지 못했습니다: {e}"))?;
    for (bytes, (inner, display)) in data.iter().zip(pack.files) {
        let name = Path::new(inner).file_name().ok_or("글꼴 파일 이름이 이상합니다.")?;
        let path = dir.join(name);
        // 이미 있으면(쓰는 중이라 잠겨 있을 수 있다) 덮어쓰지 않고 등록만 다시 한다.
        if !path.exists() {
            std::fs::write(&path, bytes).map_err(|e| format!("글꼴을 저장하지 못했습니다: {e}"))?;
        }
        register(&path, display)?;
    }
    after_install();
    Ok(())
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    // 업데이트 기능과 같은 TLS 설정(ring)을 쓴다.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let fail = |e: reqwest::Error| format!("글꼴을 내려받지 못했습니다: {e}");
    let client = reqwest::Client::builder()
        .user_agent("SSHBook")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(fail)?;
    let mut res = client
        .get(url)
        .send()
        .await
        .map_err(fail)?
        .error_for_status()
        .map_err(fail)?;
    let mut buf = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(fail)? {
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_DOWNLOAD {
            return Err("내려받은 파일이 너무 큽니다.".into());
        }
    }
    Ok(buf)
}

/// 해시를 확인하고 정해 둔 글꼴 파일만 꺼낸다(files 순서대로).
fn verified(pack: &FontPack, zip: Vec<u8>) -> Result<Vec<Vec<u8>>, String> {
    let hash = Sha256::digest(&zip);
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    if hex != pack.sha256 {
        return Err("내려받은 글꼴 파일이 예상과 다릅니다. 설치하지 않았습니다.".into());
    }
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| format!("압축을 풀지 못했습니다: {e}"))?;
    pack.files
        .iter()
        .map(|(inner, _)| {
            let mut f = archive
                .by_name(inner)
                .map_err(|e| format!("압축 파일에 {inner}가 없습니다: {e}"))?;
            let mut out = Vec::new();
            f.read_to_end(&mut out)
                .map_err(|e| format!("압축을 풀지 못했습니다: {e}"))?;
            Ok(out)
        })
        .collect()
}

#[cfg(windows)]
fn user_font_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Microsoft\Windows\Fonts"))
}

#[cfg(target_os = "macos")]
fn user_font_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Fonts"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn user_font_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("fonts"))
}

/// Windows: 이 사용자 글꼴 목록(레지스트리)에 올리고 지금 세션에도 불러온다.
#[cfg(windows)]
fn register(path: &Path, display: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let ok = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts",
            "/v",
            &format!("{display} (TrueType)"),
            "/t",
            "REG_SZ",
            "/d",
        ])
        .arg(path)
        .arg("/f")
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err("글꼴을 등록하지 못했습니다.".into());
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: wide는 끝에 0이 있는 경로 문자열이다.
    unsafe { windows_sys::Win32::Graphics::Gdi::AddFontResourceW(wide.as_ptr()) };
    Ok(())
}

#[cfg(not(windows))]
fn register(_path: &Path, _display: &str) -> Result<(), String> {
    Ok(())
}

/// 설치한 글꼴을 다른 프로그램(웹뷰 포함)이 알아채게 한다.
fn after_install() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, HWND_BROADCAST, WM_FONTCHANGE};
        // SAFETY: 인자 없는 방송 메시지다.
        unsafe { PostMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0) };
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = std::process::Command::new("fc-cache").arg("-f").status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_are_well_formed() {
        for p in PACKS {
            assert!(p.url.starts_with("https://github.com/"), "{}", p.family);
            assert_eq!(p.sha256.len(), 64, "{}", p.family);
            assert!(p
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(!p.files.is_empty());
            for (inner, _) in p.files {
                assert!(inner.ends_with(".ttf") && !inner.contains(".."), "{inner}");
            }
        }
        assert!(pack("D2Coding").is_some());
        assert!(pack("Comic Sans").is_none());
    }

    #[test]
    fn wrong_hash_is_refused() {
        let err = verified(&PACKS[0], b"not a zip".to_vec()).unwrap_err();
        assert!(err.contains("예상과 다릅니다"), "{err}");
    }

    /// 실제로 내려받아 해시와 압축 안의 파일을 확인한다(네트워크가 필요해서 평소엔 건너뛴다).
    #[tokio::test]
    #[ignore]
    async fn packs_download_and_verify() {
        for p in PACKS {
            let zip = download(p.url).await.unwrap();
            let files = verified(p, zip).unwrap();
            assert_eq!(files.len(), p.files.len());
            assert!(files.iter().all(|f| f.len() > 10_000));
        }
    }
}
