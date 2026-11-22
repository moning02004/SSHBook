// 프론트엔드가 Rust 백엔드에 요청하는 모든 경로.
// 비밀번호·개인 키는 Rust 쪽 보관함에만 있고, 여기로는 "있음/없음" 정도만 돌아온다.
// Tauri 밖(브라우저에서 npm run dev)에서는 화면 확인용 가짜 백엔드를 쓴다.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session, Snippet } from "./sessions";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  path: string;
  /** 마스터 비밀번호 없이 쓰는 중(이 PC의 열쇠 파일로 연다) */
  passwordless: boolean;
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number | null;
}

export interface RemoteListing {
  path: string;
  entries: RemoteEntry[];
}

/** 보관함에 저장된 서버 키 */
export interface KnownHost {
  hostId: string;
  algorithm: string;
  fingerprint: string;
}

export interface VaultBackup {
  path: string;
  /** 유닉스 시각(초) */
  modified: number;
  size: number;
}

/** 파일 전송 진행률 */
export interface SftpProgress {
  transferId: string;
  done: number;
  total: number;
  /** 지금 옮기는 파일(상대 경로) */
  file: string;
  filesDone: number;
  filesTotal: number;
}

/** 취소했을 때의 오류 문구(백엔드 sftp::CANCELLED와 같다) */
export const TRANSFER_CANCELLED = "전송을 취소했습니다.";

export interface TermLatency {
  id: string;
  ms: number;
}

/** 세션을 저장할 때 함께 보내는 비밀 정보. 비워 둔 항목은 기존 값을 유지한다. */
export interface SecretInput {
  password?: string;
  passphrase?: string;
  /** true면 session.keyPath 파일을 읽어 보관함 안으로 가져온다 */
  importKey?: boolean;
  /** true면 해당 세션의 비밀 정보를 지운다 */
  clear?: boolean;
}

export interface TermData {
  id: string;
  data: string; // base64
}
export interface TermExit {
  id: string;
  code: number | null;
}

/** 저장된 값이 없거나 틀렸을 때 터미널에서 다시 물어본 값. 저장하지 않는다. */
export interface OpenOptions {
  password?: string;
  passphrase?: string;
}

/** 처음 보는 서버(또는 키가 바뀐 서버)의 호스트 키 */
export interface HostKeyPrompt {
  kind: "unknown" | "changed";
  hostId: string;
  algorithm: string;
  fingerprint: string;
}

export interface AskPrompt {
  kind: "password" | "passphrase";
  message: string;
}

/** termOpen 오류 중 사용자 응답이 필요한 것을 골라낸다. */
export function parseOpenError(e: unknown): { hostKey: HostKeyPrompt } | { ask: AskPrompt } | { text: string } {
  const s = errorText(e);
  try {
    if (s.startsWith("hostkey:")) return { hostKey: JSON.parse(s.slice(8)) };
    if (s.startsWith("ask:")) return { ask: JSON.parse(s.slice(4)) };
  } catch {
    // 형식이 깨졌으면 그냥 글자로 보여 준다.
  }
  return { text: s };
}

