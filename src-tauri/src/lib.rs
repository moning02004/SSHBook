mod applog;
mod fonts;
mod forward;
mod fsperm;
mod i18n;
#[cfg(test)]
mod it_tests;
mod nopass;
mod pty;
mod sftp;
mod ssh;
mod sshconfig;
mod termlog;
mod vault;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State};
use vault::{Group, KdfParams, OpenVault, Secret, Session, SessionKind, Snippet};
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

/// 서버 질문에 대한 답을 넘겨주는 곳(None이면 취소)
type AuthReply = tokio::sync::oneshot::Sender<Option<Vec<Zeroizing<String>>>>;

#[derive(Default)]
struct AppState {
    vault: Mutex<Option<OpenVault>>,
    terms: Mutex<HashMap<String, Term>>,
    /// 사용자 확인을 기다리는 호스트 키 ("host:port" → 공개 키)
    pending_hosts: Mutex<ssh::PendingHosts>,
    /// 잠글 때마다 올라간다. 잠그는 사이에 끝난 접속을 알아채서 바로 닫는다.
    lock_generation: AtomicU64,
    /// 접속 중 OTP 같은 질문의 답을 기다리는 곳
    pending_auth: Mutex<HashMap<String, AuthReply>>,
    /// 진행 중인 파일 전송의 취소 표시 (전송 id → 표시)
    transfers: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
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
    /// 마스터 비밀번호 없이 쓰는 중(이 PC의 열쇠 파일로 연다)
    passwordless: bool,
}

#[tauri::command]
fn vault_status(app: AppHandle, state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    let path = vault_path(&app)?;
    Ok(VaultStatus {
        exists: path.exists(),
        unlocked: lock(&state.vault).is_some(),
        passwordless: nopass::is_on(&path),
        path: path.display().to_string(),
    })
}

// Argon2가 수백 ms 걸리므로 async로 두어 UI 스레드를 막지 않는다.
#[tauri::command]
async fn vault_create(app: AppHandle, state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    if password.chars().count() < 8 {
        return Err("마스터 비밀번호는 8자 이상이어야 합니다.".into());
    }
    let path = vault_path(&app)?;
    let v = OpenVault::create(&path, &password, KdfParams::DEFAULT).map_err(|e| e.to_string())?;
    let _ = nopass::remove(&path);
    *lock(&state.vault) = Some(v);
    Ok(())
}

#[tauri::command]
async fn vault_unlock(app: AppHandle, state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    let path = vault_path(&app)?;
    let v = OpenVault::open(&path, &password).map_err(|e| {
        applog::warn(&format!("보관함을 열지 못함: {e}"));
        e.to_string()
    })?;
    // 예전 버전이 만든 보관함(0644)도 내 계정만 읽게 맞춘다.
    let _ = fsperm::fix_mode(&path);
    // 직접 입력한 비밀번호로 열렸다면 남아 있는 열쇠 파일은 이 보관함과 맞지 않는 것이다.
    nopass::retire(&path, &password);
    *lock(&state.vault) = Some(v);
    Ok(())
}

/// 마스터 비밀번호 없이 쓰는 경우: 이 PC의 열쇠 파일로 연다.
#[tauri::command]
async fn vault_unlock_auto(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let path = vault_path(&app)?;
    let secret = nopass::load(&path).ok_or("이 PC의 열쇠 파일이 없습니다. 마스터 비밀번호로 여세요.")?;
    let v = OpenVault::open(&path, &secret).map_err(|e| {
        applog::warn(&format!("열쇠 파일로 보관함을 열지 못함: {e}"));
        format!("열쇠 파일로 열지 못했습니다: {e}")
    })?;
    *lock(&state.vault) = Some(v);
    Ok(())
}

/// 마스터 비밀번호 끄기: 지금 비밀번호를 확인하고, 임의의 비밀번호로 다시 잠근 뒤 열쇠 파일에 둔다.
#[tauri::command]
async fn vault_disable_password(state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let path = v.path().to_path_buf();
    if nopass::is_on(&path) {
        return Err("이미 마스터 비밀번호 없이 쓰고 있습니다.".into());
    }
    OpenVault::open(&path, &password).map_err(|_| "지금 마스터 비밀번호가 맞지 않습니다.".to_string())?;
    let secret = nopass::generate()?;
    // 열쇠를 먼저 저장한다. 여기서 멈춰도 보관함은 아직 마스터 비밀번호로 열린다.
    nopass::save(&path, &secret).map_err(|e| format!("열쇠 파일을 만들지 못했습니다: {e}"))?;
    if let Err(e) = v.change_password(&secret) {
        let _ = nopass::remove(&path);
        return Err(e.to_string());
    }
    applog::info("마스터 비밀번호를 껐습니다");
    Ok(())
}

/// 마스터 비밀번호 다시 켜기: 보관함과, 끈 동안 생긴 백업을 새 비밀번호로 잠그고 열쇠 파일을 지운다.
#[tauri::command]
async fn vault_enable_password(state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    if password.chars().count() < 8 {
        return Err("마스터 비밀번호는 8자 이상이어야 합니다.".into());
    }
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let path = v.path().to_path_buf();
    let old = nopass::load(&path).ok_or("이미 마스터 비밀번호를 쓰고 있습니다.")?;
    v.change_password(&password).map_err(|e| e.to_string())?;
    vault::backup::rekey(&path, &old, &password);
    nopass::remove(&path).map_err(|e| format!("열쇠 파일을 지우지 못했습니다: {e}"))?;
    applog::info("마스터 비밀번호를 켰습니다");
    Ok(())
}

