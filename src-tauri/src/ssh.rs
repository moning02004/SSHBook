//! SSH 연결 (russh).
//!
//! - 비밀번호·개인 키는 보관함(vault.rs)에서 꺼내 이 모듈 안에서만 쓰고 프론트엔드로 보내지 않는다.
//! - 받은 데이터는 로컬 셸과 똑같이 `term-data` / `term-exit` 이벤트로 보낸다.
//! - 처음 보는 서버의 호스트 키는 접속을 멈추고 지문을 돌려준다. 사용자가 확인하면
//!   보관함의 known_hosts에 저장한다(다른 PC로 옮길 때 같이 따라간다).
//! - 에이전트 인증: macOS/Linux는 SSH_AUTH_SOCK, Windows는 OpenSSH 에이전트 파이프.

use crate::pty::{TermData, TermExit};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub enum Auth {
    Password(Option<Zeroizing<String>>),
    Key {
        pem: Zeroizing<String>,
        passphrase: Option<Zeroizing<String>>,
    },
    Agent,
}

pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    /// 보관함에 저장된 이 서버의 공개 키(OpenSSH 한 줄 형식)
    pub known_key: Option<String>,
}

/// 보관함 known_hosts의 키
pub fn host_id(host: &str, port: u16) -> String {
    format!("{}:{port}", host.trim().to_lowercase())
}

/// 프론트엔드가 처리해야 하는 접속 중단 사유.
/// 문자열 앞머리(`hostkey:` / `ask:`)로 구분해 JSON을 붙여 보낸다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    /// "unknown" = 처음 보는 서버, "changed" = 저장된 키와 다름
    pub kind: &'static str,
    pub host_id: String,
    pub algorithm: String,
    pub fingerprint: String,
    #[serde(skip)]
    pub key: String,
}

#[derive(Serialize)]
pub struct AskPrompt {
    /// "password" | "passphrase"
    pub kind: &'static str,
    pub message: String,
}

pub enum OpenError {
    HostKey(HostKeyPrompt),
    Ask(AskPrompt),
    Other(String),
}

impl OpenError {
    pub fn into_message(self) -> String {
        match self {
            OpenError::HostKey(p) => format!("hostkey:{}", serde_json::to_string(&p).unwrap_or_default()),
            OpenError::Ask(p) => format!("ask:{}", serde_json::to_string(&p).unwrap_or_default()),
            OpenError::Other(s) => s,
        }
    }
}

fn other(prefix: &str, e: impl std::fmt::Display) -> OpenError {
    OpenError::Other(format!("{prefix}: {e}"))
}

fn ask(kind: &'static str, message: &str) -> OpenError {
    OpenError::Ask(AskPrompt {
        kind,
        message: message.into(),
    })
}

// ---- 호스트 키 확인 ----

struct Client {
    expected: Option<PublicKey>,
    seen: Arc<Mutex<Option<PublicKey>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(c) => PublicKey::from(c.public_key().clone()),
        };
        let ok = self.expected.as_ref().is_some_and(|e| e.key_data() == key.key_data());
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
        Ok(ok)
    }
}

fn host_key_prompt(kind: &'static str, host_id: String, key: &PublicKey) -> HostKeyPrompt {
    HostKeyPrompt {
        kind,
        host_id,
        algorithm: key.algorithm().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        key: key.to_openssh().unwrap_or_default(),
    }
}

// ---- 열린 SSH 터미널 ----

/// 서버에서 받은 것을 내보내는 곳. 앱에서는 Tauri 이벤트, 테스트에서는 채널이다.
pub enum Out {
    Data(Vec<u8>),
    Exit(Option<u32>),
}
pub type Sink = Arc<dyn Fn(Out) + Send + Sync>;

pub fn app_sink(app: AppHandle, id: String) -> Sink {
    Arc::new(move |o| {
        let _ = match o {
            Out::Data(b) => app.emit(
                "term-data",
                TermData {
                    id: id.clone(),
                    data: B64.encode(b),
                },
            ),
            Out::Exit(code) => app.emit("term-exit", TermExit { id: id.clone(), code }),
        };
    })
}

enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshTerm {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl SshTerm {
    pub fn write(&self, data: &str) -> Result<(), String> {
        self.tx
            .send(Cmd::Data(data.as_bytes().to_vec()))
            .map_err(|_| "연결이 끊어졌습니다.".to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let _ = self.tx.send(Cmd::Resize(cols.max(2) as u32, rows.max(2) as u32));
        Ok(())
    }

    pub fn close(&self) {
        let _ = self.tx.send(Cmd::Close);
    }
}

pub async fn connect(sink: Sink, t: Target, cols: u16, rows: u16) -> Result<SshTerm, OpenError> {
    let hid = host_id(&t.host, t.port);
    let expected = t.known_key.as_deref().and_then(|k| PublicKey::from_openssh(k).ok());
    let had_known = expected.is_some();
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected,
        seen: seen.clone(),
    };

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let result = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (t.host.as_str(), t.port), handler),
    )
    .await;
    let mut handle = match result {
        Err(_) => {
            return Err(OpenError::Other(format!(
                "{}:{}에 연결하지 못했습니다: 시간 초과",
                t.host, t.port
            )))
        }
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            // 호스트 키를 받았는데 거절된 경우라면 사용자에게 확인을 받는다.
            if let Some(key) = seen.lock().unwrap_or_else(|e| e.into_inner()).take() {
                if matches!(e, russh::Error::UnknownKey) {
                    let kind = if had_known { "changed" } else { "unknown" };
                    return Err(OpenError::HostKey(host_key_prompt(kind, hid, &key)));
                }
            }
            return Err(other(&format!("{}:{}에 연결하지 못했습니다", t.host, t.port), e));
        }
    };

    authenticate(&mut handle, &t.user, t.auth).await?;

    let ch = handle
        .channel_open_session()
        .await
        .map_err(|e| other("세션 채널을 열지 못했습니다", e))?;
    ch.request_pty(
        false,
        "xterm-256color",
        cols.max(2) as u32,
        rows.max(2) as u32,
        0,
        0,
        &[],
    )
    .await
    .map_err(|e| other("터미널(PTY)을 요청하지 못했습니다", e))?;
    ch.request_shell(false)
        .await
        .map_err(|e| other("셸을 열지 못했습니다", e))?;

    let (mut rd, wr) = ch.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();

    tauri::async_runtime::spawn(async move {
        let mut code: Option<u32> = None;
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Data(b)) => {
                        if wr.data_bytes(b).await.is_err() {
                            break;
                        }
                    }
                    Some(Cmd::Resize(c, r)) => {
                        let _ = wr.window_change(c, r, 0, 0).await;
                    }
                    Some(Cmd::Close) | None => break,
                },
                msg = rd.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        sink(Out::Data(data.to_vec()));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
            }
        }
        let _ = handle.disconnect(Disconnect::ByApplication, "", "ko").await;
        sink(Out::Exit(code));
    });

    Ok(SshTerm { tx })
}

// ---- 인증 ----

async fn authenticate(handle: &mut Handle<Client>, user: &str, auth: Auth) -> Result<(), OpenError> {
    let fail = |e: russh::Error| other("인증 중 오류가 났습니다", e);
    match auth {
        Auth::Password(None) => Err(ask("password", "")),
        Auth::Password(Some(pw)) => {
            let ok = handle
                .authenticate_password(user, pw.as_str())
                .await
                .map_err(fail)?
                .success();
            if ok {
                Ok(())
            } else {
                Err(ask("password", "비밀번호가 맞지 않습니다."))
            }
        }
        Auth::Key { pem, passphrase } => {
            let key = match decode_secret_key(&pem, passphrase.as_deref().map(|s| s.as_str())) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) if passphrase.is_none() => return Err(ask("passphrase", "")),
                Err(_) if passphrase.is_some() => return Err(ask("passphrase", "키 암호가 맞지 않습니다.")),
                Err(e) => return Err(other("개인 키를 읽지 못했습니다", e)),
            };
            let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
            let ok = handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(fail)?
                .success();
            if ok {
                Ok(())
            } else {
                Err(OpenError::Other(
                    "서버가 이 키를 받아들이지 않았습니다. 서버의 authorized_keys를 확인하세요.".into(),
                ))
            }
        }
        Auth::Agent => agent_auth(handle, user).await,
    }
}

#[cfg(windows)]
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> Result<(), OpenError> {
    use russh::keys::agent::client::AgentClient;
    let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await.map_err(|e| {
        other("SSH 에이전트에 연결하지 못했습니다 (Windows 서비스 'OpenSSH Authentication Agent'가 켜져 있는지 확인하세요)", e)
    })?;
    try_agent(handle, user, agent).await
}