export interface Backend {
  vaultStatus(): Promise<VaultStatus>;
  vaultCreate(password: string): Promise<void>;
  vaultUnlock(password: string): Promise<void>;
  /** 마스터 비밀번호 없이 쓰는 경우 열쇠 파일로 연다 */
  vaultUnlockAuto(): Promise<void>;
  vaultDisablePassword(password: string): Promise<void>;
  vaultEnablePassword(password: string): Promise<void>;
  vaultLock(): Promise<void>;
  vaultChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  /** password: 마스터 비밀번호 없이 쓰는 중일 때 내보낼 파일의 비밀번호 */
  vaultExport(dest: string, password?: string): Promise<void>;
  vaultImport(src: string, password: string): Promise<void>;
  /** 보관함 자동 백업 목록(새것부터) */
  vaultBackups(): Promise<VaultBackup[]>;
  /** 백업으로 되돌린다. 그 백업 때의 마스터 비밀번호가 필요하다 */
  vaultRestore(backup: string, password: string): Promise<void>;
  /** 진단 로그에 남긴다(비밀 정보는 넣지 않는다) */
  appLog(level: "info" | "warn" | "error", message: string): Promise<void>;
  sessionsList(): Promise<Session[]>;
  sessionSave(session: Session, secret?: SecretInput): Promise<Session>;
  sessionDelete(id: string): Promise<void>;
  /** 같은 설정(저장된 비밀번호·키 포함)으로 "이름 복사" 세션을 만든다 */
  sessionDuplicate(id: string): Promise<Session>;
  /** 그룹 이름 바꾸기(빈 이름이면 그룹 없음으로). 바뀐 세션 수 */
  sessionsRenameGroup(from: string, to: string): Promise<number>;
  snippetsList(): Promise<Snippet[]>;
  snippetSave(s: Snippet): Promise<Snippet>;
  snippetDelete(id: string): Promise<void>;
  /** 세션 기록 폴더를 열고 경로를 돌려준다 */
  openLogsDir(): Promise<string>;
  sftpList(termId: string, path: string): Promise<RemoteListing>;
  /** 터미널 셸이 지금 있는 폴더. 알 수 없으면 null */
  sftpCwd(termId: string): Promise<string | null>;
  /** 파일이면 local = 저장할 파일, 폴더면 local 폴더 안에 같은 이름으로. 옮긴 바이트 수 */
  sftpDownload(termId: string, remote: string, local: string, isDir: boolean, transferId: string): Promise<number>;
  /** 파일·폴더들을 원격 폴더로. 올린 파일 수 */
  sftpUpload(termId: string, locals: string[], remoteDir: string, transferId: string): Promise<number>;
  sftpCancel(transferId: string): Promise<void>;
  onSftpProgress(cb: (e: SftpProgress) => void): Promise<() => void>;
  sftpMkdir(termId: string, path: string): Promise<void>;
  sftpRemove(termId: string, path: string, isDir: boolean): Promise<void>;
  sftpRename(termId: string, from: string, to: string): Promise<void>;
  /** sessionId가 없으면 OS 기본 셸을 연다. 터미널 id를 돌려준다. */
  termOpen(sessionId: string | null, cols: number, rows: number, opts?: OpenOptions): Promise<string>;
  /** 사용자가 확인한 호스트 키를 보관함에 저장한다 */
  hostTrust(hostId: string): Promise<void>;
  knownHostsList(): Promise<KnownHost[]>;
  knownHostRemove(hostId: string): Promise<void>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termClose(id: string): Promise<void>;
  onTermData(cb: (e: TermData) => void): Promise<() => void>;
  onTermExit(cb: (e: TermExit) => void): Promise<() => void>;
  onTermLatency(cb: (e: TermLatency) => void): Promise<() => void>;
}

const tauriBackend: Backend = {
  vaultStatus: () => invoke("vault_status"),
  vaultCreate: (password) => invoke("vault_create", { password }),
  vaultUnlock: (password) => invoke("vault_unlock", { password }),
  vaultUnlockAuto: () => invoke("vault_unlock_auto"),
  vaultDisablePassword: (password) => invoke("vault_disable_password", { password }),
  vaultEnablePassword: (password) => invoke("vault_enable_password", { password }),
  vaultLock: () => invoke("vault_lock"),
  vaultChangePassword: (oldPassword, newPassword) => invoke("vault_change_password", { oldPassword, newPassword }),
  vaultExport: (dest, password) => invoke("vault_export", { dest, password: password ?? null }),
  vaultImport: (src, password) => invoke("vault_import", { src, password }),
  vaultBackups: () => invoke("vault_backups"),
  vaultRestore: (backup, password) => invoke("vault_restore", { backup, password }),
  appLog: (level, message) => invoke("app_log", { level, message }),
  sessionsList: () => invoke("sessions_list"),
  sessionSave: (session, secret) => invoke("session_save", { session, secret: secret ?? null }),
  sessionDelete: (id) => invoke("session_delete", { id }),
  sessionDuplicate: (id) => invoke("session_duplicate", { id }),
  sessionsRenameGroup: (from, to) => invoke("sessions_rename_group", { from, to }),
  snippetsList: () => invoke("snippets_list"),
  snippetSave: (snippet) => invoke("snippet_save", { snippet }),
  snippetDelete: (id) => invoke("snippet_delete", { id }),
  openLogsDir: () => invoke("open_logs_dir"),
  sftpList: (id, path) => invoke("sftp_list", { id, path }),
  sftpCwd: (id) => invoke("sftp_cwd", { id }),
  sftpDownload: (id, remote, local, isDir, transferId) => invoke("sftp_download", { id, remote, local, isDir, transferId }),
  sftpUpload: (id, locals, remoteDir, transferId) => invoke("sftp_upload", { id, locals, remoteDir, transferId }),
  sftpCancel: (transferId) => invoke("sftp_cancel", { transferId }),
  onSftpProgress: (cb) => listen<SftpProgress>("sftp-progress", (e) => cb(e.payload)),
  sftpMkdir: (id, path) => invoke("sftp_mkdir", { id, path }),
  sftpRemove: (id, path, isDir) => invoke("sftp_remove", { id, path, isDir }),
  sftpRename: (id, from, to) => invoke("sftp_rename", { id, from, to }),
  termOpen: (sessionId, cols, rows, opts) =>
    invoke("term_open", { sessionId, cols, rows, password: opts?.password ?? null, passphrase: opts?.passphrase ?? null }),
  hostTrust: (hostId) => invoke("host_trust", { hostId }),
  knownHostsList: () => invoke("known_hosts_list"),
  knownHostRemove: (hostId) => invoke("known_host_remove", { hostId }),
  termWrite: (id, data) => invoke("term_write", { id, data }),
  termResize: (id, cols, rows) => invoke("term_resize", { id, cols, rows }),
  termClose: (id) => invoke("term_close", { id }),
  onTermData: (cb) => listen<TermData>("term-data", (e) => cb(e.payload)),
  onTermExit: (cb) => listen<TermExit>("term-exit", (e) => cb(e.payload)),
  onTermLatency: (cb) => listen<TermLatency>("term-latency", (e) => cb(e.payload)),
};