#[tauri::command]
fn vault_lock(state: State<'_, AppState>) {
    // 지금 접속 중인 것은 끝나는 대로 닫히게 표시해 둔다.
    state.lock_generation.fetch_add(1, Ordering::SeqCst);
    for flag in lock(&state.transfers).values() {
        flag.store(true, Ordering::Relaxed);
    }
    for (_, t) in lock(&state.terms).drain() {
        t.close();
    }
    lock(&state.pending_hosts).clear();
    // 답을 기다리던 접속은 취소로 끝난다.
    lock(&state.pending_auth).clear();
    // OpenVault가 버려지면서 키가 메모리에서 지워진다(Zeroizing).
    *lock(&state.vault) = None;
}

#[tauri::command]
async fn vault_change_password(
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> CmdResult<()> {
    let (old_password, new_password) = (Zeroizing::new(old_password), Zeroizing::new(new_password));
    if new_password.chars().count() < 8 {
        return Err("마스터 비밀번호는 8자 이상이어야 합니다.".into());
    }
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    if nopass::is_on(v.path()) {
        return Err("마스터 비밀번호 없이 쓰는 중입니다. 먼저 마스터 비밀번호를 켜세요.".into());
    }
    OpenVault::open(v.path(), &old_password).map_err(|_| "지금 마스터 비밀번호가 맞지 않습니다.".to_string())?;
    v.change_password(&new_password).map_err(|e| e.to_string())
}

/// 보관함 파일 내보내기. 마스터 비밀번호 없이 쓰는 중이면 내보낼 파일의 비밀번호가 필요하다.
#[tauri::command]
async fn vault_export(
    state: State<'_, AppState>,
    dest: String,
    password: Option<String>,
    app_settings: Option<String>,
) -> CmdResult<()> {
    let password = password.map(Zeroizing::new);
    if app_settings.as_ref().is_some_and(|s| s.len() > vault::APP_SETTINGS_MAX) {
        return Err("설정이 너무 커서 내보낼 수 없습니다.".into());
    }
    let guard = lock(&state.vault);
    let v = guard.as_ref().ok_or(LOCKED)?;
    let dest = PathBuf::from(dest);
    if nopass::is_on(v.path()) {
        let pw = password.filter(|p| p.chars().count() >= 8);
        let pw = pw.ok_or("내보낼 파일의 비밀번호(8자 이상)가 필요합니다.")?;
        return v
            .export_with_password(&dest, &pw, app_settings)
            .map_err(|e| e.to_string());
    }
    v.export_to(&dest, app_settings).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeResult {
    #[serde(flatten)]
    count: vault::MergeCount,
    /// 그 파일에 들어 있던 앱 설정(JSON)
    app_settings: Option<String>,
}

/// 다른 PC에서 내보낸 파일을 지금 보관함에 더한다(지금 세션과 마스터 비밀번호는 그대로).
#[tauri::command]
async fn vault_merge(
    app: AppHandle,
    state: State<'_, AppState>,
    src: String,
    password: String,
) -> CmdResult<MergeResult> {
    let password = Zeroizing::new(password);
    let src = PathBuf::from(src);
    let mine = vault_path(&app)?;
    if src == mine || matches!((src.canonicalize(), mine.canonicalize()), (Ok(a), Ok(b)) if a == b) {
        return Err("지금 쓰고 있는 보관함 파일입니다.".into());
    }
    // 비밀번호 확인(시간이 걸린다)은 보관함을 잠그기 전에 한다.
    let mut other = vault::OpenVault::open(&src, &password).map_err(|e| e.to_string())?;
    let mut data = std::mem::take(&mut other.data);
    let app_settings = data.app_settings.take();
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let count = v.data.merge_from(data);
    v.save().map_err(|e| e.to_string())?;
    Ok(MergeResult { count, app_settings })
}

/// 가져온 보관함에 들어 있던 앱 설정을 한 번 꺼낸다(꺼낸 뒤에는 보관함에서 지운다).
#[tauri::command]
fn vault_take_app_settings(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let taken = v.data.app_settings.take();
    if taken.is_some() {
        v.save().map_err(|e| e.to_string())?;
    }
    Ok(taken)
}

#[tauri::command]
async fn vault_import(app: AppHandle, state: State<'_, AppState>, src: String, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    let dest = vault_path(&app)?;
    let v = vault::import(&PathBuf::from(src), &dest, &password).map_err(|e| e.to_string())?;
    nopass::retire(&dest, &password);
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
    /// 키 암호만 지운다(키 칸을 비우고 저장한 경우)
    #[serde(default)]
    clear_passphrase: bool,
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
    // 사용자는 비워 둘 수 있다. 그러면 연결할 때 터미널에서 묻는다.
    if s.kind == SessionKind::Ssh && s.host.as_deref().unwrap_or("").trim().is_empty() {
        return Err("호스트를 입력하세요.".into());
    }
    if let Some(problem) = s.forwards.iter().find_map(|f| f.problem()) {
        return Err(problem.into());
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
        if input.clear_passphrase {
            if let Some(mut old) = entry.passphrase.take() {
                old.zeroize();
            }
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
    // 이 세션을 점프 호스트로 쓰던 세션은 바로 붙도록 되돌린다.
    for s in v
        .data
        .sessions
        .iter_mut()
        .filter(|s| s.jump_id.as_deref() == Some(id.as_str()))
    {
        s.jump_id = None;
    }
    v.save().map_err(|e| e.to_string())
}

/// 그룹 이름을 바꾼다(그 그룹의 세션 모두). to가 비면 그룹을 없앤다(그룹 없음으로).
#[tauri::command]
fn sessions_rename_group(state: State<'_, AppState>, from: String, to: String) -> CmdResult<usize> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let n = v.data.group_rename(&from, &to)?;
    v.save().map_err(|e| e.to_string())?;
    Ok(n)
}

// ---- 그룹 ----

#[tauri::command]
fn groups_list(state: State<'_, AppState>) -> CmdResult<Vec<Group>> {
    let guard = lock(&state.vault);
    Ok(guard.as_ref().ok_or(LOCKED)?.data.group_list())
}

#[tauri::command]
fn group_add(state: State<'_, AppState>, name: String, color: Option<String>) -> CmdResult<Group> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let g = v.data.group_add(&name, color)?;
    v.save().map_err(|e| e.to_string())?;
    Ok(g)
}

#[tauri::command]
fn group_set_color(state: State<'_, AppState>, name: String, color: Option<String>) -> CmdResult<()> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    v.data.group_set_color(&name, color)?;
    v.save().map_err(|e| e.to_string())
}

/// 그룹을 지운다. 그 그룹의 세션은 그룹 없음으로 옮긴다.
/// 사이드바를 끌어서 정한 순서로 보여 주는지
#[tauri::command]
fn sidebar_manual(state: State<'_, AppState>) -> CmdResult<bool> {
    let guard = lock(&state.vault);
    Ok(guard.as_ref().ok_or(LOCKED)?.data.manual_order)
}

/// 사이드바 순서(그룹 순서, 세션 순서와 그룹)를 저장한다.
#[tauri::command]
fn sidebar_reorder(
    state: State<'_, AppState>,
    groups: Vec<String>,
    sessions: Vec<vault::SessionPlace>,
) -> CmdResult<()> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    v.data.reorder(&groups, &sessions)?;
    v.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn group_delete(state: State<'_, AppState>, name: String) -> CmdResult<usize> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let n = v.data.group_delete(&name);
    v.save().map_err(|e| e.to_string())?;
    Ok(n)
}

/// 다시 입력한 비밀번호·키 암호로 접속에 성공했을 때 보관함에 반영한다.
/// 저장해 둔 값이 있으면 바꾸고, 없으면 `add`일 때만 새로 넣는다.
/// 돌려주는 값: "updated"(바꿈·넣음) · "unchanged"(같은 값) · "none"(저장된 값이 없어 넣지 않음)
fn replace_stored_secret(
    secrets: &mut std::collections::BTreeMap<String, Secret>,
    id: &str,
    password: Option<String>,
    passphrase: Option<String>,
    add: bool,
) -> &'static str {
    let had = secrets.get(id);
    let had_any = |pick: fn(&Secret) -> bool| had.is_some_and(pick);
    let has_pw = had_any(|s| s.password.is_some());
    let has_pp = had_any(|s| s.passphrase.is_some());
    let mut result = "none";
    for (is_pw, new) in [(true, password), (false, passphrase)] {
        let Some(mut new) = new.filter(|v| !v.is_empty()) else {
            continue;
        };
        let stored = if is_pw { has_pw } else { has_pp };
        if !stored && !add {
            new.zeroize();
            continue;
        }
        let entry = secrets.entry(id.to_string()).or_default();
        let slot = if is_pw {
            &mut entry.password
        } else {
            &mut entry.passphrase
        };
        match slot.as_mut() {
            Some(old) if *old == new => {
                new.zeroize();
                if result == "none" {
                    result = "unchanged";
                }
            }
            Some(old) => {
                // 예전 값은 메모리에서 지우고 바꾼다.
                old.zeroize();
                *old = std::mem::take(&mut new);
                result = "updated";
            }
            None => {
                *slot = Some(std::mem::take(&mut new));
                result = "updated";
            }
        }
    }
    result
}

/// 편집 창의 '보기'용. 보관함이 열려 있을 때만 저장된 비밀번호·키 암호를 돌려준다.
#[tauri::command]
fn session_reveal_secret(state: State<'_, AppState>, id: String, kind: String) -> CmdResult<Option<String>> {
    let guard = lock(&state.vault);
    let v = guard.as_ref().ok_or(LOCKED)?;
    let Some(sec) = v.data.secrets.get(&id) else {
        return Ok(None);
    };
    match kind.as_str() {
        "password" => Ok(sec.password.clone()),
        "passphrase" => Ok(sec.passphrase.clone()),
        _ => Err("알 수 없는 항목입니다.".into()),
    }
}

#[tauri::command]
fn session_update_secret(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    passphrase: Option<String>,
    add: Option<bool>,
) -> CmdResult<String> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    match v.data.sessions.iter().find(|s| s.id == id) {
        None => return Ok("none".into()),
        // 바로 접속을 끈 세션은 저장하지도, 저장할지 묻지도 않는다.
        Some(s) if s.ask_login => return Ok("skip".into()),
        Some(_) => {}
    }
    let result = replace_stored_secret(&mut v.data.secrets, &id, password, passphrase, add.unwrap_or(false));
    if result == "updated" {
        v.save().map_err(|e| e.to_string())?;
    }
    Ok(result.into())
}

/// 같은 설정(저장된 비밀번호·키 포함)으로 새 세션을 만든다. 이름 뒤에 "복사"를 붙인다.
#[tauri::command]
fn session_duplicate(state: State<'_, AppState>, id: String) -> CmdResult<Session> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    let mut s = v
        .data
        .sessions
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or("세션을 찾을 수 없습니다.")?;
    s.id = uuid::Uuid::new_v4().to_string();
    s.name = format!("{} 복사", s.name);
    if let Some(sec) = v.data.secrets.get(&id).cloned() {
        v.data.secrets.insert(s.id.clone(), sec);
    }
    v.data.sessions.push(s.clone());
    v.save().map_err(|e| e.to_string())?;
    Ok(with_flags(s, &v.data.secrets))
}

// ---- 명령 모음 ----

#[tauri::command]
fn snippets_list(state: State<'_, AppState>) -> CmdResult<Vec<Snippet>> {
    let guard = lock(&state.vault);
    Ok(guard.as_ref().ok_or(LOCKED)?.data.snippets.clone())
}

#[tauri::command]
fn snippet_save(state: State<'_, AppState>, snippet: Snippet) -> CmdResult<Snippet> {
    let mut s = snippet;
    if s.command.trim().is_empty() {
        return Err("명령을 입력하세요.".into());
    }
    if s.name.trim().is_empty() {
        s.name = s.command.lines().next().unwrap_or("").chars().take(40).collect();
    }
    if s.id.is_empty() {
        s.id = uuid::Uuid::new_v4().to_string();
    }
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    match v.data.snippets.iter_mut().find(|x| x.id == s.id) {
        Some(x) => *x = s.clone(),
        None => v.data.snippets.push(s.clone()),
    }
    v.save().map_err(|e| e.to_string())?;
    Ok(s)
}

#[tauri::command]
fn snippet_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    v.data.snippets.retain(|s| s.id != id);
    v.save().map_err(|e| e.to_string())
}

// ---- 터미널 ----

enum Plan {
    Local {
        shell: Option<String>,
        cwd: Option<String>,
    },
    Ssh {
        connect: Box<ssh::Connect>,
        /// 세션 기록을 켠 경우 (파일 경로, 머리글)
        log: Option<(PathBuf, String)>,
    },
}

/// 세션 하나의 SSH 접속 정보와 인증 수단을 보관함에서 꺼낸다.
/// `typed_user`: 세션에 사용자가 비어 있어 터미널에서 물어본 값. `None`이면 사용자를 물어보라고 돌려준다.
/// 점프 호스트처럼 물어볼 수 없는 경우는 `ask_user`를 끈다.
fn target_for(
    v: &OpenVault,
    s: &Session,
    password: Option<String>,
    passphrase: Option<String>,
    typed_user: Option<String>,
    ask_user: bool,
) -> CmdResult<ssh::Target> {
    let host = s.host.clone().unwrap_or_default().trim().to_string();
    let saved_user = s.user.clone().unwrap_or_default().trim().to_string();
    if host.is_empty() {
        return Err(format!("'{}': 호스트를 입력하세요.", s.name));
    }
    let user = if !saved_user.is_empty() {
        saved_user
    } else if let Some(u) = typed_user.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        u
    } else if ask_user {
        return Err(ssh::ask("user", "").into_message());
    } else {
        return Err(format!("'{}': 사용자를 입력하세요.", s.name));
    };
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
    Ok(ssh::Target {
        host,
        port,
        user,
        auth,
        known_key,
        kbd: None,
    })
}

