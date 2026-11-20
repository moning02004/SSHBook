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
        Self::open_inner(path, |salt, params| derive_key(password, salt, params))
    }

    /// 키체인에 기억해 둔 키로 연다. 비밀번호를 바꿨거나 다른 보관함을 가져왔으면 실패한다.
    pub fn open_with_key(path: &Path, key: &[u8]) -> Result<Self> {
        Self::open_inner(path, |_, _| {
            let k: [u8; 32] = key.try_into().map_err(|_| VaultError::Decrypt)?;
            Ok(Zeroizing::new(k))
        })
    }

    /// 키체인에 기억할 키
    pub fn key(&self) -> &[u8] {
        &self.key[..]
    }

    fn open_inner(path: &Path, make_key: impl FnOnce(&[u8], KdfParams) -> Result<Zeroizing<[u8; 32]>>) -> Result<Self> {
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

        let key = make_key(&salt, h.kdf.params)?;
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

    /// 지금 내용을 저장한 뒤 파일을 그대로 복사한다. 내보낸 파일도 같은 비밀번호로 잠겨 있다.
    pub fn export_to(&self, dest: &Path) -> Result<()> {
        self.save()?;
        if dest != self.path {
            fs::copy(&self.path, dest)?;
        }
        Ok(())
    }
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
        let dest = dir.join(format!("vault-{stamp}.sshv"));
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
            has_password: false,
            has_private_key: false,
            has_passphrase: false,
        }
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
    fn open_with_remembered_key() {
        let path = tmp_path("vault.sshv");
        let mut v = OpenVault::create(&path, "correct horse", FAST).unwrap();
        v.data.sessions.push(sample_session("s1"));
        v.save().unwrap();
        let key = v.key().to_vec();

        let again = OpenVault::open_with_key(&path, &key).unwrap();
        assert_eq!(again.data.sessions.len(), 1);
        assert!(OpenVault::open_with_key(&path, &[0u8; 32]).is_err());
        assert!(OpenVault::open_with_key(&path, &key[..10]).is_err());

        // 비밀번호를 바꾸면 기억해 둔 옛 키로는 열리지 않는다.
        v.change_password("battery staple").unwrap();
        assert!(OpenVault::open_with_key(&path, &key).is_err());
        assert!(OpenVault::open_with_key(&path, v.key()).is_ok());
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
        let exported = tmp_path("exported.sshv");
        v.export_to(&exported).unwrap();

        let other_pc = tmp_path("vault.sshv");
        let imported = import(&exported, &other_pc, "pw-12345678").unwrap();
        assert_eq!(imported.data.sessions[0].name, "prod-web-01");
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
