//! SSH 연결 (russh).
//!
//! - 비밀번호·개인 키는 보관함(vault.rs)에서 꺼내 이 모듈 안에서만 쓰고 프론트엔드로 보내지 않는다.
//! - 받은 데이터는 로컬 셸과 똑같이 `term-data` / `term-exit` 이벤트로 보낸다.
//! - 처음 보는 서버의 호스트 키는 접속을 멈추고 지문을 돌려준다. 사용자가 확인하면
//!   보관함의 known_hosts에 저장한다(다른 PC로 옮길 때 같이 따라간다).
//! - 에이전트 인증: macOS/Linux는 SSH_AUTH_SOCK, Windows는 OpenSSH 에이전트 파이프.
//! - 점프 호스트: 먼저 그 서버에 붙고, 그 연결 안에 direct-tcpip 터널을 열어 목적지에 붙는다.
//! - 시작 경로: 셸 대신 `cd 경로; exec $SHELL -l`을 실행한다.

use crate::forward::{self, RemoteMap};
use crate::pty::DataPump;
use crate::termlog::TermLog;
use crate::vault::Forward;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 인증은 하드웨어 키 터치나 OTP 입력을 기다릴 수 있어서 넉넉히 둔다.
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_KBD_ROUNDS: usize = 8;
const MAX_KBD_PROMPTS: usize = 8;
const MAX_KBD_TEXT: usize = 500;
/// 인증 뒤 채널·PTY·셸 요청
const SETUP_TIMEOUT: Duration = Duration::from_secs(15);

/// 서버가 답하지 않아도 끝나도록 시간 제한을 건다.
async fn within<T, E: std::fmt::Display>(
    what: &str,
    limit: Duration,
    f: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, OpenError> {
    match tokio::time::timeout(limit, f).await {
        Ok(r) => r.map_err(|e| other(what, e)),
        Err(_) => Err(OpenError::Other(format!("{what}: 서버가 응답하지 않습니다"))),
    }
}

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
    /// OTP처럼 접속 중에 사용자에게 물어야 할 때 쓴다
    pub kbd: Option<KbdAsker>,
}