/// 보관함에서 접속에 필요한 것만 꺼낸다. 잠금을 쥔 채 await하지 않도록 따로 둔다.
fn plan_for(
    app: &AppHandle,
    state: &AppState,
    session_id: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
    user: Option<String>,
    default_shell: Option<String>,
) -> CmdResult<Plan> {
    // 세션 없이 여는 로컬 셸은 설정의 '기본 로컬 셸'을 쓴다(비우면 OS 기본).
    let Some(sid) = session_id else {
        return Ok(Plan::Local {
            shell: default_shell,
            cwd: None,
        });
    };
    let guard = lock(&state.vault);
    let v = guard.as_ref().ok_or(LOCKED)?;
    let find = |id: &str| v.data.sessions.iter().find(|s| s.id == id);
    let s = find(&sid).ok_or("세션을 찾을 수 없습니다.")?;
    if s.kind == SessionKind::Local {
        return Ok(Plan::Local {
            shell: s.shell.clone(),
            cwd: s.cwd.clone(),
        });
    }
    let target = target_for(v, s, password, passphrase, user, true)?;
    let jump = match s.jump_id.as_deref().filter(|j| !j.is_empty()) {
        Some(jid) => {
            let j = find(jid)
                .filter(|j| j.kind == SessionKind::Ssh && j.id != s.id)
                .ok_or("거쳐 갈 서버(점프 호스트) 세션을 찾을 수 없습니다. 세션 편집에서 다시 고르세요.")?;
            Some(target_for(v, j, None, None, None, false)?)
        }
        None => None,
    };
    let log = if s.log_output {
        let dir = logs_dir(app)?;
        let header = format!(
            "SSHBook 세션 기록 · {} · {}@{}:{}",
            s.name, target.user, target.host, target.port
        );
        Some((termlog::log_path(&dir, &s.name), header))
    } else {
        None
    };
    Ok(Plan::Ssh {
        connect: Box::new(ssh::Connect {
            target,
            jump,
            start_dir: s.cwd.clone().filter(|d| !d.trim().is_empty()),
            forwards: s.forwards.clone(),
        }),
        log,
    })
}

