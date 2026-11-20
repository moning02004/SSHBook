import { useState } from "react";
import { errorText, type SecretInput } from "../lib/api";
import { pickKeyFile } from "../lib/dialogs";
import {
  COLOR_LABEL,
  describeSession,
  forwardProblem,
  SESSION_COLORS,
  type AuthMethod,
  type Forward,
  type ForwardKind,
  type Session,
} from "../lib/sessions";
import { IconClose, IconPlus, IconTrash } from "./Icons";

interface Props {
  initial: Session | null;
  groups: string[];
  /** 점프 호스트로 고를 수 있는 세션 */
  sessions: Session[];
  onSave: (session: Session, secret: SecretInput) => Promise<void>;
  onDelete?: (session: Session) => Promise<void>;
  /** 같은 설정으로 새 세션을 만든다 */
  onDuplicate?: (session: Session) => Promise<void>;
  onClose: () => void;
}

const FORWARD_LABEL: Record<ForwardKind, string> = { local: "로컬 (-L)", remote: "원격 (-R)", dynamic: "SOCKS (-D)" };

const blank: Session = { id: "", name: "", group: null, kind: "ssh", host: "", port: 22, user: "", auth: "password" };

const AUTH_LABEL: Record<AuthMethod, string> = { password: "비밀번호", key: "키 파일", agent: "SSH 에이전트" };

/**
 * 세션 편집. 로컬 셸은 탭의 + 로 바로 열기 때문에 여기서는 SSH만 만든다.
 * 예전에 저장한 로컬 셸 세션은 이름·그룹·셸만 고칠 수 있다.
 */