/// 서버가 묻는 항목(keyboard-interactive). 문구는 제어 문자를 뺀 값이다.
#[derive(Serialize, Clone, Debug)]
pub struct KbdField {
    pub text: String,
    pub echo: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct KbdRequest {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdField>,
}

/// 질문을 사용자에게 보여 주고 답을 받는다. 취소하면 None.
pub type KbdAsker = Arc<
    dyn Fn(KbdRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<Zeroizing<String>>>> + Send>>
        + Send
        + Sync,
>;

/// 보관함 known_hosts의 키
pub fn host_id(host: &str, port: u16) -> String {
    format!("{}:{port}", host.trim().to_lowercase())
}

/// 사용자 확인을 기다리는 호스트 키.
/// 같은 서버에 동시에 연결해도 섞이지 않도록 (서버, 지문) 쌍으로 보관한다.
/// 그래야 사용자가 화면에서 본 바로 그 지문의 키만 저장된다.
#[derive(Default)]
pub struct PendingHosts(HashMap<(String, String), String>);

impl PendingHosts {
    pub fn insert(&mut self, p: &HostKeyPrompt) {
        self.0.insert((p.host_id.clone(), p.fingerprint.clone()), p.key.clone());
    }

    /// 확인한 지문의 키를 꺼내고, 그 서버의 나머지 대기 키는 버린다.
    pub fn take(&mut self, host_id: &str, fingerprint: &str) -> Option<String> {
        let key = self.0.remove(&(host_id.to_string(), fingerprint.to_string()))?;
        self.0.retain(|(h, _), _| h != host_id);
        Some(key)
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
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
    /// "user" | "password" | "passphrase"
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

pub(crate) fn ask(kind: &'static str, message: &str) -> OpenError {
    OpenError::Ask(AskPrompt {
        kind,
        message: message.into(),
    })
}

// ---- 호스트 키 확인 ----

pub struct Client {
    expected: Option<PublicKey>,
    seen: Arc<Mutex<Option<PublicKey>>>,
    /// 원격 포워딩(-R): 서버가 열어 준 포트 → 내 PC에서 이어 줄 곳
    remote: RemoteMap,
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

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let dest = self
            .remote
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&connected_port)
            .cloned();
        match dest {
            Some((host, port)) => {
                reply.accept().await;
                tokio::spawn(forward::pipe_to_local(channel, host, port));
            }
            None => {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await
            }
        }
        Ok(())
    }
}

/// 화면에 보여 줄 저장된 서버 키
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host_id: String,
    pub algorithm: String,
    pub fingerprint: String,
}

pub fn describe_known(host_id: &str, key: &str) -> KnownHost {
    match PublicKey::from_openssh(key) {
        Ok(k) => KnownHost {
            host_id: host_id.into(),
            algorithm: k.algorithm().to_string(),
            fingerprint: k.fingerprint(HashAlg::Sha256).to_string(),
        },
        Err(_) => KnownHost {
            host_id: host_id.into(),
            algorithm: "?".into(),
            fingerprint: "(읽을 수 없는 키)".into(),
        },
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
    /// 서버 응답 시간(ms)
    Latency(u32),
}
pub type Sink = Arc<dyn Fn(Out) + Send + Sync>;

#[derive(Serialize, Clone)]
struct TermLatency {
    id: String,
    ms: u32,
}

/// 세션 기록 파일. 첫 출력이 올 때 연다(접속에 실패하면 파일을 만들지 않는다).
enum LogState {
    Pending(PathBuf, String),
    Open(TermLog),
    Off,
}

impl LogState {
    /// 기록하고, 파일을 열지 못했으면 터미널에 보여 줄 경고를 돌려준다.
    fn write(&mut self, data: &[u8]) -> Option<String> {
        if let LogState::Pending(path, header) = self {
            match TermLog::create(path, header) {
                Ok(l) => *self = LogState::Open(l),
                Err(e) => {
                    let msg = format!("\x1b[33m[기록] 파일을 만들지 못해 이 세션은 기록하지 않습니다: {e}\x1b[0m\r\n");
                    *self = LogState::Off;
                    return Some(msg);
                }
            }
        }
        if let LogState::Open(l) = self {
            if l.write(data).is_err() {
                *self = LogState::Off;
            }
        }
        None
    }

    fn finish(&mut self) {
        if let LogState::Open(l) = self {
            l.finish("연결 종료");
        }
        *self = LogState::Off;
    }
}

/// log(파일 경로, 머리글)가 있으면 받은 출력을 세션 기록 파일에도 쓴다.
pub fn app_sink(app: AppHandle, id: String, log: Option<(PathBuf, String)>) -> Sink {
    let log = Mutex::new(match log {
        Some((p, h)) => LogState::Pending(p, h),
        None => LogState::Off,
    });
    let pump = DataPump::new(app.clone(), id.clone());
    Arc::new(move |o| match o {
        Out::Data(b) => {
            if let Some(warn) = log.lock().unwrap_or_else(|e| e.into_inner()).write(&b) {
                pump.data(warn.into_bytes());
            }
            pump.data(b);
        }
        Out::Exit(code) => {
            log.lock().unwrap_or_else(|e| e.into_inner()).finish();
            // 앞서 받은 출력을 다 보낸 뒤에 끝났다고 알린다.
            pump.exit(code);
        }
        Out::Latency(ms) => {
            let _ = app.emit("term-latency", TermLatency { id: id.clone(), ms });
        }
    })
}

enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshTerm {
    tx: mpsc::UnboundedSender<Cmd>,
    /// 같은 연결 위에 SFTP 채널을 더 열 때 쓴다.
    pub conn: Arc<Conn>,
}

/// 인증까지 끝난 SSH 연결. 셸 채널이 닫히면 함께 끊는다.
pub struct Conn {
    pub handle: Arc<Handle<Client>>,
    pub sftp: tokio::sync::Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
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

/// 연결 한 번에 필요한 것
pub struct Connect {
    pub target: Target,
    /// 거쳐 갈 서버. 그 서버의 인증은 보관함에 저장된 것만 쓴다(터미널에서 묻지 않는다).
    pub jump: Option<Target>,
    /// 연결하자마자 이동할 폴더. 없으면 서버 기본값(보통 홈 폴더).
    pub start_dir: Option<String>,
    pub forwards: Vec<Forward>,
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    })
}

/// TCP(또는 점프 호스트를 통한 터널)로 붙고 호스트 키 확인·인증까지 한다.
async fn establish(t: Target, via: Option<&Handle<Client>>, remote: RemoteMap) -> Result<Handle<Client>, OpenError> {
    let hid = host_id(&t.host, t.port);
    let expected = t.known_key.as_deref().and_then(|k| PublicKey::from_openssh(k).ok());
    let had_known = expected.is_some();
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected,
        seen: seen.clone(),
        remote,
    };
    let where_ = format!("{}:{}", t.host, t.port);
    let timed_out = || OpenError::Other(format!("{where_}에 연결하지 못했습니다: 시간 초과"));