fn logs_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("logs"))
}

/// 세션 기록 폴더를 Finder/탐색기로 연다.
#[tauri::command]
fn open_logs_dir(app: AppHandle) -> CmdResult<String> {
    let dir = logs_dir(&app)?;
    fsperm::private_dir(&dir).map_err(|e| e.to_string())?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("폴더를 열지 못했습니다: {e}"))?;
    Ok(dir.display().to_string())
}

/// password / passphrase는 저장된 값이 없거나 틀려서 터미널에서 다시 물어본 값이다. 저장하지 않는다.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
    cols: u16,
    rows: u16,
    password: Option<String>,
    passphrase: Option<String>,
    user: Option<String>,
    prompt_key: Option<String>,
    shell: Option<String>,
) -> CmdResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let generation = state.lock_generation.load(Ordering::SeqCst);
    let plan = plan_for(&app, &state, session_id, password, passphrase, user, shell).inspect_err(|e| {
        // 사용자를 묻는 것은 정상 흐름이라 남기지 않는다.
        if !e.starts_with("ask:") {
            applog::warn(&format!("연결 준비 실패: {e}"))
        }
    })?;
    let term = match plan {
        Plan::Local { shell, cwd } => Term::Local(pty::spawn(app, id.clone(), shell, cwd, cols, rows)?),
        Plan::Ssh { mut connect, log } => {
            if let Some(key) = prompt_key {
                let asker = auth_asker(app.clone(), key);
                connect.target.kbd = Some(asker.clone());
                if let Some(j) = connect.jump.as_mut() {
                    j.kbd = Some(asker);
                }
            }
            let t = &connect.target;
            let via = connect.jump.as_ref().map(|j| format!(" (점프 {}:{})", j.host, j.port));
            let dest = format!("{}@{}:{}{}", t.user, t.host, t.port, via.unwrap_or_default());
            match ssh::connect(ssh::app_sink(app, id.clone(), log), *connect, cols, rows).await {
                Ok(t) => {
                    applog::info(&format!("연결됨 {dest}"));
                    Term::Ssh(t)
                }
                Err(ssh::OpenError::HostKey(p)) => {
                    applog::info(&format!("호스트 키 확인 필요 {} ({})", p.host_id, p.kind));
                    if state.lock_generation.load(Ordering::SeqCst) == generation {
                        lock(&state.pending_hosts).insert(&p);
                    }
                    return Err(ssh::OpenError::HostKey(p).into_message());
                }
                // 비밀번호를 다시 묻는 것은 정상 흐름이라 남기지 않는다.
                Err(e @ ssh::OpenError::Ask(_)) => return Err(e.into_message()),
                Err(e) => {
                    let msg = e.into_message();
                    applog::warn(&format!("연결 실패 {dest}: {msg}"));
                    return Err(msg);
                }
            }
        }
    };
    // 접속하는 사이에 보관함을 잠갔다면 이 연결을 남기지 않는다.
    let mut terms = lock(&state.terms);
    if state.lock_generation.load(Ordering::SeqCst) != generation {
        drop(terms);
        term.close();
        return Err(LOCKED.into());
    }
    terms.insert(id.clone(), term);
    Ok(id)
}

