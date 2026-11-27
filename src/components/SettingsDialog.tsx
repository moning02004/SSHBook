import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  FONT_PRESETS,
  FONT_SIZE,
  fontStack,
  getSettings,
  isFontInstalled,
  LINE_HEIGHTS,
  resetSettings,
  SCROLLBACKS,
  subscribeSettings,
  updateSettings,
  AUTO_LOCK_CHOICES,
  type CursorStyle,
} from "../lib/settings";
import type { Group, Session } from "../lib/sessions";
import type { ThemeName } from "../lib/theme";
import { appVersion, checkForUpdate, installUpdate, useUpdateState } from "../lib/updater";
import { api } from "../lib/api";
import { refreshFonts } from "../lib/terminals";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { Dropdown } from "./Dropdown";
import { GroupSettings } from "./GroupSettings";
import { ShellInput } from "./ShellInput";
import { IconClose, IconExport, IconUnlock } from "./Icons";
import { ImportSshConfigDialog } from "./ImportSshConfigDialog";
import { KnownHostsDialog } from "./KnownHostsDialog";
import { PasswordModeDialog } from "./PasswordModeDialog";
import { SideTabs } from "./SideTabs";
import { language, savedLanguage, saveLanguage, tx, type Language } from "../lib/i18n";
import { useEscape } from "../lib/useEscape";

export function useSettings() {
  return useSyncExternalStore(subscribeSettings, getSettings);
}

interface Props {
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  /** 세션 기록 폴더 열기 */
  onOpenLogs: () => void;
  /** 화면 아래에 잠깐 보여 줄 알림 */
  onNotice: (message: string) => void;
  /** 마스터 비밀번호 없이 쓰는 중인지 */
  passwordless: boolean;
  /** 비밀번호 사용을 켜거나 껐을 때 상태를 다시 읽는다 */
  onVaultChanged: () => void | Promise<void>;
  /** 보관함 파일 내보내기. password는 비밀번호 없이 쓰는 중일 때 내보낼 파일의 비밀번호 */
  onExport: (password?: string) => void;
  /** 보관함 잠그기 */
  onLock: () => void;
  /** 지금 세션 목록(가져오기에서 중복을 가린다) */
  sessions: Session[];
  /** 미리 만든 그룹과 그룹 색 */
  groups: Group[];
  /** 그룹을 바꾼 뒤 세션과 그룹 목록을 다시 읽는다 */
  onGroupsChanged: () => Promise<void>;
  onClose: () => void;
}

const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";
const K = isMac ? "⌘⇧" : "Ctrl+Shift+";

const SHORTCUTS: [string, string][] = [
  [tx("호스트 목록"), isMac ? "⌘D" : "Alt+D"],
  [tx("끊긴 창 다시 연결"), isMac ? "⌘R" : "Ctrl+R"],
  [tx("설정 열기"), `${MOD},`],
  [tx("글자 크게 / 작게 / 원래대로"), `${MOD}= / ${MOD}- / ${MOD}0`],
  [tx("사이드바 접기·펼치기"), `${K}B`],
  [tx("전체 화면"), "F11"],
  [tx("오른쪽 / 아래로 분할"), "Alt+Shift+→ / ↓"],
  [tx("이 창만 크게 보기"), `${K}Z`],
  [tx("복사 / 붙여넣기"), isMac ? `${K}C / ${K}V` : `Ctrl+C (${tx("고른 글자가 있을 때")}) · ${K}C / ${K}V`],
  [tx("화면 지우기"), `${K}K`],
  [tx("터미널에서 찾기"), isMac ? "⌘F" : `${K}F`],
  [tx("명령 모음"), `${K}S`],
  [tx("파일 창 (SFTP)"), `${K}O`],
  [tx("분할 창 동시 입력"), `${K}I`],
  [tx("다음 / 이전 탭"), "Ctrl+Tab / Ctrl+Shift+Tab"],
  [tx("n번째 탭 (9 = 마지막)"), isMac ? "⌘1 … ⌘9" : "Alt+1 … Alt+9"],
  [tx("옆 칸으로 이동"), isMac ? tx("⌘⌥ + 방향키") : tx("Ctrl+Alt + 방향키")],
  [tx("탭 이름 바꾸기"), tx("탭 더블클릭")],
  [tx("탭 옮기기 / 분할"), tx("탭을 다른 칸이나 가장자리로 끌기")],
  [tx("탭 닫기 (가운데 버튼)"), tx("휠 클릭")],
  ...(isMac ? ([[tx("탭 닫기 (탭이 없으면 창 닫기)"), "⌘W"]] as [string, string][]) : []),
  [tx("창 닫기"), `${K}W`],
];

