// 프론트엔드가 Rust 백엔드에 요청하는 모든 경로.
// 비밀번호·개인 키는 Rust 쪽 보관함에만 있고, 여기로는 "있음/없음" 정도만 돌아온다.
// Tauri 밖(브라우저에서 npm run dev)에서는 화면 확인용 가짜 백엔드를 쓴다.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "./sessions";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  path: string;
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
  vaultLock(): Promise<void>;
  vaultChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  vaultExport(dest: string): Promise<void>;
  vaultImport(src: string, password: string): Promise<void>;
  sessionsList(): Promise<Session[]>;
  sessionSave(session: Session, secret?: SecretInput): Promise<Session>;
  sessionDelete(id: string): Promise<void>;
  /** sessionId가 없으면 OS 기본 셸을 연다. 터미널 id를 돌려준다. */
  termOpen(sessionId: string | null, cols: number, rows: number, opts?: OpenOptions): Promise<string>;
  /** 사용자가 확인한 호스트 키를 보관함에 저장한다 */
  hostTrust(hostId: string): Promise<void>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termClose(id: string): Promise<void>;
  onTermData(cb: (e: TermData) => void): Promise<() => void>;
  onTermExit(cb: (e: TermExit) => void): Promise<() => void>;
}

const tauriBackend: Backend = {
  vaultStatus: () => invoke("vault_status"),
  vaultCreate: (password) => invoke("vault_create", { password }),
  vaultUnlock: (password) => invoke("vault_unlock", { password }),
  vaultLock: () => invoke("vault_lock"),
  vaultChangePassword: (oldPassword, newPassword) => invoke("vault_change_password", { oldPassword, newPassword }),
  vaultExport: (dest) => invoke("vault_export", { dest }),
  vaultImport: (src, password) => invoke("vault_import", { src, password }),
  sessionsList: () => invoke("sessions_list"),
  sessionSave: (session, secret) => invoke("session_save", { session, secret: secret ?? null }),
  sessionDelete: (id) => invoke("session_delete", { id }),
  termOpen: (sessionId, cols, rows, opts) =>
    invoke("term_open", { sessionId, cols, rows, password: opts?.password ?? null, passphrase: opts?.passphrase ?? null }),
  hostTrust: (hostId) => invoke("host_trust", { hostId }),
  termWrite: (id, data) => invoke("term_write", { id, data }),
  termResize: (id, cols, rows) => invoke("term_resize", { id, cols, rows }),
  termClose: (id) => invoke("term_close", { id }),
  onTermData: (cb) => listen<TermData>("term-data", (e) => cb(e.payload)),
  onTermExit: (cb) => listen<TermExit>("term-exit", (e) => cb(e.payload)),
};

// ---- 브라우저용 가짜 백엔드 (화면 확인 전용, 저장하지 않음) ----

function createMockBackend(): Backend {
  let exists = false;
  let unlocked = false;
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
      return { exists, unlocked, path: "(브라우저 미리보기 — 저장하지 않음)" };
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
    async vaultLock() {
      unlocked = false;
    },
    async vaultChangePassword() {},
    async vaultExport() {},
    async vaultImport() {
      exists = true;
      unlocked = true;
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
      sessions = sessions.filter((s) => s.id !== id);
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
    async onTermData(cb) {
      dataSubs.add(cb);
      return () => dataSubs.delete(cb);
    },
    async onTermExit(cb) {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
  };
}

export const api: Backend = inTauri ? tauriBackend : createMockBackend();

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