/// 보관함에 저장된(확인한) 서버 키 목록. 지문은 연결할 때 보여 주는 것과 같다.
#[tauri::command]
fn known_hosts_list(state: State<'_, AppState>) -> CmdResult<Vec<ssh::KnownHost>> {
    let guard = lock(&state.vault);
    let v = guard.as_ref().ok_or(LOCKED)?;
    Ok(v.data
        .known_hosts
        .iter()
        .map(|(id, key)| ssh::describe_known(id, key))
        .collect())
}

/// 저장된 서버 키를 지운다. 다음에 연결할 때 처음 보는 서버처럼 지문을 다시 묻는다.
#[tauri::command]
fn known_host_remove(state: State<'_, AppState>, host_id: String) -> CmdResult<()> {
    let mut guard = lock(&state.vault);
    let v = guard.as_mut().ok_or(LOCKED)?;
    if v.data.known_hosts.remove(&host_id).is_none() {
        return Err("그 서버의 키가 저장돼 있지 않습니다.".into());
    }
    v.save().map_err(|e| e.to_string())
}

/// 사용자가 지문을 확인한 서버 키를 보관함에 저장한다.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthPromptEvent {
    key: String,
    id: String,
    #[serde(flatten)]
    request: ssh::KbdRequest,
}

/// 접속 중 서버의 질문(OTP 등)을 화면으로 보내고 답을 기다린다.
fn auth_asker(app: AppHandle, key: String) -> ssh::KbdAsker {
    Arc::new(move |request| {
        let (app, key) = (app.clone(), key.clone());
        Box::pin(async move {
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let state = app.state::<AppState>();
            lock(&state.pending_auth).insert(id.clone(), tx);
            let event = AuthPromptEvent {
                key,
                id: id.clone(),
                request,
            };
            let sent = app.emit("term-auth-prompt", event).is_ok();
            let answer = if sent {
                tokio::time::timeout(std::time::Duration::from_secs(170), rx).await
            } else {
                Ok(Ok(None))
            };
            lock(&state.pending_auth).remove(&id);
            answer.ok().and_then(|r| r.ok()).flatten()
        })
    })
}

