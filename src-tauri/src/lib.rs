mod pty;
mod ssh;
mod vault;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};
use vault::{KdfParams, OpenVault, Secret, Session, SessionKind};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

type CmdResult<T> = Result<T, String>;

enum Term {
    Local(pty::LocalPty),
    Ssh(ssh::SshTerm),
}

impl Term {
    fn close(self) {
        match self {
            Term::Local(mut p) => p.kill(),
            Term::Ssh(s) => s.close(),
        }
    }
}

#[derive(Default)]
struct AppState {
    vault: Mutex<Option<OpenVault>>,
    terms: Mutex<HashMap<String, Term>>,
    /// 사용자 확인을 기다리는 호스트 키 ("host:port" → 공개 키)
    pending_hosts: Mutex<HashMap<String, String>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn vault_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("vault.sshv"))
}

const LOCKED: &str = "보관함이 잠겨 있습니다.";

// ---- 보관함 ----

#[derive(Serialize)]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
    path: String,
}

#[tauri::command]
fn vault_status(app: AppHandle, state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    let path = vault_path(&app)?;
    Ok(VaultStatus {
        exists: path.exists(),
        unlocked: lock(&state.vault).is_some(),
        path: path.display().to_string(),
    })
}

// Argon2가 수백 ms 걸리므로 async로 두어 UI 스레드를 막지 않는다.
#[tauri::command]
async fn vault_create(app: AppHandle, state: State<'_, AppState>, password: String) -> CmdResult<()> {
    if password.chars().count() < 8 {
        return Err("마스터 비밀번호는 8자 이상이어야 합니다.".into());
    }
    let v = OpenVault::create(&vault_path(&app)?, &password, KdfParams::DEFAULT).map_err(|e| e.to_string())?;
    *lock(&state.vault) = Some(v);
    Ok(())
}

#[tauri::command]
async fn vault_unlock(app: AppHandle, state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let v = OpenVault::open(&vault_path(&app)?, &password).map_err(|e| e.to_string())?;
    *lock(&state.vault) = Some(v);
    Ok(())
}

#[tauri::command]
fn vault_lock(state: State<'_, AppState>) {
    for (_, t) in lock(&state.terms).drain() {
        t.close();
    }
    lock(&state.pending_hosts).clear();
    // OpenVault가 버려지면서 키가 메모리에서 지워진다(Zeroizing).
    *lock(&state.vault) = None;
}

