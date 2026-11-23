import { useEffect, useRef, useState } from "react";
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
import { Dropdown } from "./Dropdown";
import { IconClose, IconPlus, IconTrash } from "./Icons";
import { SideTabs } from "./SideTabs";

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

type EditorTab = "connect" | "auth" | "display" | "network" | "log" | "shell";

const SSH_TABS: [EditorTab, string][] = [
  ["connect", "연결"],
  ["auth", "인증"],
  ["display", "표시"],
  ["network", "네트워크"],
  ["log", "기록"],
];

const LOCAL_TABS: [EditorTab, string][] = [
  ["display", "표시"],
  ["shell", "로컬 셸"],
];

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
  const [tab, setTab] = useState<EditorTab>(isLocal ? "display" : "connect");
  // 처음 열 때만 첫 칸에 초점을 준다. 항목을 오갈 때 초점을 뺏으면 방향키로 옮겨 다닐 수 없다.
  const navigated = useRef(false);
  const focusCwd = useRef(false);
  const pick = (next: EditorTab) => {
    navigated.current = true;
    focusCwd.current = false;
    setTab(next);
  };
  // 새 세션은 다음 → 다음 → … → 저장 순서로 진행한다. 저장하면 바로 연결된다.
  const isNew = !initial;
  const steps = isLocal ? LOCAL_TABS : SSH_TABS;
  const step = steps.findIndex(([id]) => id === tab);
  const isLastStep = step === steps.length - 1;
  const panel = useRef<HTMLDivElement>(null);
  const focusPanel = useRef(false);
  useEffect(() => {
    if (!focusPanel.current) return;
    focusPanel.current = false;
    panel.current?.querySelector<HTMLElement>('input:not([type="checkbox"]), .dropdown, input')?.focus();
  }, [tab]);

  /** 이 항목에서 다음으로 넘어가면 안 되는 이유 */
  const stepProblem = (where: EditorTab): string | null => {
    if (isLocal) return null;
    if (where === "connect") {
      if (!s.host?.trim()) return "호스트를 입력하세요.";
      if (useDir && !s.cwd?.trim()) return "시작 경로를 입력하거나 '연결 시 경로 지정'을 끄세요.";
    }
    if (where === "auth") {
      if (!s.user?.trim()) return "사용자를 입력하세요.";
      if (auth === "key" && !s.keyPath?.trim()) return "개인 키 파일을 고르세요.";
    }
    if (where === "network") {
      for (const f of forwards) {
        const problem = forwardProblem(f);
        if (problem) return problem;
      }
    }
    return null;
  };
  const goStep = (to: number) => {
    setError("");
    focusPanel.current = true;
    pick(steps[to][0]);
    focusPanel.current = true;
  };
  const nextStep = () => {
    const problem = stepProblem(tab);
    if (problem) return setError(problem);
    goStep(step + 1);
  };

  /** 문제가 있는 칸이 있는 항목으로 옮겨서 알려 준다. */
  const invalid = (where: EditorTab, message: string) => {
    pick(where);
    setError(message);
  };

  const submit = async () => {
    setError("");
    const host = s.host?.trim() ?? "";
    const name = s.name.trim() || host;
    if (!isLocal && !host) return invalid("connect", "호스트를 입력하세요.");
    if (!isLocal && !s.user?.trim()) return invalid("auth", "사용자를 입력하세요.");
    if (!name) return invalid("display", "이름을 입력하세요.");
    if (!isLocal && auth === "key" && !s.keyPath?.trim()) return invalid("auth", "개인 키 파일을 고르세요.");
    if (!isLocal && useDir && !s.cwd?.trim()) return invalid("connect", "시작 경로를 입력하거나 '연결 시 경로 지정'을 끄세요.");
    for (const f of isLocal ? [] : forwards) {
      const problem = forwardProblem(f);
      if (problem) return invalid("network", problem);
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
        className="dialog settings-dialog session-editor"
        role="dialog"
        aria-labelledby="se-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            if (isNew && !isLastStep) nextStep();
            else void submit();
          }
        }}
      >
        <div className="dialog-head">
          <h2 id="se-title">{initial ? "세션 편집" : "새 세션"}</h2>
          <button className="icon-btn ghost" aria-label="닫기" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="settings-layout">
          <SideTabs
            tabs={isLocal ? LOCAL_TABS : SSH_TABS}
            active={tab}
            onPick={pick}
            idPrefix="se-tab"
            panelId="se-panel"
            label="세션 설정 항목"
            isMarked={(id) => (id === "network" ? !!s.jumpId || forwards.length > 0 : id === "log" && !!s.logOutput)}
          />

          {/* key: 항목을 바꾸면 스크롤이 맨 위에서 시작한다 */}
          <div ref={panel} key={tab} id="se-panel" className="dialog-body settings-panel" role="tabpanel" aria-labelledby={`se-tab-${tab}`}>
            {isLocal ? (
              <>
              {tab === "display" && (
                <>
                  <section className="form-section">
                    <h3>표시</h3>
                    <div className="grid2">
                      <label className="field">
                        <span>이름</span>
                        <input className="input" autoFocus={isLocal && !navigated.current} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder={s.host?.trim() || "비우면 호스트 이름"} />
                      </label>
                      <label className="field">
                        <span>그룹</span>
                        <input className="input" list="group-list" value={s.group ?? ""} onChange={(e) => set({ group: e.target.value })} placeholder="그룹 없음" />
                        <datalist id="group-list">
                          {groups.map((g) => (
                            <option key={g} value={g} />
                          ))}
                        </datalist>
                      </label>
                    </div>
                  </section>
                </>
              )}
              {tab === "shell" && (
                <>
                  <section className="form-section">
                    <h3>로컬 셸</h3>
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
                  </section>
                </>
              )}
              </>
            ) : (
              <>
              {tab === "connect" && (
                <>
                  <section className="form-section">
                    <h3>연결</h3>
                    <div className="grid-host">
                      <label className="field">
                        <span>호스트</span>
                        <input className="input mono" autoFocus={!navigated.current} value={s.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder="10.0.1.21 또는 example.com" />
                      </label>
                      <label className="field">
                        <span>포트</span>
                        <input className="input mono" inputMode="numeric" value={s.port ?? 22} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 22 })} />
                      </label>
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={useDir} onChange={(e) => { focusCwd.current = e.target.checked; setUseDir(e.target.checked); }} />
                      <span>
                        연결 시 경로 지정
                        <span className="hint">{useDir ? "연결되면 이 경로로 이동합니다." : `연결되면 홈 폴더(/home/${s.user?.trim() || "사용자"})에서 시작합니다.`}</span>
                      </span>
                    </label>
                    {useDir && (
                      <label className="field">
                        <span>시작 경로</span>
                        <input className="input mono" autoFocus={focusCwd.current} value={s.cwd ?? ""} onChange={(e) => set({ cwd: e.target.value })} placeholder="/srv" />
                      </label>
                    )}
                  </section>
                </>
              )}
              {tab === "auth" && (
                <>
                  <section className="form-section">
                    <h3>인증</h3>
                    <label className="field">
                      <span>사용자</span>
                      <input className="input mono" value={s.user ?? ""} onChange={(e) => set({ user: e.target.value })} placeholder="deploy" />
                    </label>
                    <div className="seg" role="group" aria-label="인증 방식">
                      {(["password", "key", "agent"] as AuthMethod[]).map((a) => (
                        <button key={a} aria-pressed={auth === a} onClick={() => set({ auth: a })}>
                          {AUTH_LABEL[a]}
                        </button>
                      ))}
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
                  </section>
                </>
              )}
              {tab === "display" && (
                <>
                  <section className="form-section">
                    <h3>표시</h3>
                    <div className="grid2">
                      <label className="field">
                        <span>이름</span>
                        <input className="input" autoFocus={isLocal} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder={s.host?.trim() || "비우면 호스트 이름"} />
                      </label>
                      <label className="field">
                        <span>그룹</span>
                        <input className="input" list="group-list" value={s.group ?? ""} onChange={(e) => set({ group: e.target.value })} placeholder="그룹 없음" />
                        <datalist id="group-list">
                          {groups.map((g) => (
                            <option key={g} value={g} />
                          ))}
                        </datalist>
                      </label>
                    </div>
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
                  </section>
                </>
              )}
              {tab === "network" && (
                <>
                  <section className="form-section">
                    <h3>점프 호스트</h3>
                      <label className="field">
                        <span>거쳐 갈 서버</span>
                        <Dropdown
                          value={s.jumpId ?? ""}
                          options={[{ value: "", label: "바로 연결" }, ...jumpChoices.map((j) => ({ value: j.id, label: `${j.name} — ${describeSession(j)}` }))]}
                          onChange={(v) => set({ jumpId: v || null })}
                        />
                        {s.jumpId && <span className="hint">점프 호스트의 비밀번호나 키는 그 세션에 저장된 것을 씁니다.</span>}
                      </label>
                  </section>

                  <section className="form-section">
                    <h3>포트 포워딩</h3>
                      <div className="field">
                        {forwards.map((f, i) => (
                          <div key={i} className="forward-row">
                            <Dropdown<ForwardKind>
                              ariaLabel="종류"
                              value={f.kind}
                              options={(Object.keys(FORWARD_LABEL) as ForwardKind[]).map((k) => ({ value: k, label: FORWARD_LABEL[k] }))}
                              onChange={(kind) => setForward(i, { kind })}
                            />
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
                                  placeholder="localhost"
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
                        {forwards.length > 0 && (
                          <span className="hint">
                            포워딩은 이 PC(127.0.0.1)에서만 열리지만 인증은 없습니다. 연결된 동안 이 PC의 다른 프로그램이나 브라우저 페이지도 그 포트에 닿을 수 있으니, 관리 화면·DB처럼 민감한 곳은 쓸 때만 켜 두세요.
                          </span>
                        )}
                      </div>
                  </section>
                </>
              )}
              {tab === "log" && (
                <>
                  <section className="form-section">
                    <h3>출력 기록</h3>
                      <label className="check">
                        <input type="checkbox" checked={!!s.logOutput} onChange={(e) => set({ logOutput: e.target.checked })} />
                        <span>
                          출력 기록 저장
                          <span className="hint">터미널 출력을 시각과 함께 파일로 남깁니다(내 계정만 읽을 수 있게 저장). 화면에 보인 내용은 비밀번호나 토큰이라도 그대로 남으니 주의하세요. 설정 → 세션 기록에서 폴더를 열 수 있습니다.</span>
                        </span>
                      </label>
                  </section>
                </>
              )}
              </>
            )}
          </div>
        </div>

        {error && <p className="error form-error" role="alert">{error}</p>}

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
          {isNew && <span className="hint">{step + 1} / {steps.length}</span>}
          <button className="btn" onClick={onClose}>
            취소
          </button>
          {isNew && step > 0 && (
            <button className="btn" disabled={busy} onClick={() => goStep(step - 1)}>
              이전
            </button>
          )}
          {isNew && !isLastStep ? (
            <button className="btn primary" onClick={nextStep}>
              다음
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={submit}>
              {isNew ? "저장하고 연결" : "저장"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