/// 서버 질문에 대한 답. None이면 취소.
#[tauri::command]
fn term_auth_answer(state: State<'_, AppState>, id: String, answers: Option<Vec<String>>) {
    if let Some(tx) = lock(&state.pending_auth).remove(&id) {
        let _ = tx.send(answers.map(|a| a.into_iter().map(Zeroizing::new).collect()));
    }
}

/// 화면 언어를 저장한다. 메뉴는 다음 실행부터 바뀐다.
#[tauri::command]
fn app_set_language(app: AppHandle, lang: String) -> CmdResult<()> {
    let lang = if lang == "en" { "en" } else { "ko" };
    i18n::set_language(lang);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("language"), lang).map_err(|e| e.to_string())
}

/// `~/.ssh/config`의 호스트 목록(가져오기 화면용)
#[tauri::command]
fn ssh_config_hosts(state: State<'_, AppState>) -> CmdResult<Vec<sshconfig::ConfigHost>> {
    if lock(&state.vault).is_none() {
        return Err(LOCKED.into());
    }
    Ok(sshconfig::load(&pty::expand_home("~/.ssh/config")))
}

#[tauri::command]
fn host_trust(state: State<'_, AppState>, host_id: String, fingerprint: String) -> CmdResult<()> {
    // 사용자가 화면에서 본 지문의 키만 저장한다.
    let key = lock(&state.pending_hosts)
        .take(&host_id, &fingerprint)
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

/// 로컬 셸의 지금 폴더를 Finder·탐색기로 연다. 연 폴더 경로를 돌려준다.
/// hint: 셸이 OSC 9;9·OSC 7로 알려 준 폴더(Windows에서 쓴다).
#[tauri::command]
fn term_reveal_cwd(state: State<'_, AppState>, id: String, hint: Option<String>) -> CmdResult<String> {
    let dir = match lock(&state.terms).get(&id) {
        Some(Term::Local(p)) => p.current_dir(hint.as_deref()),
        Some(Term::Ssh(_)) => return Err("SSH 세션의 폴더는 이 PC에서 열 수 없습니다.".into()),
        None => return Err("연결이 끊어졌습니다.".into()),
    }
    .ok_or("지금 폴더를 알 수 없습니다.")?;
    pty::reveal_dir(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 로컬 셸에 끌어다 놓은 파일들을 그 셸에 맞는 경로 글자로 바꾼다.
#[tauri::command]
fn term_drop_text(state: State<'_, AppState>, id: String, paths: Vec<String>) -> CmdResult<String> {
    match lock(&state.terms).get(&id) {
        Some(Term::Local(p)) => Ok(p.drop_text(&paths)),
        Some(Term::Ssh(_)) => Err("SSH 세션에는 파일 경로를 넣지 않습니다.".into()),
        None => Err("연결이 끊어졌습니다.".into()),
    }
}

/// 터미널 안 프로그램이 OSC 52로 보낸 글자를 클립보드에 넣는다.
/// 웹뷰의 클립보드 API는 사용자가 누른 순간에만 되는 곳이 있어서(macOS) 앱이 직접 넣는다.
#[tauri::command]
fn clipboard_write(text: String) -> CmdResult<()> {
    const MAX: usize = 1024 * 1024;
    if text.len() > MAX {
        return Err("복사할 글자가 너무 깁니다.".into());
    }
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| format!("클립보드에 넣지 못했습니다: {e}"))
}

/// 터미널 안의 링크를 기본 브라우저로 연다(http·https만).
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    pty::open_web_url(&url)
}

/// 이 PC에서 고를 수 있는 셸(cmd, PowerShell, WSL 배포판, /etc/shells …)
#[tauri::command]
async fn local_shells() -> Vec<pty::ShellChoice> {
    tauri::async_runtime::spawn_blocking(pty::available_shells)
        .await
        .unwrap_or_default()
}

/// 앱 안에서 설치할 수 있는 글꼴 이름
#[tauri::command]
fn fonts_installable() -> Vec<&'static str> {
    fonts::PACKS.iter().map(|p| p.family).collect()
}

