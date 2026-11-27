import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { ConfirmClose } from "./components/ConfirmClose";
import { SettingsDialog, useSettings } from "./components/SettingsDialog";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { IconCopy, IconEdit, IconExpand, IconMoon, IconPlus, IconPrompt, IconSettings, IconShrink, IconSidebar, IconSun, IconTarget, IconTrash } from "./components/Icons";
import { HostPicker } from "./components/HostPicker";
import { SessionEditor } from "./components/SessionEditor";
import { SnippetsDialog } from "./components/SnippetsDialog";
import { UpdateNotice } from "./components/UpdateNotice";
import { checkForUpdate } from "./lib/updater";
import { Sidebar } from "./components/Sidebar";
import { Splash } from "./components/Splash";
import { VaultScreen } from "./components/VaultScreen";
import { tabTitle, Workspace, type PaneInfo } from "./components/Workspace";
import { api, errorText, inTauri, type SecretInput, type VaultStatus } from "./lib/api";
import { loadFlag, saveFlag, SIDEBAR_HIDDEN } from "./lib/prefs";
import { bumpFontSize, DEFAULT_SETTINGS, updateSettings } from "./lib/settings";
import { pickExportPath } from "./lib/dialogs";
import { sideAt, type DropSide, type SplitDir } from "./lib/layout";
import * as desks from "./lib/groups";
import { emptyDesk, type Desk, type TabDrop } from "./lib/groups";
import { describeSession, type Group, type Session, type SidebarLayout, type Snippet } from "./lib/sessions";
import * as terms from "./lib/terminals";
import { applyTheme, loadTheme, type ThemeName } from "./lib/theme";
import { tx } from "./lib/i18n";

const MAX_PANES = 8;
const newId = () => crypto.randomUUID();
const isMac = navigator.platform.toLowerCase().includes("mac");

/** 앱 단축키. 터미널 입력으로 넘기지 않는다. */
function shortcutOf(e: KeyboardEvent): string | null {
  if (e.type !== "keydown") return null;
  if (e.key === "F11") return "fullscreen";
  // 호스트 목록: 맥은 ⌘D, 그 밖은 Alt+D. 셸의 Ctrl+D(EOF)와 겹치지 않게 한다.
  // 한글 입력 상태에서도 동작하도록 물리 키로 본다.
  if (e.code === "KeyD" && !e.shiftKey && !e.ctrlKey && (isMac ? e.metaKey && !e.altKey : e.altKey && !e.metaKey)) return "hosts";
  // 찾기: 맥은 ⌘F. 그 밖은 Ctrl+F가 셸 단축키(앞으로 한 글자)라서 Ctrl+Shift+F만 쓴다.
  if (isMac && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === "KeyF") return "search";
  // 탭 넘기기: Ctrl+Tab / Ctrl+Shift+Tab (맥·Windows 같음)
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") return e.shiftKey ? "tab-prev" : "tab-next";
  // n번째 탭: 맥 ⌘1~9, Windows Alt+1~9 (9는 마지막 탭)
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
  if (digit && !e.shiftKey && !e.ctrlKey && (isMac ? e.metaKey && !e.altKey : e.altKey && !e.metaKey)) return `tab-${digit}`;
  // 칸 이동: 맥 ⌘⌥방향키, Windows Ctrl+Alt+방향키
  const arrow = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key];
  if (arrow && !e.shiftKey && e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return `focus-${arrow}`;
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
    case "F": return "search";
    case "I": return "broadcast";
    case "S": return "snippets";
    case "O": return "sftp";
  }
  return null;
}

/**
 * 끊긴 창 다시 연결.
 * 맥은 ⌘R: 셸과 겹치지 않으니 늘 가로챈다(연결된 창에서는 아무 일도 하지 않고, 페이지 새로고침도 막는다).
 * 그 밖은 Ctrl+R: 셸의 기록 검색과 겹치므로 연결된 창에서는 셸로 보낸다.
 * activeLive: 지금 고른 창이 연결돼 있는지(창이 없으면 false)
 */
function reconnectShortcutOf(e: KeyboardEvent, activeLive: boolean): string | null {
  if (e.type !== "keydown" || e.code !== "KeyR" || e.shiftKey || e.altKey) return null;
  if (isMac) return e.metaKey && !e.ctrlKey ? "reconnect" : null;
  return e.ctrlKey && !e.metaKey && !activeLive ? "reconnect" : null;
}
const K = isMac ? "⌘⇧" : "Ctrl+Shift+";

/** 끌고 있는 탭과 놓을 자리 */
type DropTarget = (TabDrop & { center?: boolean }) | null;
interface DragState {
  paneId: string;
  label: string;
  x: number;
  y: number;
  /** 잡은 지점이 탭 안에서 어디였는지. 끄는 동안 그 지점이 커서 아래에 머문다. */
  grab: { dx: number; dy: number; width: number };
  target: DropTarget;
}
const SIDE_LABEL: Record<DropSide, string> = { left: tx("왼쪽에 분할"), right: tx("오른쪽에 분할"), top: tx("위에 분할"), bottom: tx("아래에 분할") };
/** 이만큼 움직여야 끌기로 본다(그 전에는 그냥 클릭) */
const DRAG_START_PX = 5;

