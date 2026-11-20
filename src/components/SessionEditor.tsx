import { useState } from "react";
import { errorText, type SecretInput } from "../lib/api";
import { pickKeyFile } from "../lib/dialogs";
import type { AuthMethod, Session } from "../lib/sessions";
import { IconClose } from "./Icons";

interface Props {
  initial: Session | null;
  groups: string[];
  onSave: (session: Session, secret: SecretInput) => Promise<void>;
  onDelete?: (session: Session) => Promise<void>;
  onClose: () => void;
}

const blank: Session = { id: "", name: "", group: null, kind: "ssh", host: "", port: 22, user: "", auth: "password" };

const AUTH_LABEL: Record<AuthMethod, string> = { password: "비밀번호", key: "키 파일", agent: "SSH 에이전트" };

/**
 * 세션 편집. 로컬 셸은 탭의 + 로 바로 열기 때문에 여기서는 SSH만 만든다.
 * 예전에 저장한 로컬 셸 세션은 이름·그룹·셸만 고칠 수 있다.
 */
export function SessionEditor({ initial, groups, onSave, onDelete, onClose }: Props) {
  const [s, setS] = useState<Session>(initial ?? blank);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // "보관함에 저장" 하나로 비밀번호, 또는 키 파일 + 키 암호를 함께 다룬다.
  const [store, setStore] = useState(() => {
    if (!initial) return true;
    if (initial.auth === "key") return !!initial.hasPrivateKey || !!initial.hasPassphrase;
    return !!initial.hasPassword;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<Session>) => setS((prev) => ({ ...prev, ...patch }));
  const isLocal = s.kind === "local";
  const auth = s.auth ?? "password";

  const submit = async () => {
    setError("");
    const host = s.host?.trim() ?? "";
    const name = s.name.trim() || host;
    if (!isLocal && !host) return setError("호스트를 입력하세요.");
    if (!isLocal && !s.user?.trim()) return setError("사용자를 입력하세요.");
    if (!name) return setError("이름을 입력하세요.");
    if (!isLocal && auth === "key" && !s.keyPath?.trim()) return setError("개인 키 파일을 고르세요.");

    const secret: SecretInput = {};
    if (isLocal || auth === "agent") {
      secret.clear = true;
    } else if (!store) {
      // 저장하지 않으면 지금까지 저장된 것도 지운다. 연결할 때 터미널에서 묻는다.
      secret.clear = true;
    } else if (auth === "password") {
      if (password) secret.password = password;
    } else {
      const keyChanged = s.keyPath !== initial?.keyPath;
      secret.importKey = keyChanged || !initial?.hasPrivateKey;
      if (passphrase) secret.passphrase = passphrase;
    }

    setBusy(true);
    try {
      await onSave({ ...s, name, host: host || s.host, user: s.user?.trim(), group: s.group?.trim() || null }, secret);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const savedHint = (has?: boolean) => (has ? "저장됨 · 바꿀 때만 입력" : "");

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-labelledby="se-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") void submit();
        }}
      >
        <div className="dialog-head">
          <h2 id="se-title">{initial ? "세션 편집" : "새 세션"}</h2>
          <button className="icon-btn ghost" aria-label="닫기" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="dialog-body">
          {!isLocal && (
            <div className="grid-host">
              <label className="field">
                <span>호스트</span>
                <input className="input mono" autoFocus value={s.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder="10.0.1.21 또는 example.com" />
              </label>
              <label className="field">
                <span>포트</span>
                <input className="input mono" inputMode="numeric" value={s.port ?? 22} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 22 })} />
              </label>
            </div>
          )}

          <div className="grid2">
            <label className="field">
              <span>그룹</span>
              <input className="input" list="group-list" value={s.group ?? ""} onChange={(e) => set({ group: e.target.value })} placeholder="그룹 없음" />
              <datalist id="group-list">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>이름</span>
              <input className="input" autoFocus={isLocal} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder={s.host?.trim() || "비우면 호스트 이름"} />
            </label>
          </div>

          <hr className="divider" />

          {isLocal ? (
            <div className="grid2">
              <label className="field">
                <span>셸 (비우면 OS 기본 셸)</span>
                <input className="input mono" value={s.shell ?? ""} onChange={(e) => set({ shell: e.target.value })} placeholder="zsh, bash, pwsh.exe…" />
              </label>
              <label className="field">
                <span>시작 폴더</span>
                <input className="input mono" value={s.cwd ?? ""} onChange={(e) => set({ cwd: e.target.value })} placeholder="~" />
              </label>
            </div>
          ) : (
            <>
              <label className="field">
                <span>사용자</span>
                <input className="input mono" value={s.user ?? ""} onChange={(e) => set({ user: e.target.value })} placeholder="deploy" />
              </label>

              <div className="field">
                <span className="field-label" id="auth-label">인증 방식</span>
                <div className="seg" role="group" aria-labelledby="auth-label">
                  {(["password", "key", "agent"] as AuthMethod[]).map((a) => (
                    <button key={a} aria-pressed={auth === a} onClick={() => set({ auth: a })}>
                      {AUTH_LABEL[a]}
                    </button>
                  ))}
                </div>
              </div>

              {auth === "password" && (
                <label className="field">
                  <span>비밀번호</span>
                  <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={savedHint(initial?.hasPassword)} />
                </label>
              )}

              {auth === "key" && (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="keyfile">개인 키 파일</label>
                    <div className="row-gap">
                      <input id="keyfile" className="input mono" value={s.keyPath ?? ""} onChange={(e) => set({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
                      <button className="btn" style={{ height: 38, flex: "none" }} onClick={async () => { const p = await pickKeyFile(); if (p) set({ keyPath: p }); }}>
                        찾아보기
                      </button>
                    </div>
                  </div>
                  <label className="field">
                    <span>키 암호 (없으면 비워 두기)</span>
                    <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={savedHint(initial?.hasPassphrase)} />
                  </label>
                </>
              )}

              {auth === "agent" ? (
                <p className="hint">OS의 SSH 에이전트(macOS ssh-agent, Windows OpenSSH 에이전트)에 올라간 키를 씁니다. 보관함에는 아무것도 저장하지 않습니다.</p>
              ) : (
                <label className="check">
                  <input type="checkbox" checked={store} onChange={(e) => setStore(e.target.checked)} />
                  <span>
                    {auth === "password" ? "비밀번호를 보관함에 저장" : "키 파일과 키 암호를 보관함에 저장"}
                    <br />
                    <span className="hint">
                      {store
                        ? auth === "key"
                          ? "보관함 파일만 옮기면 다른 PC에서도 이 키로 연결됩니다."
                          : "마스터 비밀번호로 암호화해서 저장합니다."
                        : "연결할 때마다 터미널에서 묻습니다."}
                    </span>
                  </span>
                </label>
              )}
            </>
          )}

          {error && <p className="error" role="alert">{error}</p>}
        </div>

        <div className="dialog-foot">
          {initial && onDelete && (
            <button className="btn danger" disabled={busy} onClick={() => onDelete(initial)}>
              삭제
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