/// 글꼴을 내려받아 이 사용자 계정에 설치한다.
#[tauri::command]
async fn font_install(family: String) -> CmdResult<()> {
    let pack = fonts::pack(&family).ok_or("앱에서 설치할 수 없는 글꼴입니다.")?;
    fonts::install(pack).await
}

#[tauri::command]
fn term_close(state: State<'_, AppState>, id: String) {
    if let Some(t) = lock(&state.terms).remove(&id) {
        t.close();
    }
}

// ---- 파일 주고받기 (SFTP) ----

fn conn_of(state: &AppState, id: &str) -> CmdResult<Arc<ssh::Conn>> {
    match lock(&state.terms).get(id) {
        Some(Term::Ssh(s)) => Ok(s.conn.clone()),
        Some(Term::Local(_)) => Err("로컬 셸에서는 파일 창을 쓸 수 없습니다.".into()),
        None => Err("연결이 끊어졌습니다.".into()),
    }
}

/// 실패하면 SFTP 채널을 버려서 다음에 새로 열게 한다(채널이 끊겼을 수 있다).
async fn sftp_call<T>(conn: &ssh::Conn, r: CmdResult<T>) -> CmdResult<T> {
    if let Err(e) = &r {
        applog::warn(&format!("SFTP 오류: {e}"));
        sftp::reset(conn).await;
    }
    r
}

/// 화면 쪽에서 난 오류(업데이트 실패, 처리하지 못한 예외)를 진단 로그에 남긴다.
#[tauri::command]
fn app_log(level: String, message: String) {
    let level = if level == "warn" || level == "error" {
        "WARN"
    } else {
        "INFO"
    };
    applog::write(level, &format!("[화면] {message}"));
}

/// 보관함 백업 목록(새것부터)
#[tauri::command]
fn vault_backups(app: AppHandle) -> CmdResult<Vec<vault::backup::Backup>> {
    Ok(vault::backup::list(&vault_path(&app)?))
}

/// 백업으로 되돌린다. 지금 보관함은 .sshv.bak으로 남는다. 그 백업 때의 마스터 비밀번호가 필요하다.
#[tauri::command]
async fn vault_restore(app: AppHandle, state: State<'_, AppState>, backup: String, password: String) -> CmdResult<()> {
    let password = Zeroizing::new(password);
    let dest = vault_path(&app)?;
    let src = PathBuf::from(&backup);
    if !vault::backup::is_backup_of(&dest, &src) {
        return Err("보관함 백업 폴더의 파일이 아닙니다.".into());
    }
    // 마스터 비밀번호 없이 쓰는 중이면 비워 둔 칸은 이 PC의 열쇠로 연다.
    let v = match (password.is_empty(), nopass::load(&dest)) {
        (true, Some(secret)) => vault::import(&src, &dest, &secret).map_err(|e| e.to_string())?,
        _ => {
            let v = vault::import(&src, &dest, &password).map_err(|e| e.to_string())?;
            nopass::retire(&dest, &password);
            v
        }
    };
    applog::info(&format!("보관함을 백업에서 되돌림: {backup}"));
    *lock(&state.vault) = Some(v);
    Ok(())
}

#[tauri::command]
async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> CmdResult<sftp::Listing> {
    let c = conn_of(&state, &id)?;
    let r = sftp::list(&c, &path).await;
    sftp_call(&c, r).await
}

/// 이 탭의 셸이 지금 있는 폴더. 알 수 없으면 null.
#[tauri::command]
async fn sftp_cwd(state: State<'_, AppState>, id: String) -> CmdResult<Option<String>> {
    let c = conn_of(&state, &id)?;
    sftp::terminal_cwd(&c).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
    transfer_id: String,
    #[serde(flatten)]
    progress: sftp::Progress,
}

/// 전송 하나를 등록한다: 취소 표시를 남기고, 진행률은 `sftp-progress` 이벤트로 보낸다.
fn start_transfer(app: &AppHandle, state: &AppState, transfer_id: &str) -> sftp::Transfer {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    lock(&state.transfers).insert(transfer_id.to_string(), cancel.clone());
    let app = app.clone();
    let tid = transfer_id.to_string();
    sftp::Transfer {
        cancel,
        on_progress: Box::new(move |p| {
            let _ = app.emit(
                "sftp-progress",
                TransferEvent {
                    transfer_id: tid.clone(),
                    progress: p.clone(),
                },
            );
        }),
    }
}

/// 내려받기. 파일이면 local = 저장할 파일, 폴더면 local 폴더 안에 같은 이름으로 만든다.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
    is_dir: bool,
    overwrite: bool,
    transfer_id: String,
) -> CmdResult<u64> {
    let c = conn_of(&state, &id)?;
    let t = start_transfer(&app, &state, &transfer_id);
    let r = sftp::download(&c, &remote, &PathBuf::from(local), is_dir, overwrite, &t).await;
    lock(&state.transfers).remove(&transfer_id);
    // 취소와 "이미 있음"은 채널 문제가 아니므로 SFTP 세션을 버리지 않는다.
    if matches!(&r, Err(e) if e == sftp::CANCELLED || e.starts_with("exists:")) {
        return r;
    }
    sftp_call(&c, r).await
}

