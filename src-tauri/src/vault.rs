//! 보관함 파일 (vault.sshv)
//!
//! 세션 목록과 비밀 정보(비밀번호, 개인 키, 패스프레이즈)를 파일 하나에 담아
//! 마스터 비밀번호로만 암호화한다. PC 고유 정보는 섞지 않으므로,
//! 파일을 다른 PC로 복사하고 같은 비밀번호를 넣으면 그대로 열린다(암호 걸린 엑셀 파일처럼).
//!
//! 형식 (JSON):
//! ```json
//! {
//!   "format": "sshbook-vault", "version": 1,
//!   "kdf":    { "alg": "argon2id", "m_kib": 65536, "t": 3, "p": 1, "salt": "<base64 16B>" },
//!   "cipher": { "alg": "aes-256-gcm", "nonce": "<base64 12B>" },
//!   "ciphertext": "<base64>"
//! }
//! ```
//! - 키 = Argon2id(마스터 비밀번호, salt, m/t/p) → 32바이트
//! - ciphertext = AES-256-GCM(키, nonce, 평문 JSON, AAD = ciphertext를 뺀 머리글 JSON)
//!   머리글을 AAD로 묶어서, 누가 KDF 설정 등을 바꾸면 복호화가 실패한다.
//! - 저장할 때마다 nonce를 새로 뽑는다. 비밀번호를 바꾸면 salt도 새로 뽑는다.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const FORMAT: &str = "sshbook-vault";
/// 예전 이름(SSH Terminal)으로 만든 보관함도 연다. 다음에 저장할 때 새 이름으로 바뀐다.
const LEGACY_FORMATS: &[&str] = &["ssh-terminal-vault"];
pub const VERSION: u32 = 1;
const KDF_ALG: &str = "argon2id";
const CIPHER_ALG: &str = "aes-256-gcm";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("보관함 파일을 읽거나 쓰지 못했습니다: {0}")]
    Io(#[from] std::io::Error),
    #[error("보관함 파일 형식이 아닙니다.")]
    Format,
    #[error("이 앱보다 새 버전에서 만든 보관함입니다 (형식 버전 {0}). 앱을 업데이트하세요.")]
    UnsupportedVersion(u32),
    #[error("마스터 비밀번호가 맞지 않거나 파일이 손상되었습니다.")]
    Decrypt,
    #[error("보관함의 암호화 설정이 허용 범위를 벗어났습니다.")]
    Kdf,
    #[error("보관함이 이미 있습니다.")]
    AlreadyExists,
    #[error("난수를 만들지 못했습니다.")]
    Random,
    #[error("보관함 파일 자신에게는 내보낼 수 없습니다. 다른 위치를 고르세요.")]
    SameFile,
}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl KdfParams {
    /// OWASP 권장 범위의 기본값. 보통 PC에서 0.3~1초 정도 걸린다.
    pub const DEFAULT: KdfParams = KdfParams {
        m_kib: 64 * 1024,
        t: 3,
        p: 1,
    };

    /// 다른 곳에서 가져온 파일이 터무니없는 값으로 메모리를 다 쓰지 않게 막는다.
    fn check(&self) -> Result<()> {
        let ok = (8..=1024 * 1024).contains(&self.m_kib) && (1..=20).contains(&self.t) && (1..=16).contains(&self.p);
        if ok {
            Ok(())
        } else {
            Err(VaultError::Kdf)
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct KdfHeader {
    alg: String,
    #[serde(flatten)]
    params: KdfParams,
    salt: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct CipherHeader {
    alg: String,
    nonce: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Header {
    format: String,
    version: u32,
    kdf: KdfHeader,
    cipher: CipherHeader,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    #[serde(flatten)]
    header: Header,
    ciphertext: String,
}

// ---- 보관함 안에 들어가는 내용 ----

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Local,
    Ssh,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    pub kind: SessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// "password" | "key" | "agent"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// 탭·창 테두리에 보일 환경 색 ("red" | "orange" | "yellow" | "green" | "blue" | "purple")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// 거쳐 갈 서버(다른 SSH 세션의 id)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_id: Option<String>,
    /// 연결할 때 함께 여는 포트 포워딩
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forwards: Vec<Forward>,
    /// 켜면 터미널 출력을 시각과 함께 파일로 남긴다
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub log_output: bool,
    /// 바로 접속을 끈 세션: 비밀번호·키 암호를 저장하지 않고 연결할 때마다 묻는다(저장할지도 묻지 않는다).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ask_login: bool,
    // 아래는 화면 표시용. 프론트엔드에서 온 값은 무시하고, 목록을 돌려줄 때만 채운다.
    #[serde(default, skip_deserializing)]
    pub has_password: bool,
    #[serde(default, skip_deserializing)]
    pub has_private_key: bool,
    #[serde(default, skip_deserializing)]
    pub has_passphrase: bool,
}

/// 포트 포워딩 하나.
/// - local(-L):   내 PC 127.0.0.1:bind_port → (서버에서 본) host:port
/// - remote(-R):  서버 localhost:bind_port → (내 PC에서 본) host:port
/// - dynamic(-D): 내 PC 127.0.0.1:bind_port에 SOCKS5 프록시
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub kind: ForwardKind,
    pub bind_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl Forward {
    /// 저장하거나 열기 전에 확인한다. 문제가 있으면 사용자에게 보일 문장.
    pub fn problem(&self) -> Option<&'static str> {
        if self.bind_port == 0 {
            return Some("포워딩 포트는 1~65535 사이여야 합니다.");
        }
        if self.kind != ForwardKind::Dynamic {
            let host_ok = self.host.as_deref().is_some_and(|h| !h.trim().is_empty());
            if !host_ok || self.port.unwrap_or(0) == 0 {
                return Some("포워딩 목적지의 호스트와 포트를 입력하세요.");
            }
        }
        None
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

/// 명령 모음(스니펫). 보관함에 같이 저장해서 다른 PC로도 따라간다.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub command: String,
}

/// 세션 그룹. 세션이 하나도 없어도 미리 만들어 둘 수 있고, 색을 정할 수 있다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub name: String,
    /// red / orange / yellow / green / blue / purple. 없으면 색 없음
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

pub const GROUP_COLORS: [&str; 6] = ["red", "orange", "yellow", "green", "blue", "purple"];
const GROUP_NAME_MAX: usize = 60;

#[derive(Serialize, Deserialize, Clone, Default, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// OpenSSH 형식 개인 키 원문
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

impl Secret {
    pub fn is_empty(&self) -> bool {
        self.password.is_none() && self.private_key.is_none() && self.passphrase.is_none()
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct VaultData {
    #[serde(default)]
    pub sessions: Vec<Session>,
    /// 세션 id → 비밀 정보
    #[serde(default)]
    pub secrets: BTreeMap<String, Secret>,
    /// "host:port" → 서버 공개 키(OpenSSH 한 줄). 사용자가 확인한 키만 들어간다.
    #[serde(default)]
    pub known_hosts: BTreeMap<String, String>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    /// 미리 만든 그룹과 그룹 색. 세션에만 적힌 그룹은 여기 없을 수도 있다.
    #[serde(default)]
    pub groups: Vec<Group>,
    /// 사이드바를 사용자가 끌어서 정한 순서로 보여 준다(sessions·groups 순서). 아니면 가나다순.
    #[serde(default)]
    pub manual_order: bool,
    /// 내보낸 파일에만 넣는 앱 설정(글꼴·테마·언어 등, JSON). 가져온 PC가 읽어서 적용한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_settings: Option<String>,
}

/// 내보내는 앱 설정의 최대 크기
pub const APP_SETTINGS_MAX: usize = 64 * 1024;

/// 사이드바에서 세션 하나의 자리: 순서대로 늘어놓은 세션과 그 그룹
#[derive(Deserialize, Debug, Clone)]
pub struct SessionPlace {
    pub id: String,
    pub group: Option<String>,
}

fn check_group_name(name: &str) -> std::result::Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("그룹 이름을 입력하세요.".into());
    }
    if name.chars().count() > GROUP_NAME_MAX {
        return Err("그룹 이름이 너무 깁니다.".into());
    }
    Ok(name.to_string())
}

fn check_group_color(color: Option<String>) -> std::result::Result<Option<String>, String> {
    match color {
        Some(c) if !GROUP_COLORS.contains(&c.as_str()) => Err("알 수 없는 색입니다.".into()),
        c => Ok(c),
    }
}

impl VaultData {
    /// 미리 만든 그룹 + 세션에만 적힌 그룹(색 없음). 정렬은 화면에서 한다.
    pub fn group_list(&self) -> Vec<Group> {
        let mut out = self.groups.clone();
        for g in self.sessions.iter().filter_map(|s| s.group.as_deref()) {
            let g = g.trim();
            if !g.is_empty() && !out.iter().any(|x| x.name == g) {
                out.push(Group {
                    name: g.to_string(),
                    color: None,
                });
            }
        }
        out
    }

    /// 사이드바 순서를 통째로 정한다. 목록에 없는 세션·그룹은 뒤에 그대로 남긴다.
    pub fn reorder(&mut self, groups: &[String], places: &[SessionPlace]) -> std::result::Result<(), String> {
        let groups = groups
            .iter()
            .map(|g| check_group_name(g))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut rest = std::mem::take(&mut self.sessions);
        let mut sessions = Vec::with_capacity(rest.len());
        for p in places {
            let Some(i) = rest.iter().position(|s| s.id == p.id) else {
                continue; // 그사이 지운 세션
            };
            let mut s = rest.remove(i);
            s.group = match p.group.as_deref().map(str::trim) {
                Some(g) if !g.is_empty() => Some(check_group_name(g)?),
                _ => None,
            };
            sessions.push(s);
        }
        sessions.append(&mut rest);
        self.sessions = sessions;

        let mut old = std::mem::take(&mut self.groups);
        let mut ordered = Vec::with_capacity(groups.len() + old.len());
        for name in groups {
            if ordered.iter().any(|g: &Group| g.name == name) {
                continue;
            }
            match old.iter().position(|g| g.name == name) {
                Some(i) => ordered.push(old.remove(i)),
                None => ordered.push(Group { name, color: None }),
            }
        }
        ordered.append(&mut old);
        self.groups = ordered;
        self.manual_order = true;
        Ok(())
    }

    /// 그룹을 만든다. 같은 이름이 이미 있으면 거절한다.
    pub fn group_add(&mut self, name: &str, color: Option<String>) -> std::result::Result<Group, String> {
        let name = check_group_name(name)?;
        let color = check_group_color(color)?;
        if self.group_list().iter().any(|g| g.name == name) {
            return Err("같은 이름의 그룹이 있습니다.".into());
        }
        let g = Group { name, color };
        self.groups.push(g.clone());
        Ok(g)
    }

    /// 그룹 색을 바꾼다. 세션에만 적혀 있던 그룹이면 이때 목록에 넣는다.
    pub fn group_set_color(&mut self, name: &str, color: Option<String>) -> std::result::Result<(), String> {
        let color = check_group_color(color)?;
        if let Some(g) = self.groups.iter_mut().find(|g| g.name == name) {
            g.color = color;
        } else if self.sessions.iter().any(|s| s.group.as_deref() == Some(name)) {
            self.groups.push(Group {
                name: name.to_string(),
                color,
            });
        } else {
            return Err("그룹을 찾지 못했습니다.".into());
        }
        Ok(())
    }

    /// 그룹 이름을 바꾼다(그 그룹의 세션 모두). to가 비면 그룹을 지운다(세션은 그룹 없음으로).
    /// 이미 있는 그룹 이름으로 바꾸면 두 그룹을 합치고 색은 받는 쪽 것을 쓴다. 옮긴 세션 수를 돌려준다.
    pub fn group_rename(&mut self, from: &str, to: &str) -> std::result::Result<usize, String> {
        if to.trim().is_empty() {
            return Ok(self.group_delete(from));
        }
        let to = check_group_name(to)?;
        let mut n = 0;
        for s in self.sessions.iter_mut().filter(|s| s.group.as_deref() == Some(from)) {
            s.group = Some(to.clone());
            n += 1;
        }
        let target_exists = self.groups.iter().any(|g| g.name == to);
        if let Some(i) = self.groups.iter().position(|g| g.name == from) {
            if target_exists {
                self.groups.remove(i);
            } else {
                self.groups[i].name = to;
            }
        }
        Ok(n)
    }

    /// 그룹을 지운다. 그 그룹의 세션은 그룹 없음으로 옮긴다. 옮긴 세션 수를 돌려준다.
    pub fn group_delete(&mut self, name: &str) -> usize {
        self.groups.retain(|g| g.name != name);
        let mut n = 0;
        for s in self.sessions.iter_mut().filter(|s| s.group.as_deref() == Some(name)) {
            s.group = None;
            n += 1;
        }
        n
    }
}

// ---- 열린 보관함 ----

pub struct OpenVault {
    path: PathBuf,
    key: Zeroizing<[u8; 32]>,
    params: KdfParams,
    salt: Vec<u8>,
    pub data: VaultData,
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|_| VaultError::Random)?;
    Ok(buf)
}

fn derive_key(password: &str, salt: &[u8], p: KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    p.check()?;
    let params = Params::new(p.m_kib, p.t, p.p, Some(32)).map_err(|_| VaultError::Kdf)?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key[..])
        .map_err(|_| VaultError::Kdf)?;
    Ok(key)
}

impl OpenVault {
    /// 새 보관함을 만들고 바로 저장한다. 파일이 이미 있으면 실패한다.
    pub fn create(path: &Path, password: &str, params: KdfParams) -> Result<Self> {
        if path.exists() {
            return Err(VaultError::AlreadyExists);
        }
        let salt = random::<SALT_LEN>()?.to_vec();
        let key = derive_key(password, &salt, params)?;
        let v = OpenVault {
            path: path.to_path_buf(),
            key,
            params,
            salt,
            data: VaultData::default(),
        };
        v.save()?;
        Ok(v)
    }

    /// 파일을 마스터 비밀번호로 연다. 어느 PC에서 만든 파일이든 같다.
    pub fn open(path: &Path, password: &str) -> Result<Self> {
        let bytes = fs::read(path)?;
        let env: Envelope = serde_json::from_slice(&bytes).map_err(|_| VaultError::Format)?;
        let h = &env.header;
        if h.format != FORMAT && !LEGACY_FORMATS.contains(&h.format.as_str()) {
            return Err(VaultError::Format);
        }
        if h.version > VERSION {
            return Err(VaultError::UnsupportedVersion(h.version));
        }
        if h.kdf.alg != KDF_ALG || h.cipher.alg != CIPHER_ALG {
            return Err(VaultError::Format);
        }
        let salt = B64.decode(&h.kdf.salt).map_err(|_| VaultError::Format)?;
        let nonce = B64.decode(&h.cipher.nonce).map_err(|_| VaultError::Format)?;
        let ct = B64.decode(&env.ciphertext).map_err(|_| VaultError::Format)?;
        if salt.len() < SALT_LEN || nonce.len() != NONCE_LEN {
            return Err(VaultError::Format);
        }

        let key = derive_key(password, &salt, h.kdf.params)?;
        let aad = serde_json::to_vec(h).map_err(|_| VaultError::Format)?;
        let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| VaultError::Decrypt)?;
        let plain = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: &aad })
                .map_err(|_| VaultError::Decrypt)?,
        );
        let data: VaultData = serde_json::from_slice(&plain).map_err(|_| VaultError::Format)?;
        Ok(OpenVault {
            path: path.to_path_buf(),
            key,
            params: h.kdf.params,
            salt,
            data,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn seal(&self) -> Result<Vec<u8>> {
        self.seal_as(FORMAT)
    }

    fn seal_as(&self, format: &str) -> Result<Vec<u8>> {
        let plain = Zeroizing::new(serde_json::to_vec(&self.data).map_err(|_| VaultError::Format)?);
        let nonce = random::<NONCE_LEN>()?;
        let header = Header {
            format: format.into(),
            version: VERSION,
            kdf: KdfHeader {
                alg: KDF_ALG.into(),
                params: self.params,
                salt: B64.encode(&self.salt),
            },
            cipher: CipherHeader {
                alg: CIPHER_ALG.into(),
                nonce: B64.encode(nonce),
            },
        };
        let aad = serde_json::to_vec(&header).map_err(|_| VaultError::Format)?;
        let cipher = Aes256Gcm::new_from_slice(&self.key[..]).map_err(|_| VaultError::Decrypt)?;
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &aad })
            .map_err(|_| VaultError::Decrypt)?;
        let env = Envelope {
            header,
            ciphertext: B64.encode(ct),
        };
        serde_json::to_vec_pretty(&env).map_err(|_| VaultError::Format)
    }

    /// 임시 파일에 쓴 뒤 바꿔치기해서, 저장 도중 꺼져도 기존 파일이 깨지지 않게 한다.
    pub fn save(&self) -> Result<()> {
        let bytes = self.seal()?;
        if let Some(dir) = self.path.parent() {
            crate::fsperm::private_dir(dir)?;
        }
        // 덮어쓰기 전에 지금 파일을 백업해 둔다(한 시간에 최대 하나).
        let _ = backup::take(&self.path, backup::MIN_GAP_SECS);
        let tmp = self.path.with_extension("sshv.tmp");
        crate::fsperm::write_private(&tmp, &bytes)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// 새 salt로 키를 다시 만들고 저장한다. 내보낸 옛 파일은 옛 비밀번호로 계속 열린다.
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        // 비밀번호를 바꾸기 직전 상태는 시간과 상관없이 남긴다.
        backup::take(&self.path, 0)?;
        let salt = random::<SALT_LEN>()?.to_vec();
        self.key = derive_key(new_password, &salt, self.params)?;
        self.salt = salt;
        self.save()
    }

    /// 지금 내용을 다른 비밀번호로 잠근 파일로 내보낸다(이 보관함은 그대로).
    /// 마스터 비밀번호 없이 쓸 때: 다른 PC에는 이 PC의 열쇠 파일이 없기 때문이다.
    pub fn export_with_password(&self, dest: &Path, password: &str, app_settings: Option<String>) -> Result<()> {
        if same_file(dest, &self.path) {
            return Err(VaultError::SameFile);
        }
        let salt = random::<SALT_LEN>()?.to_vec();
        let key = derive_key(password, &salt, self.params)?;
        self.write_copy(dest, key, salt, app_settings)
    }

    /// 이 보관함의 내용(+앱 설정)을 dest에 주어진 키로 잠가 쓴다.
    fn write_copy(
        &self,
        dest: &Path,
        key: Zeroizing<[u8; 32]>,
        salt: Vec<u8>,
        app_settings: Option<String>,
    ) -> Result<()> {
        let mut data = self.data.clone();
        data.app_settings = app_settings.filter(|s| s.len() <= APP_SETTINGS_MAX);
        let copy = OpenVault {
            path: dest.to_path_buf(),
            key,
            params: self.params,
            salt,
            data,
        };
        // 임시 파일에 쓴 뒤 바꿔치기해서, 실패해도 그 자리의 파일이 깨지지 않게 한다.
        let mut tmp = dest.as_os_str().to_owned();
        tmp.push(".sshbook-tmp");
        let tmp = PathBuf::from(tmp);
        crate::fsperm::write_private(&tmp, &copy.seal()?)?;
        fs::rename(&tmp, dest).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })?;
        Ok(())
    }

    /// 이 파일만 새 비밀번호로 다시 잠근다(백업을 만들지 않고, 수정 시각도 유지한다).
    fn reseal_in_place(&mut self, new_password: &str) -> Result<()> {
        let when = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        let salt = random::<SALT_LEN>()?.to_vec();
        self.key = derive_key(new_password, &salt, self.params)?;
        self.salt = salt;
        let bytes = self.seal()?;
        let tmp = self.path.with_extension("sshv.tmp");
        crate::fsperm::write_private(&tmp, &bytes)?;
        fs::rename(&tmp, &self.path)?;
        if let (Some(t), Ok(f)) = (when, fs::File::options().write(true).open(&self.path)) {
            let _ = f.set_modified(t);
        }
        Ok(())
    }

    /// 지금 내용을 저장한 뒤 파일을 그대로 복사한다. 내보낸 파일도 같은 비밀번호로 잠겨 있다.
    /// 같은 마스터 비밀번호로 잠근 사본을 내보낸다. 앱 설정도 함께 넣는다.
    pub fn export_to(&self, dest: &Path, app_settings: Option<String>) -> Result<()> {
        self.save()?;
        // 다른 경로 표기(심볼릭 링크 등)로 자기 자신에 쓰면 보관함이 바뀔 수 있다.
        if same_file(dest, &self.path) {
            return Ok(());
        }
        self.write_copy(dest, self.key.clone(), self.salt.clone(), app_settings)
    }
}

