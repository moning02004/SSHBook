//! 이 PC에서 기억하기: 보관함을 여는 키(마스터 비밀번호가 아니라 거기서 만든 32바이트 키)를
//! OS 키체인에 둔다. macOS는 키체인, Windows는 자격 증명 관리자.
//! 키체인이 없는 환경(CI의 Linux 등)에서는 기억하지 못한다고만 알린다.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use zeroize::Zeroizing;

const SERVICE: &str = "com.moning02004.sshbook";
const ACCOUNT: &str = "vault-key";

fn entry() -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).ok()
}

pub fn load() -> Option<Zeroizing<Vec<u8>>> {
    let s = Zeroizing::new(entry()?.get_password().ok()?);
    B64.decode(s.as_bytes())
        .ok()
        .filter(|k| k.len() == 32)
        .map(Zeroizing::new)
}

pub fn store(key: &[u8]) -> Result<(), String> {
    let e = entry().ok_or("이 PC의 키체인을 쓸 수 없습니다.")?;
    let s = Zeroizing::new(B64.encode(key));
    e.set_password(&s)
        .map_err(|err| format!("키체인에 저장하지 못했습니다: {err}"))
}

pub fn forget() {
    if let Some(e) = entry() {
        let _ = e.delete_credential();
    }
}