export function SessionEditor({ initial, groups, sessions, onSave, onDelete, onDuplicate, onClose }: Props) {
  const [s, setS] = useState<Session>(initial ?? blank);
  // SSH 시작 경로: 체크하면 그 경로로, 안 하면 서버 기본(홈 폴더)으로 들어간다.
  const [useDir, setUseDir] = useState(() => initial?.kind === "ssh" && !!initial.cwd?.trim());
  const forwards = s.forwards ?? [];
  const setForward = (i: number, patch: Partial<Forward>) =>
    set({ forwards: forwards.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const jumpChoices = sessions.filter((x) => x.kind === "ssh" && x.id !== s.id);
  const hasAdvanced = !!(initial?.jumpId || initial?.forwards?.length || initial?.logOutput);
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
    if (!isLocal && useDir && !s.cwd?.trim()) return setError("시작 경로를 입력하거나 '연결 시 경로 지정'을 끄세요.");
    for (const f of isLocal ? [] : forwards) {
      const problem = forwardProblem(f);
      if (problem) return setError(problem);
    }

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
      const extra: Partial<Session> = isLocal
        ? {}
        : {
            cwd: useDir ? s.cwd?.trim() : undefined,
            forwards: forwards.map((f) => (f.kind === "dynamic" ? { kind: f.kind, bindPort: f.bindPort } : { ...f, host: f.host?.trim() })),
            jumpId: s.jumpId || null,
          };
      await onSave({ ...s, ...extra, name, host: host || s.host, user: s.user?.trim(), group: s.group?.trim() || null }, secret);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const savedHint = (has?: boolean) => (has ? "저장됨 · 바꿀 때만 입력" : "");

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`dialog${isLocal ? "" : " wide"}`}
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

              <hr className="divider" />

              <label className="check">
                <input type="checkbox" checked={useDir} onChange={(e) => setUseDir(e.target.checked)} />
                <span>
                  연결 시 경로 지정
                  <br />
                  <span className="hint">{useDir ? "연결되면 이 경로로 이동합니다." : `연결되면 홈 폴더(/home/${s.user?.trim() || "사용자"})에서 시작합니다.`}</span>
                </span>
              </label>
              {useDir && (
                <label className="field">
                  <span>시작 경로</span>
                  <input className="input mono" autoFocus value={s.cwd ?? ""} onChange={(e) => set({ cwd: e.target.value })} placeholder="/srv" />
                </label>
              )}

              <div className="field">
                <span className="field-label" id="color-label">환경 색</span>
                <div className="swatches" role="radiogroup" aria-labelledby="color-label">
                  <button role="radio" aria-checked={!s.color} className="swatch none" title="색 없음" aria-label="색 없음" onClick={() => set({ color: null })} />
                  {SESSION_COLORS.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={s.color === c}
                      className={`swatch env-${c}`}
                      title={COLOR_LABEL[c]}
                      aria-label={COLOR_LABEL[c]}
                      onClick={() => set({ color: c })}
                    />
                  ))}
                  <span className="hint">{s.color ? COLOR_LABEL[s.color] : "탭과 창 테두리에 색이 보입니다"}</span>
                </div>
              </div>

              <details className="advanced" open={hasAdvanced}>
                <summary>고급 · 점프 호스트, 포트 포워딩, 출력 기록</summary>

                <label className="field">
                  <span>거쳐 갈 서버 (점프 호스트)</span>
                  <select className="input" value={s.jumpId ?? ""} onChange={(e) => set({ jumpId: e.target.value || null })}>
                    <option value="">바로 연결</option>
                    {jumpChoices.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name} — {describeSession(j)}
                      </option>
                    ))}
                  </select>
                  {s.jumpId && <span className="hint">점프 호스트의 비밀번호나 키는 그 세션에 저장된 것을 씁니다.</span>}
                </label>

                <div className="field">
                  <span className="field-label">포트 포워딩</span>
                  {forwards.map((f, i) => (
                    <div key={i} className="forward-row">
                      <select className="input" aria-label="종류" value={f.kind} onChange={(e) => setForward(i, { kind: e.target.value as ForwardKind })}>
                        {(Object.keys(FORWARD_LABEL) as ForwardKind[]).map((k) => (
                          <option key={k} value={k}>
                            {FORWARD_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input mono"
                        aria-label={f.kind === "remote" ? "서버 포트" : "내 PC 포트"}
                        placeholder={f.kind === "remote" ? "서버 포트" : "내 PC 포트"}
                        inputMode="numeric"
                        value={f.bindPort || ""}
                        onChange={(e) => setForward(i, { bindPort: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                      />
                      {f.kind !== "dynamic" ? (
                        <>
                          <span className="arrow" aria-hidden>→</span>
                          <input
                            className="input mono"
                            aria-label="목적지 호스트"
                            placeholder={f.kind === "remote" ? "localhost" : "db.internal"}
                            value={f.host ?? ""}
                            onChange={(e) => setForward(i, { host: e.target.value })}
                          />
                          <input
                            className="input mono"
                            aria-label="목적지 포트"
                            placeholder="포트"
                            inputMode="numeric"
                            value={f.port || ""}
                            onChange={(e) => setForward(i, { port: Number(e.target.value.replace(/\D/g, "")) || undefined })}
                          />
                        </>
                      ) : (
                        <span className="hint socks-hint">브라우저 프록시를 127.0.0.1:{f.bindPort || "포트"}로</span>
                      )}
                      <button className="icon-btn ghost" aria-label="포워딩 지우기" title="지우기" onClick={() => set({ forwards: forwards.filter((_, j) => j !== i) })}>
                        <IconTrash width={14} height={14} />
                      </button>
                    </div>
                  ))}
                  <div>
                    <button className="btn subtle" onClick={() => set({ forwards: [...forwards, { kind: "local", bindPort: 0, host: "", port: undefined }] })}>
                      <IconPlus width={13} height={13} /> 포워딩 추가
                    </button>
                  </div>
                  <span className="hint">로컬: 내 PC 포트 → 서버에서 본 목적지 · 원격: 서버 포트 → 내 PC에서 본 목적지 · SOCKS: 내 PC 포트에 프록시</span>
                </div>

                <label className="check">
                  <input type="checkbox" checked={!!s.logOutput} onChange={(e) => set({ logOutput: e.target.checked })} />
                  <span>
                    출력 기록 저장
                    <br />
                    <span className="hint">터미널 출력을 시각과 함께 파일로 남깁니다(내 계정만 읽을 수 있게 저장). 화면에 보인 내용은 비밀번호나 토큰이라도 그대로 남으니 주의하세요. 설정 → 세션 기록에서 폴더를 열 수 있습니다.</span>
                  </span>
                </label>
              </details>
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
          {initial && onDuplicate && !isLocal && (
            <button className="btn" disabled={busy} title="같은 설정(저장된 비밀번호·키 포함)으로 새 세션을 만듭니다" onClick={() => void onDuplicate(initial)}>
              복제
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
