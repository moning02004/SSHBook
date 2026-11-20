import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmClose } from "./components/ConfirmClose";
import { SettingsDialog, useSettings } from "./components/SettingsDialog";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { IconClose, IconExpand, IconMoon, IconPlus, IconPrompt, IconSettings, IconShrink, IconSidebar, IconSplit, IconSun } from "./components/Icons";
import { SessionEditor } from "./components/SessionEditor";
import { Sidebar } from "./components/Sidebar";
import { VaultScreen } from "./components/VaultScreen";
import { Workspace, type PaneInfo, type Tab } from "./components/Workspace";
import { api, errorText, inTauri, type SecretInput, type VaultStatus } from "./lib/api";
import { loadFlag, saveFlag, SIDEBAR_HIDDEN } from "./lib/prefs";
import { bumpFontSize, DEFAULT_SETTINGS, updateSettings } from "./lib/settings";
import { pickExportPath } from "./lib/dialogs";
import { closePane, isSplit, pane, paneIds, splitPane, splitQuad, unsplit, type SplitDir } from "./lib/layout";
import { describeSession, type Session } from "./lib/sessions";
import * as terms from "./lib/terminals";
import { applyTheme, loadTheme, type ThemeName } from "./lib/theme";

const MAX_PANES = 8;
const newId = () => crypto.randomUUID();
const isMac = navigator.platform.toLowerCase().includes("mac");

/** 앱 단축키. 터미널 입력으로 넘기지 않는다. */
function shortcutOf(e: KeyboardEvent): string | null {
  if (e.type !== "keydown") return null;
  if (e.key === "F11") return "fullscreen";
  if (e.altKey && e.shiftKey && e.key === "ArrowRight") return "split-row";
  if (e.altKey && e.shiftKey && e.key === "ArrowDown") return "split-column";
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey) {
    switch (e.key) {
      case "=":
      case "+": return "font-up";
      case "-": return "font-down";
      case "0": return "font-reset";
      case ",": return "settings";
    }
  }
  if (!mod || !e.shiftKey) return null;
  switch (e.key.toUpperCase()) {
    case "Z": return "zoom";
    case "W": return "close";
    case "C": return "copy";
    case "V": return "paste";
    case "K": return "clear";
    case "B": return "sidebar";
  }
  return null;
}
const K = isMac ? "⌘⇧" : "Ctrl+Shift+";

