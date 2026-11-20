import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  type CursorStyle,
} from "../lib/settings";
import type { ThemeName } from "../lib/theme";
import { appVersion, checkForUpdate, installUpdate, useUpdateState } from "../lib/updater";
import { IconClose } from "./Icons";

export function useSettings() {
  return useSyncExternalStore(subscribeSettings, getSettings);
}

interface Props {
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  onClose: () => void;
}

const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";
const K = isMac ? "⌘⇧" : "Ctrl+Shift+";

const SHORTCUTS: [string, string][] = [
  ["호스트 목록", isMac ? "⌘D" : "Alt+D"],
  ["끊긴 창 다시 연결", isMac ? "⌘R" : "Ctrl+R"],
  ["설정 열기", `${MOD},`],
  ["글자 크게 / 작게 / 원래대로", `${MOD}= / ${MOD}- / ${MOD}0`],
  ["사이드바 접기·펼치기", `${K}B`],
  ["전체 화면", "F11"],
  ["오른쪽 / 아래로 분할", "Alt+Shift+→ / ↓"],
  ["이 창만 크게 보기", `${K}Z`],
  ["복사 / 붙여넣기", `${K}C / ${K}V`],
  ["화면 지우기", `${K}K`],
  ...(isMac ? ([["탭 닫기 (탭이 없으면 창 닫기)", "⌘W"]] as [string, string][]) : []),
  ["창 닫기", `${K}W`],
];

const CUSTOM = "__custom__";