    let result = match via {
        Some(jump) => {
            let ch = tokio::time::timeout(
                CONNECT_TIMEOUT,
                jump.channel_open_direct_tcpip(t.host.clone(), t.port as u32, "127.0.0.1", 0),
            )
            .await
            .map_err(|_| timed_out())?
            .map_err(|e| other(&format!("점프 호스트에서 {where_}로 가는 길을 열지 못했습니다"), e))?;
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                client::connect_stream(config(), ch.into_stream(), handler),
            )
            .await
        }
        None => {
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                client::connect(config(), (t.host.as_str(), t.port), handler),
            )
            .await
        }
    };
    let mut handle = match result {
        Err(_) => return Err(timed_out()),
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            // 호스트 키를 받았는데 거절된 경우라면 사용자에게 확인을 받는다.
            if let Some(key) = seen.lock().unwrap_or_else(|e| e.into_inner()).take() {
                if matches!(e, russh::Error::UnknownKey) {
                    let kind = if had_known { "changed" } else { "unknown" };
                    return Err(OpenError::HostKey(host_key_prompt(kind, hid, &key)));
                }
            }
            return Err(other(&format!("{where_}에 연결하지 못했습니다"), e));
        }
    };
    match tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut handle, &t.user, t.auth, t.kbd)).await {
        Ok(r) => r?,
        Err(_) => return Err(OpenError::Other(format!("{where_} 인증: 서버가 응답하지 않습니다"))),
    }
    Ok(handle)
}

/// 점프 호스트에서 난 오류. 호스트 키 확인은 그대로 넘기고(어느 서버인지 지문 화면에 나온다),
/// 비밀번호를 물어야 하는 경우는 보관함에 저장하라고 안내한다.
fn jump_error(e: OpenError, label: &str) -> OpenError {
    match e {
        OpenError::HostKey(p) => OpenError::HostKey(p),
        OpenError::Ask(a) => OpenError::Other(format!(
            "점프 호스트 {label}: {}보관함에 저장된 {}가 필요합니다. 점프 호스트 세션에 저장해 주세요.",
            if a.message.is_empty() {
                String::new()
            } else {
                format!("{} ", a.message)
            },
            if a.kind == "password" {
                "비밀번호"
            } else {
                "키 암호"
            }
        )),
        OpenError::Other(s) => OpenError::Other(format!("점프 호스트 {label}: {s}")),
    }
}

/// 셸 대신 실행할 명령: 시작 폴더로 옮긴 뒤 로그인 셸을 띄운다. 폴더가 없으면 알리고 홈에서 시작한다.
pub fn start_command(dir: &str) -> String {
    let q = shell_path(dir.trim());
    format!("cd {q} 2>/dev/null || echo \"시작 경로로 이동하지 못했습니다: \"{q}; exec \"$SHELL\" -l")
}

