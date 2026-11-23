//! 포트 포워딩 (-L / -R / -D).
//!
//! SSH 연결 하나에 붙어서 돌고, 연결이 끝나면 함께 멈춘다(작업을 abort).
//! 성공·실패는 터미널에 한 줄로 알린다. 포워딩이 실패해도 셸 연결은 그대로 쓴다.

use crate::ssh::{Client, Out, Sink};
use crate::vault::{Forward, ForwardKind};
use russh::client::{Handle, Msg};
use russh::Channel;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// 원격 포워딩: 서버 쪽 포트 → 내 PC에서 이어 줄 곳
pub type RemoteMap = Arc<Mutex<HashMap<u32, (String, u16)>>>;

const SOCKS_HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const DIM: &str = "\x1b[2m";
const YELLOW: &str = "\x1b[33m";
const RESET: &str = "\x1b[0m";

fn note(sink: &Sink, ok: bool, text: String) {
    let color = if ok { DIM } else { YELLOW };
    let label = crate::i18n::tr("포워딩");
    let text = crate::i18n::tr(&text);
    sink(Out::Data(format!("{color}[{label}] {text}{RESET}\r\n").into_bytes()));
}

pub fn describe(f: &Forward) -> String {
    let dest = format!("{}:{}", f.host.as_deref().unwrap_or("localhost"), f.port.unwrap_or(0));
    match f.kind {
        ForwardKind::Local => format!("내 PC 127.0.0.1:{} → {dest}", f.bind_port),
        ForwardKind::Remote => format!("서버 localhost:{} → 내 PC {dest}", f.bind_port),
        ForwardKind::Dynamic => format!("SOCKS5 프록시 127.0.0.1:{}", f.bind_port),
    }
}

/// 세션에 저장된 포워딩을 모두 연다. 돌려준 작업들은 연결이 끝날 때 abort한다.
pub async fn start_all(
    handle: &Arc<Handle<Client>>,
    remote: &RemoteMap,
    forwards: &[Forward],
    sink: &Sink,
) -> Vec<JoinHandle<()>> {
    let mut tasks = Vec::new();
    for f in forwards {
        let what = describe(f);
        if let Some(problem) = f.problem() {
            note(sink, false, format!("{what} — 열지 못했습니다: {problem}"));
            continue;
        }
        let dest = || -> Option<(String, u16)> {
            let host = f.host.as_deref().map(str::trim).filter(|h| !h.is_empty())?.to_string();
            Some((host, f.port.filter(|p| *p > 0)?))
        };
        let result: Result<Option<JoinHandle<()>>, String> = match f.kind {
            ForwardKind::Local => match dest() {
                Some((host, port)) => listen(f.bind_port, handle.clone(), move |sock, h| {
                    tokio::spawn(local_conn(sock, h, host.clone(), port));
                })
                .await
                .map(Some),
                None => Err("목적지 호스트와 포트를 입력하세요".into()),
            },
            ForwardKind::Dynamic => listen(f.bind_port, handle.clone(), |sock, h| {
                tokio::spawn(socks_conn(sock, h));
            })
            .await
            .map(Some),
            ForwardKind::Remote => match dest() {
                Some(d) => {
                    remote
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(f.bind_port as u32, d);
                    handle
                        .tcpip_forward("localhost", f.bind_port as u32)
                        .await
                        .map(|_| None)
                        .map_err(|e| format!("서버가 거절했습니다 ({e})"))
                }
                None => Err("목적지 호스트와 포트를 입력하세요".into()),
            },
        };
        match result {
            Ok(task) => {
                note(sink, true, what);
                tasks.extend(task);
            }
            Err(e) => note(sink, false, format!("{what} — 열지 못했습니다: {e}")),
        }
    }
    tasks
}

/// 내 PC 127.0.0.1:port에서 접속을 받아 on_conn으로 넘긴다.
async fn listen<F>(port: u16, handle: Arc<Handle<Client>>, on_conn: F) -> Result<JoinHandle<()>, String>
where
    F: Fn(TcpStream, Arc<Handle<Client>>) + Send + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("포트 {port}를 열지 못했습니다 ({e})"))?;
    Ok(tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            on_conn(sock, handle.clone());
        }
    }))
}

