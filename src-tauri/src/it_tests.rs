//! 실제 OpenSSH 서버에 붙는 통합 테스트.
//!
//! 평소 `cargo test`에서는 건너뛴다(#[ignore]). 서버를 띄우고 돌린다:
//!   docker build -t sshbook-it-sshd .github/sshd
//!   docker run -d --name sshbook-it -p 127.0.0.1:2222:22 sshbook-it-sshd
//!   cargo test -- --ignored it_
//! 포트는 SSHBOOK_IT_PORT(기본 2222)로 바꿀 수 있다.

use crate::sftp;
use crate::ssh::{self, Auth, Connect, OpenError, Out, Sink, Target};
use crate::vault::{Forward, ForwardKind};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

const USER: &str = "tester";
const PASSWORD: &str = "tester-pw";

fn port() -> u16 {
    std::env::var("SSHBOOK_IT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(2222)
}

fn target(host: &str, port: u16, known_key: Option<String>) -> Target {
    Target {
        host: host.into(),
        port,
        user: USER.into(),
        auth: Auth::Password(Some(Zeroizing::new(PASSWORD.into()))),
        known_key,
    }
}

fn sink() -> (Sink, mpsc::UnboundedReceiver<Out>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(move |o| drop(tx.send(o))), rx)
}

fn plain(t: Target) -> Connect {
    Connect {
        target: t,
        jump: None,
        start_dir: None,
        forwards: vec![],
    }
}

/// 처음 붙을 때 받은 호스트 키를 그대로 믿는다(테스트 서버라서).
async fn host_key(c: Connect) -> String {
    match ssh::connect(sink().0, c, 80, 24).await {
        Err(OpenError::HostKey(p)) => p.key,
        Err(e) => panic!("호스트 키 확인을 기대했습니다: {}", e.into_message()),
        Ok(_) => panic!("호스트 키 확인 없이 붙었습니다"),
    }
}

async fn trusted() -> Target {
    let key = host_key(plain(target("127.0.0.1", port(), None))).await;
    target("127.0.0.1", port(), Some(key))
}