/// 셸에 넘길 경로. 작은따옴표로 감싸되, 맨 앞 ~는 셸이 홈으로 바꾸도록 따옴표 밖에 둔다.
fn shell_path(p: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    if p == "~" {
        return "~".into();
    }
    match p.strip_prefix("~/") {
        Some(rest) => format!("~/{}", quote(rest)),
        None => quote(p),
    }
}

const PING_EVERY: Duration = Duration::from_secs(5);

pub async fn connect(sink: Sink, c: Connect, cols: u16, rows: u16) -> Result<SshTerm, OpenError> {
    let jump = match c.jump {
        Some(j) => {
            let label = format!("{}@{}", j.user, j.host);
            Some(Arc::new(
                establish(j, None, RemoteMap::default())
                    .await
                    .map_err(|e| jump_error(e, &label))?,
            ))
        }
        None => None,
    };
    let remote = RemoteMap::default();
    let handle = Arc::new(establish(c.target, jump.as_deref(), remote.clone()).await?);

    let ch = within(
        "세션 채널을 열지 못했습니다",
        SETUP_TIMEOUT,
        handle.channel_open_session(),
    )
    .await?;
    within(
        "터미널(PTY)을 요청하지 못했습니다",
        SETUP_TIMEOUT,
        ch.request_pty(
            false,
            "xterm-256color",
            cols.max(2) as u32,
            rows.max(2) as u32,
            0,
            0,
            &[],
        ),
    )
    .await?;
    match c.start_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => {
            within(
                "시작 경로로 셸을 열지 못했습니다",
                SETUP_TIMEOUT,
                ch.exec(false, start_command(dir)),
            )
            .await?
        }
        None => within("셸을 열지 못했습니다", SETUP_TIMEOUT, ch.request_shell(false)).await?,
    }

    let mut tasks = forward::start_all(&handle, &remote, &c.forwards, &sink).await;

    // 응답 시간: 몇 초마다 서버에 ping을 보내 답이 오기까지 잰다.
    {
        let h = handle.clone();
        let sink = sink.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                let t0 = Instant::now();
                if let Ok(Ok(())) = tokio::time::timeout(Duration::from_secs(10), h.send_ping()).await {
                    sink(Out::Latency(t0.elapsed().as_millis().min(u32::MAX as u128) as u32));
                }
                tokio::time::sleep(PING_EVERY).await;
            }
        }));
    }

    let (mut rd, wr) = ch.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let conn = Arc::new(Conn {
        handle: handle.clone(),
        sftp: tokio::sync::Mutex::new(None),
    });

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
        tasks.iter().for_each(|t| t.abort());
        let _ = handle.disconnect(Disconnect::ByApplication, "", "ko").await;
        if let Some(j) = jump {
            let _ = j.disconnect(Disconnect::ByApplication, "", "ko").await;
        }
        sink(Out::Exit(code));
    });

    Ok(SshTerm { tx, conn })
}

// ---- 인증 ----

fn auth_error(e: russh::Error) -> OpenError {
    other("인증 중 오류가 났습니다", e)
}

fn offers(methods: &russh::MethodSet, kind: russh::MethodKind) -> bool {
    methods.contains(&kind)
}

/// 서버가 보낸 문구에서 터미널 제어 문자를 뺀다(화면 조작 방지).
fn clean_text(s: &str) -> String {
    s.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_KBD_TEXT)
        .collect::<String>()
        .trim()
        .to_string()
}

fn is_password_prompt(prompts: &[client::Prompt]) -> bool {
    matches!(prompts, [p] if !p.echo && p.prompt.to_lowercase().contains("password"))
}