#[tauri::command]
async fn vault_change_password(
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> CmdResult<()> {
    if new_password.chars().count() < 8 {
        return Err("마스터 비밀번호는 8자 이상이어야 합니다.".into());
    }
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    OpenVault::open(v.path(), &old_password).map_err(|_| "지금 마스터 비밀번호가 맞지 않습니다.".to_string())?;
    v.change_password(&new_password).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_export(state: State<'_, AppState>, dest: String) -> CmdResult<()> {
    let guard = lock(&state.vault);
    guard
        .as_ref()
        .ok_or(LOCKED)?
        .export_to(&PathBuf::from(dest))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn vault_import(app: AppHandle, state: State<'_, AppState>, src: String, password: String) -> CmdResult<()> {
    let v = vault::import(&PathBuf::from(src), &vault_path(&app)?, &password).map_err(|e| e.to_string())?;
    *lock(&state.vault) = Some(v);
    Ok(())
}

// ---- 세션 ----

/// 세션을 저장할 때 함께 오는 비밀 정보. 비운 항목은 기존 값을 그대로 둔다.
#[derive(Deserialize, Default, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct SecretInput {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default)]
    import_key: bool,
    #[serde(default)]
    clear: bool,
}

fn with_flags(mut s: Session, secrets: &std::collections::BTreeMap<String, Secret>) -> Session {
    let sec = secrets.get(&s.id);
    s.has_password = sec.is_some_and(|x| x.password.is_some());
    s.has_private_key = sec.is_some_and(|x| x.private_key.is_some());
    s.has_passphrase = sec.is_some_and(|x| x.passphrase.is_some());
    s
}

#[tauri::command]
fn sessions_list(state: State<'_, AppState>) -> CmdResult<Vec<Session>> {
    let guard = lock(&state.vault);
    let v = guard.as_ref().ok_or(LOCKED)?;
    Ok(v.data
        .sessions
        .iter()
        .cloned()
        .map(|s| with_flags(s, &v.data.secrets))
        .collect())
}

#[tauri::command]
fn session_save(state: State<'_, AppState>, session: Session, secret: Option<SecretInput>) -> CmdResult<Session> {
    let mut s = session;
    if s.name.trim().is_empty() {
        return Err("이름을 입력하세요.".into());
    }
    if s.kind == SessionKind::Ssh
        && (s.host.as_deref().unwrap_or("").trim().is_empty() || s.user.as_deref().unwrap_or("").trim().is_empty())
    {
        return Err("호스트와 사용자를 입력하세요.".into());
    }
    if s.id.is_empty() {
        s.id = uuid::Uuid::new_v4().to_string();
    }
    s.group = s.group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());

    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;

    if let Some(mut input) = secret {
        let entry = v.data.secrets.entry(s.id.clone()).or_default();
        if input.clear {
            *entry = Secret::default();
        }
        if let Some(p) = input.password.take().filter(|p| !p.is_empty()) {
            entry.password = Some(p);
        }
        if let Some(p) = input.passphrase.take().filter(|p| !p.is_empty()) {
            entry.passphrase = Some(p);
        }
        if input.import_key {
            let path = s
                .key_path
                .as_deref()
                .filter(|p| !p.trim().is_empty())
                .ok_or("개인 키 파일 경로가 없습니다.")?;
            let pem = std::fs::read_to_string(pty::expand_home(path))
                .map_err(|e| format!("키 파일을 읽지 못했습니다: {e}"))?;
            if !pem.contains("PRIVATE KEY") {
                return Err("개인 키 파일이 아닌 것 같습니다 (OpenSSH/PEM 형식이 필요합니다).".into());
            }
            entry.private_key = Some(pem);
        }
        if entry.is_empty() {
            v.data.secrets.remove(&s.id);
        }
    }

    match v.data.sessions.iter_mut().find(|x| x.id == s.id) {
        Some(existing) => *existing = s.clone(),
        None => v.data.sessions.push(s.clone()),
    }
    v.save().map_err(|e| e.to_string())?;
    Ok(with_flags(s, &v.data.secrets))
}

#[tauri::command]
fn session_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    v.data.sessions.retain(|s| s.id != id);
    v.data.secrets.remove(&id);
    v.save().map_err(|e| e.to_string())
}

// ---- 터미널 ----

enum Plan {
    Local { shell: Option<String>, cwd: Option<String> },
    Ssh(ssh::Target),
}

/// 보관함에서 접속에 필요한 것만 꺼낸다. 잠금을 쥔 채 await하지 않도록 따로 둔다.
fn plan_for(
    state: &AppState,
    session_id: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
) -> CmdResult<Plan> {
    let Some(sid) = session_id else {
        return Ok(Plan::Local { shell: None, cwd: None });
    };
    let guard = lock(&state.vault);
    let v = guard.as_ref().ok_or(LOCKED)?;
    let s = v
        .data
        .sessions
        .iter()
        .find(|s| s.id == sid)
        .ok_or("세션을 찾을 수 없습니다.")?;
    if s.kind == SessionKind::Local {
        return Ok(Plan::Local {
            shell: s.shell.clone(),
            cwd: s.cwd.clone(),
        });
    }
    let host = s.host.clone().unwrap_or_default().trim().to_string();
    let user = s.user.clone().unwrap_or_default().trim().to_string();
    if host.is_empty() || user.is_empty() {
        return Err("호스트와 사용자를 입력하세요.".into());
    }
    let port = s.port.unwrap_or(22);
    let sec = v.data.secrets.get(&s.id);
    let z = |o: Option<String>| o.filter(|x| !x.is_empty()).map(Zeroizing::new);

    let auth = match s.auth.as_deref().unwrap_or("password") {
        "agent" => ssh::Auth::Agent,
        "key" => {
            let pem = match sec.and_then(|x| x.private_key.clone()) {
                Some(p) => p,
                None => {
                    let path = s
                        .key_path
                        .as_deref()
                        .filter(|p| !p.trim().is_empty())
                        .ok_or("개인 키 파일이 지정되지 않았습니다.")?;
                    std::fs::read_to_string(pty::expand_home(path))
                        .map_err(|e| format!("키 파일을 읽지 못했습니다: {e}"))?
                }
            };
            ssh::Auth::Key {
                pem: Zeroizing::new(pem),
                passphrase: z(passphrase).or_else(|| z(sec.and_then(|x| x.passphrase.clone()))),
            }
        }
        _ => ssh::Auth::Password(z(password).or_else(|| z(sec.and_then(|x| x.password.clone())))),
    };
    let known_key = v.data.known_hosts.get(&ssh::host_id(&host, port)).cloned();
    Ok(Plan::Ssh(ssh::Target {
        host,
        port,
        user,
        auth,
        known_key,
    }))
}