async fn read_until(rx: &mut mpsc::UnboundedReceiver<Out>, needle: &str) -> String {
    let mut got = String::new();
    let res = tokio::time::timeout(Duration::from_secs(10), async {
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

async fn open(c: Connect) -> (ssh::SshTerm, mpsc::UnboundedReceiver<Out>) {
    let (s, rx) = sink();
    let term = ssh::connect(s, c, 100, 30)
        .await
        .unwrap_or_else(|e| panic!("{}", e.into_message()));
    (term, rx)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_start_dir_and_shell() {
    let mut c = plain(trusted().await);
    c.start_dir = Some("/srv/app".into());
    let (term, mut rx) = open(c).await;
    term.write("pwd; echo END-$((40+2))\r").unwrap();
    let got = read_until(&mut rx, "END-42").await;
    assert!(got.contains("/srv/app"), "{got:?}");
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_missing_start_dir_falls_back_home() {
    let mut c = plain(trusted().await);
    c.start_dir = Some("/no/such/dir".into());
    let (term, mut rx) = open(c).await;
    read_until(&mut rx, "시작 경로로 이동하지 못했습니다").await;
    term.write("pwd; echo END-$((40+2))\r").unwrap();
    let got = read_until(&mut rx, "END-42").await;
    assert!(got.contains("/home/tester"), "{got:?}");
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_terminal_cwd_follows_cd() {
    let (term, mut rx) = open(plain(trusted().await)).await;
    term.write("cd /etc; echo DONE-$((1+1))\r").unwrap();
    read_until(&mut rx, "DONE-2").await;
    let cwd = sftp::terminal_cwd(&term.conn).await.unwrap();
    assert_eq!(cwd.as_deref(), Some("/etc"));
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_sftp_round_trip() {
    let (term, _rx) = open(plain(trusted().await)).await;
    let conn = &term.conn;
    let dir = format!("/tmp/it-{}", uuid::Uuid::new_v4());
    sftp::mkdir(conn, &dir).await.unwrap();

    let local_dir = std::env::temp_dir().join(format!("sshbook-it-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let src = local_dir.join("hello.txt");
    let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&src, &body).unwrap();

    let q = sftp::Transfer::quiet();
    assert_eq!(
        sftp::upload(conn, std::slice::from_ref(&src), &dir, &q).await.unwrap(),
        1
    );
    let remote = format!("{dir}/hello.txt");
    let listing = sftp::list(conn, &dir).await.unwrap();
    assert!(listing
        .entries
        .iter()
        .any(|e| e.name == "hello.txt" && e.size == body.len() as u64));

    let back = local_dir.join("back.txt");
    assert_eq!(
        sftp::download(conn, &remote, &back, false, &q).await.unwrap(),
        body.len() as u64
    );
    assert_eq!(std::fs::read(&back).unwrap(), body);

    let renamed = format!("{dir}/renamed.txt");
    sftp::rename(conn, &remote, &renamed).await.unwrap();
    sftp::remove(conn, &renamed, false).await.unwrap();
    sftp::remove(conn, &dir, true).await.unwrap();
    assert!(sftp::list(conn, &dir).await.is_err());
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_local_forward_reaches_server_side_port() {
    let bind = free_port();
    let mut c = plain(trusted().await);
    c.forwards = vec![Forward {
        kind: ForwardKind::Local,
        bind_port: bind,
        host: Some("127.0.0.1".into()),
        port: Some(22),
    }];
    let (_term, mut rx) = open(c).await;
    read_until(&mut rx, "[포워딩]").await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", bind)).await.unwrap();
    let mut banner = [0u8; 7];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut banner))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&banner, b"SSH-2.0");
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_remote_forward_reaches_local_service() {
    // 내 PC 쪽 서비스: 받은 줄을 대문자로 돌려준다.
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
    let remote_port = 20000 + (free_port() % 20000);
    let mut c = plain(trusted().await);
    c.forwards = vec![Forward {
        kind: ForwardKind::Remote,
        bind_port: remote_port,
        host: Some("127.0.0.1".into()),
        port: Some(svc_port),
    }];
    let (term, mut rx) = open(c).await;
    let note = read_until(&mut rx, "[포워딩]").await;
    assert!(!note.contains("열지 못했습니다"), "{note:?}");
    term.write(&format!("echo hello-remote | nc -w 2 127.0.0.1 {remote_port}\r"))
        .unwrap();
    read_until(&mut rx, "HELLO-REMOTE").await;
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_socks_proxy_connects_through_server() {
    let bind = free_port();
    let mut c = plain(trusted().await);
    c.forwards = vec![Forward {
        kind: ForwardKind::Dynamic,
        bind_port: bind,
        host: None,
        port: None,
    }];
    let (_term, mut rx) = open(c).await;
    read_until(&mut rx, "[포워딩]").await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", bind)).await.unwrap();
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello).await.unwrap();
    assert_eq!(hello, [5, 0]);
    // CONNECT localhost:22 (서버 쪽에서 본 주소)
    let mut req = vec![5, 1, 0, 3, 9];
    req.extend_from_slice(b"localhost");
    req.extend_from_slice(&22u16.to_be_bytes());
    s.write_all(&req).await.unwrap();
    let mut reply = [0u8; 10];
    s.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply[1], 0, "SOCKS 응답이 실패입니다: {reply:?}");
    let mut banner = [0u8; 7];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut banner))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&banner, b"SSH-2.0");
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_jump_host_to_inner_address() {
    // 점프 호스트 = 테스트 서버, 목적지 = 그 서버 안에서 본 127.0.0.1:22
    let jump = trusted().await;
    let inner_key = host_key(Connect {
        target: target("127.0.0.1", 22, None),
        jump: Some(trusted().await),
        start_dir: None,
        forwards: vec![],
    })
    .await;
    let (term, mut rx) = open(Connect {
        target: target("127.0.0.1", 22, Some(inner_key)),
        jump: Some(jump),
        start_dir: None,
        forwards: vec![],
    })
    .await;
    term.write("echo via-jump-$((2*21))\r").unwrap();
    read_until(&mut rx, "via-jump-42").await;
}

#[tokio::test]
#[ignore = "OpenSSH 테스트 서버가 필요합니다"]
async fn it_sftp_folder_round_trip_with_progress_and_cancel() {
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;
    let (term, _rx) = open(plain(trusted().await)).await;
    let conn = &term.conn;
    let base = std::env::temp_dir().join(format!("sshbook-it-{}", uuid::Uuid::new_v4()));
    let proj = base.join("proj");
    std::fs::create_dir_all(proj.join("sub/deep")).unwrap();
    std::fs::write(proj.join("a.txt"), vec![b'a'; 200_000]).unwrap();
    std::fs::write(proj.join("sub/deep/b.txt"), b"deep").unwrap();

    let remote_dir = format!("/tmp/it-{}", uuid::Uuid::new_v4());
    sftp::mkdir(conn, &remote_dir).await.unwrap();

    let seen = Arc::new(Mutex::new(Vec::<sftp::Progress>::new()));
    let s2 = seen.clone();
    let t = sftp::Transfer {
        cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        on_progress: Box::new(move |p| s2.lock().unwrap().push(p.clone())),
    };
    assert_eq!(
        sftp::upload(conn, std::slice::from_ref(&proj), &remote_dir, &t)
            .await
            .unwrap(),
        2
    );
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        (last.done, last.total, last.files_done, last.files_total),
        (200_004, 200_004, 2, 2)
    );

    // 폴더째 내려받기
    let down = base.join("down");
    std::fs::create_dir_all(&down).unwrap();
    let n = sftp::download(
        conn,
        &format!("{remote_dir}/proj"),
        &down,
        true,
        &sftp::Transfer::quiet(),
    )
    .await
    .unwrap();
    assert_eq!(n, 200_004);
    assert_eq!(std::fs::read(down.join("proj/sub/deep/b.txt")).unwrap(), b"deep");

    // 취소: 시작하자마자 취소 표시 → 오류, 쓰다 만 파일은 남지 않는다
    let c = sftp::Transfer::quiet();
    c.cancel.store(true, Ordering::Relaxed);
    let err = sftp::download(
        conn,
        &format!("{remote_dir}/proj/a.txt"),
        &base.join("x.txt"),
        false,
        &c,
    )
    .await
    .unwrap_err();
    assert_eq!(err, sftp::CANCELLED);
    assert!(!base.join("x.txt").exists() && !base.join("x.sshbook-part").exists());
}
