import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, errorText, type SecretInput } from "../lib/api";
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
import { ComboBox } from "./ComboBox";
import { ShellInput } from "./ShellInput";
import { PasswordInput } from "./PasswordInput";
import { Dropdown } from "./Dropdown";
import { IconClose, IconPlus, IconTrash } from "./Icons";
import { SideTabs } from "./SideTabs";
import { tx } from "../lib/i18n";
import { useEscape } from "../lib/useEscape";

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

const FORWARD_LABEL: Record<ForwardKind, string> = { local: tx("로컬 (-L)"), remote: tx("원격 (-R)"), dynamic: "SOCKS (-D)" };

const blank: Session = { id: "", name: "", group: null, kind: "ssh", host: "", port: 22, user: "", auth: "password" };

const AUTH_LABEL: Record<AuthMethod, string> = { password: tx("비밀번호"), key: tx("키 파일"), agent: tx("SSH 에이전트") };

type EditorTab = "connect" | "auth" | "display" | "network" | "log" | "shell";

const SSH_TABS: [EditorTab, string][] = [
  ["connect", tx("연결")],
  ["auth", tx("인증")],
  ["display", tx("표시")],
  ["network", tx("네트워크")],
  ["log", tx("기록")],
];

const LOCAL_TABS: [EditorTab, string][] = [
  ["display", tx("표시")],
  ["shell", tx("로컬 셸")],
];

/**
 * 세션 편집. 로컬 셸은 탭의 + 로 바로 열기 때문에 여기서는 SSH만 만든다.
 * 예전에 저장한 로컬 셸 세션은 이름·그룹·셸만 고칠 수 있다.
 */