async fn local_conn(mut sock: TcpStream, handle: Arc<Handle<Client>>, host: String, port: u16) {
    let (ip, from) = peer(&sock);
    if let Ok(ch) = handle.channel_open_direct_tcpip(host, port as u32, ip, from).await {
        let mut stream = ch.into_stream();
        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    }
}

fn peer(sock: &TcpStream) -> (String, u32) {
    sock.peer_addr()
        .map(|a| (a.ip().to_string(), a.port() as u32))
        .unwrap_or_else(|_| ("127.0.0.1".into(), 0))
}

/// 서버가 원격 포워딩 포트로 받은 접속을 내 PC의 목적지로 잇는다.
pub async fn pipe_to_local(channel: Channel<Msg>, host: String, port: u16) {
    if let Ok(mut sock) = TcpStream::connect((host.as_str(), port)).await {
        let mut stream = channel.into_stream();
        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    }
}

// ---- SOCKS5 (인증 없음, CONNECT만) ----

async fn socks_conn(mut sock: TcpStream, handle: Arc<Handle<Client>>) {
    // 인사만 하고 멈춘 접속이 쌓이지 않게 시간 제한을 둔다.
    let Ok(Ok((host, port))) = tokio::time::timeout(SOCKS_HELLO_TIMEOUT, socks_handshake(&mut sock)).await else {
        return;
    };
    let (ip, from) = peer(&sock);
    match handle.channel_open_direct_tcpip(host, port as u32, ip, from).await {
        Ok(ch) => {
            // 성공. 묶인 주소는 쓰지 않으므로 0.0.0.0:0으로 답한다.
            if sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_err() {
                return;
            }
            let mut stream = ch.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
        }
        Err(_) => {
            // 4 = 호스트에 닿을 수 없음
            let _ = sock.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        }
    }
}

/// 인사와 요청을 읽고 목적지를 돌려준다. 지원하지 않는 요청은 거절하고 Err.
async fn socks_handshake<S: AsyncReadExt + AsyncWriteExt + Unpin>(sock: &mut S) -> std::io::Result<(String, u16)> {
    let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "socks");
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(bad());
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        sock.write_all(&[5, 0xff]).await?;
        return Err(bad());
    }
    sock.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[0] != 5 || req[1] != 1 {
        // 7 = 지원하지 않는 명령
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(bad());
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            sock.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| bad())?
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            sock.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(bad());
        }
    };
    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn socks_handshake_reads_domain_target() {
        let (mut client, mut server) = tokio::io::duplex(256);
        let task = tokio::spawn(async move { socks_handshake(&mut server).await });
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut reply = [0u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [5, 0]);
        let mut req = vec![5, 1, 0, 3, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&443u16.to_be_bytes());
        client.write_all(&req).await.unwrap();
        assert_eq!(task.await.unwrap().unwrap(), ("example.com".to_string(), 443));
    }

    #[tokio::test]
    async fn socks_handshake_rejects_bind_command() {
        let (mut client, mut server) = tokio::io::duplex(256);
        let task = tokio::spawn(async move { socks_handshake(&mut server).await });
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut reply = [0u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        client.write_all(&[5, 2, 0, 1, 127, 0, 0, 1, 0, 80]).await.unwrap();
        assert!(task.await.unwrap().is_err());
        let mut fail = [0u8; 2];
        client.read_exact(&mut fail).await.unwrap();
        assert_eq!(fail, [5, 7]);
    }

    #[test]
    fn describes_each_kind() {
        let f = |kind, host: Option<&str>, port| Forward {
            kind,
            bind_port: 8080,
            host: host.map(String::from),
            port,
        };
        assert_eq!(
            describe(&f(ForwardKind::Local, Some("db"), Some(5432))),
            "내 PC 127.0.0.1:8080 → db:5432"
        );
        assert_eq!(
            describe(&f(ForwardKind::Dynamic, None, None)),
            "SOCKS5 프록시 127.0.0.1:8080"
        );
    }
}