/// 두 경로가 같은 파일인지(없는 경로는 글자로만 비교)
fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// 파일 하나를 old로 열어 new로 다시 잠근다(다른 비밀번호의 파일이면 실패하고 그대로 둔다).
pub fn rekey_file(path: &Path, old: &str, new: &str) -> Result<()> {
    OpenVault::open(path, old)?.reseal_in_place(new)
}

/// 보관함 자동 백업. 보관함 옆 `backups/` 폴더에 `vault-<날짜-시각>.sshv`로 남긴다.
/// 백업도 그때의 마스터 비밀번호로 잠겨 있다(복사본이므로).
pub mod backup {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

    /// 같은 시간대에 너무 많이 쌓이지 않게: 마지막 백업 뒤 이만큼 지나야 새로 만든다.
    pub const MIN_GAP_SECS: u64 = 60 * 60;
    /// 이보다 많으면 오래된 것부터 지운다.
    pub const KEEP: usize = 10;

    #[derive(serde::Serialize, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct Backup {
        pub path: String,
        /// 유닉스 시각(초)
        pub modified: u64,
        pub size: u64,
    }

    pub fn dir_for(vault: &Path) -> PathBuf {
        vault.parent().unwrap_or(Path::new(".")).join("backups")
    }

    /// 백업 목록, 새것부터
    pub fn list(vault: &Path) -> Vec<Backup> {
        let Ok(rd) = fs::read_dir(dir_for(vault)) else {
            return vec![];
        };
        let mut v: Vec<Backup> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "sshv"))
            .filter_map(|p| {
                let m = fs::metadata(&p).ok()?;
                let t = m
                    .modified()
                    .ok()?
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .ok()?
                    .as_secs();
                Some(Backup {
                    path: p.display().to_string(),
                    modified: t,
                    size: m.len(),
                })
            })
            .collect();
        v.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.path.cmp(&a.path)));
        v
    }

    /// 보관함이 있고 마지막 백업이 min_gap보다 오래됐으면 지금 파일을 복사해 둔다.
    pub fn take(vault: &Path, min_gap_secs: u64) -> std::io::Result<Option<PathBuf>> {
        if !vault.exists() {
            return Ok(None);
        }
        let newest = list(vault).into_iter().next();
        if let Some(b) = &newest {
            let age = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH + Duration::from_secs(b.modified))
                .unwrap_or_default();
            if age.as_secs() < min_gap_secs {
                return Ok(None);
            }
        }
        let dir = dir_for(vault);
        crate::fsperm::private_dir(&dir)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
        // 같은 순간에 두 번 백업해도 겹치지 않게 짧은 임의 꼬리를 붙인다.
        let tail = &uuid::Uuid::new_v4().simple().to_string()[..6];
        let dest = dir.join(format!("vault-{stamp}-{tail}.sshv"));
        fs::copy(vault, &dest)?;
        crate::fsperm::fix_mode(&dest)?;
        // 복사본의 수정 시각을 지금으로 맞춘다(목록 정렬과 간격 계산에 쓴다).
        if let Ok(f) = fs::File::options().write(true).open(&dest) {
            let _ = f.set_modified(SystemTime::now());
        }
        for old in list(vault).into_iter().skip(KEEP) {
            let _ = fs::remove_file(old.path);
        }
        Ok(Some(dest))
    }

    /// old 비밀번호로 열리는 백업을 new로 다시 잠근다(다른 비밀번호의 백업은 그대로). 바꾼 개수.
    pub fn rekey(vault: &Path, old: &str, new: &str) -> usize {
        list(vault)
            .iter()
            .filter(|b| {
                super::OpenVault::open(Path::new(&b.path), old)
                    .and_then(|mut v| v.reseal_in_place(new))
                    .is_ok()
            })
            .count()
    }

    /// 복구할 파일이 정말 이 보관함의 백업 폴더 안에 있는지
    pub fn is_backup_of(vault: &Path, candidate: &Path) -> bool {
        let dir = dir_for(vault);
        match (dir.canonicalize(), candidate.canonicalize()) {
            (Ok(d), Ok(c)) => c.starts_with(d) && c.extension().is_some_and(|x| x == "sshv"),
            _ => false,
        }
    }
}