/// 파일·폴더들을 원격 폴더로 올린다. 올린 파일 수를 돌려준다.
#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    locals: Vec<String>,
    remote_dir: String,
    transfer_id: String,
) -> CmdResult<u32> {
    let c = conn_of(&state, &id)?;
    let t = start_transfer(&app, &state, &transfer_id);
    let paths: Vec<PathBuf> = locals.into_iter().map(PathBuf::from).collect();
    let r = sftp::upload(&c, &paths, &remote_dir, &t).await;
    lock(&state.transfers).remove(&transfer_id);
    if matches!(&r, Err(e) if e == sftp::CANCELLED) {
        return r;
    }
    sftp_call(&c, r).await
}

/// 진행 중인 전송을 멈춘다(쓰다 만 파일은 지운다).
#[tauri::command]
fn sftp_cancel(state: State<'_, AppState>, transfer_id: String) {
    if let Some(flag) = lock(&state.transfers).get(&transfer_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> CmdResult<()> {
    let c = conn_of(&state, &id)?;
    let r = sftp::mkdir(&c, &path).await;
    sftp_call(&c, r).await
}

#[tauri::command]
async fn sftp_remove(state: State<'_, AppState>, id: String, path: String, is_dir: bool) -> CmdResult<()> {
    let c = conn_of(&state, &id)?;
    let r = sftp::remove(&c, &path, is_dir).await;
    sftp_call(&c, r).await
}

#[tauri::command]
async fn sftp_rename(state: State<'_, AppState>, id: String, from: String, to: String) -> CmdResult<()> {
    let c = conn_of(&state, &id)?;
    let r = sftp::rename(&c, &from, &to).await;
    sftp_call(&c, r).await
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
        i18n::tr("파일"),
        true,
        &[&MenuItem::with_id(
            app,
            MENU_CLOSE_TAB,
            i18n::tr("탭 닫기"),
            true,
            Some("CmdOrCtrl+W"),
        )?],
    )?;
    // 편집 메뉴가 있어야 입력칸에서 ⌘C·⌘V·⌘A가 동작한다.
    let edit = Submenu::with_items(
        app,
        i18n::tr("편집"),
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
        i18n::tr("윈도우"),
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
        .setup(|app| {
            if let Ok(dir) = logs_dir(app.handle()) {
                applog::init(dir);
            }
            if let Ok(dir) = app.path().app_config_dir() {
                i18n::load(&dir.join("language"));
            }
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
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
            vault_unlock_auto,
            vault_disable_password,
            vault_enable_password,
            vault_lock,
            vault_change_password,
            vault_export,
            vault_import,
            sessions_list,
            session_save,
            session_update_secret,
            session_reveal_secret,
            session_delete,
            session_duplicate,
            sessions_rename_group,
            groups_list,
            group_add,
            group_set_color,
            group_delete,
            snippets_list,
            snippet_save,
            snippet_delete,
            open_logs_dir,
            app_log,
            vault_backups,
            vault_restore,
            sftp_list,
            sftp_cwd,
            sftp_download,
            sftp_upload,
            sftp_cancel,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            term_open,
            host_trust,
            known_hosts_list,
            known_host_remove,
            term_write,
            term_resize,
            term_close,
            term_reveal_cwd,
            clipboard_write,
            fonts_installable,
            local_shells,
            vault_merge,
            vault_take_app_settings,
            term_drop_text,
            sidebar_manual,
            sidebar_reorder,
            open_url,
            font_install,
            term_auth_answer,
            app_set_language,
            ssh_config_hosts,
        ])
        .run(tauri::generate_context!())
        .expect("앱을 시작하지 못했습니다");
}

#[cfg(test)]
mod secret_update_tests {
    use super::*;

    #[test]
    fn replaces_only_values_that_were_stored() {
        let mut secrets = std::collections::BTreeMap::new();
        let mut sec = Secret::default();
        sec.password = Some("old".into());
        secrets.insert("a".to_string(), sec);
        // 저장하지 않은 세션에는 묻기 전에는 넣지 않는다.
        assert_eq!(
            replace_stored_secret(&mut secrets, "b", Some("x".into()), None, false),
            "none"
        );
        assert!(!secrets.contains_key("b"));
        assert_eq!(
            replace_stored_secret(&mut secrets, "b", Some("x".into()), None, true),
            "updated"
        );
        assert_eq!(secrets["b"].password.as_deref(), Some("x"));
        // 저장한 적 없는 키 암호는 넣지 않는다.
        assert_eq!(
            replace_stored_secret(&mut secrets, "a", None, Some("pp".into()), false),
            "none"
        );
        assert_eq!(secrets["a"].passphrase, None);
        // 같은 값이나 빈 값은 바꾸지 않는다.
        assert_eq!(
            replace_stored_secret(&mut secrets, "a", Some("old".into()), None, false),
            "unchanged"
        );
        assert_eq!(
            replace_stored_secret(&mut secrets, "a", Some(String::new()), None, false),
            "none"
        );
        assert_eq!(
            replace_stored_secret(&mut secrets, "a", Some("new".into()), None, false),
            "updated"
        );
        assert_eq!(secrets["a"].password.as_deref(), Some("new"));
    }
}