/** 설정 화면. 바꾸는 즉시 열린 터미널에 적용되고 이 PC에 저장된다. */
export function SettingsDialog({ theme, onTheme, onClose }: Props) {
  const s = useSettings();
  const installed = useMemo(() => new Map(FONT_PRESETS.map((f) => [f, isFontInstalled(f)])), []);
  const isPreset = s.fontFamily === "" || FONT_PRESETS.includes(s.fontFamily);
  const [custom, setCustom] = useState(!isPreset);

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
      <div className="dialog wide" role="dialog" aria-labelledby="st-title" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-head">
          <h2 id="st-title">설정</h2>
          <button className="icon-btn ghost" aria-label="닫기" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="dialog-body">
          <section className="settings-section">
            <h3>터미널 글꼴</h3>
            <div className="grid-font">
              <label className="field">
                <span>글꼴</span>
                <select
                  className="input"
                  value={custom ? CUSTOM : s.fontFamily}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM) return setCustom(true);
                    setCustom(false);
                    updateSettings({ fontFamily: e.target.value });
                  }}
                >
                  <option value="">기본 (Cascadia Mono / SF Mono)</option>
                  {FONT_PRESETS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                      {installed.get(f) ? "" : " — 설치 안 됨"}
                    </option>
                  ))}
                  <option value={CUSTOM}>직접 입력…</option>
                </select>
              </label>
              <div className="field">
                <span className="field-label" id="fs-label">크기</span>
                <div className="stepper" role="group" aria-labelledby="fs-label">
                  <button className="icon-btn" aria-label="글자 작게" disabled={s.fontSize <= FONT_SIZE.min} onClick={() => updateSettings({ fontSize: s.fontSize - 1 })}>
                    −
                  </button>
                  <input
                    className="input mono"
                    inputMode="numeric"
                    aria-label="글자 크기"
                    value={s.fontSize}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/\D/g, ""));
                      if (n) updateSettings({ fontSize: n });
                    }}
                  />
                  <button className="icon-btn" aria-label="글자 크게" disabled={s.fontSize >= FONT_SIZE.max} onClick={() => updateSettings({ fontSize: s.fontSize + 1 })}>
                    +
                  </button>
                </div>
              </div>
            </div>
            {custom && (
              <label className="field">
                <span>글꼴 이름</span>
                <input className="input" autoFocus value={s.fontFamily} onChange={(e) => updateSettings({ fontFamily: e.target.value })} placeholder="예: Hack, Ubuntu Mono" />
              </label>
            )}
            {seg("줄 간격", s.lineHeight, LINE_HEIGHTS.map((v) => [v, v.toFixed(1)] as [number, string]), (v) => updateSettings({ lineHeight: v }))}
            <div className="font-preview" style={{ fontFamily: fontStack(s.fontFamily), fontSize: s.fontSize, lineHeight: s.lineHeight }} aria-label="미리보기">
              <div>
                <span className="p-user">deploy@prod-web-01</span>:<span className="p-path">~/app</span>$ ls -la
              </div>
              <div>drwxr-xr-x  5 deploy  staff  160  배포 로그 0O 1lI</div>
            </div>
          </section>

          <section className="settings-section">
            <h3>커서</h3>
            {seg<CursorStyle>("모양", s.cursorStyle, [["block", "블록 █"], ["bar", "막대 │"], ["underline", "밑줄 _"]], (v) => updateSettings({ cursorStyle: v }))}
            <label className="check">
              <input type="checkbox" checked={s.cursorBlink} onChange={(e) => updateSettings({ cursorBlink: e.target.checked })} />
              <span>커서 깜빡임</span>
            </label>
          </section>

          <section className="settings-section">
            <h3>동작</h3>
            <label className="check">
              <input type="checkbox" checked={s.copyOnSelect} onChange={(e) => updateSettings({ copyOnSelect: e.target.checked })} />
              <span>
                끌어서 고르면 바로 복사
                <br />
                <span className="hint">복사 단축키를 누르지 않아도 클립보드에 들어갑니다.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={s.rightClickPaste} onChange={(e) => updateSettings({ rightClickPaste: e.target.checked })} />
              <span>
                오른쪽 클릭으로 붙여넣기
                <br />
                <span className="hint">PuTTY와 같은 방식입니다. 켜면 분할 메뉴는 Shift+오른쪽 클릭이나 창 머리의 ⋯ 버튼으로 엽니다.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={s.confirmClose} onChange={(e) => updateSettings({ confirmClose: e.target.checked })} />
              <span>
                연결된 창을 닫을 때 묻기
                <br />
                <span className="hint">닫기 확인에서 '다시 묻지 않음'을 골랐다면 여기서 다시 켭니다.</span>
              </span>
            </label>
            <label className="field">
              <span>스크롤 기록</span>
              <select className="input" value={s.scrollback} onChange={(e) => updateSettings({ scrollback: Number(e.target.value) })}>
                {SCROLLBACKS.map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString("ko-KR")}줄
                  </option>
                ))}
                {!SCROLLBACKS.includes(s.scrollback) && <option value={s.scrollback}>{s.scrollback.toLocaleString("ko-KR")}줄</option>}
              </select>
            </label>
          </section>

          <section className="settings-section">
            <h3>화면</h3>
            {seg<ThemeName>("테마", theme, [["light", "라이트"], ["dark", "다크"]], onTheme)}
          </section>

          <UpdateSection />

          <section className="settings-section">
            <h3>단축키</h3>
            <dl className="shortcuts">
              {SHORTCUTS.map(([what, key]) => (
                <div key={what}>
                  <dt>{what}</dt>
                  <dd>{key}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={() => { resetSettings(); setCustom(false); }}>
            기본값으로 되돌리기
          </button>
          <span className="spacer" />
          <span className="hint">바꾸는 즉시 적용됩니다</span>
          <button className="btn primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
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
    st.phase === "checking" ? "확인하는 중…"
    : st.phase === "latest" ? "최신 버전입니다."
    : st.phase === "available" ? `새 버전 v${st.version}이 있습니다.`
    : st.phase === "downloading" ? `v${st.version} 내려받는 중${st.percent !== null ? ` · ${st.percent}%` : "…"}`
    : st.phase === "installing" ? "설치 중… 곧 다시 시작합니다."
    : st.phase === "error" ? st.message
    : "";

  return (
    <section className="settings-section">
      <h3>업데이트</h3>
      <div className="row-gap" style={{ alignItems: "center" }}>
        <span style={{ flex: 1 }}>
          지금 버전 <b style={{ fontFamily: "var(--mono)" }}>{version && version !== "미리보기" ? `v${version}` : version}</b>
        </span>
        {st.phase === "available" ? (
          <button className="btn primary" onClick={() => void installUpdate()}>
            지금 업데이트
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => void checkForUpdate(true)}>
            업데이트 확인
          </button>
        )}
      </div>
      {status && (
        <p className="hint" role="status" style={st.phase === "error" ? { color: "var(--danger)" } : undefined}>
          {status}
        </p>
      )}
      <p className="hint">새 버전은 GitHub 릴리스에서 받습니다. 앱을 켤 때도 자동으로 확인합니다.</p>
    </section>
  );
}