export function SessionEditor({ initial, groups, sessions, onSave, onDelete, onDuplicate, onClose }: Props) {
  useEscape(onClose);
  const [s, setS] = useState<Session>(initial ?? blank);
  // SSH 시작 경로: 체크하면 그 경로로, 안 하면 서버 기본(홈 폴더)으로 들어간다.
  const [useDir, setUseDir] = useState(() => initial?.kind === "ssh" && !!initial.cwd?.trim());
  const forwards = s.forwards ?? [];
  const setForward = (i: number, patch: Partial<Forward>) =>
    set({ forwards: forwards.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const jumpChoices = sessions.filter((x) => x.kind === "ssh" && x.id !== s.id);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // "바로 접속" 하나로 비밀번호, 또는 키 파일 + 키 암호의 저장을 함께 다룬다. 기본은 켬.
  // 끄면 보관함에서 지우고 연결할 때마다 터미널에서 로그인한다.
  const [store, setStore] = useState(() => !initial?.askLogin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 저장된 비밀번호·키 암호는 칸에 미리 채워 둔다('보기'로 바로 확인할 수 있게).
  useEffect(() => {
    if (!initial || initial.kind !== "ssh") return;
    let alive = true;
    const load = (kind: "password" | "passphrase", fill: Dispatch<SetStateAction<string>>) =>
      api
        .sessionRevealSecret(initial.id, kind)
        .then((v) => alive && v && fill((cur) => cur || v))
        .catch((e) => alive && setError(errorText(e)));
    if (initial.hasPassword) void load("password", setPassword);
    if (initial.hasPassphrase) void load("passphrase", setPassphrase);
    return () => {
      alive = false;
    };
    // 창을 열 때 한 번만 불러온다.
  }, []);
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
      if (!s.host?.trim()) return tx("호스트를 입력하세요.");
      if (useDir && !s.cwd?.trim()) return tx("시작 경로를 입력하거나 '연결 시 경로 지정'을 끄세요.");
    }
    if (where === "auth") {
      if (store && auth === "key" && !s.keyPath?.trim()) return tx("개인 키 파일을 고르세요.");
    }
    if (where === "network") {
      for (const f of forwards) {
        const problem = forwardProblem(f);
        if (problem) return problem;
      }
    }
    return null;
  };
  // 새 세션에서 '다음'으로 가 본 가장 먼 항목. 거기까지는 왼쪽 목록으로 오갈 수 있다.
  const [reached, setReached] = useState(0);
  const goStep = (to: number) => {
    setError("");
    focusPanel.current = true;
    pick(steps[to][0]);
    setReached((r) => Math.max(r, to));
  };
  const nextStep = () => {
    const problem = stepProblem(tab);
    if (problem) return setError(problem);
    goStep(step + 1);
  };
  /** 왼쪽 목록에서 항목을 눌렀을 때. 새 세션은 순서대로만 앞으로 갈 수 있다. */
  const pickTab = (next: EditorTab): boolean => {
    if (!isNew) {
      pick(next);
      return true;
    }
    const to = steps.findIndex(([id]) => id === next);
    if (to > reached) {
      setError(tx("지금 항목을 입력하고 '다음'을 누르세요."));
      return false;
    }
    // 이미 지나온 항목이라도 앞으로 갈 때는 그 사이 항목을 다시 확인한다(돌아가서 지웠을 수 있다).
    for (let i = step; i < to; i++) {
      const problem = stepProblem(steps[i][0]);
      if (problem) {
        if (i !== step) pick(steps[i][0]);
        setError(problem);
        return false;
      }
    }
    setError("");
    pick(next);
    return true;
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
    if (!isLocal && !host) return invalid("connect", tx("호스트를 입력하세요."));
    if (!name) return invalid("display", tx("이름을 입력하세요."));
    if (!isLocal && store && auth === "key" && !s.keyPath?.trim()) return invalid("auth", tx("개인 키 파일을 고르세요."));
    if (!isLocal && useDir && !s.cwd?.trim()) return invalid("connect", tx("시작 경로를 입력하거나 '연결 시 경로 지정'을 끄세요."));
    for (const f of isLocal ? [] : forwards) {
      const problem = forwardProblem(f);
      if (problem) return invalid("network", problem);
    }

    const secret: SecretInput = {};
    if (isLocal || auth === "agent" || !store) {
      secret.clear = true;
    } else if (!store) {
      // 저장하지 않으면 지금까지 저장된 것도 지운다. 연결할 때 터미널에서 묻는다.
      secret.clear = true;
    } else if (auth === "password") {
      // 비밀번호 칸은 저장된 값으로 미리 채워 두므로, 비웠다면 저장된 비밀번호도 지운다.
      if (password) secret.password = password;
      else secret.clear = true;
    } else {
      const keyChanged = s.keyPath !== initial?.keyPath;
      secret.importKey = keyChanged || !initial?.hasPrivateKey;
      // 키 암호 칸도 저장된 값으로 미리 채워 두므로, 비웠다면 저장된 키 암호를 지운다.
      if (passphrase) secret.passphrase = passphrase;
      else secret.clearPassphrase = true;
    }

    setBusy(true);
    try {
      const extra: Partial<Session> = isLocal
        ? {}
        : {
            cwd: useDir ? s.cwd?.trim() : undefined,
            forwards: forwards.map((f) => (f.kind === "dynamic" ? { kind: f.kind, bindPort: f.bindPort } : { ...f, host: f.host?.trim() })),
            jumpId: s.jumpId || null,
            askLogin: !store,
            // 바로 접속을 끄면 사용자와 비밀번호를 연결할 때 터미널에서 받는다.
            ...(store ? {} : { user: undefined, auth: "password" as AuthMethod }),
          };
      await onSave({ ...s, user: s.user?.trim(), ...extra, name, host: host || s.host, group: s.group?.trim() || null }, secret);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };


  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog settings-dialog session-editor"
        role="dialog"
        aria-labelledby="se-title"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            if (isNew && !isLastStep) nextStep();
            else void submit();
          }
        }}
      >
        <div className="dialog-head">
          <h2 id="se-title">{initial ? tx("세션 편집") : tx("새 세션")}</h2>
          <button className="icon-btn ghost" aria-label={tx("닫기")} onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="settings-layout">
          <SideTabs
            tabs={isLocal ? LOCAL_TABS : SSH_TABS}
            active={tab}
            onPick={pickTab}
            isLocked={(id) => isNew && steps.findIndex(([t]) => t === id) > reached}
            idPrefix="se-tab"
            panelId="se-panel"
            label={tx("세션 설정 항목")}
            isMarked={(id) => (id === "network" ? !!s.jumpId || forwards.length > 0 : id === "log" && !!s.logOutput)}
          />

          {/* key: 항목을 바꾸면 스크롤이 맨 위에서 시작한다 */}
          <div ref={panel} key={tab} id="se-panel" className="dialog-body settings-panel" role="tabpanel" aria-labelledby={`se-tab-${tab}`}>
            {isLocal ? (
              <>
              {tab === "display" && (
                <>
                  <section className="form-section">
                    <h3>{tx("표시")}</h3>
                    <div className="grid2">
                      <div className="field">
                        <span className="field-label">{tx("그룹")}</span>
                        <ComboBox value={s.group ?? ""} options={groups} onChange={(group) => set({ group })} placeholder={tx("그룹 없음")} ariaLabel={tx("그룹")} />
                      </div>
                      <label className="field">
                        <span>{tx("이름")}</span>
                        <input className="input" autoFocus={isLocal && !navigated.current} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder={s.host?.trim() || tx("비우면 호스트 이름")} />
                      </label>
                    </div>
                  </section>
                </>
              )}
              {tab === "shell" && (
                <>
                  <section className="form-section">
                    <h3>{tx("로컬 셸")}</h3>
                    <div className="grid2">
                      <div className="field">
                        <span className="field-label">{tx("셸 (비우면 기본 셸)")}</span>
                        <ShellInput value={s.shell ?? ""} onChange={(shell) => set({ shell })} placeholder="zsh, pwsh.exe, wsl.exe -d Ubuntu…" ariaLabel={tx("셸")} />
                      </div>
                      <label className="field">
                        <span>{tx("시작 폴더")}</span>
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
                    <h3>{tx("연결")}</h3>
                    <div className="grid-host">
                      <label className="field">
                        <span>{tx("호스트")}</span>
                        <input className="input mono" autoFocus={!navigated.current} value={s.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder={tx("10.0.1.21 또는 example.com")} />
                      </label>
                      <label className="field">
                        <span>{tx("포트")}</span>
                        <input className="input mono" inputMode="numeric" value={s.port ?? 22} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 22 })} />
                      </label>
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={useDir} onChange={(e) => { focusCwd.current = e.target.checked; setUseDir(e.target.checked); }} />
                      <span>
                        {tx("연결 시 경로 지정")}
                        <span className="hint">{useDir ? tx("연결되면 이 경로로 이동합니다.") : tx("연결되면 홈 폴더(/home/{0})에서 시작합니다.", s.user?.trim() || tx("사용자"))}</span>
                      </span>
                    </label>
                    {useDir && (
                      <label className="field">
                        <span>{tx("시작 경로")}</span>
                        <input className="input mono" autoFocus={focusCwd.current} value={s.cwd ?? ""} onChange={(e) => set({ cwd: e.target.value })} placeholder="/srv" />
                      </label>
                    )}
                  </section>
                </>
              )}
              {tab === "auth" && (
                <>
                  <section className="form-section">
                    <label className="check">
                      <input type="checkbox" checked={store} onChange={(e) => setStore(e.target.checked)} />
                      <span>
                        {tx("바로 접속")}
                        <span className="hint">
                          {store
                            ? auth === "agent"
                              ? tx("SSH 에이전트의 키로 묻지 않고 연결합니다.")
                              : auth === "key"
                              ? tx("키 파일과 키 암호를 보관함에 저장해 묻지 않고 연결합니다. 보관함 파일만 옮기면 다른 PC에서도 이 키로 연결됩니다.")
                              : tx("비밀번호를 보관함에 암호화해 저장하고, 연결할 때 묻지 않습니다. 비워 두면 처음 연결할 때 묻습니다.")
                            : tx("아무것도 저장하지 않고, 연결할 때마다 터미널에서 사용자와 비밀번호를 입력합니다.")}
                        </span>
                      </span>
                    </label>
                  </section>
                  {/* 바로 접속을 끄면 아래는 모두 막는다. 값은 남겨 두었다가 다시 켜면 돌아온다. */}
                  <fieldset className="form-section plain-fieldset" disabled={!store}>
                    <h3>{tx("인증")}</h3>
                    <label className="field">
                      <span>{tx("사용자")}</span>
                      <input className="input mono" value={store ? (s.user ?? "") : ""} onChange={(e) => set({ user: e.target.value })} placeholder={store ? tx("비워 두면 연결할 때 묻기") : tx("연결할 때 터미널에서 입력")} />
                    </label>
                    <div className="seg" role="group" aria-label={tx("인증 방식")}>
                      {(["password", "key", "agent"] as AuthMethod[]).map((a) => (
                        <button key={a} aria-pressed={(store ? auth : "password") === a} onClick={() => set({ auth: a })}>
                          {AUTH_LABEL[a]}
                        </button>
                      ))}
                    </div>
                    {(!store || auth === "password") && (
                      <label className="field">
                        <span>{tx("비밀번호")}</span>
                        <PasswordInput value={store ? password : ""} onChange={setPassword} disabled={!store} placeholder={store ? tx("비워 두면 저장하지 않고, 연결할 때 묻습니다") : tx("연결할 때 터미널에서 입력")} />
                      </label>
                    )}
                    {store && auth === "key" && (
                      <>
                        <div className="field">
                          <label className="field-label" htmlFor="keyfile">{tx("개인 키 파일")}</label>
                          <div className="row-gap">
                            <input id="keyfile" className="input mono" value={s.keyPath ?? ""} onChange={(e) => set({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
                            <button className="btn" style={{ height: 38, flex: "none" }} onClick={async () => { const p = await pickKeyFile(); if (p) set({ keyPath: p }); }}>
                              {tx("찾아보기")}
                            </button>
                          </div>
                        </div>
                        <label className="field">
                          <span>{tx("키 암호 (없으면 비워 두기)")}</span>
                          <PasswordInput value={store ? passphrase : ""} onChange={setPassphrase} disabled={!store} placeholder={store ? tx("비워 두면 저장하지 않습니다") : tx("연결할 때 터미널에서 입력")} />
                        </label>
                      </>
                    )}
                    {store && auth === "agent" && (
                      <p className="hint">{tx("OS의 SSH 에이전트(macOS ssh-agent, Windows OpenSSH 에이전트)에 올라간 키를 씁니다. 보관함에는 아무것도 저장하지 않습니다.")}</p>
                    )}
                  </fieldset>
                </>
              )}
              {tab === "display" && (
                <>
                  <section className="form-section">
                    <h3>{tx("표시")}</h3>
                    <div className="grid2">
                      <div className="field">
                        <span className="field-label">{tx("그룹")}</span>
                        <ComboBox value={s.group ?? ""} options={groups} onChange={(group) => set({ group })} placeholder={tx("그룹 없음")} ariaLabel={tx("그룹")} />
                      </div>
                      <label className="field">
                        <span>{tx("이름")}</span>
                        <input className="input" autoFocus={isLocal} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder={s.host?.trim() || tx("비우면 호스트 이름")} />
                      </label>
                    </div>
                    <div className="field">
                      <span className="field-label" id="color-label">{tx("환경 색")}</span>
                      <div className="swatches" role="radiogroup" aria-labelledby="color-label">
                        <button role="radio" aria-checked={!s.color} className="swatch none" title={tx("색 없음")} aria-label={tx("색 없음")} onClick={() => set({ color: null })} />
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
                        <span className="hint">{s.color ? COLOR_LABEL[s.color] : tx("탭과 창 테두리에 색이 보입니다")}</span>
                      </div>
                    </div>
                  </section>
                </>
              )}
              {tab === "network" && (
                <>
                  <section className="form-section">
                    <h3>{tx("점프 호스트")}</h3>
                      <label className="field">
                        <span>{tx("거쳐 갈 서버")}</span>
                        <Dropdown
                          value={s.jumpId ?? ""}
                          options={[{ value: "", label: tx("바로 연결") }, ...jumpChoices.map((j) => ({ value: j.id, label: `${j.name} — ${describeSession(j)}` }))]}
                          onChange={(v) => set({ jumpId: v || null })}
                        />
                        {s.jumpId && <span className="hint">{tx("점프 호스트의 비밀번호나 키는 그 세션에 저장된 것을 씁니다.")}</span>}
                      </label>
                  </section>

                  <section className="form-section">
                    <h3>{tx("포트 포워딩")}</h3>
                      <div className="field">
                        {forwards.map((f, i) => (
                          <div key={i} className="forward-row">
                            <Dropdown<ForwardKind>
                              ariaLabel={tx("종류")}
                              value={f.kind}
                              options={(Object.keys(FORWARD_LABEL) as ForwardKind[]).map((k) => ({ value: k, label: FORWARD_LABEL[k] }))}
                              onChange={(kind) => setForward(i, { kind })}
                            />
                            <input
                              className="input mono"
                              aria-label={f.kind === "remote" ? tx("서버 포트") : tx("내 PC 포트")}
                              placeholder={f.kind === "remote" ? tx("서버 포트") : tx("내 PC 포트")}
                              inputMode="numeric"
                              value={f.bindPort || ""}
                              onChange={(e) => setForward(i, { bindPort: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                            />
                            {f.kind !== "dynamic" ? (
                              <>
                                <span className="arrow" aria-hidden>→</span>
                                <input
                                  className="input mono"
                                  aria-label={tx("목적지 호스트")}
                                  placeholder="localhost"
                                  value={f.host ?? ""}
                                  onChange={(e) => setForward(i, { host: e.target.value })}
                                />
                                <input
                                  className="input mono"
                                  aria-label={tx("목적지 포트")}
                                  placeholder={tx("포트")}
                                  inputMode="numeric"
                                  value={f.port || ""}
                                  onChange={(e) => setForward(i, { port: Number(e.target.value.replace(/\D/g, "")) || undefined })}
                                />
                              </>
                            ) : (
                              <span className="hint socks-hint">{tx("브라우저 프록시를 127.0.0.1:")}{f.bindPort || tx("포트")}{tx("로")}</span>
                            )}
                            <button className="icon-btn ghost" aria-label={tx("포워딩 지우기")} title={tx("지우기")} onClick={() => set({ forwards: forwards.filter((_, j) => j !== i) })}>
                              <IconTrash width={14} height={14} />
                            </button>
                          </div>
                        ))}
                        <div>
                          <button className="btn subtle" onClick={() => set({ forwards: [...forwards, { kind: "local", bindPort: 0, host: "", port: undefined }] })}>
                            <IconPlus width={13} height={13} />{" "}{tx("포워딩 추가")}
                          </button>
                        </div>
                        <span className="hint">{tx("로컬: 내 PC 포트 → 서버에서 본 목적지 · 원격: 서버 포트 → 내 PC에서 본 목적지 · SOCKS: 내 PC 포트에 프록시")}</span>
                        {forwards.length > 0 && (
                          <span className="hint">
                            {tx("포워딩은 이 PC(127.0.0.1)에서만 열리지만 인증은 없습니다. 연결된 동안 이 PC의 다른 프로그램이나 브라우저 페이지도 그 포트에 닿을 수 있으니, 관리 화면·DB처럼 민감한 곳은 쓸 때만 켜 두세요.")}
                          </span>
                        )}
                      </div>
                  </section>
                </>
              )}
              {tab === "log" && (
                <>
                  <section className="form-section">
                    <h3>{tx("출력 기록")}</h3>
                      <label className="check">
                        <input type="checkbox" checked={!!s.logOutput} onChange={(e) => set({ logOutput: e.target.checked })} />
                        <span>
                          {tx("출력 기록 저장")}
                          <span className="hint">{tx("터미널 출력을 시각과 함께 파일로 남깁니다(내 계정만 읽을 수 있게 저장). 화면에 보인 내용은 비밀번호나 토큰이라도 그대로 남으니 주의하세요. 설정 → 세션 기록에서 폴더를 열 수 있습니다.")}</span>
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
              {tx("삭제")}
            </button>
          )}
          {initial && onDuplicate && !isLocal && (
            <button className="btn" disabled={busy} title={tx("같은 설정(저장된 비밀번호·키 포함)으로 새 세션을 만듭니다")} onClick={() => void onDuplicate(initial)}>
              {tx("복제")}
            </button>
          )}
          <span className="spacer" />
          {isNew && <span className="hint">{step + 1} / {steps.length}</span>}
          <button className="btn" onClick={onClose}>
            {tx("취소")}
          </button>
          {isNew && step > 0 && (
            <button className="btn" disabled={busy} onClick={() => goStep(step - 1)}>
              {tx("이전")}
            </button>
          )}
          {isNew && !isLastStep ? (
            <button className="btn primary" onClick={nextStep}>
              {tx("다음")}
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={submit}>
              {isNew ? tx("저장하고 연결") : tx("저장")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