const CUSTOM = "__custom__";

type SettingsTab = "appearance" | "terminal" | "groups" | "security" | "shortcuts" | "import" | "logs" | "update";

const TABS: [SettingsTab, string][] = [
  ["appearance", tx("화면")],
  ["terminal", tx("터미널")],
  ["groups", tx("그룹")],
  ["security", tx("보안")],
  ["shortcuts", tx("단축키")],
  ["import", tx("가져오기")],
  ["logs", tx("기록")],
  ["update", tx("업데이트")],
];

/** 설정을 다시 열면 마지막으로 보던 항목을 보여 준다. */
let lastTab: SettingsTab = "appearance";

/** 설정 화면. 바꾸는 즉시 열린 터미널에 적용되고 이 PC에 저장된다. */
export function SettingsDialog({ theme, onTheme, onOpenLogs, onNotice, passwordless, onVaultChanged, onExport, onLock, sessions, groups, onGroupsChanged, onClose }: Props) {
  useEscape(onClose);
  const [sub, setSub] = useState<"password" | "hosts" | "disable" | "enable" | "export" | "sshconfig" | null>(null);
  const s = useSettings();
  const [installed, setInstalled] = useState(() => new Map(FONT_PRESETS.map((f) => [f, isFontInstalled(f)])));
  const [installable, setInstallable] = useState<string[]>([]);
  /** idle · busy(내려받는 중) · done(바로 보임) · restart(다시 시작해야 보임) */
  const [fontJob, setFontJob] = useState<{ family: string; phase: "busy" | "done" | "restart" } | null>(null);
  useEffect(() => {
    api.fontsInstallable().then(setInstallable, () => setInstallable([]));
  }, []);
  const installFont = async (family: string) => {
    setFontJob({ family, phase: "busy" });
    try {
      await api.fontInstall(family);
      // 웹뷰가 새 글꼴을 바로 알아채면 그대로 쓰고, 아니면 다시 시작하라고 알린다.
      await new Promise((r) => setTimeout(r, 400));
      const ok = isFontInstalled(family);
      setInstalled((m) => new Map(m).set(family, ok));
      if (ok) refreshFonts();
      setFontJob({ family, phase: ok ? "done" : "restart" });
    } catch (e) {
      setFontJob(null);
      onNotice(tx("글꼴을 설치하지 못했습니다: {0}", e instanceof Error ? e.message : String(e)));
    }
  };
  const isPreset = s.fontFamily === "" || FONT_PRESETS.includes(s.fontFamily);
  const [custom, setCustom] = useState(!isPreset);
  const missing = !custom && s.fontFamily !== "" && installed.get(s.fontFamily) === false ? s.fontFamily : null;
  const job = fontJob && fontJob.family === s.fontFamily ? fontJob : null;
  const [tab, setTab] = useState<SettingsTab>(lastTab);
  const [lang, setLang] = useState<Language>(savedLanguage);
  const pick = (next: SettingsTab) => {
    lastTab = next;
    setTab(next);
  };

  const seg = <T extends string | number>(label: string, value: T, options: [T, string][], onPick: (v: T) => void) => (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} aria-pressed={value === v} onClick={() => onPick(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-labelledby="st-title">
        <div className="dialog-head">
          <h2 id="st-title">{tx("설정")}</h2>
          <button className="icon-btn ghost" aria-label={tx("닫기")} onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="settings-layout">
          <SideTabs tabs={TABS} active={tab} onPick={pick} idPrefix="st-tab" panelId="st-panel" label={tx("설정 항목")} />

          {/* key: 항목을 바꾸면 스크롤이 맨 위에서 시작한다 */}
          <div key={tab} id="st-panel" className="dialog-body settings-panel" role="tabpanel" aria-labelledby={`st-tab-${tab}`}>
          {tab === "appearance" && (
            <>
              <section className="settings-section">
                <h3>{tx("테마")}</h3>
                {seg<ThemeName>(tx("색상 모드"), theme, [["light", tx("라이트")], ["dark", tx("다크")]], onTheme)}
                {seg<Language>(tx("언어"), lang, [["ko", "한국어"], ["en", "English"]], (next) => {
                  saveLanguage(next);
                  setLang(next);
                })}
                {lang !== language && <span className="hint">{tx("앱을 다시 켜면 적용됩니다.")}</span>}
              </section>

              <section className="settings-section">
                <h3>{tx("터미널 글꼴")}</h3>
                <div className="grid-font">
                  <label className="field">
                    <span>{tx("글꼴")}</span>
                    <Dropdown
                      value={custom ? CUSTOM : s.fontFamily}
                      options={[
                        { value: "", label: tx("기본 (Cascadia Mono / SF Mono)") },
                        ...FONT_PRESETS.map((f) => ({
                          value: f,
                          label: `${f}${
                            installed.get(f)
                              ? ""
                              : fontJob?.family === f && fontJob.phase === "restart"
                                ? tx(" — 설치함 · 다시 시작하면 적용")
                                : installable.includes(f)
                                  ? tx(" — 설치 안 됨 · 여기서 설치 가능")
                                  : tx(" — 설치 안 됨")
                          }`,
                        })),
                        { value: CUSTOM, label: tx("직접 입력…") },
                      ]}
                      onChange={(v) => {
                        if (v === CUSTOM) return setCustom(true);
                        setCustom(false);
                        updateSettings({ fontFamily: v });
                      }}
                    />
                  </label>
                  <div className="field">
                    <span className="field-label" id="fs-label">{tx("크기")}</span>
                    <div className="stepper" role="group" aria-labelledby="fs-label">
                      <button className="icon-btn" aria-label={tx("글자 작게")} disabled={s.fontSize <= FONT_SIZE.min} onClick={() => updateSettings({ fontSize: s.fontSize - 1 })}>
                        −
                      </button>
                      <input
                        className="input mono"
                        inputMode="numeric"
                        aria-label={tx("글자 크기")}
                        value={s.fontSize}
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/\D/g, ""));
                          if (n) updateSettings({ fontSize: n });
                        }}
                      />
                      <button className="icon-btn" aria-label={tx("글자 크게")} disabled={s.fontSize >= FONT_SIZE.max} onClick={() => updateSettings({ fontSize: s.fontSize + 1 })}>
                        +
                      </button>
                    </div>
                  </div>
                </div>
                {(missing || job) && (
                  <div className="font-missing" role="status">
                    {job?.phase === "done" ? (
                      <span>{tx("{0}을(를) 설치했습니다.", s.fontFamily)}</span>
                    ) : job?.phase === "restart" ? (
                      <>
                        <span>{tx("{0}을(를) 설치했습니다. SSHBook을 다시 시작하면 적용됩니다.", s.fontFamily)}</span>
                        <button className="btn" onClick={() => void relaunch()}>
                          {tx("다시 시작")}
                        </button>
                      </>
                    ) : installable.includes(s.fontFamily) ? (
                      <>
                        <span>{tx("{0}이(가) 이 PC에 없어 다른 글꼴로 보입니다. 무료 글꼴이라 바로 설치할 수 있습니다.", s.fontFamily)}</span>
                        <button className="btn primary" disabled={job?.phase === "busy"} onClick={() => void installFont(s.fontFamily)}>
                          {job?.phase === "busy" ? tx("설치하는 중…") : tx("설치하기")}
                        </button>
                      </>
                    ) : (
                      <span>{tx("{0}이(가) 이 PC에 없어 다른 글꼴로 보입니다.", s.fontFamily)}</span>
                    )}
                  </div>
                )}
                {custom && (
                  <label className="field">
                    <span>{tx("글꼴 이름")}</span>
                    <input className="input" autoFocus value={s.fontFamily} onChange={(e) => updateSettings({ fontFamily: e.target.value })} placeholder={tx("예: Hack, Ubuntu Mono")} />
                  </label>
                )}
                {seg(tx("줄 간격"), s.lineHeight, LINE_HEIGHTS.map((v) => [v, v.toFixed(1)] as [number, string]), (v) => updateSettings({ lineHeight: v }))}
                <div className="font-preview" style={{ fontFamily: fontStack(s.fontFamily), fontSize: s.fontSize, lineHeight: s.lineHeight }} aria-label={tx("미리보기")}>
                  <div>
                    <span className="p-user">deploy@prod-web-01</span>:<span className="p-path">~/app</span>$ ls -la
                  </div>
                  <div>{tx("drwxr-xr-x  5 deploy  staff  160  배포 로그 0O 1lI")}</div>
                </div>
              </section>

              <section className="settings-section">
                <h3>{tx("커서")}</h3>
                {seg<CursorStyle>(tx("모양"), s.cursorStyle, [["block", tx("블록 █")], ["bar", tx("막대 │")], ["underline", tx("밑줄 _")]], (v) => updateSettings({ cursorStyle: v }))}
                <label className="check">
                  <input type="checkbox" checked={s.cursorBlink} onChange={(e) => updateSettings({ cursorBlink: e.target.checked })} />
                  <span>{tx("커서 깜빡임")}</span>
                </label>
              </section>

              <section className="settings-section">
                <h3>{tx("그리기")}</h3>
                <label className="check">
                  <input type="checkbox" checked={s.gpuRender} onChange={(e) => updateSettings({ gpuRender: e.target.checked })} />
                  <span>
                    {tx("GPU로 그리기")}
                    <br />
                    <span className="hint">{tx("화면을 자주 다시 그리는 프로그램에서도 부드럽습니다. 글자가 깨지거나 번지면 끄세요.")}</span>
                  </span>
                </label>
              </section>
            </>
          )}
          {tab === "terminal" && (
            <>
              <section className="settings-section">
                <h3>{tx("동작")}</h3>
                <div className="field">
                  <span className="field-label">{tx("기본 로컬 셸")}</span>
                  <ShellInput
                    value={s.defaultShell}
                    onChange={(defaultShell) => updateSettings({ defaultShell })}
                    placeholder={tx("비우면 기본 셸 (Windows는 Git Bash, 없으면 PowerShell)")}
                    ariaLabel={tx("기본 로컬 셸")}
                  />
                  <span className="hint">{tx("세션 없이 여는 로컬 셸 탭에 씁니다. Windows는 Git Bash가 있으면 ls·grep 같은 리눅스 명령을 바로 쓰도록 Git Bash로 엽니다(Git for Windows에 들어 있음). 세션마다 다른 셸은 세션 편집 → 로컬 셸에서 정합니다.")}</span>
                </div>
                <label className="check">
                  <input type="checkbox" checked={s.copyOnSelect} onChange={(e) => updateSettings({ copyOnSelect: e.target.checked })} />
                  <span>
                    {tx("끌어서 고르면 바로 복사")}
                    <br />
                    <span className="hint">{tx("복사 단축키를 누르지 않아도 클립보드에 들어갑니다.")}</span>
                  </span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.allowAppCopy} onChange={(e) => updateSettings({ allowAppCopy: e.target.checked })} />
                  <span>
                    {tx("터미널 안 프로그램의 복사 허용")}
                    <br />
                    <span className="hint">{tx("Claude Code·tmux·vim 같은 프로그램이 고른 글자를 클립보드에 넣습니다(OSC 52). 마우스를 쓰는 프로그램에서 직접 고르려면 Shift(맥은 Option)를 누른 채 끌어서 고르세요.")}</span>
                  </span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.rightClickPaste} onChange={(e) => updateSettings({ rightClickPaste: e.target.checked })} />
                  <span>
                    {tx("오른쪽 클릭으로 붙여넣기")}
                    <br />
                    <span className="hint">{tx("PuTTY와 같은 방식입니다. 켜면 분할 메뉴는 Shift+오른쪽 클릭이나 창 머리의 ⋯ 버튼으로 엽니다.")}</span>
                  </span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.confirmClose} onChange={(e) => updateSettings({ confirmClose: e.target.checked })} />
                  <span>
                    {tx("연결된 창을 닫을 때 묻기")}
                    <br />
                    <span className="hint">{tx("닫기 확인에서 '다시 묻지 않음'을 골랐다면 여기서 다시 켭니다.")}</span>
                  </span>
                </label>
                <label className="field">
                  <span>{tx("스크롤 기록")}</span>
                  <Dropdown
                    value={s.scrollback}
                    options={[...SCROLLBACKS, ...(SCROLLBACKS.includes(s.scrollback) ? [] : [s.scrollback])].map((n) => ({ value: n, label: tx("{0}줄", n.toLocaleString("ko-KR")) }))}
                    onChange={(scrollback) => updateSettings({ scrollback })}
                  />
                </label>
              </section>
            </>
          )}
          {tab === "groups" && <GroupSettings groups={groups} sessions={sessions} onChanged={onGroupsChanged} onNotice={onNotice} />}
          {tab === "security" && (
            <>
              <section className="settings-section">
                <h3>{tx("보관함")}</h3>
                <div className="row-gap" style={{ alignItems: "center" }}>
                  <IconUnlock style={{ color: "var(--ok)", flex: "none" }} />
                  <span style={{ flex: 1, fontWeight: 500 }}>{passwordless ? tx("비밀번호 없이 사용 중") : tx("열려 있음")}</span>
                  <button className="btn" title={tx("다른 PC로 옮길 보관함 파일 내보내기")} onClick={() => (passwordless ? setSub("export") : onExport())}>
                    <IconExport width={14} height={14} />{" "}{tx("내보내기")}
                  </button>
                  {!passwordless && (
                    <button className="btn" onClick={onLock}>
                      {tx("잠그기")}
                    </button>
                  )}
                </div>
                <span className="hint">
                  {passwordless ? tx("앱을 켜면 이 PC의 열쇠 파일로 바로 열립니다. 내 계정으로 도는 프로그램도 읽을 수 있으니 FileVault를 켜 두세요.") : tx("잠그면 열린 연결도 모두 끊깁니다.")}
                </span>
              </section>

              <section className="settings-section">
                <h3>{tx("잠금과 비밀번호")}</h3>
                {!passwordless && (
                <label className="field">
                  <span>{tx("자동 잠금")}</span>
                  <Dropdown
                    value={s.autoLockMinutes}
                    options={AUTO_LOCK_CHOICES.map((m) => ({ value: m, label: m === 0 ? tx("잠그지 않음") : tx("{0}분 동안 입력이 없으면 잠금", m) }))}
                    onChange={(autoLockMinutes) => updateSettings({ autoLockMinutes })}
                  />
                  <span className="hint">{tx("잠그면 열린 연결도 모두 끊깁니다.")}</span>
                </label>
                )}
                <div className="row-gap">
                  {passwordless ? (
                    <button className="btn" onClick={() => setSub("enable")}>
                      {tx("마스터 비밀번호 켜기")}
                    </button>
                  ) : (
                    <>
                      <button className="btn" onClick={() => setSub("password")}>
                        {tx("마스터 비밀번호 바꾸기")}
                      </button>
                      <button className="btn" onClick={() => setSub("disable")}>
                        {tx("마스터 비밀번호 끄기")}
                      </button>
                    </>
                  )}
                  <button className="btn" onClick={() => setSub("hosts")}>
                    {tx("알려진 서버 관리")}
                  </button>
                </div>
              </section>
            </>
          )}
          {tab === "shortcuts" && (
            <>
              <section className="settings-section">
                <h3>{tx("단축키")}</h3>
                <dl className="shortcuts">
                  {SHORTCUTS.map(([what, key]) => (
                    <div key={what}>
                      <dt>{what}</dt>
                      <dd>{key}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </>
          )}
          {tab === "import" && (
            <>
              <section className="settings-section">
                <h3>~/.ssh/config</h3>
                <div className="row-gap" style={{ alignItems: "center" }}>
                  <span className="hint" style={{ flex: 1 }}>
                    {tx("쓰던 SSH 설정의 호스트를 골라 세션으로 만듭니다. 설정 파일은 바꾸지 않습니다.")}
                  </span>
                  <button className="btn" onClick={() => setSub("sshconfig")}>
                    {tx("가져오기")}
                  </button>
                </div>
              </section>
            </>
          )}
          {tab === "logs" && (
            <>
              <section className="settings-section">
                <h3>{tx("세션 기록·진단 로그")}</h3>
                <div className="row-gap" style={{ alignItems: "center" }}>
                  <span className="hint" style={{ flex: 1 }}>
                    {tx("세션 편집 → 고급에서 '출력 기록 저장'을 켠 세션의 출력과, 연결 실패 같은 오류 원인(sshbook-app.log)이 이 폴더에 남습니다. 비밀번호는 남기지 않습니다.")}
                  </span>
                  <button className="btn" onClick={onOpenLogs}>
                    {tx("기록 폴더 열기")}
                  </button>
                </div>
              </section>
            </>
          )}
          {tab === "update" && (
            <>
              <UpdateSection />
            </>
          )}
          </div>
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={() => { resetSettings(); setCustom(false); }}>
            {tx("기본값으로 되돌리기")}
          </button>
          <span className="spacer" />
          <span className="hint">{tx("바꾸는 즉시 적용됩니다")}</span>
          <button className="btn primary" onClick={onClose}>
            {tx("닫기")}
          </button>
        </div>
      </div>
      {sub === "password" && (
        <ChangePasswordDialog
          onClose={() => setSub(null)}
          onDone={(m) => {
            setSub(null);
            onNotice(m);
          }}
        />
      )}
      {sub === "hosts" && <KnownHostsDialog onClose={() => setSub(null)} />}
      {sub === "sshconfig" && (
        <ImportSshConfigDialog
          sessions={sessions}
          onClose={() => setSub(null)}
          onImported={async (m) => {
            await onVaultChanged();
            onNotice(m);
          }}
        />
      )}
      {(sub === "disable" || sub === "enable" || sub === "export") && (
        <PasswordModeDialog
          mode={sub}
          onClose={() => setSub(null)}
          onDone={async (pw) => {
            setSub(null);
            if (sub === "export") return onExport(pw);
            await onVaultChanged();
            onNotice(sub === "disable" ? tx("마스터 비밀번호를 껐습니다. 다음부터 바로 열립니다.") : tx("마스터 비밀번호를 켰습니다."));
          }}
        />
      )}
    </div>
  );
}

/** 지금 버전과 업데이트 확인 */
function UpdateSection() {
  const [version, setVersion] = useState("");
  const st = useUpdateState();
  useEffect(() => void appVersion().then(setVersion), []);

  const busy = st.phase === "checking" || st.phase === "downloading" || st.phase === "installing";
  const status =
    st.phase === "checking" ? tx("확인하는 중…")
    : st.phase === "latest" ? tx("최신 버전입니다.")
    : st.phase === "available" ? tx("새 버전 v{0}이 있습니다.", st.version)
    : st.phase === "downloading" ? tx("v{0} 내려받는 중{1}", st.version, st.percent !== null ? ` · ${st.percent}%` : "…")
    : st.phase === "installing" ? tx("설치 중… 곧 다시 시작합니다.")
    : st.phase === "error" ? st.message
    : "";

  return (
    <section className="settings-section">
      <h3>{tx("업데이트")}</h3>
      <div className="row-gap" style={{ alignItems: "center" }}>
        <span style={{ flex: 1 }}>
          {tx("지금 버전")}{" "}<b style={{ fontFamily: "var(--mono)" }}>{version && version !== tx("미리보기") ? `v${version}` : version}</b>
        </span>
        {st.phase === "available" ? (
          <button className="btn primary" onClick={() => void installUpdate()}>
            {tx("지금 업데이트")}
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => void checkForUpdate(true)}>
            {tx("업데이트 확인")}
          </button>
        )}
      </div>
      {status && (
        <p className="hint" role="status" style={st.phase === "error" ? { color: "var(--danger)" } : undefined}>
          {status}
        </p>
      )}
      <p className="hint">{tx("새 버전은 GitHub 릴리스에서 받습니다. 앱을 켤 때도 자동으로 확인합니다.")}</p>
    </section>
  );
}