#[cfg(not(windows))]
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> Result<(), OpenError> {
    use russh::keys::agent::client::AgentClient;
    let agent = AgentClient::connect_env()
        .await
        .map_err(|e| other("SSH 에이전트에 연결하지 못했습니다 (SSH_AUTH_SOCK을 확인하세요)", e))?;
    try_agent(handle, user, agent).await
}

async fn try_agent<R>(
    handle: &mut Handle<Client>,
    user: &str,
    mut agent: russh::keys::agent::client::AgentClient<R>,
) -> Result<(), OpenError>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ids = agent
        .request_identities()
        .await
        .map_err(|e| other("에이전트에서 키 목록을 받지 못했습니다", e))?;
    if ids.is_empty() {
        return Err(OpenError::Other(
            "SSH 에이전트에 등록된 키가 없습니다 (ssh-add로 추가하세요).".into(),
        ));
    }
    let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
    for id in ids {
        let key = id.public_key().into_owned();
        if let Ok(r) = handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return Ok(());
            }
        }
    }
    Err(OpenError::Other(
        "서버가 에이전트의 키를 하나도 받아들이지 않았습니다.".into(),
    ))
}

#[cfg(test)]
mod tests {
    //! 같은 프로세스 안에 russh 테스트 서버를 띄워 실제 SSH 흐름을 확인한다.
    use super::*;
    use russh::server::{self, Auth as SAuth, Msg, Session as SSession};
    use russh::{Channel, ChannelId};

    const HOST_A: &str = include_str!("testdata/host_a");
    const HOST_B: &str = include_str!("testdata/host_b");
    const CLIENT: &str = include_str!("testdata/client");
    const CLIENT_PUB: &str = include_str!("testdata/client.pub");

    struct TestServer;

    impl server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<SAuth, Self::Error> {
            Ok(if user == "tester" && password == "right-pw" {
                SAuth::Accept
            } else {
                SAuth::reject()
            })
        }

        async fn auth_publickey(&mut self, _: &str, key: server::VerifiedPublicKey<'_>) -> Result<SAuth, Self::Error> {
            let allowed = PublicKey::from_openssh(CLIENT_PUB.trim()).unwrap();
            Ok(if key.public_key.key_data() == allowed.key_data() {
                SAuth::Accept
            } else {
                SAuth::reject()
            })
        }

        async fn channel_open_session(
            &mut self,
            _: Channel<Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut SSession,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        async fn pty_request(
            &mut self,
            ch: ChannelId,
            term: &str,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            _: &[(russh::Pty, u32)],
            s: &mut SSession,
        ) -> Result<(), Self::Error> {
            s.data(ch, format!("pty {term} {cols}x{rows}\r\n").into_bytes())?;
            Ok(())
        }

        async fn shell_request(&mut self, ch: ChannelId, s: &mut SSession) -> Result<(), Self::Error> {
            s.data(ch, b"welcome\r\n".to_vec())?;
            Ok(())
        }

        async fn window_change_request(
            &mut self,
            ch: ChannelId,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            s: &mut SSession,
        ) -> Result<(), Self::Error> {
            s.data(ch, format!("resize {cols}x{rows}\r\n").into_bytes())?;
            Ok(())
        }

        async fn data(&mut self, ch: ChannelId, data: &[u8], s: &mut SSession) -> Result<(), Self::Error> {
            if data == b"exit" {
                s.exit_status_request(ch, 7)?;
                s.eof(ch)?;
                s.close(ch)?;
            } else {
                s.data(ch, [b"echo:", data].concat())?;
            }
            Ok(())
        }
    }

