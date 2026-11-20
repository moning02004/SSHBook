//! 보관함 파일 (vault.sshv)
//!
//! 세션 목록과 비밀 정보(비밀번호, 개인 키, 패스프레이즈)를 파일 하나에 담아
//! 마스터 비밀번호로만 암호화한다. PC 고유 정보는 섞지 않으므로,
//! 파일을 다른 PC로 복사하고 같은 비밀번호를 넣으면 그대로 열린다(암호 걸린 엑셀 파일처럼).
//!
//! 형식 (JSON):
//! ```json
//! {
//!   "format": "ssh-terminal-vault", "version": 1,
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

pub const FORMAT: &str = "ssh-terminal-vault";
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
    // 아래는 화면 표시용. 프론트엔드에서 온 값은 무시하고, 목록을 돌려줄 때만 채운다.
    #[serde(default, skip_deserializing)]
    pub has_password: bool,
    #[serde(default, skip_deserializing)]
    pub has_private_key: bool,
    #[serde(default, skip_deserializing)]
    pub has_passphrase: bool,
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
        if h.format != FORMAT {
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
        let plain = Zeroizing::new(serde_json::to_vec(&self.data).map_err(|_| VaultError::Format)?);
        let nonce = random::<NONCE_LEN>()?;
        let header = Header {
            format: FORMAT.into(),
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
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("sshv.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// 새 salt로 키를 다시 만들고 저장한다. 내보낸 옛 파일은 옛 비밀번호로 계속 열린다.
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
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

/// 다른 PC에서 가져온 파일을 확인하고 dest 자리에 놓은 뒤 연다.
/// dest에 이미 보관함이 있으면 `.sshv.bak`으로 남겨 둔다.
pub fn import(src: &Path, dest: &Path, password: &str) -> Result<OpenVault> {
    OpenVault::open(src, password)?; // 비밀번호가 맞는지 먼저 확인
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir)?;
    }
    if dest.exists() && src != dest {
        fs::copy(dest, dest.with_extension("sshv.bak"))?;
    }
    if src != dest {
        fs::copy(src, dest)?;
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
            has_password: false,
            has_private_key: false,
            has_passphrase: false,
        }
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