/// 다른 PC에서 가져온 파일을 확인하고 dest 자리에 놓은 뒤 연다.
/// dest에 이미 보관함이 있으면 `.sshv.bak`으로 남겨 둔다.
pub fn import(src: &Path, dest: &Path, password: &str) -> Result<OpenVault> {
    OpenVault::open(src, password)?; // 비밀번호가 맞는지 먼저 확인
    if let Some(dir) = dest.parent() {
        crate::fsperm::private_dir(dir)?;
    }
    if dest.exists() && src != dest {
        let bak = dest.with_extension("sshv.bak");
        fs::copy(dest, &bak)?;
        crate::fsperm::fix_mode(&bak)?;
    }
    if src != dest {
        fs::copy(src, dest)?;
        crate::fsperm::fix_mode(dest)?;
    }
    OpenVault::open(dest, password)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 테스트는 빠르게 돌도록 KDF를 가볍게 한다.
    const FAST: KdfParams = KdfParams {
        m_kib: 1024,
        t: 1,
        p: 1,
    };

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sshv-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn pw_secret(pw: &str) -> Secret {
        Secret {
            password: Some(pw.into()),
            private_key: None,
            passphrase: None,
        }
    }

    fn sample_session(id: &str) -> Session {
        Session {
            id: id.into(),
            name: "prod-web-01".into(),
            group: Some("운영".into()),
            kind: SessionKind::Ssh,
            shell: None,
            cwd: None,
            host: Some("10.0.1.21".into()),
            port: Some(22),
            user: Some("deploy".into()),
            auth: Some("password".into()),
            key_path: None,
            color: None,
            jump_id: None,
            forwards: vec![],
            log_output: false,
            ask_login: false,
            has_password: false,
            has_private_key: false,
            has_passphrase: false,
        }
    }

    #[test]
    fn reorder_sets_session_order_groups_and_group_order() {
        let mut d = VaultData::default();
        for (id, g) in [("a", Some("운영")), ("b", Some("개발")), ("c", None)] {
            let mut s = sample_session(id);
            s.group = g.map(String::from);
            d.sessions.push(s);
        }
        d.groups.push(Group {
            name: "개발".into(),
            color: Some("blue".into()),
        });
        assert!(!d.manual_order);
        let place = |id: &str, g: Option<&str>| SessionPlace {
            id: id.into(),
            group: g.map(String::from),
        };
        d.reorder(
            &["운영".into(), "개발".into()],
            &[place("c", Some("개발")), place("b", Some("개발")), place("x", None)],
        )
        .unwrap();
        assert!(d.manual_order);
        let ids: Vec<_> = d.sessions.iter().map(|s| (s.id.as_str(), s.group.as_deref())).collect();
        // 목록에 없던 a는 뒤에 그대로, 없는 x는 무시
        assert_eq!(ids, [("c", Some("개발")), ("b", Some("개발")), ("a", Some("운영"))]);
        let groups: Vec<_> = d.groups.iter().map(|g| (g.name.as_str(), g.color.as_deref())).collect();
        assert_eq!(groups, [("운영", None), ("개발", Some("blue"))]);
        assert!(d.reorder(&["".into()], &[]).is_err());
    }

    #[test]
    fn groups_can_be_empty_colored_renamed_and_deleted() {
        let mut d = VaultData::default();
        d.sessions.push(sample_session("s1")); // 그룹 "운영"
                                               // 세션에만 적힌 그룹도 목록에 나온다(색 없음).
        assert_eq!(
            d.group_list(),
            vec![Group {
                name: "운영".into(),
                color: None
            }]
        );

        // 세션 없는 그룹을 미리 만든다.
        d.group_add(" 개발 ", Some("green".into())).unwrap();
        assert!(d.group_add("개발", None).is_err());
        assert!(d.group_add("운영", None).is_err());
        assert!(d.group_add("  ", None).is_err());
        assert!(d.group_add("x", Some("pink".into())).is_err());
        assert_eq!(d.group_list().len(), 2);

        // 세션에만 있던 그룹에 색을 주면 목록에 들어간다.
        d.group_set_color("운영", Some("red".into())).unwrap();
        assert!(d
            .groups
            .iter()
            .any(|g| g.name == "운영" && g.color.as_deref() == Some("red")));
        assert!(d.group_set_color("없는 그룹", None).is_err());

        // 이름을 바꾸면 세션도 따라간다. 이미 있는 이름이면 합치고 받는 쪽 색을 쓴다.
        assert_eq!(d.group_rename("운영", "prod").unwrap(), 1);
        assert_eq!(d.sessions[0].group.as_deref(), Some("prod"));
        assert_eq!(d.group_rename("prod", "개발").unwrap(), 1);
        assert_eq!(
            d.group_list(),
            vec![Group {
                name: "개발".into(),
                color: Some("green".into())
            }]
        );

        // 지우면 세션은 그룹 없음으로 간다.
        assert_eq!(d.group_delete("개발"), 1);
        assert_eq!(d.sessions[0].group, None);
        assert!(d.group_list().is_empty());
    }

    #[test]
    fn legacy_format_opens_and_upgrades_on_save() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        v.data.sessions.push(sample_session("s1"));
        fs::write(&path, v.seal_as(LEGACY_FORMATS[0]).unwrap()).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains(LEGACY_FORMATS[0]));

        let v = OpenVault::open(&path, "correct horse").unwrap();
        assert_eq!(v.data.sessions.len(), 1);
        v.save().unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains(FORMAT));
        assert!(OpenVault::open(&path, "correct horse").is_ok());
    }

    #[test]
    fn saves_keep_hourly_backups_and_restore_works() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        assert!(backup::list(&path).is_empty(), "처음 만들 때는 이전 파일이 없다");
        v.data.sessions.push(sample_session("s1"));
        v.save().unwrap();
        assert_eq!(backup::list(&path).len(), 1);
        v.data.sessions.push(sample_session("s2"));
        v.save().unwrap();
        assert_eq!(backup::list(&path).len(), 1, "한 시간 안에는 하나만");

        // 비밀번호 변경 직전은 늘 남긴다.
        v.change_password("battery staple").unwrap();
        let list = backup::list(&path);
        assert_eq!(list.len(), 2);

        // 가장 최근 백업 = 변경 직전(세션 2개, 옛 비밀번호)
        let newest = Path::new(&list[0].path);
        assert!(backup::is_backup_of(&path, newest));
        assert!(!backup::is_backup_of(&path, &path));
        let restored = import(newest, &path, "correct horse").unwrap();
        assert_eq!(restored.data.sessions.len(), 2);
    }

    #[test]
    fn passwordless_round_trip_keeps_backups_openable() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "master one", FAST).unwrap();
        v.data.sessions.push(sample_session("s1"));
        v.save().unwrap();

        // 끄기: 임의 비밀번호로 다시 잠근다. 그 직전 백업은 옛 비밀번호로 남는다.
        v.change_password("random-secret").unwrap();
        assert!(OpenVault::open(&path, "random-secret").is_ok());
        assert!(OpenVault::open(&path, "master one").is_err());

        // 내보내기는 받은 비밀번호로 잠기고, 이 보관함은 그대로다.
        let out = tmp_path("export.sshv");
        v.export_with_password(&out, "for other pc", None).unwrap();
        assert_eq!(OpenVault::open(&out, "for other pc").unwrap().data.sessions.len(), 1);
        assert!(OpenVault::open(&out, "random-secret").is_err());
        assert!(OpenVault::open(&path, "random-secret").is_ok());

        // 다시 켜기: 끈 동안의 백업도 새 비밀번호로 열려야 한다.
        v.change_password("master two").unwrap();
        let before: Vec<u64> = backup::list(&path).iter().map(|b| b.modified).collect();
        assert_eq!(backup::rekey(&path, "random-secret", "master two"), 1);
        let list = backup::list(&path);
        assert_eq!(
            list.iter().map(|b| b.modified).collect::<Vec<_>>(),
            before,
            "시각은 그대로"
        );
        let opens = |pw: &str| {
            list.iter()
                .filter(|b| OpenVault::open(Path::new(&b.path), pw).is_ok())
                .count()
        };
        assert_eq!(opens("random-secret"), 0);
        assert_eq!(opens("master two"), 1);
        assert!(opens("master one") >= 1, "끄기 전 백업은 그때 비밀번호로 남는다");
    }

    #[test]
    fn export_refuses_the_vault_itself() {
        let path = tmp_path("vault.sshv");
        let v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        assert!(matches!(
            v.export_with_password(&path, "other pw 1", None),
            Err(VaultError::SameFile)
        ));
        // 같은 파일을 다른 표기로 가리켜도 막는다.
        let dotted = path.parent().unwrap().join(".").join("vault.sshv");
        assert!(matches!(
            v.export_with_password(&dotted, "other pw 1", None),
            Err(VaultError::SameFile)
        ));
        v.export_to(&dotted, None).unwrap();
        assert!(OpenVault::open(&path, "correct horse").is_ok());
    }

    #[test]
    fn forward_validation() {
        let f = |kind, bind_port, host: Option<&str>, port| Forward {
            kind,
            bind_port,
            host: host.map(String::from),
            port,
        };
        assert!(f(ForwardKind::Local, 8000, Some("db"), Some(5432)).problem().is_none());
        assert!(f(ForwardKind::Dynamic, 1080, None, None).problem().is_none());
        assert!(f(ForwardKind::Dynamic, 0, None, None).problem().is_some());
        assert!(f(ForwardKind::Local, 8000, Some("  "), Some(5432)).problem().is_some());
        assert!(f(ForwardKind::Remote, 8000, Some("db"), Some(0)).problem().is_some());
    }

    #[test]
    fn backups_are_pruned() {
        let path = tmp_path("vault.sshv");
        let v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        for _ in 0..(backup::KEEP + 3) {
            backup::take(&path, 0).unwrap();
        }
        assert_eq!(backup::list(&path).len(), backup::KEEP);
        drop(v);
    }

    #[test]
    fn older_vault_without_new_fields_still_opens() {
        let json =
            r#"{"sessions":[{"id":"a","name":"n","kind":"ssh","host":"h","user":"u"}],"secrets":{},"known_hosts":{}}"#;
        let d: VaultData = serde_json::from_str(json).unwrap();
        assert!(d.snippets.is_empty());
        let s = &d.sessions[0];
        assert!(s.forwards.is_empty() && !s.log_output && s.color.is_none() && s.jump_id.is_none());
    }

    #[test]
    fn unknown_format_is_rejected() {
        let path = tmp_path("vault.sshv");
        let v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        fs::write(&path, v.seal_as("other-app").unwrap()).unwrap();
        assert!(matches!(
            OpenVault::open(&path, "correct horse"),
            Err(VaultError::Format)
        ));
    }

    #[test]
    fn create_save_and_reopen() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        v.data.sessions.push(sample_session("s1"));
        v.data.secrets.insert("s1".into(), pw_secret("hunter2"));
        v.save().unwrap();

        let again = OpenVault::open(&path, "correct horse").unwrap();
        assert_eq!(again.data.sessions.len(), 1);
        assert_eq!(again.data.secrets["s1"].password.as_deref(), Some("hunter2"));
    }

    #[test]
    fn wrong_password_is_rejected() {
        let path = tmp_path("vault.sshv");
        OpenVault::create(&path, "correct horse", FAST).unwrap();
        assert!(matches!(OpenVault::open(&path, "wrong"), Err(VaultError::Decrypt)));
    }

    #[test]
    fn file_does_not_contain_plaintext() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "pw-12345678", FAST).unwrap();
        v.data.sessions.push(sample_session("s1"));
        v.data.secrets.insert("s1".into(), pw_secret("hunter2"));
        v.save().unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("hunter2"));
        assert!(!text.contains("10.0.1.21"));
    }

    #[test]
    fn tampering_with_header_breaks_decryption() {
        let path = tmp_path("vault.sshv");
        OpenVault::create(&path, "pw-12345678", FAST).unwrap();
        let text = fs::read_to_string(&path).unwrap().replace("\"t\": 1", "\"t\": 2");
        fs::write(&path, text).unwrap();
        assert!(matches!(
            OpenVault::open(&path, "pw-12345678"),
            Err(VaultError::Decrypt)
        ));
    }

    #[test]
    fn copied_file_opens_elsewhere_with_same_password() {
        // 다른 PC로 옮기는 경우: 파일만 복사해도 열려야 한다.
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "pw-12345678", FAST).unwrap();
        v.data.sessions.push(sample_session("s1"));
        v.data.groups.push(Group {
            name: "운영".into(),
            color: Some("red".into()),
        });
        let exported = tmp_path("book_settings.sshbook");
        v.export_to(&exported, Some(r#"{"settings":{"fontSize":15}}"#.into()))
            .unwrap();
        // 내 보관함에는 앱 설정을 남기지 않는다.
        assert!(OpenVault::open(&path, "pw-12345678")
            .unwrap()
            .data
            .app_settings
            .is_none());

        let other_pc = tmp_path("vault.sshv");
        let imported = import(&exported, &other_pc, "pw-12345678").unwrap();
        assert_eq!(imported.data.sessions[0].name, "prod-web-01");
        assert_eq!(imported.data.groups[0].color.as_deref(), Some("red"));
        assert_eq!(
            imported.data.app_settings.as_deref(),
            Some(r#"{"settings":{"fontSize":15}}"#)
        );
        assert!(import(&exported, &other_pc, "wrong").is_err());
    }

    #[test]
    fn change_password_replaces_old_one() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "old-password", FAST).unwrap();
        v.change_password("new-password").unwrap();
        assert!(OpenVault::open(&path, "old-password").is_err());
        assert!(OpenVault::open(&path, "new-password").is_ok());
    }

    #[test]
    fn absurd_kdf_params_are_refused() {
        let path = tmp_path("vault.sshv");
        OpenVault::create(&path, "pw-12345678", FAST).unwrap();
        let text = fs::read_to_string(&path)
            .unwrap()
            .replace("\"m_kib\": 1024", "\"m_kib\": 4000000000");
        fs::write(&path, text).unwrap();
        assert!(matches!(OpenVault::open(&path, "pw-12345678"), Err(VaultError::Kdf)));
    }
}