export function App() {
  const [theme, setTheme] = useState<ThemeName>(loadTheme);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  /** 미리 만든 그룹과 그룹 색. 세션 목록이 바뀔 때마다 다시 읽는다. */
  const [groupInfos, setGroupInfos] = useState<Group[]>([]);
  // 사이드바를 끌어서 정한 순서로 보여 주는지(아니면 가나다순)
  const [sidebarManual, setSidebarManual] = useState(false);
  // 분할된 칸들과 칸마다의 탭(파이참 에디터 분할처럼)
  const [desk, setDesk] = useState<Desk>(emptyDesk);
  const [panes, setPanes] = useState<Record<string, PaneInfo>>({});
  /** tab: 탭을 오른쪽 클릭, pane: 터미널을 오른쪽 클릭 */
  const [menu, setMenu] = useState<
  | { x: number; y: number; paneId: string; kind: "tab" | "pane" }
  | { x: number; y: number; session: Session; kind: "session" }
  | null
>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState<{ session: Session | null } | null>(null);
  const [notice, setNotice] = useState("");
  const [sidebarHidden, setSidebarHidden] = useState(() => loadFlag(SIDEBAR_HIDDEN, false));
  const settings = useSettings();
  const askOnClose = settings.confirmClose;
  const [showSettings, setShowSettings] = useState(false);
  const [confirm, setConfirm] = useState<{ names: string[]; run: () => void } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [searchPane, setSearchPane] = useState<string | null>(null);
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [sftpPanes, setSftpPanes] = useState<Set<string>>(() => new Set());
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  // 창의 연결 상태가 바뀌면 다시 그린다(탭·사이드바의 상태 점).
  useSyncExternalStore(terms.subscribeStatus, terms.statusSnapshot);

  // 앱을 켜고 조금 뒤 새 버전을 조용히 확인한다(실패해도 알리지 않는다).
  useEffect(() => {
    const t = setTimeout(() => void checkForUpdate(false), 3000);
    return () => clearTimeout(t);
  }, []);

  // 알림은 잠깐 보였다가 사라진다.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);

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
    // 세션 목록까지 받은 뒤 화면을 바꿔서, 빈 목록이 잠깐 보이지 않게 한다.
    if (st.unlocked) setSessions(await api.sessionsList());
    setStatus(st);
  }, []);
  useEffect(() => void refresh(), [refresh]);

  /** 지금 입력이 가는 터미널 */
  const activeId = desks.activePane(desk);
  const groupCount = desks.groupOrder(desk).length;

  const infoFor = (sessionId: string | null, list: Session[] = sessions): PaneInfo => {
    const s = list.find((x) => x.id === sessionId);
    return s
      ? { sessionId: s.id, title: s.name, sub: describeSession(s), color: s.color ?? null, ssh: s.kind === "ssh" }
      : { sessionId: null, title: tx("로컬 셸"), sub: tx("기본 셸") };
  };

  // 세션을 고치면(이름·색 등) 열린 창의 머리글도 바로 바꾼다.
  useEffect(() => {
    setPanes((all) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(all).map(([id, p]) => {
          if (!p.sessionId) return [id, p];
          const s = sessions.find((x) => x.id === p.sessionId);
          if (!s) return [id, p];
          const info = { ...p, title: s.name, sub: describeSession(s), color: s.color ?? null };
          if (info.title !== p.title || info.sub !== p.sub || info.color !== p.color) changed = true;
          return [id, info];
        }),
      );
      return changed ? next : all;
    });
  }, [sessions]);

  // 동시 입력: 켜져 있으면 보이는 칸들의 탭에 같은 입력을 보낸다.
  const visibleKey = desks.visibleTabs(desk).join(",");
  useEffect(() => {
    const visible = desks.visibleTabs(desk);
    terms.setBroadcastGroups(desk.broadcast && visible.length > 1 ? [visible] : []);
  }, [desk.broadcast, visibleKey]);

  const toggleBroadcast = () => {
    if (desks.visibleTabs(desk).length < 2) return setNotice(tx("동시 입력은 칸을 둘 이상으로 나눴을 때 씁니다."));
    setDesk((d) => ({ ...d, broadcast: !d.broadcast }));
  };
  const toggleSftp = (paneId: string) =>
    setSftpPanes((all) => {
      const next = new Set(all);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
      return next;
    });

  const openSnippets = async () => {
    try {
      setSnippets(await api.snippetsList());
    } catch (e) {
      setNotice(tx("명령 모음을 열지 못했습니다: {0}", errorText(e)));
    }
  };
  const closeSnippets = () => {
    setSnippets(null);
    if (activeId) requestAnimationFrame(() => terms.focusPane(activeId));
  };

  // ---- 칸과 탭 조작 ----

  /** 새 탭(새 연결)을 연다. groupId를 주면 그 칸에, 아니면 지금 칸에. */
  const openTab = (sessionId: string | null, list?: Session[], groupId?: string | null) => {
    const paneId = newId();
    setPanes((p) => ({ ...p, [paneId]: infoFor(sessionId, list) }));
    setDesk((d) => desks.addTab(d, paneId, newId(), groupId));
  };

  /** 사이드바에서 세션을 눌렀을 때: 이미 열린 탭이 있으면 그 탭으로 가고, 없으면 새로 연다. */
  const showSession = (sessionId: string) => {
    const open = desks.allTabs(desk).filter((t) => panes[t]?.sessionId === sessionId);
    if (open.length === 0) return openTab(sessionId);
    const target = activeId && open.includes(activeId) ? activeId : open[0];
    setDesk((d) => desks.activate(d, target));
    requestAnimationFrame(() => terms.focusPane(target));
  };

  /** 같은 세션으로 새로 연결하는 탭 id를 만든다(같은 서버에 하나 더). */
  const clonePanes = (fromPaneId: string, count: number) => {
    const ids = Array.from({ length: count }, newId);
    setPanes((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, p[fromPaneId]])) }));
    return ids;
  };

  const fullNotice = () => setNotice(tx("칸은 {0}개까지 나눌 수 있습니다.", MAX_PANES));

  /** 이 탭의 칸 옆에 새 칸을 만들고 같은 세션으로 새로 연결한다. */
  const doSplit = (paneId: string, dir: SplitDir) => {
    const g = desks.groupOf(desk, paneId);
    if (!g) return;
    if (groupCount >= MAX_PANES) return fullNotice();
    const [id] = clonePanes(paneId, 1);
    setDesk((d) => desks.splitWith(d, g.id, dir === "row" ? "right" : "bottom", id, newId()));
  };

  /** 이 탭을 새 칸으로 옮겨서 분할한다(새로 연결하지 않는다). */
  const moveToSplit = (paneId: string, side: DropSide) => {
    const g = desks.groupOf(desk, paneId);
    if (!g) return;
    if (groupCount >= MAX_PANES) return fullNotice();
    setDesk((d) => desks.moveTab(d, paneId, { kind: "edge", groupId: g.id, side }, newId()));
  };

  const doQuad = (paneId: string) => {
    const g = desks.groupOf(desk, paneId);
    if (!g) return;
    if (groupCount + 3 > MAX_PANES) return fullNotice();
    const ids = clonePanes(paneId, 3) as [string, string, string];
    setDesk((d) => desks.quad(d, g.id, ids, [newId(), newId(), newId()]));
  };

  const doZoom = (paneId: string) => {
    const g = desks.groupOf(desk, paneId);
    if (g) setDesk((d) => desks.toggleZoom(d, g.id));
  };

  /** 분할 해제: 모든 칸의 탭을 지금 칸 하나에 모은다(연결은 그대로). */
  const doUnsplit = () => setDesk((d) => desks.unsplitAll(d));

  /** 연결된 창이 있으면 닫기 전에 묻는다('다시 묻지 않음'을 고르면 그다음부터는 바로 닫는다). */
  const requestClose = (ids: string[], run: () => void) => {
    const live = ids.filter(terms.isLive);
    if (!askOnClose || live.length === 0) return run();
    setConfirm({ names: [...new Set(live.map((id) => tabTitle(panes[id])))], run });
  };

  const reallyCloseTabs = (ids: string[]) => {
    const gone = new Set(ids);
    ids.forEach((id) => void terms.disposePane(id));
    setPanes((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !gone.has(id))));
    setSftpPanes((s) => new Set([...s].filter((id) => !gone.has(id))));
    setSearchPane((s) => (s && gone.has(s) ? null : s));
    setDesk((d) => desks.closeTabs(d, ids));
  };

  /** 여러 탭을 한꺼번에 닫는다(연결된 것이 있으면 한 번만 묻는다). */
  const closeTabs = (ids: string[]) => ids.length && requestClose(ids, () => reallyCloseTabs(ids));
  const closeTab = (paneId: string) => closeTabs([paneId]);

  const run = (action: string, paneId: string) => {
    switch (action) {
      case "split-row": return doSplit(paneId, "row");
      case "split-column": return doSplit(paneId, "column");
      case "zoom": return doZoom(paneId);
      case "close": return closeTab(paneId);
      case "copy": return terms.copySelection(paneId);
      case "paste": return void terms.pasteInto(paneId);
      case "clear": return terms.clearPane(paneId);
      case "search": return setSearchPane(paneId);
      case "broadcast": return toggleBroadcast();
      case "sftp": return panes[paneId]?.ssh ? toggleSftp(paneId) : setNotice(tx("파일 창은 SSH 세션에서만 열 수 있습니다."));
      case "tab-next": return setDesk((d) => desks.cycleTab(d, 1));
      case "tab-prev": return setDesk((d) => desks.cycleTab(d, -1));
    }
    if (action.startsWith("tab-")) return setDesk((d) => desks.nthTab(d, Number(action.slice(4))));
    if (action.startsWith("focus-")) {
      const rects = [...document.querySelectorAll<HTMLElement>("[data-group-id]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.groupId!, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      const from = desk.activeGroup;
      const to = from ? desks.neighborGroup(rects, from, action.slice(6) as desks.Dir) : null;
      if (to) setDesk((d) => desks.activateGroup(d, to));
    }
  };

  const activeLive = !!activeId && terms.paneStatus(activeId) !== "closed";

  // 터미널 링크를 열지 못하면 알림줄에 보인다.
  useEffect(() => terms.setLinkErrorHandler((m) => setNotice(tx("링크를 열지 못했습니다: {0}", m))), []);

  // 단축키: xterm이 먹지 않게 걸러내고, 창(window)에서 처리한다.
  useEffect(() => {
    const actionOf = (e: KeyboardEvent) => shortcutOf(e) ?? reconnectShortcutOf(e, activeLive);
    terms.setShortcutFilter((e) => actionOf(e) !== null);
    const onKey = (e: KeyboardEvent) => {
      const action = actionOf(e);
      if (action === "hosts") {
        if (confirm || editing || showSettings) return;
        e.preventDefault();
        return picker ? closePicker() : setPicker(true);
      }
      if (picker || snippets) return;
      switch (action) {
        case "snippets":
          e.preventDefault();
          if (confirm || editing || showSettings) return;
          return void openSnippets();
        case "reconnect":
          // 앱 화면이 새로고침되지 않도록 늘 막는다.
          e.preventDefault();
          if (!activeId || confirm || editing) return;
          return void terms.reconnect(activeId);
        case "sidebar": e.preventDefault(); return toggleSidebar();
        case "fullscreen": e.preventDefault(); return void toggleFullscreen();
        case "settings": e.preventDefault(); return setShowSettings(true);
        case "font-up": e.preventDefault(); return bumpFontSize(1);
        case "font-down": e.preventDefault(); return bumpFontSize(-1);
        case "font-reset": e.preventDefault(); return updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
      }
      if (!action || !activeId || confirm || editing) return;
      e.preventDefault();
      run(action, activeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** 터미널을 오른쪽 클릭했을 때 */
  const menuItems = (paneId: string): MenuItem[] => {
    const g = desks.groupOf(desk, paneId);
    const multi = groupCount > 1;
    const full = groupCount >= MAX_PANES;
    const ssh = !!panes[paneId]?.ssh;
    const closed = terms.paneStatus(paneId) === "closed";
    return [
      ...(closed ? ([{ label: tx("다시 연결"), shortcut: isMac ? "⌘R" : "Ctrl+R", onSelect: () => void terms.reconnect(paneId) }, "separator"] as MenuItem[]) : []),
      { label: tx("오른쪽으로 분할"), shortcut: "Alt+Shift+→", disabled: full, onSelect: () => doSplit(paneId, "row") },
      { label: tx("아래로 분할"), shortcut: "Alt+Shift+↓", disabled: full, onSelect: () => doSplit(paneId, "column") },
      { label: tx("4분할로 나누기"), disabled: groupCount + 3 > MAX_PANES, onSelect: () => doQuad(paneId) },
      "separator",
      { label: desk.zoomed ? tx("분할 화면으로 돌아가기") : tx("이 칸만 크게 보기"), shortcut: `${K}Z`, disabled: !multi, onSelect: () => doZoom(paneId) },
      { label: tx("분할 해제 · 모든 탭을 한 칸으로"), disabled: !multi, onSelect: doUnsplit },
      { label: desk.broadcast ? tx("동시 입력 끄기") : tx("동시 입력 켜기 · 보이는 모든 칸"), shortcut: `${K}I`, disabled: !multi, onSelect: toggleBroadcast },
      "separator",
      { label: tx("찾기"), shortcut: isMac ? "⌘F" : `${K}F`, onSelect: () => setSearchPane(paneId) },
      { label: tx("명령 모음…"), shortcut: `${K}S`, onSelect: () => void openSnippets() },
      ...(ssh ? ([{ label: sftpPanes.has(paneId) ? tx("파일 창 닫기") : tx("파일 창 열기 (SFTP)"), shortcut: `${K}O`, onSelect: () => toggleSftp(paneId) }] as MenuItem[]) : []),
      ...(!ssh ? ([{ label: isMac ? tx("지금 폴더를 Finder에서 열기") : tx("지금 폴더를 탐색기에서 열기"), disabled: closed, onSelect: () => revealCwd(paneId) }] as MenuItem[]) : []),
      "separator",
      { label: tx("복사"), shortcut: isMac ? `${K}C` : "Ctrl+C", onSelect: () => terms.copySelection(paneId) },
      { label: tx("붙여넣기"), shortcut: `${K}V`, onSelect: () => void terms.pasteInto(paneId) },
      { label: tx("화면 지우기"), shortcut: `${K}K`, onSelect: () => terms.clearPane(paneId) },
      "separator",
      { label: g && g.tabs.length > 1 ? tx("탭 닫기") : tx("칸 닫기"), shortcut: isMac ? "⌘W" : `${K}W`, danger: true, onSelect: () => closeTab(paneId) },
    ];
  };

  const revealCwd = (paneId: string) =>
    void terms.revealCwd(paneId).catch((e) => setNotice(tx("폴더를 열지 못했습니다: {0}", e instanceof Error ? e.message : String(e))));

  /** 사이드바의 세션을 오른쪽 클릭했을 때 */
  const sessionMenuItems = (s: Session): MenuItem[] => {
    const isOpen = desks.allTabs(desk).some((t) => panes[t]?.sessionId === s.id);
    const icon = { width: 15, height: 15 };
    return [
      isOpen
        ? { label: tx("열린 탭으로 이동"), icon: <IconTarget {...icon} />, onSelect: () => showSession(s.id) }
        : { label: tx("연결"), icon: <IconPrompt {...icon} />, onSelect: () => openTab(s.id) },
      { label: tx("새 탭으로 열기"), icon: <IconPlus {...icon} />, shortcut: tx("휠 클릭"), onSelect: () => openTab(s.id) },
      "separator",
      { label: tx("편집…"), icon: <IconEdit {...icon} />, onSelect: () => setEditing({ session: s }) },
      { label: tx("복제"), icon: <IconCopy {...icon} />, onSelect: () => void duplicateSession(s) },
      "separator",
      { label: tx("제거…"), icon: <IconTrash {...icon} />, danger: true, onSelect: () => void deleteSession(s) },
    ];
  };

  /** 탭을 오른쪽 클릭했을 때 (파이참 탭 메뉴처럼) */
  const tabMenuItems = (paneId: string): MenuItem[] => {
    const g = desks.groupOf(desk, paneId);
    if (!g) return [];
    const i = g.tabs.indexOf(paneId);
    const full = groupCount >= MAX_PANES;
    const alone = g.tabs.length === 1;
    const closed = terms.paneStatus(paneId) === "closed";
    return [
      { label: tx("같은 세션을 새 탭으로"), onSelect: () => openTab(panes[paneId]?.sessionId ?? null, undefined, g.id) },
      { label: tx("탭 이름 바꾸기…"), shortcut: tx("더블클릭"), onSelect: () => setRenamingTab(paneId) },
      ...(closed ? ([{ label: tx("다시 연결"), shortcut: isMac ? "⌘R" : "Ctrl+R", onSelect: () => terms.reconnect(paneId) }] as MenuItem[]) : []),
      "separator",
      { label: tx("오른쪽으로 분할 · 새로 연결"), disabled: full, onSelect: () => doSplit(paneId, "row") },
      { label: tx("아래로 분할 · 새로 연결"), disabled: full, onSelect: () => doSplit(paneId, "column") },
      { label: tx("오른쪽 칸으로 옮기기"), disabled: full || alone, onSelect: () => moveToSplit(paneId, "right") },
      { label: tx("아래 칸으로 옮기기"), disabled: full || alone, onSelect: () => moveToSplit(paneId, "bottom") },
      ...(groupCount > 1 ? ([{ label: tx("분할 해제 · 모든 탭을 한 칸으로"), onSelect: doUnsplit }] as MenuItem[]) : []),
      "separator",
      { label: tx("탭 닫기"), shortcut: isMac ? "⌘W" : undefined, onSelect: () => closeTab(paneId) },
      { label: tx("다른 탭 모두 닫기"), disabled: alone, onSelect: () => closeTabs(g.tabs.filter((t) => t !== paneId)) },
      { label: tx("왼쪽 탭 모두 닫기"), disabled: i === 0, onSelect: () => closeTabs(g.tabs.slice(0, i)) },
      { label: tx("오른쪽 탭 모두 닫기"), disabled: i === g.tabs.length - 1, onSelect: () => closeTabs(g.tabs.slice(i + 1)) },
      "separator",
      { label: groupCount > 1 ? tx("이 칸의 탭 모두 닫기") : tx("모든 탭 닫기"), danger: true, onSelect: () => closeTabs(g.tabs) },
    ];
  };

  // ---- 탭 끌어서 옮기기 (파이참처럼) ----
  // 다른 칸의 탭 줄에 놓으면 그 칸으로, 칸의 가장자리에 놓으면 그쪽에 새 칸을 만들고,
  // 칸 한가운데에 놓으면 그 칸의 탭으로 넣는다.
  // HTML 드래그(draggable)는 Windows에서 파일 끌어다 놓기 설정과 부딪혀서 마우스 이벤트로 직접 만든다.

  const deskRef = useRef(desk);
  deskRef.current = desk;

  const targetAt = (x: number, y: number, paneId: string): DropTarget => {
    const d = deskRef.current;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const bar = el.closest<HTMLElement>("[data-group-bar]");
    if (bar) {
      const groupId = bar.dataset.groupBar!;
      const chips = [...bar.querySelectorAll<HTMLElement>("[data-tab-pane]")];
      const index = chips.filter((c) => {
        const r = c.getBoundingClientRect();
        return r.left + r.width / 2 < x;
      }).length;
      const drop: TabDrop = { kind: "bar", groupId, index };
      return desks.canDrop(d, paneId, drop) ? drop : null;
    }
    const body = el.closest<HTMLElement>("[data-group-body]");
    if (!body) return null;
    const groupId = body.dataset.groupBody!;
    const side = sideAt(x, y, body.getBoundingClientRect());
    if (side) {
      const drop: TabDrop = { kind: "edge", groupId, side };
      const src = desks.groupOf(d, paneId);
      // 칸이 꽉 찼으면 새 칸을 만들 수 없다(자기 칸의 유일한 탭을 옮기는 경우는 칸 수가 그대로).
      const grows = !(src && src.tabs.length === 1);
      if (grows && desks.groupOrder(d).length >= MAX_PANES) return null;
      return desks.canDrop(d, paneId, drop) ? drop : null;
    }
    const drop = { kind: "bar" as const, groupId, index: d.groups[groupId]?.tabs.length ?? 0, center: true };
    return desks.groupOf(d, paneId)?.id !== groupId && desks.canDrop(d, paneId, drop) ? drop : null;
  };

  const startTabDrag = (e: ReactMouseEvent, paneId: string) => {
    if (e.button !== 0) return;
    const label = tabTitle(panes[paneId]);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = Math.min(box.width, 260);
    const grab = { dx: Math.min(x0 - box.left, width - 12), dy: y0 - box.top, width };
    let active = false;
    let last: DragState | null = null;

    const move = (ev: MouseEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
        active = true;
        document.body.classList.add("dragging-tab");
      }
      last = { paneId, label, x: ev.clientX, y: ev.clientY, grab, target: targetAt(ev.clientX, ev.clientY, paneId) };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("dragging-tab");
      if (!active) return;
      setDrag(null);
      const target = last?.target;
      if (target) setDesk((d) => desks.moveTab(d, paneId, target, newId()));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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

  // 로컬 셸에 파일을 끌어다 놓으면 그 경로를 넣는다(macOS 터미널처럼). 파일 창(SFTP) 위면 그쪽이 올린다.
  useEffect(() => {
    let over: HTMLElement | null = null;
    const slotAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el || el.closest(".sftp")) return null;
      return el.closest<HTMLElement>(".term-slot[data-pane-id]");
    };
    const mark = (slot: HTMLElement | null) => {
      if (over === slot) return;
      over?.classList.remove("file-over");
      over = slot;
      over?.classList.add("file-over");
    };
    const dropAt = async (x: number, y: number, paths: string[]) => {
      mark(null);
      const slot = slotAt(x, y);
      if (slot?.dataset.paneId) await terms.dropPaths(slot.dataset.paneId, paths);
    };
    if (!inTauri) {
      // 브라우저 미리보기·E2E용
      (window as unknown as { __sshbookDropFiles?: typeof dropAt }).__sshbookDropFiles = dropAt;
      return;
    }
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "leave") return mark(null);
      const s = window.devicePixelRatio || 1;
      const x = p.position.x / s;
      const y = p.position.y / s;
      if (p.type === "drop") void dropAt(x, y, p.paths);
      else mark(slotAt(x, y));
    });
    return () => {
      mark(null);
      void un.then((f) => f());
    };
  }, []);
  useEffect(() => {
    if (!inTauri) return;
    const w = getCurrentWindow();
    const un = w.onCloseRequested((e) => {
      const { ask, panes: all } = closeGuard.current;
      const live = Object.keys(all).filter(terms.isLive);
      if (!ask || live.length === 0) return;
      e.preventDefault();
      setConfirm({ names: [...new Set(live.map((id) => all[id]?.title ?? tx("터미널")))], run: () => void w.destroy() });
    });
    return () => void un.then((f) => f());
  }, []);

  // macOS ⌘W(메뉴의 '탭 닫기'): 열린 대화상자 → 지금 탭 순서로 닫고, 탭이 없으면 창을 닫는다.
  const onCloseTabKey = useRef(() => {});
  onCloseTabKey.current = () => {
    if (confirm) return setConfirm(null);
    if (editing) return setEditing(null);
    if (snippets) return closeSnippets();
    if (picker) return closePicker();
    if (showSettings) return setShowSettings(false);
    if (menu) return setMenu(null);
    if (activeId) return closeTab(activeId);
    void getCurrentWindow().close();
  };
  useEffect(() => {
    if (!inTauri) return;
    const un = listen("menu-close-tab", () => onCloseTabKey.current());
    return () => void un.then((f) => f());
  }, []);

  // ---- 세션과 보관함 ----

  const unlocked = !!status?.unlocked;
  useEffect(() => {
    if (!unlocked) return setGroupInfos([]);
    let live = true;
    Promise.all([api.groupsList(), api.sidebarManual()])
      .then(([g, m]) => {
        if (!live) return;
        setGroupInfos(g);
        setSidebarManual(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessions, unlocked]);
  // 세션 편집의 그룹 고르기 목록: 미리 만든 그룹 + 세션에 적힌 그룹
  const groups = useMemo(
    () =>
      [...new Set([...groupInfos.map((g) => g.name), ...sessions.map((s) => s.group?.trim()).filter((g): g is string => !!g)])].sort((a, b) =>
        a.localeCompare(b, "ko"),
      ),
    [groupInfos, sessions],
  );
  const reloadSessions = async () => {
    const [list, g, m] = await Promise.all([api.sessionsList(), api.groupsList(), api.sidebarManual()]);
    setSessions(list);
    setGroupInfos(g);
    setSidebarManual(m);
  };
  // 사이드바에서 끌어 놓은 순서: 화면을 먼저 바꾸고 저장한다.
  const reorderSidebar = async (layout: SidebarLayout) => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const placed = layout.sessions.flatMap((p) => {
      const s = byId.get(p.id);
      return s ? [{ ...s, group: p.group }] : [];
    });
    setSessions([...placed, ...sessions.filter((s) => !layout.sessions.some((p) => p.id === s.id))]);
    const info = new Map(groupInfos.map((g) => [g.name, g]));
    setGroupInfos([
      ...layout.groups.map((name) => info.get(name) ?? { name, color: null }),
      ...groupInfos.filter((g) => !layout.groups.includes(g.name)),
    ]);
    setSidebarManual(true);
    try {
      await api.sidebarReorder(layout.groups, layout.sessions);
    } catch (e) {
      setNotice(tx("순서를 저장하지 못했습니다: {0}", errorText(e)));
    }
    await reloadSessions().catch(() => {});
  };
  // 연결이 살아 있는 창이 하나라도 있는 세션
  const connected = new Set(
    Object.entries(panes)
      .filter(([id, p]) => p.sessionId && terms.paneStatus(id) === "live")
      .map(([, p]) => p.sessionId as string),
  );

  const saveSession = async (s: Session, secret: SecretInput) => {
    const isNew = !s.id;
    const saved = await api.sessionSave(s, secret);
    const list = await api.sessionsList();
    setSessions(list);
    setEditing(null);
    // 새로 만든 세션은 저장하자마자 연결한다.
    if (isNew) openTab(saved.id, list);
  };

  const duplicateSession = async (s: Session) => {
    try {
      const copy = await api.sessionDuplicate(s.id);
      setSessions(await api.sessionsList());
      setEditing({ session: copy });
      setNotice(tx("'{0}'을 만들었습니다. 호스트만 바꿔 저장하세요.", copy.name));
    } catch (e) {
      setNotice(tx("복제하지 못했습니다: {0}", errorText(e)));
    }
  };

  const saveSnippet = async (s: Snippet) => {
    await api.snippetSave(s);
    setSnippets(await api.snippetsList());
  };
  const deleteSnippet = async (s: Snippet) => {
    await api.snippetDelete(s.id);
    setSnippets(await api.snippetsList());
  };

  const deleteSession = async (s: Session) => {
    if (!window.confirm(tx("'{0}' 세션을 지울까요? 보관함에 저장된 비밀번호와 키도 함께 지워집니다.", s.name))) return;
    await api.sessionDelete(s.id);
    setSessions(await api.sessionsList());
    setEditing(null);
  };

  const closePicker = () => {
    setPicker(false);
    if (activeId) requestAnimationFrame(() => terms.focusPane(activeId));
  };

  const lock = () => requestClose(Object.keys(panes), () => void reallyLock());

  const reallyLock = async () => {
    // 잠그면서 화면을 비우는 것은 '모든 탭을 닫은 것'이 아니므로 저장해 둔 배치를 지우지 않는다.
    skipSave.current = true;
    setEditing(null);
    setPicker(false);
    setSnippets(null);
    setShowSettings(false);
    setConfirm(null);
    setMenu(null);
    setSearchPane(null);
    setSftpPanes(new Set());
    // 보관함부터 잠근다. 창 정리를 기다리다가 잠금이 늦어지면 안 된다.
    try {
      await api.vaultLock();
    } finally {
      void terms.disposeAll();
      setDesk(emptyDesk);
      setPanes({});
    }
    await refresh();
  };

  const exportVault = async (password?: string) => {
    try {
      const dest = await pickExportPath();
      if (!dest) return;
      await api.vaultExport(dest, password);
      setNotice(tx("보관함 파일을 내보냈습니다: {0}", dest));
    } catch (e) {
      setNotice(tx("내보내지 못했습니다: {0}", errorText(e)));
    }
  };

  // 자동 잠금: 설정한 시간 동안 키보드·마우스 입력이 없으면 잠근다(연결도 끊긴다).
  const lastInput = useRef(Date.now());
  const lockRef = useRef(reallyLock);
  lockRef.current = reallyLock;
  useEffect(() => {
    const bump = () => (lastInput.current = Date.now());
    const evs = ["keydown", "mousedown", "wheel", "touchstart"] as const;
    evs.forEach((ev) => window.addEventListener(ev, bump, { capture: true, passive: true }));
    return () => evs.forEach((ev) => window.removeEventListener(ev, bump, { capture: true }));
  }, []);
  useEffect(() => {
    const minutes = settings.autoLockMinutes;
    // 마스터 비밀번호 없이 쓰면 잠가도 바로 열리므로 자동 잠금을 쓰지 않는다.
    if (!minutes || !status?.unlocked || status.passwordless) return;
    lastInput.current = Date.now();
    const t = setInterval(() => {
      if (Date.now() - lastInput.current >= minutes * 60_000) void lockRef.current();
    }, 15_000);
    return () => clearInterval(t);
  }, [settings.autoLockMinutes, status?.unlocked, status?.passwordless]);

  const openLogs = async () => {
    try {
      const dir = await api.openLogsDir();
      setNotice(tx("세션 기록 폴더: {0}", dir));
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  // ---- 작업 공간 저장·복원 ----
  // 비밀 정보 없이 칸 배치와 탭마다의 세션 id, 바꾼 탭 이름만 이 PC(localStorage)에 둔다.

  const workspaceKey = status ? `sshbook.workspace:${status.path}` : null;
  const skipSave = useRef(false);
  /** 이번에 연 뒤로 탭을 한 번이라도 열었는지(처음 빈 화면을 '모두 닫음'으로 저장하지 않게) */
  const hadTabs = useRef(false);

  // 잠금을 풀면 지난번 배치를 바로 보여 준다. 접속은 하지 않고, 탭마다 다시 연결할 때 붙는다.
  useEffect(() => {
    if (!status?.unlocked || !workspaceKey) return;
    skipSave.current = false;
    hadTabs.current = false;
    try {
      const raw = localStorage.getItem(workspaceKey);
      const saved = raw ? (JSON.parse(raw) as desks.SavedWorkspace) : null;
      if (saved?.v !== 1 || desks.savedTabCount(saved) === 0) return;
      const { desk: next, opened } = desks.restoreWorkspace(saved, (id) => sessions.some((s) => s.id === id), newId);
      if (!next.root) return;
      opened.forEach(([id, tab]) => terms.openDisconnected(id, tab.sessionId));
      setPanes(Object.fromEntries(opened.map(([id, tab]) => [id, { ...infoFor(tab.sessionId), ...(tab.name ? { customTitle: tab.name } : {}) }])));
      setDesk(next);
    } catch {
      // 저장된 배치가 깨졌으면 빈 화면으로 시작한다.
    }
  }, [status?.unlocked, workspaceKey]);

  // 배치가 바뀌면 잠시 뒤 저장한다.
  useEffect(() => {
    if (!status?.unlocked || !workspaceKey || skipSave.current) return;
    if (desk.root) hadTabs.current = true;
    if (!desk.root && !hadTabs.current) return;
    const t = setTimeout(() => {
      const saved = desks.saveWorkspace(desk, (id) => {
        const p = panes[id];
        return p ? { sessionId: p.sessionId, ...(p.customTitle ? { name: p.customTitle } : {}) } : null;
      });
      try {
        if (saved) localStorage.setItem(workspaceKey, JSON.stringify(saved));
        else localStorage.removeItem(workspaceKey);
      } catch {
        // 저장소를 못 쓰면 복원만 안 될 뿐이다.
      }
    }, 400);
    return () => clearTimeout(t);
  }, [desk, panes, status?.unlocked, workspaceKey]);

  // ---- 화면 ----

  if (!status) return <Splash />;
  if (!status.unlocked) return <VaultScreen status={status} onOpened={refresh} />;

  const activeInfo = activeId ? panes[activeId] : null;

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-btn ghost"
          aria-pressed={!sidebarHidden}
          aria-label={sidebarHidden ? tx("사이드바 펼치기") : tx("사이드바 접기")}
          title={`${sidebarHidden ? tx("사이드바 펼치기") : tx("사이드바 접기")} (${K}B)`}
          onClick={toggleSidebar}
        >
          <IconSidebar />
        </button>
        <div className="brand">
          <IconPrompt width={18} height={18} style={{ color: "var(--accent)" }} />
          SSHBook
        </div>
        <span style={{ flex: 1 }} />
        {inTauri && (
          <button
            className="icon-btn"
            aria-label={fullscreen ? tx("전체 화면 끝내기") : tx("전체 화면")}
            title={`${fullscreen ? tx("전체 화면 끝내기") : tx("전체 화면")} (F11)`}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <IconShrink /> : <IconExpand />}
          </button>
        )}
        <button className="icon-btn" aria-label={tx("설정")} title={tx("설정 ({0},)", isMac ? "⌘" : "Ctrl+")} onClick={() => setShowSettings(true)}>
          <IconSettings />
        </button>
        <button
          className="icon-btn"
          aria-label={theme === "light" ? tx("다크 모드로 전환") : tx("라이트 모드로 전환")}
          title={theme === "light" ? tx("다크 모드로 전환") : tx("라이트 모드로 전환")}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? <IconMoon /> : <IconSun />}
        </button>
      </header>

      <div className="body">
        {!sidebarHidden && (
          <Sidebar
            sessions={sessions}
            groups={groupInfos}
            manualOrder={sidebarManual}
            onReorder={reorderSidebar}
            connected={connected}
            selectedId={activeInfo?.sessionId ?? null}
            onOpen={(s) => showSession(s.id)}
            onOpenNew={(s) => openTab(s.id)}
            onEdit={(s) => setEditing({ session: s })}
            onMenu={(s, x, y) => setMenu({ session: s, x, y, kind: "session" })}
            onNew={() => setEditing({ session: null })}
            onRenameGroup={async (from, to) => {
              try {
                await api.sessionsRenameGroup(from, to);
                setSessions(await api.sessionsList());
              } catch (e) {
                setNotice(tx("그룹 이름을 바꾸지 못했습니다: {0}", errorText(e)));
              }
            }}
          />
        )}

        <main className="main">
          {desk.root ? (
            <Workspace
              desk={desk}
              panes={panes}
              onActivateTab={(id) => setDesk((d) => desks.activate(d, id))}
              onActivateGroup={(gid) => setDesk((d) => desks.activateGroup(d, gid))}
              onCloseTab={closeTab}
              onTabMenu={(paneId, x, y) => setMenu({ paneId, x, y, kind: "tab" })}
              onPaneMenu={(paneId, x, y) => setMenu({ paneId, x, y, kind: "pane" })}
              onNewTab={(gid) => openTab(null, undefined, gid)}
              onTabDragStart={startTabDrag}
              dragging={drag?.paneId ?? null}
              drop={drag?.target ?? null}
              rightClickPaste={settings.rightClickPaste}
              onUnzoom={() => setDesk((d) => ({ ...d, zoomed: null }))}
              onResize={(path, ratio) => setDesk((d) => desks.resize(d, path, ratio))}
              searchPane={searchPane}
              onCloseSearch={() => setSearchPane(null)}
              sftpPanes={sftpPanes}
              onToggleSftp={toggleSftp}
              onToggleBroadcast={toggleBroadcast}
              renamingTab={renamingTab}
              onRenameStart={setRenamingTab}
              onRename={(paneId, name) => {
                setRenamingTab(null);
                if (name === null) return;
                const custom = name.trim();
                setPanes((p) => (p[paneId] ? { ...p, [paneId]: { ...p[paneId], customTitle: custom && custom !== p[paneId].title ? custom : undefined } } : p));
                requestAnimationFrame(() => terms.focusPane(paneId));
              }}
            />
          ) : (
            <div className="welcome">
              <p>{sidebarHidden ? tx("사이드바를 펼쳐 세션을 고르거나 로컬 셸을 여세요.") : tx("왼쪽에서 세션을 고르거나 로컬 셸을 여세요.")}</p>
              <p className="hint">{isMac ? "⌘D" : "Alt+D"}{" "}{tx("호스트 목록 · 연결이 끊긴 탭에서")}{" "}{isMac ? "⌘R" : "Ctrl+R"}{" "}{tx("다시 연결 · 탭을 끌어 칸 가장자리에 놓으면 분할")}</p>
              <button className="btn" onClick={() => openTab(null)}>
                <IconPrompt width={14} height={14} />{" "}{tx("로컬 셸 열기")}
              </button>
            </div>
          )}
        </main>
      </div>

      <UpdateNotice liveCount={Object.keys(panes).filter((id) => terms.paneStatus(id) === "live").length} />
      {notice && (
        <div className="toast" role="status" onClick={() => setNotice("")}>
          {notice}
        </div>
      )}
      {picker && (
        <HostPicker
          sessions={sessions}
          connected={connected}
          onConnect={(s) => {
            setPicker(false);
            openTab(s.id);
          }}
          onEdit={(s) => {
            setPicker(false);
            setEditing({ session: s });
          }}
          onDelete={(s) => void deleteSession(s)}
          onClose={closePicker}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          header={menu.kind === "session" ? { title: menu.session.name, sub: describeSession(menu.session) } : undefined}
          items={
            menu.kind === "session"
              ? sessionMenuItems(menu.session)
              : menu.kind === "tab"
                ? tabMenuItems(menu.paneId)
                : menuItems(menu.paneId)
          }
          onClose={() => setMenu(null)}
        />
      )}
      {drag && (
        <>
          {/* 잡은 탭이 그대로 커서에 붙어 따라온다 */}
          <div
            className="drag-ghost"
            style={{ left: drag.x - drag.grab.dx, top: drag.y - drag.grab.dy, minWidth: drag.grab.width }}
            aria-hidden
          >
            <IconPrompt width={13} height={13} />
            <span className="t">{drag.label}</span>
          </div>
          {drag.target && (
            <div className="drag-where" style={{ left: drag.x - drag.grab.dx, top: drag.y - drag.grab.dy + 36 }} aria-hidden>
              {drag.target.kind === "edge" ? SIDE_LABEL[drag.target.side] : drag.target.center ? tx("이 칸의 탭으로") : tx("여기로 옮기기")}
            </div>
          )}
        </>
      )}
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
      {showSettings && (
        <SettingsDialog
          theme={theme}
          onTheme={setTheme}
          onOpenLogs={() => void openLogs()}
          onNotice={setNotice}
          passwordless={status.passwordless}
          onVaultChanged={refresh}
          onExport={(pw) => void exportVault(pw)}
          sessions={sessions}
          groups={groupInfos}
          onGroupsChanged={reloadSessions}
          onLock={() => {
            // 연결된 탭이 있으면 묻는 창이 설정에 가리지 않게 먼저 닫는다.
            setShowSettings(false);
            lock();
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {snippets && (
        <SnippetsDialog
          snippets={snippets}
          canInsert={!!activeId}
          onInsert={(s, runIt) => {
            const target = activeId;
            setSnippets(null);
            if (target) requestAnimationFrame(() => terms.insertCommand(target, s.command, runIt));
          }}
          onSave={saveSnippet}
          onDelete={deleteSnippet}
          onClose={closeSnippets}
        />
      )}
      {editing && (
        <SessionEditor
          key={editing.session?.id ?? "new"}
          initial={editing.session}
          groups={groups}
          sessions={sessions}
          onSave={saveSession}
          onDelete={deleteSession}
          onDuplicate={duplicateSession}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