/// keyboard-interactive(OTP·2단계 인증). 성공하면 true, 서버가 거절하면 false.
/// 비밀번호를 이미 알면 "Password:" 질문에는 그 값으로 답하고 나머지만 사용자에게 묻는다.
async fn keyboard(
    handle: &mut Handle<Client>,
    user: &str,
    asker: Option<&KbdAsker>,
    password: Option<&str>,
) -> Result<bool, OpenError> {
    let Some(asker) = asker else { return Ok(false) };
    let mut password = password;
    let mut reply = handle
        .authenticate_keyboard_interactive_start(user, None::<String>)
        .await
        .map_err(auth_error)?;
    for _ in 0..MAX_KBD_ROUNDS {
        let (name, instructions, prompts) = match reply {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => (name, instructions, prompts),
        };
        if prompts.len() > MAX_KBD_PROMPTS {
            return Err(OpenError::Other("서버가 너무 많은 항목을 물었습니다.".into()));
        }
        let answers: Vec<Zeroizing<String>> = if prompts.is_empty() {
            vec![]
        } else if let Some(pw) = password.filter(|_| is_password_prompt(&prompts)) {
            password = None;
            vec![Zeroizing::new(pw.to_string())]
        } else {
            let request = KbdRequest {
                name: clean_text(&name),
                instructions: clean_text(&instructions),
                prompts: prompts
                    .iter()
                    .map(|p| KbdField {
                        text: clean_text(&p.prompt),
                        echo: p.echo,
                    })
                    .collect(),
            };
            match asker(request).await {
                Some(a) if a.len() == prompts.len() => a,
                _ => return Err(OpenError::Other("연결을 취소했습니다.".into())),
            }
        };
        let plain = answers.iter().map(|a| a.to_string()).collect();
        reply = handle
            .authenticate_keyboard_interactive_respond(plain)
            .await
            .map_err(auth_error)?;
    }
    Err(OpenError::Other("인증 단계가 너무 많습니다.".into()))
}

fn code_rejected() -> OpenError {
    OpenError::Other("서버가 입력한 인증 코드를 받아들이지 않았습니다.".into())
}