/// password / passphrase는 저장된 값이 없거나 틀려서 터미널에서 다시 물어본 값이다. 저장하지 않는다.
#[tauri::command]
async fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
    cols: u16,
    rows: u16,
    password: Option<String>,
    passphrase: Option<String>,
) -> CmdResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let term = match plan_for(&state, session_id, password, passphrase)? {
        Plan::Local { shell, cwd } => Term::Local(pty::spawn(app, id.clone(), shell, cwd, cols, rows)?),
        Plan::Ssh(target) => match ssh::connect(ssh::app_sink(app, id.clone()), target, cols, rows).await {
            Ok(t) => Term::Ssh(t),
            Err(ssh::OpenError::HostKey(p)) => {
                lock(&state.pending_hosts).insert(p.host_id.clone(), p.key.clone());
                return Err(ssh::OpenError::HostKey(p).into_message());
            }
            Err(e) => return Err(e.into_message()),
        },
    };
    lock(&state.terms).insert(id.clone(), term);
    Ok(id)
}

/// 사용자가 지문을 확인한 서버 키를 보관함에 저장한다.
#[tauri::command]
fn host_trust(state: State<'_, AppState>, host_id: String) -> CmdResult<()> {
    let key = lock(&state.pending_hosts)
        .remove(&host_id)
        .ok_or("확인할 호스트 키가 없습니다. 다시 연결해 보세요.")?;
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    v.data.known_hosts.insert(host_id, key);
    v.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn term_write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    match lock(&state.terms).get_mut(&id) {
        Some(Term::Local(p)) => p.write(&data),
        Some(Term::Ssh(s)) => s.write(&data),
        None => Ok(()),
    }
}

#[tauri::command]
fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    match lock(&state.terms).get(&id) {
        Some(Term::Local(p)) => p.resize(cols, rows),
        Some(Term::Ssh(s)) => s.resize(cols, rows),
        None => Ok(()),
    }
}

#[tauri::command]
fn term_close(state: State<'_, AppState>, id: String) {
    if let Some(t) = lock(&state.terms).remove(&id) {
        t.close();
    }
}

/// macOS 메뉴. 기본 메뉴의 ⌘W(창 닫기) 대신 "탭 닫기"를 두고, 누르면 화면에 알린다.
/// 화면은 탭이 있으면 탭을 닫고, 없으면 창을 닫는다.
/// 다른 OS에서는 메뉴를 쓰지 않지만 CI(Linux)에서 컴파일은 되도록 막지 않는다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "파일",
        true,
        &[&MenuItem::with_id(
            app,
            MENU_CLOSE_TAB,
            "탭 닫기",
            true,
            Some("CmdOrCtrl+W"),
        )?],
    )?;
    // 편집 메뉴가 있어야 입력칸에서 ⌘C·⌘V·⌘A가 동작한다.
    let edit = Submenu::with_items(
        app,
        "편집",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "윈도우",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &window])
}

const MENU_CLOSE_TAB: &str = "close-tab";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_menu(app_menu(_app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            if event.id().as_ref() == MENU_CLOSE_TAB {
                let _ = app.emit("menu-close-tab", ());
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_change_password,
            vault_export,
            vault_import,
            sessions_list,
            session_save,
            session_delete,
            term_open,
            host_trust,
            term_write,
            term_resize,
            term_close,
        ])
        .run(tauri::generate_context!())
        .expect("앱을 시작하지 못했습니다");
}