// ---- 브라우저용 가짜 백엔드 (화면 확인 전용, 저장하지 않음) ----

function createMockBackend(): Backend {
  let exists = false;
  let unlocked = false;
  let passwordless = false;
  let snippets: Snippet[] = [
    { id: "s1", name: "도커 로그", command: "docker compose logs -f --tail=200 api" },
    { id: "s2", name: "디스크 사용량", command: "df -h" },
  ];
  const latencySubs = new Set<(e: TermLatency) => void>();
  const progressSubs = new Set<(e: SftpProgress) => void>();
  const cancelled = new Set<string>();
  /** 미리보기: 2초 동안 진행률을 흉내 낸다 */
  const fakeTransfer = async (transferId: string, total: number, files: number) => {
    for (let i = 0; i <= 20; i++) {
      if (cancelled.has(transferId)) throw TRANSFER_CANCELLED;
      const done = Math.round((total * i) / 20);
      const filesDone = Math.min(files, Math.floor((files * i) / 20));
      progressSubs.forEach((cb) => cb({ transferId, done, total, file: `file-${filesDone + 1}.log`, filesDone, filesTotal: files }));
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const remoteTree: Record<string, RemoteEntry[]> = {
    "/home/dev": [
      { name: "app", isDir: true, isLink: false, size: 0, mtime: 1763600000 },
      { name: "logs", isDir: true, isLink: false, size: 0, mtime: 1763600000 },
      { name: ".bashrc", isDir: false, isLink: false, size: 3771, mtime: 1763000000 },
      { name: "notes.txt", isDir: false, isLink: false, size: 1204, mtime: 1763650000 },
    ],
    "/home/dev/app": [{ name: "docker-compose.yml", isDir: false, isLink: false, size: 862, mtime: 1763640000 }],
    "/home/dev/logs": [{ name: "api.log", isDir: false, isLink: false, size: 5_242_880, mtime: 1763660000 }],
  };
  const norm = (p: string) => {
    const parts: string[] = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return "/" + parts.join("/");
  };
  let sessions: Session[] = [
    { id: "m1", name: "localhost", group: null, kind: "local", shell: "zsh" },
    { id: "m2", name: "prod-web-01", group: null, kind: "ssh", host: "10.0.1.21", port: 22, user: "deploy", auth: "key", hasPrivateKey: true },
    { id: "m3", name: "dev-box", group: null, kind: "ssh", host: "dev.internal", port: 2222, user: "dev", auth: "password", hasPassword: true },
  ];
  const dataSubs = new Set<(e: TermData) => void>();
  const exitSubs = new Set<(e: TermExit) => void>();
  const lines = new Map<string, string>();
  const toB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const emit = (id: string, text: string) => dataSubs.forEach((cb) => cb({ id, data: toB64(text) }));
  let seq = 0;
  const trusted = new Set<string>();
  let pendingTrust: string | null = null;
  const wait = () => new Promise((r) => setTimeout(r, 120));

  return {
    async vaultStatus() {
      return { exists, unlocked, path: "(브라우저 미리보기 — 저장하지 않음)", passwordless };
    },
    async vaultCreate() {
      await wait();
      exists = true;
      unlocked = true;
    },
    async vaultUnlock(password) {
      await wait();
      if (!password) throw "마스터 비밀번호가 맞지 않습니다.";
      unlocked = true;
    },
    async vaultUnlockAuto() {
      await wait();
      if (!passwordless) throw "이 PC의 열쇠 파일이 없습니다.";
      unlocked = true;
    },
    async vaultDisablePassword(password) {
      await wait();
      if (!password) throw "지금 마스터 비밀번호가 맞지 않습니다.";
      passwordless = true;
    },
    async vaultEnablePassword() {
      await wait();
      passwordless = false;
    },
    async vaultLock() {
      unlocked = false;
    },
    async vaultChangePassword(oldPassword) {
      await wait();
      if (oldPassword !== "test1234") throw "지금 마스터 비밀번호가 맞지 않습니다.";
    },
    async vaultExport() {},
    async vaultImport() {
      exists = true;
      unlocked = true;
    },
    async vaultBackups() {
      const now = Math.floor(Date.now() / 1000);
      return [
        { path: "/backups/vault-20261121-090000.sshv", modified: now - 3600, size: 4096 },
        { path: "/backups/vault-20261120-180000.sshv", modified: now - 86400, size: 3900 },
      ];
    },
    async vaultRestore(_backup, password) {
      await wait();
      if (!password) throw "마스터 비밀번호가 맞지 않거나 파일이 손상되었습니다.";
      unlocked = true;
    },
    async appLog(level, message) {
      console.info(`[appLog:${level}]`, message);
    },
    async sessionsList() {
      return sessions;
    },
    async sessionSave(session) {
      const saved = { ...session, id: session.id || `m${Date.now()}` };
      sessions = sessions.some((s) => s.id === saved.id)
        ? sessions.map((s) => (s.id === saved.id ? saved : s))
        : [...sessions, saved];
      return saved;
    },
    async sessionDelete(id) {
      sessions = sessions.filter((s) => s.id !== id).map((s) => (s.jumpId === id ? { ...s, jumpId: null } : s));
    },
    async sessionDuplicate(id) {
      const src = sessions.find((s) => s.id === id);
      if (!src) throw "세션을 찾을 수 없습니다.";
      const copy = { ...src, id: `m${Date.now()}`, name: `${src.name} 복사` };
      sessions = [...sessions, copy];
      return copy;
    },
    async sessionsRenameGroup(from, to) {
      let n = 0;
      sessions = sessions.map((s) => (s.group === from ? (n++, { ...s, group: to.trim() || null }) : s));
      return n;
    },
    async snippetsList() {
      return snippets;
    },
    async snippetSave(s) {
      if (!s.command.trim()) throw "명령을 입력하세요.";
      const saved = { ...s, id: s.id || `sn${Date.now()}`, name: s.name.trim() || s.command.split("\n")[0].slice(0, 40) };
      snippets = snippets.some((x) => x.id === saved.id) ? snippets.map((x) => (x.id === saved.id ? saved : x)) : [...snippets, saved];
      return saved;
    },
    async snippetDelete(id) {
      snippets = snippets.filter((x) => x.id !== id);
    },
    async openLogsDir() {
      return "(브라우저 미리보기)";
    },
    async sftpList(_id, path) {
      const abs = norm(path.trim() ? path : "/home/dev");
      const entries = remoteTree[abs];
      if (!entries) throw "경로를 찾지 못했습니다: No such file";
      await wait();
      return { path: abs, entries };
    },
    async sftpCwd() {
      return "/home/dev/app";
    },
    async sftpDownload(_id, _remote, _local, _isDir, transferId) {
      await fakeTransfer(transferId, 5_242_880, 3);
      return 5_242_880;
    },
    async sftpUpload(_id, locals, dir, transferId) {
      await fakeTransfer(transferId, 1_048_576 * locals.length, locals.length);
      for (const local of locals) {
        const name = local.split(/[\\/]/).pop() ?? "file";
        (remoteTree[norm(dir)] ??= []).push({ name, isDir: false, isLink: false, size: 100, mtime: Date.now() / 1000 });
      }
      return locals.length;
    },
    async sftpCancel(transferId) {
      cancelled.add(transferId);
    },
    async onSftpProgress(cb) {
      progressSubs.add(cb);
      return () => progressSubs.delete(cb);
    },
    async sftpMkdir(_id, path) {
      const abs = norm(path);
      const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
      (remoteTree[parent] ??= []).push({ name: abs.split("/").pop()!, isDir: true, isLink: false, size: 0, mtime: Date.now() / 1000 });
      remoteTree[abs] = [];
    },
    async sftpRemove(_id, path) {
      const abs = norm(path);
      const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
      remoteTree[parent] = (remoteTree[parent] ?? []).filter((e) => e.name !== abs.split("/").pop());
    },
    async sftpRename(_id, from, to) {
      const a = norm(from);
      const parent = a.slice(0, a.lastIndexOf("/")) || "/";
      remoteTree[parent] = (remoteTree[parent] ?? []).map((e) => (e.name === a.split("/").pop() ? { ...e, name: norm(to).split("/").pop()! } : e));
    },
    async termOpen(sessionId, _cols, _rows, opts) {
      const s = sessions.find((x) => x.id === sessionId);
      // 미리보기: 처음 연결하는 SSH 세션은 호스트 키 확인과 비밀번호 입력을 흉내 낸다.
      if (s?.kind === "ssh" && !trusted.has(s.id)) {
        pendingTrust = s.id;
        throw `hostkey:${JSON.stringify({ kind: "unknown", hostId: `${s.host}:${s.port ?? 22}`, algorithm: "ssh-ed25519", fingerprint: "SHA256:mOcKpReViEw0nLy4bRoWsEr+xYz1234567890abc" })}`;
      }
      if (s?.kind === "ssh" && s.auth === "password" && !opts?.password) {
        throw `ask:${JSON.stringify({ kind: "password", message: "" })}`;
      }
      const id = `t${++seq}`;
      if (s?.kind === "ssh") {
        const tick = setInterval(() => latencySubs.forEach((cb) => cb({ id, ms: 20 + Math.round(Math.random() * 40) })), 2000);
        exitSubs.add(({ id: gone }) => gone === id && clearInterval(tick));
      }
      setTimeout(() => {
        emit(id, `\x1b[2m브라우저 미리보기입니다. 실제 연결은 Tauri 앱에서 동작합니다.\x1b[0m\r\n`);
        emit(id, `${s ? s.name : "local"} $ `);
      }, 50);
      return id;
    },
    async termWrite(id, data) {
      // 미리보기: exit를 치면 연결이 끊긴 것처럼 보여 준다(⌘R·Ctrl+R 재연결 확인용).
      if (data === "\r") {
        const line = (lines.get(id) ?? "").trim();
        lines.delete(id);
        if (line === "exit") {
          emit(id, "\r\nlogout\r\n");
          return void setTimeout(() => exitSubs.forEach((cb) => cb({ id, code: 0 })), 30);
        }
        return emit(id, "\r\n$ ");
      }
      lines.set(id, (lines.get(id) ?? "") + data);
      emit(id, data);
    },
    async termResize() {},
    async termClose() {},
    async hostTrust() {
      if (pendingTrust) trusted.add(pendingTrust);
    },
    async knownHostsList() {
      return [...trusted].map((id) => {
        const s = sessions.find((x) => x.id === id);
        return { hostId: `${s?.host}:${s?.port ?? 22}`, algorithm: "ssh-ed25519", fingerprint: "SHA256:mOcKpReViEw0nLy4bRoWsEr+xYz1234567890abc" };
      });
    },
    async knownHostRemove(hostId) {
      for (const id of trusted) {
        const s = sessions.find((x) => x.id === id);
        if (`${s?.host}:${s?.port ?? 22}` === hostId) trusted.delete(id);
      }
    },
    async onTermData(cb) {
      dataSubs.add(cb);
      return () => dataSubs.delete(cb);
    },
    async onTermExit(cb) {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
    async onTermLatency(cb) {
      latencySubs.add(cb);
      return () => latencySubs.delete(cb);
    },
  };
}

export const api: Backend = inTauri ? tauriBackend : createMockBackend();

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