async fn authenticate(
    handle: &mut Handle<Client>,
    user: &str,
    auth: Auth,
    kbd: Option<KbdAsker>,
) -> Result<(), OpenError> {
    use russh::MethodKind::{KeyboardInteractive, Password};
    match auth {
        Auth::Password(None) => {
            // 서버가 비밀번호 없이 OTP만 받을 수도 있어서 방법부터 확인한다.
            match handle.authenticate_none(user).await.map_err(auth_error)? {
                client::AuthResult::Success => Ok(()),
                client::AuthResult::Failure { remaining_methods, .. }
                    if kbd.is_some()
                        && !offers(&remaining_methods, Password)
                        && offers(&remaining_methods, KeyboardInteractive) =>
                {
                    if keyboard(handle, user, kbd.as_ref(), None).await? {
                        Ok(())
                    } else {
                        Err(code_rejected())
                    }
                }
                client::AuthResult::Failure { .. } => Err(ask("password", "")),
            }
        }
        Auth::Password(Some(pw)) => {
            match handle
                .authenticate_password(user, pw.as_str())
                .await
                .map_err(auth_error)?
            {
                client::AuthResult::Success => Ok(()),
                client::AuthResult::Failure {
                    remaining_methods,
                    partial_success,
                } => {
                    if offers(&remaining_methods, KeyboardInteractive)
                        && keyboard(handle, user, kbd.as_ref(), Some(pw.as_str())).await?
                    {
                        return Ok(());
                    }
                    if partial_success {
                        return Err(code_rejected());
                    }
                    Err(ask("password", "비밀번호가 맞지 않습니다."))
                }
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
            match handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(auth_error)?
            {
                client::AuthResult::Success => Ok(()),
                // 키는 통과했고 OTP가 더 필요한 경우
                client::AuthResult::Failure {
                    remaining_methods,
                    partial_success: true,
                } if offers(&remaining_methods, KeyboardInteractive) => {
                    if keyboard(handle, user, kbd.as_ref(), None).await? {
                        Ok(())
                    } else {
                        Err(code_rejected())
                    }
                }
                client::AuthResult::Failure { .. } => Err(OpenError::Other(
                    "서버가 이 키를 받아들이지 않았습니다. 서버의 authorized_keys를 확인하세요.".into(),
                )),
            }
        }
        Auth::Agent => agent_auth(handle, user, kbd).await,
    }
}

#[cfg(windows)]
async fn agent_auth(handle: &mut Handle<Client>, user: &str, kbd: Option<KbdAsker>) -> Result<(), OpenError> {
    use russh::keys::agent::client::AgentClient;
    let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await.map_err(|e| {
        other("SSH 에이전트에 연결하지 못했습니다 (Windows 서비스 'OpenSSH Authentication Agent'가 켜져 있는지 확인하세요)", e)
    })?;
    try_agent(handle, user, agent, kbd).await
}

#[cfg(not(windows))]
async fn agent_auth(handle: &mut Handle<Client>, user: &str, kbd: Option<KbdAsker>) -> Result<(), OpenError> {
    use russh::keys::agent::client::AgentClient;
    let agent = AgentClient::connect_env()
        .await
        .map_err(|e| other("SSH 에이전트에 연결하지 못했습니다 (SSH_AUTH_SOCK을 확인하세요)", e))?;
    try_agent(handle, user, agent, kbd).await
}

async fn try_agent<R>(
    handle: &mut Handle<Client>,
    user: &str,
    mut agent: russh::keys::agent::client::AgentClient<R>,
    kbd: Option<KbdAsker>,
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
        match handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(client::AuthResult::Success) => return Ok(()),
            Ok(client::AuthResult::Failure {
                remaining_methods,
                partial_success: true,
            }) if offers(&remaining_methods, russh::MethodKind::KeyboardInteractive) => {
                return if keyboard(handle, user, kbd.as_ref(), None).await? {
                    Ok(())
                } else {
                    Err(code_rejected())
                };
            }
            _ => {}
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

    /// 연결마다 하나. 셸 채널에서만 echo하고, 터널(direct-tcpip) 채널 데이터는 건드리지 않는다.
    #[derive(Default)]
    struct TestServer {
        sessions: std::collections::HashSet<ChannelId>,
    }

    impl server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<SAuth, Self::Error> {
            Ok(if user == "tester" && password == "right-pw" {
                SAuth::Accept
            } else {
                SAuth::reject()
            })
        }

        async fn auth_none(&mut self, user: &str) -> Result<SAuth, Self::Error> {
            Ok(if user == "otp" {
                SAuth::Reject {
                    proceed_with_methods: Some((&[russh::MethodKind::KeyboardInteractive][..]).into()),
                    partial_success: false,
                }
            } else {
                SAuth::reject()
            })
        }

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            user: &str,
            _: &str,
            response: Option<server::Response<'a>>,
        ) -> Result<SAuth, Self::Error> {
            if user != "otp" {
                return Ok(SAuth::reject());
            }
            Ok(match response {
                None => SAuth::Partial {
                    name: "2FA".into(),
                    instructions: "\x1b[2Jenter code".into(),
                    prompts: vec![("Code: ".into(), false)].into(),
                },
                Some(mut r) => {
                    if r.next().is_some_and(|b| &b[..] == b"123456") {
                        SAuth::Accept
                    } else {
                        SAuth::reject()
                    }
                }
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
            ch: Channel<Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut SSession,
        ) -> Result<(), Self::Error> {
            self.sessions.insert(ch.id());
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

        async fn exec_request(&mut self, ch: ChannelId, data: &[u8], s: &mut SSession) -> Result<(), Self::Error> {
            s.data(ch, [b"exec:", data, b"\r\nwelcome\r\n"].concat())?;
            Ok(())
        }

        /// 점프 호스트·로컬 포워딩 확인용: 요청받은 곳에 TCP로 붙어 그대로 잇는다.
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: server::ChannelOpenHandle,
            _: &mut SSession,
        ) -> Result<(), Self::Error> {
            match tokio::net::TcpStream::connect((host.to_string(), port as u16)).await {
                Ok(mut sock) => {
                    reply.accept().await;
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                    });
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
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
            if !self.sessions.contains(&ch) {
                return Ok(());
            }
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
                    if let Ok(running) = server::run_stream(config, sock, TestServer::default()).await {
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
            kbd: None,
        }
    }

    fn plain(t: Target) -> Connect {
        Connect {
            target: t,
            jump: None,
            start_dir: None,
            forwards: vec![],
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
        match connect(sink().0, plain(t), 80, 24).await {
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
        let term = connect(sink, plain(target(port, pw("right-pw"), Some(pub_of(HOST_A)))), 100, 30)
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

    fn otp_target(port: u16, code: &'static str, seen: Arc<Mutex<Vec<KbdRequest>>>) -> Target {
        let mut t = target(port, Auth::Password(None), Some(pub_of(HOST_A)));
        t.user = "otp".into();
        t.kbd = Some(Arc::new(move |req| {
            seen.lock().unwrap().push(req);
            Box::pin(async move { (!code.is_empty()).then(|| vec![Zeroizing::new(code.to_string())]) })
        }));
        t
    }

    #[tokio::test]
    async fn otp_prompts_cleaned_and_code_checked() {
        let port = start_server(HOST_A).await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (s, _rx) = sink();
        let ok = connect(s, plain(otp_target(port, "123456", seen.clone())), 80, 24).await;
        assert!(ok.is_ok(), "맞는 코드로 접속되어야 한다");
        ok.ok().unwrap().close();
        {
            let got = seen.lock().unwrap();
            assert_eq!(got[0].prompts[0].text, "Code:");
            assert!(!got[0].prompts[0].echo);
            assert_eq!(got[0].instructions, "[2Jenter code", "ESC는 빠져야 한다");
        }
        let (s, _rx) = sink();
        let bad = connect(s, plain(otp_target(port, "000000", seen.clone())), 80, 24).await;
        assert!(matches!(bad, Err(OpenError::Other(m)) if m.contains("인증 코드")));
        let (s, _rx) = sink();
        let cancelled = connect(s, plain(otp_target(port, "", seen)), 80, 24).await;
        assert!(matches!(cancelled, Err(OpenError::Other(m)) if m.contains("취소")));
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
        let _term = connect(sink, plain(target(port, key(Some("testpass")), known)), 80, 24)
            .await
            .unwrap_or_else(|e| panic!("{}", e.into_message()));
        read_until(&mut rx, "welcome").await;
    }

    #[test]
    fn known_host_fingerprint_matches_prompt() {
        let key = pub_of(HOST_A);
        let k = describe_known("example.com:22", &key);
        let parsed = PublicKey::from_openssh(&key).unwrap();
        assert_eq!(k.fingerprint, parsed.fingerprint(HashAlg::Sha256).to_string());
        assert!(k.fingerprint.starts_with("SHA256:"));
        assert_eq!(describe_known("x:22", "garbage").algorithm, "?");
    }

    #[test]
    fn pending_host_keys_do_not_mix() {
        let p = |fp: &str, key: &str| HostKeyPrompt {
            kind: "unknown",
            host_id: "srv:22".into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: fp.into(),
            key: key.into(),
        };
        let mut pending = PendingHosts::default();
        pending.insert(&p("SHA256:real", "real-key"));
        // 같은 서버의 다른 연결에 다른 키가 와도 앞의 것을 덮어쓰지 않는다.
        pending.insert(&p("SHA256:attacker", "attacker-key"));
        assert_eq!(pending.take("srv:22", "SHA256:nope"), None);
        assert_eq!(pending.take("srv:22", "SHA256:real").as_deref(), Some("real-key"));
        // 확인이 끝나면 그 서버의 다른 대기 키는 남지 않는다.
        assert_eq!(pending.take("srv:22", "SHA256:attacker"), None);
    }

    #[test]
    fn start_command_quotes_paths() {
        assert_eq!(shell_path("/srv"), "'/srv'");
        assert_eq!(shell_path("~"), "~");
        assert_eq!(shell_path("~/my app"), "~/'my app'");
        assert_eq!(shell_path("/a'b"), r"'/a'\''b'");
        assert!(start_command(" /srv ").starts_with("cd '/srv' 2>/dev/null ||"));
    }

    #[tokio::test]
    async fn start_dir_runs_cd_then_login_shell() {
        let port = start_server(HOST_A).await;
        let (sink, mut rx) = sink();
        let mut c = plain(target(port, pw("right-pw"), Some(pub_of(HOST_A))));
        c.start_dir = Some("/srv".into());
        let _term = connect(sink, c, 80, 24)
            .await
            .unwrap_or_else(|e| panic!("{}", e.into_message()));
        let got = read_until(&mut rx, "welcome").await;
        assert!(got.contains("exec:cd '/srv'"), "{got:?}");
        assert!(got.contains("exec \"$SHELL\" -l"), "{got:?}");
    }

    #[tokio::test]
    async fn connects_through_jump_host() {
        let jump_port = start_server(HOST_B).await;
        let dest_port = start_server(HOST_A).await;
        let (sink, mut rx) = sink();
        let c = Connect {
            target: target(dest_port, pw("right-pw"), Some(pub_of(HOST_A))),
            jump: Some(target(jump_port, pw("right-pw"), Some(pub_of(HOST_B)))),
            start_dir: None,
            forwards: vec![],
        };
        let term = connect(sink, c, 80, 24)
            .await
            .unwrap_or_else(|e| panic!("{}", e.into_message()));
        read_until(&mut rx, "welcome").await;
        term.write("via-jump").unwrap();
        read_until(&mut rx, "echo:via-jump").await;
    }

    #[tokio::test]
    async fn jump_host_errors_are_labelled() {
        let jump_port = start_server(HOST_B).await;
        let dest_port = start_server(HOST_A).await;
        let c = Connect {
            target: target(dest_port, pw("right-pw"), Some(pub_of(HOST_A))),
            jump: Some(target(jump_port, Auth::Password(None), Some(pub_of(HOST_B)))),
            start_dir: None,
            forwards: vec![],
        };
        match connect(sink().0, c, 80, 24).await {
            Err(OpenError::Other(s)) => assert!(s.starts_with("점프 호스트 tester@127.0.0.1"), "{s}"),
            _ => panic!("점프 호스트 비밀번호가 없다고 알려야 합니다"),
        }
        // 점프 호스트의 호스트 키도 확인을 받는다.
        let c = Connect {
            target: target(dest_port, pw("right-pw"), Some(pub_of(HOST_A))),
            jump: Some(target(jump_port, pw("right-pw"), None)),
            start_dir: None,
            forwards: vec![],
        };
        match connect(sink().0, c, 80, 24).await {
            Err(OpenError::HostKey(p)) => assert_eq!(p.host_id, format!("127.0.0.1:{jump_port}")),
            _ => panic!("점프 호스트의 호스트 키를 물어야 합니다"),
        }
    }

    #[tokio::test]
    async fn local_forward_reaches_target() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // 서버 쪽에서 닿을 '내부 서비스': 받은 것을 대문자로 돌려준다.
        let svc = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let svc_port = svc.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = svc.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    if let Ok(n) = s.read(&mut buf).await {
                        let _ = s.write_all(&buf[..n].to_ascii_uppercase()).await;
                    }
                });
            }
        });
        // 비어 있는 로컬 포트를 하나 고른다.
        let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bind_port = free.local_addr().unwrap().port();
        drop(free);

        let port = start_server(HOST_A).await;
        let (sink, mut rx) = sink();
        let mut c = plain(target(port, pw("right-pw"), Some(pub_of(HOST_A))));
        c.forwards = vec![Forward {
            kind: crate::vault::ForwardKind::Local,
            bind_port,
            host: Some("127.0.0.1".into()),
            port: Some(svc_port),
        }];
        let _term = connect(sink, c, 80, 24)
            .await
            .unwrap_or_else(|e| panic!("{}", e.into_message()));
        read_until(&mut rx, "[포워딩]").await;

        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", bind_port)).await.unwrap();
        s.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"PING");
    }
}