export function App() {
  const [theme, setTheme] = useState<ThemeName>(loadTheme);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [panes, setPanes] = useState<Record<string, PaneInfo>>({});
  const [menu, setMenu] = useState<{ paneId: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ session: Session | null } | null>(null);
  const [notice, setNotice] = useState("");
  const [sidebarHidden, setSidebarHidden] = useState(() => loadFlag(SIDEBAR_HIDDEN, false));
  const settings = useSettings();
  const askOnClose = settings.confirmClose;
  const [showSettings, setShowSettings] = useState(false);
  const [confirm, setConfirm] = useState<{ names: string[]; run: () => void } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const toggleSidebar = () =>
    setSidebarHidden((v) => {
      saveFlag(SIDEBAR_HIDDEN, !v);
      return !v;
    });

  const toggleFullscreen = async () => {
    if (!inTauri) return;
    const w = getCurrentWindow();
    const next = !(await w.isFullscreen());
    await w.setFullscreen(next);
    setFullscreen(next);
  };

  useEffect(() => {
    applyTheme(theme);
    terms.setTerminalTheme(theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    const st = await api.vaultStatus();
    setStatus(st);
    if (st.unlocked) setSessions(await api.sessionsList());
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const tabOf = (paneId: string) => tabs.find((t) => paneIds(t.root).includes(paneId)) ?? null;
  const updateTab = (tabId: string, fn: (t: Tab) => Tab) => setTabs((all) => all.map((t) => (t.id === tabId ? fn(t) : t)));

  const infoFor = (sessionId: string | null): PaneInfo => {
    const s = sessions.find((x) => x.id === sessionId);
    return s ? { sessionId: s.id, title: s.name, sub: describeSession(s) } : { sessionId: null, title: "로컬 셸", sub: "기본 셸" };
  };

  // ---- 탭과 창 조작 ----

  const openTab = (sessionId: string | null) => {
    const paneId = newId();
    const tab: Tab = { id: newId(), root: pane(paneId), activePane: paneId, zoomed: null };
    setPanes((p) => ({ ...p, [paneId]: infoFor(sessionId) }));
    setTabs((all) => [...all, tab]);
    setActiveTabId(tab.id);
  };

  /** 새 창은 같은 세션으로 새로 연결한다(같은 서버에 창 하나 더). */
  const clonePanes = (fromPaneId: string, count: number) => {
    const ids = Array.from({ length: count }, newId);
    setPanes((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, p[fromPaneId]])) }));
    return ids;
  };

  const doSplit = (paneId: string, dir: SplitDir) => {
    const tab = tabOf(paneId);
    if (!tab || paneIds(tab.root).length >= MAX_PANES) return;
    const [id] = clonePanes(paneId, 1);
    updateTab(tab.id, (t) => ({ ...t, root: splitPane(t.root, paneId, dir, id), activePane: id, zoomed: null }));
  };

  const doQuad = (paneId: string) => {
    const tab = tabOf(paneId);
    if (!tab || isSplit(tab.root)) return;
    const ids = clonePanes(paneId, 3) as [string, string, string];
    updateTab(tab.id, (t) => ({ ...t, root: splitQuad(t.root, paneId, ids), zoomed: null }));
  };

  const doZoom = (paneId: string) => {
    const tab = tabOf(paneId);
    if (!tab || !isSplit(tab.root)) return;
    updateTab(tab.id, (t) => ({ ...t, zoomed: t.zoomed ? null : paneId, activePane: paneId }));
  };

  /** 분할 해제: 이 창만 남기고, 나머지 창은 연결을 유지한 채 새 탭으로 옮긴다. */
  const doUnsplit = (paneId: string) => {
    const tab = tabOf(paneId);
    if (!tab) return;
    const { root, detached } = unsplit(tab.root, paneId);
    const moved: Tab[] = detached.map((id) => ({ id: newId(), root: pane(id), activePane: id, zoomed: null }));
    setTabs((all) => {
      const i = all.findIndex((t) => t.id === tab.id);
      const next = [...all];
      next.splice(i, 1, { ...tab, root, activePane: paneId, zoomed: null }, ...moved);
      return next;
    });
  };

  /** 연결된 창이 있으면 닫기 전에 묻는다('다시 묻지 않음'을 고르면 그다음부터는 바로 닫는다). */
  const requestClose = (ids: string[], run: () => void) => {
    const live = ids.filter(terms.isLive);
    if (!askOnClose || live.length === 0) return run();
    setConfirm({ names: [...new Set(live.map((id) => panes[id]?.title ?? "터미널"))], run });
  };

  const doClosePane = (paneId: string) => requestClose([paneId], () => reallyClosePane(paneId));

  const reallyClosePane = (paneId: string) => {
    const tab = tabOf(paneId);
    if (!tab) return;
    const root = closePane(tab.root, paneId);
    void terms.disposePane(paneId);
    setPanes(({ [paneId]: _, ...rest }) => rest);
    if (!root) return removeTab(tab.id);
    updateTab(tab.id, (t) => ({ ...t, root, activePane: paneIds(root)[0], zoomed: null }));
  };

  const removeTab = (tabId: string) => {
    const i = tabs.findIndex((t) => t.id === tabId);
    const next = tabs.filter((t) => t.id !== tabId);
    setTabs(next);
    if (tabId === activeTabId) setActiveTabId(next[Math.min(i, next.length - 1)]?.id ?? null);
  };

  const closeTab = (tab: Tab) => requestClose(paneIds(tab.root), () => reallyCloseTab(tab));

  const reallyCloseTab = (tab: Tab) => {
    const ids = paneIds(tab.root);
    ids.forEach((id) => void terms.disposePane(id));
    setPanes((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !ids.includes(id))));
    removeTab(tab.id);
  };

  const run = (action: string, paneId: string) => {
    switch (action) {
      case "split-row": return doSplit(paneId, "row");
      case "split-column": return doSplit(paneId, "column");
      case "zoom": return doZoom(paneId);
      case "close": return doClosePane(paneId);
      case "copy": return terms.copySelection(paneId);
      case "paste": return void terms.pasteInto(paneId);
      case "clear": return terms.clearPane(paneId);
    }
  };

  // 단축키: xterm이 먹지 않게 걸러내고, 창(window)에서 처리한다.
  useEffect(() => {
    terms.setShortcutFilter((e) => shortcutOf(e) !== null);
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutOf(e);
      switch (action) {
        case "sidebar": e.preventDefault(); return toggleSidebar();
        case "fullscreen": e.preventDefault(); return void toggleFullscreen();
        case "settings": e.preventDefault(); return setShowSettings(true);
        case "font-up": e.preventDefault(); return bumpFontSize(1);
        case "font-down": e.preventDefault(); return bumpFontSize(-1);
        case "font-reset": e.preventDefault(); return updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
      }
      if (!action || !activeTab || confirm || editing) return;
      e.preventDefault();
      run(action, activeTab.activePane);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const menuItems = (paneId: string): MenuItem[] => {
    const tab = tabOf(paneId);
    const split = !!tab && isSplit(tab.root);
    const full = !!tab && paneIds(tab.root).length >= MAX_PANES;
    return [
      { label: "오른쪽으로 분할", shortcut: "Alt+Shift+→", disabled: full, onSelect: () => doSplit(paneId, "row") },
      { label: "아래로 분할", shortcut: "Alt+Shift+↓", disabled: full, onSelect: () => doSplit(paneId, "column") },
      { label: "4분할로 나누기", disabled: split, onSelect: () => doQuad(paneId) },
      "separator",
      { label: tab?.zoomed ? "분할 화면으로 돌아가기" : "이 창만 크게 보기", shortcut: `${K}Z`, disabled: !split, onSelect: () => doZoom(paneId) },
      { label: "분할 해제 · 나머지는 새 탭으로", disabled: !split, onSelect: () => doUnsplit(paneId) },
      "separator",
      { label: "복사", shortcut: `${K}C`, onSelect: () => terms.copySelection(paneId) },
      { label: "붙여넣기", shortcut: `${K}V`, onSelect: () => void terms.pasteInto(paneId) },
      { label: "화면 지우기", shortcut: `${K}K`, onSelect: () => terms.clearPane(paneId) },
      "separator",
      { label: "창 닫기", shortcut: `${K}W`, danger: true, onSelect: () => doClosePane(paneId) },
    ];
  };

  // Ctrl(⌘)+마우스 휠로 글자 크기 조절
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.deltaY === 0) return;
      e.preventDefault();
      bumpFontSize(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  // 앱 창을 닫을 때도 연결된 세션이 있으면 묻는다.
  const closeGuard = useRef({ ask: askOnClose, panes });
  closeGuard.current = { ask: askOnClose, panes };
  useEffect(() => {
    if (!inTauri) return;
    const w = getCurrentWindow();
    const un = w.onCloseRequested((e) => {
      const { ask, panes: all } = closeGuard.current;
      const live = Object.keys(all).filter(terms.isLive);
      if (!ask || live.length === 0) return;
      e.preventDefault();
      setConfirm({ names: [...new Set(live.map((id) => all[id]?.title ?? "터미널"))], run: () => void w.destroy() });
    });
    return () => void un.then((f) => f());
  }, []);

  // ---- 세션과 보관함 ----

  const groups = useMemo(() => [...new Set(sessions.map((s) => s.group?.trim()).filter((g): g is string => !!g))], [sessions]);
  const connected = useMemo(() => new Set(Object.values(panes).map((p) => p.sessionId).filter((x): x is string => !!x)), [panes]);

  const saveSession = async (s: Session, secret: SecretInput) => {
    await api.sessionSave(s, secret);
    setSessions(await api.sessionsList());
    setEditing(null);
  };

  const deleteSession = async (s: Session) => {
    if (!window.confirm(`'${s.name}' 세션을 지울까요? 보관함에 저장된 비밀번호와 키도 함께 지워집니다.`)) return;
    await api.sessionDelete(s.id);
    setSessions(await api.sessionsList());
    setEditing(null);
  };

  const lock = () => requestClose(Object.keys(panes), () => void reallyLock());

  const reallyLock = async () => {
    await terms.disposeAll();
    setTabs([]);
    setPanes({});
    setActiveTabId(null);
    await api.vaultLock();
    await refresh();
  };

  const exportVault = async () => {
    try {
      const dest = await pickExportPath();
      if (!dest) return;
      await api.vaultExport(dest);
      setNotice(`보관함 파일을 내보냈습니다: ${dest}`);
    } catch (e) {
      setNotice(`내보내지 못했습니다: ${errorText(e)}`);
    }
  };

  // ---- 화면 ----

  if (!status) return null;
  if (!status.unlocked) return <VaultScreen status={status} onOpened={refresh} />;

  const activeInfo = activeTab ? panes[activeTab.activePane] : null;
  const hint = !activeTab
    ? ""
    : activeTab.zoomed
      ? `확대 중 — ${K}Z로 돌아가기`
      : isSplit(activeTab.root)
        ? `${paneIds(activeTab.root).length}개 창 · 오른쪽 클릭으로 분할 해제`
        : "오른쪽 클릭으로 창 분할";

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-btn ghost"
          aria-pressed={!sidebarHidden}
          aria-label={sidebarHidden ? "사이드바 펼치기" : "사이드바 접기"}
          title={`${sidebarHidden ? "사이드바 펼치기" : "사이드바 접기"} (${K}B)`}
          onClick={toggleSidebar}
        >
          <IconSidebar />
        </button>
        <div className="brand">
          <IconPrompt width={18} height={18} style={{ color: "var(--accent)" }} />
          SSHBook
        </div>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" aria-label="설정" title={`설정 (${isMac ? "⌘" : "Ctrl+"},)`} onClick={() => setShowSettings(true)}>
          <IconSettings />
        </button>
        <button
          className="icon-btn"
          aria-label={theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환"}
          title={theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환"}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? <IconMoon /> : <IconSun />}
        </button>
      </header>

      <div className="body">
        {!sidebarHidden && (
          <Sidebar
            sessions={sessions}
            connected={connected}
            selectedId={activeInfo?.sessionId ?? null}
            onOpen={(s) => openTab(s.id)}
            onEdit={(s) => setEditing({ session: s })}
            onNew={() => setEditing({ session: null })}
            onLock={lock}
            onExport={exportVault}
          />
        )}

        <main className="main">
          <nav className="tabnav" aria-label="열린 세션">
            <div role="tablist" style={{ display: "contents" }}>
              {tabs.map((t) => (
                <div key={t.id} className={`tab${t.id === activeTabId ? " selected" : ""}`}>
                  <button
                    role="tab"
                    aria-selected={t.id === activeTabId}
                    className="tab-label"
                    title={panes[t.activePane]?.sub}
                    onClick={() => setActiveTabId(t.id)}
                  >
                    {isSplit(t.root) ? <IconSplit width={13} height={13} /> : <IconPrompt width={13} height={13} />}
                    <span className="t">{panes[t.activePane]?.title ?? "터미널"}</span>
                  </button>
                  <button className="close" aria-label="탭 닫기" title="탭 닫기" onClick={() => closeTab(t)}>
                    <IconClose width={12} height={12} />
                  </button>
                </div>
              ))}
            </div>
            <button className="icon-btn ghost new-tab" aria-label="새 탭 (로컬 셸)" title="새 탭 (로컬 셸)" onClick={() => openTab(null)}>
              <IconPlus width={14} height={14} />
            </button>
            <span className="spacer" />
            {inTauri && (
              <button
                className="icon-btn ghost tool"
                aria-label={fullscreen ? "전체 화면 끝내기" : "전체 화면"}
                title={`${fullscreen ? "전체 화면 끝내기" : "전체 화면"} (F11)`}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <IconShrink width={14} height={14} /> : <IconExpand width={14} height={14} />}
              </button>
            )}
          </nav>

          {activeTab ? (
            <Workspace
              tab={activeTab}
              panes={panes}
              onActivate={(id) => activeTab.activePane !== id && updateTab(activeTab.id, (t) => ({ ...t, activePane: id }))}
              onMenu={(paneId, x, y) => setMenu({ paneId, x, y })}
              rightClickPaste={settings.rightClickPaste}
              onUnzoom={() => updateTab(activeTab.id, (t) => ({ ...t, zoomed: null }))}
            />
          ) : (
            <div className="welcome">
              <p>{sidebarHidden ? "위의 + 로 로컬 셸을 열거나, 사이드바를 펼쳐 세션을 고르세요." : "왼쪽에서 세션을 고르거나 + 로 로컬 셸을 여세요."}</p>
              <button className="btn" onClick={() => openTab(null)}>
                <IconPrompt width={14} height={14} /> 로컬 셸 열기
              </button>
            </div>
          )}

          <footer className="statusbar">
            <span>{activeInfo ? `${activeInfo.title} · ${activeInfo.sub}` : "연결 없음"}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{notice}</span>
            <span>{hint}</span>
          </footer>
        </main>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.paneId)} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmClose
          names={confirm.names}
          onCancel={() => setConfirm(null)}
          onConfirm={(dontAsk) => {
            if (dontAsk) updateSettings({ confirmClose: false });
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
        />
      )}
      {showSettings && <SettingsDialog theme={theme} onTheme={setTheme} onClose={() => setShowSettings(false)} />}
      {editing && (
        <SessionEditor
          initial={editing.session}
          groups={groups}
          onSave={saveSession}
          onDelete={deleteSession}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