    /// 127.0.0.1의 빈 포트에 서버를 띄우고 포트를 돌려준다.
    async fn start_server(host_key: &str) -> u16 {
        let config = Arc::new(server::Config {
            keys: vec![decode_secret_key(host_key, None).unwrap()],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(running) = server::run_stream(config, sock, TestServer).await {
                        let _ = running.await;
                    }
                });
            }
        });
        port
    }

    fn pub_of(private: &str) -> String {
        decode_secret_key(private, None)
            .unwrap()
            .public_key()
            .to_openssh()
            .unwrap()
    }

    fn target(port: u16, auth: Auth, known_key: Option<String>) -> Target {
        Target {
            host: "127.0.0.1".into(),
            port,
            user: "tester".into(),
            auth,
            known_key,
        }
    }

    fn pw(s: &str) -> Auth {
        Auth::Password(Some(Zeroizing::new(s.into())))
    }

    fn sink() -> (Sink, mpsc::UnboundedReceiver<Out>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |o| drop(tx.send(o))), rx)
    }

    /// needle이 나올 때까지 받은 출력을 모은다.
    async fn read_until(rx: &mut mpsc::UnboundedReceiver<Out>, needle: &str) -> String {
        let mut got = String::new();
        let res = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(o) = rx.recv().await {
                if let Out::Data(b) = o {
                    got.push_str(&String::from_utf8_lossy(&b));
                    if got.contains(needle) {
                        return;
                    }
                }
            }
        })
        .await;
        assert!(res.is_ok(), "{needle:?}를 받지 못했습니다. 받은 것: {got:?}");
        got
    }

    async fn open_err(t: Target) -> OpenError {
        match connect(sink().0, t, 80, 24).await {
            Ok(_) => panic!("실패해야 하는 접속이 성공했습니다"),
            Err(e) => e,
        }
    }

    #[tokio::test]
    async fn unknown_host_asks_for_confirmation() {
        let port = start_server(HOST_A).await;
        match open_err(target(port, pw("right-pw"), None)).await {
            OpenError::HostKey(p) => {
                assert_eq!(p.kind, "unknown");
                assert_eq!(p.host_id, format!("127.0.0.1:{port}"));
                assert!(p.fingerprint.starts_with("SHA256:"));
                let expected = PublicKey::from_openssh(&pub_of(HOST_A)).unwrap();
                assert_eq!(PublicKey::from_openssh(&p.key).unwrap().key_data(), expected.key_data());
            }
            _ => panic!("호스트 키 확인을 요청해야 합니다"),
        }
    }

    #[tokio::test]
    async fn changed_host_key_is_reported() {
        let port = start_server(HOST_B).await;
        match open_err(target(port, pw("right-pw"), Some(pub_of(HOST_A)))).await {
            OpenError::HostKey(p) => assert_eq!(p.kind, "changed"),
            _ => panic!("키가 바뀌었다고 알려야 합니다"),
        }
    }

    #[tokio::test]
    async fn password_session_round_trip() {
        let port = start_server(HOST_A).await;
        let (sink, mut rx) = sink();
        let term = connect(sink, target(port, pw("right-pw"), Some(pub_of(HOST_A))), 100, 30)
            .await
            .unwrap_or_else(|e| panic!("{}", e.into_message()));
        let got = read_until(&mut rx, "welcome").await;
        assert!(got.contains("pty xterm-256color 100x30"), "{got:?}");

        term.write("hello").unwrap();
        read_until(&mut rx, "echo:hello").await;
        term.resize(120, 40).unwrap();
        read_until(&mut rx, "resize 120x40").await;

        term.write("exit").unwrap();
        let code = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(o) = rx.recv().await {
                if let Out::Exit(c) = o {
                    return c;
                }
            }
            None
        })
        .await
        .unwrap();
        assert_eq!(code, Some(7));
    }

    #[tokio::test]
    async fn missing_or_wrong_password_asks_again() {
        let port = start_server(HOST_A).await;
        let known = Some(pub_of(HOST_A));
        match open_err(target(port, Auth::Password(None), known.clone())).await {
            OpenError::Ask(a) => assert_eq!((a.kind, a.message.as_str()), ("password", "")),
            _ => panic!("비밀번호를 물어야 합니다"),
        }
        match open_err(target(port, pw("wrong"), known)).await {
            OpenError::Ask(a) => assert_eq!(a.kind, "password"),
            _ => panic!("틀린 비밀번호는 다시 물어야 합니다"),
        }
    }

    #[tokio::test]
    async fn encrypted_key_needs_passphrase() {
        let port = start_server(HOST_A).await;
        let known = Some(pub_of(HOST_A));
        let key = |p: Option<&str>| Auth::Key {
            pem: Zeroizing::new(CLIENT.into()),
            passphrase: p.map(|x| Zeroizing::new(x.into())),
        };

        match open_err(target(port, key(None), known.clone())).await {
            OpenError::Ask(a) => assert_eq!((a.kind, a.message.as_str()), ("passphrase", "")),
            _ => panic!("키 암호를 물어야 합니다"),
        }
        match open_err(target(port, key(Some("nope")), known.clone())).await {
            OpenError::Ask(a) => assert_eq!(a.kind, "passphrase"),
            _ => panic!("틀린 키 암호는 다시 물어야 합니다"),
        }
        let (sink, mut rx) = sink();
        let _term = connect(sink, target(port, key(Some("testpass")), known), 80, 24)
            .await
            .unwrap_or_else(|e| panic!("{}", e.into_message()));
        read_until(&mut rx, "welcome").await;
    }
}
