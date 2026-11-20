// 작업 공간 = 분할된 칸(그룹)들의 배치 + 칸마다의 탭 목록. 파이참의 에디터 분할과 같다.
// - 레이아웃 트리(layout.ts)의 잎이 칸 id다.
// - 탭 하나 = 터미널 하나(paneId). 한 칸에 탭이 여러 개 있고, 그중 하나만 보인다.
// - 마지막 탭이 빠진 칸은 사라지고, 남은 칸이 자리를 채운다.

import { closePane, insertBeside, pane, paneIds, setRatio, splitQuad, type DropSide, type LayoutNode } from "./layout";

export interface Group {
  id: string;
  /** 탭(터미널 id) 순서 */
  tabs: string[];
  /** 보이는 탭 */
  active: string;
}

export interface Desk {
  root: LayoutNode | null;
  groups: Record<string, Group>;
  /** 입력·단축키가 가는 칸 */
  activeGroup: string | null;
  /** 이 칸만 크게 보는 중 */
  zoomed: string | null;
  /** 보이는 칸들의 탭에 같은 입력을 동시에 보낸다 */
  broadcast: boolean;
}

export const emptyDesk: Desk = { root: null, groups: {}, activeGroup: null, zoomed: null, broadcast: false };

/** 칸 순서(왼쪽 위부터) */
export const groupOrder = (d: Desk): string[] => (d.root ? paneIds(d.root) : []);

export const groupOf = (d: Desk, paneId: string): Group | null =>
  Object.values(d.groups).find((g) => g.tabs.includes(paneId)) ?? null;

export const allTabs = (d: Desk): string[] => groupOrder(d).flatMap((id) => d.groups[id]?.tabs ?? []);

/** 화면에 보이는 터미널: 칸마다 보이는 탭 하나(크게 보기 중이면 그 칸 것만) */
export const visibleTabs = (d: Desk): string[] =>
  (d.zoomed ? [d.zoomed] : groupOrder(d)).map((id) => d.groups[id]?.active).filter((x): x is string => !!x);

/** 지금 입력이 가는 터미널 */
export const activePane = (d: Desk): string | null => (d.activeGroup ? (d.groups[d.activeGroup]?.active ?? null) : null);

const withGroup = (d: Desk, g: Group): Desk => ({ ...d, groups: { ...d.groups, [g.id]: g } });

/**
 * 탭을 칸에 넣는다. 칸이 없으면(처음) 새 칸을 만든다. index를 주지 않으면 맨 뒤에.
 * newGroupId는 칸을 새로 만들어야 할 때만 쓴다.
 */
export function addTab(d: Desk, paneId: string, newGroupId: string, groupId?: string | null, index?: number): Desk {
  const gid = groupId && d.groups[groupId] ? groupId : d.activeGroup && d.groups[d.activeGroup] ? d.activeGroup : groupOrder(d)[0];
  if (!d.root || !gid) {
    const g: Group = { id: newGroupId, tabs: [paneId], active: paneId };
    return { ...d, root: pane(g.id), groups: { [g.id]: g }, activeGroup: g.id, zoomed: null };
  }
  const g = d.groups[gid];
  const tabs = [...g.tabs];
  tabs.splice(index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length)), 0, paneId);
  return { ...withGroup(d, { ...g, tabs, active: paneId }), activeGroup: gid };
}

export function activate(d: Desk, paneId: string): Desk {
  const g = groupOf(d, paneId);
  if (!g) return d;
  if (g.active === paneId && d.activeGroup === g.id) return d;
  return { ...withGroup(d, { ...g, active: paneId }), activeGroup: g.id };
}

export function activateGroup(d: Desk, groupId: string): Desk {
  return d.groups[groupId] && d.activeGroup !== groupId ? { ...d, activeGroup: groupId } : d;
}

/** 탭 하나를 뺀다. 칸이 비면 칸도 없앤다. */
function removeTab(d: Desk, paneId: string): Desk {
  const g = groupOf(d, paneId);
  if (!g) return d;
  const i = g.tabs.indexOf(paneId);
  const tabs = g.tabs.filter((t) => t !== paneId);
  if (tabs.length) {
    // 보던 탭이 닫히면 오른쪽(없으면 왼쪽) 탭을 보여 준다.
    const active = g.active === paneId ? tabs[Math.min(i, tabs.length - 1)] : g.active;
    return withGroup(d, { ...g, tabs, active });
  }
  const root = d.root ? closePane(d.root, g.id) : null;
  const { [g.id]: _, ...groups } = d.groups;
  if (!root) return emptyDesk;
  const remaining = paneIds(root);
  return {
    ...d,
    root,
    groups,
    activeGroup: d.activeGroup === g.id ? remaining[0] : d.activeGroup,
    zoomed: d.zoomed === g.id ? null : d.zoomed,
  };
}

export const closeTabs = (d: Desk, ids: string[]): Desk => ids.reduce(removeTab, d);

/** groupId 칸의 side 쪽에 새 칸을 만들고 paneId(아직 어느 칸에도 없는 탭)를 넣는다. */
export function splitWith(d: Desk, groupId: string, side: DropSide, paneId: string, newGroupId: string): Desk {
  if (!d.root || !d.groups[groupId]) return d;
  const g: Group = { id: newGroupId, tabs: [paneId], active: paneId };
  return {
    ...withGroup(d, g),
    root: insertBeside(d.root, groupId, pane(newGroupId), side),
    activeGroup: newGroupId,
    zoomed: null,
  };
}

export type TabDrop = { kind: "bar"; groupId: string; index: number } | { kind: "edge"; groupId: string; side: DropSide };

/** 끌어다 놓은 탭을 옮길 수 있는지(아무것도 바뀌지 않는 경우는 false) */
export function canDrop(d: Desk, paneId: string, drop: TabDrop): boolean {
  const src = groupOf(d, paneId);
  if (!src || !d.groups[drop.groupId]) return false;
  if (drop.kind === "edge") return !(src.id === drop.groupId && src.tabs.length === 1);
  if (src.id !== drop.groupId) return true;
  const from = src.tabs.indexOf(paneId);
  return drop.index !== from && drop.index !== from + 1;
}

/** 탭을 다른 칸의 탭 줄(index 자리)이나 칸 가장자리(새 칸)로 옮긴다. */
export function moveTab(d: Desk, paneId: string, drop: TabDrop, newGroupId: string): Desk {
  if (!canDrop(d, paneId, drop)) return d;
  const src = groupOf(d, paneId)!;
  if (drop.kind === "bar") {
    if (src.id === drop.groupId) {
      const from = src.tabs.indexOf(paneId);
      const tabs = src.tabs.filter((t) => t !== paneId);
      tabs.splice(drop.index > from ? drop.index - 1 : drop.index, 0, paneId);
      return { ...withGroup(d, { ...src, tabs, active: paneId }), activeGroup: src.id };
    }
    const rest = removeTab(d, paneId);
    const target = rest.groups[drop.groupId];
    const tabs = [...target.tabs];
    tabs.splice(Math.min(drop.index, tabs.length), 0, paneId);
    return { ...withGroup(rest, { ...target, tabs, active: paneId }), activeGroup: target.id, zoomed: null };
  }
  const rest = removeTab(d, paneId);
  return splitWith(rest, drop.groupId, drop.side, paneId, newGroupId);
}

/** groupId 칸을 4칸으로 나눈다. 새 3칸에는 paneIds를 하나씩 넣는다. */
export function quad(d: Desk, groupId: string, panes3: [string, string, string], groups3: [string, string, string]): Desk {
  if (!d.root || !d.groups[groupId]) return d;
  let next: Desk = { ...d, root: splitQuad(d.root, groupId, groups3), zoomed: null };
  groups3.forEach((gid, i) => (next = withGroup(next, { id: gid, tabs: [panes3[i]], active: panes3[i] })));
  return next;
}

/** 분할을 모두 풀어 탭을 지금 칸 하나에 모은다(칸 순서대로). */
export function unsplitAll(d: Desk): Desk {
  if (!d.root || !d.activeGroup) return d;
  const keep = d.groups[d.activeGroup];
  const tabs = allTabs(d);
  return { ...d, root: pane(keep.id), groups: { [keep.id]: { ...keep, tabs } }, zoomed: null };
}

export const resize = (d: Desk, path: number[], ratio: number): Desk => (d.root ? { ...d, root: setRatio(d.root, path, ratio) } : d);

export function toggleZoom(d: Desk, groupId: string): Desk {
  if (groupOrder(d).length < 2) return d;
  return { ...d, zoomed: d.zoomed === groupId ? null : groupId, activeGroup: groupId };
}

// ---- 키보드로 칸 이동 ----

export type Dir = "left" | "right" | "up" | "down";
export interface Rect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * from 칸에서 dir 쪽으로 가장 가까운 칸. 그쪽으로 겹치는(가로 이동이면 세로로 겹치는) 칸을 먼저 고르고,
 * 같으면 중심이 가까운 칸. 없으면 null.
 */
export function neighborGroup(rects: Rect[], fromId: string, dir: Dir): string | null {
  const from = rects.find((r) => r.id === fromId);
  if (!from) return null;
  const cx = (r: Rect) => (r.left + r.right) / 2;
  const cy = (r: Rect) => (r.top + r.bottom) / 2;
  const ahead = (r: Rect) =>
    dir === "left" ? r.right <= from.left + 1 : dir === "right" ? r.left >= from.right - 1 : dir === "up" ? r.bottom <= from.top + 1 : r.top >= from.bottom - 1;
  const overlap = (r: Rect) =>
    dir === "left" || dir === "right"
      ? Math.min(r.bottom, from.bottom) - Math.max(r.top, from.top)
      : Math.min(r.right, from.right) - Math.max(r.left, from.left);
  const candidates = rects.filter((r) => r.id !== fromId && ahead(r));
  if (!candidates.length) return null;
  const dist = (r: Rect) => Math.hypot(cx(r) - cx(from), cy(r) - cy(from));
  candidates.sort((a, b) => {
    const oa = overlap(a) > 0 ? 1 : 0;
    const ob = overlap(b) > 0 ? 1 : 0;
    return ob - oa || dist(a) - dist(b);
  });
  return candidates[0].id;
}

/** 지금 칸의 다음/이전 탭(끝에서 처음으로 돈다) */
export function cycleTab(d: Desk, step: 1 | -1): Desk {
  const g = d.activeGroup ? d.groups[d.activeGroup] : null;
  if (!g || g.tabs.length < 2) return d;
  const i = g.tabs.indexOf(g.active);
  return activate(d, g.tabs[(i + step + g.tabs.length) % g.tabs.length]);
}

/** 지금 칸의 n번째 탭(1부터). 9는 늘 마지막 탭 */
export function nthTab(d: Desk, n: number): Desk {
  const g = d.activeGroup ? d.groups[d.activeGroup] : null;
  if (!g) return d;
  const t = n >= 9 ? g.tabs[g.tabs.length - 1] : g.tabs[n - 1];
  return t ? activate(d, t) : d;
}

// ---- 작업 공간 저장·복원 ----
// 비밀 정보 없이 배치와 세션 id만 저장한다. 터미널 id는 다시 열 때 새로 만든다.

export interface SavedTab {
  /** 저장된 세션 id. null이면 로컬 셸 */
  sessionId: string | null;
  /** 사용자가 바꾼 탭 이름 */
  name?: string;
}
export interface SavedWorkspace {
  v: 1;
  root: LayoutNode;
  groups: Record<string, { tabs: SavedTab[]; active: number }>;
  activeGroup: string | null;
}

export function saveWorkspace(d: Desk, tabInfo: (paneId: string) => SavedTab | null): SavedWorkspace | null {
  if (!d.root) return null;
  const groups: SavedWorkspace["groups"] = {};
  for (const id of groupOrder(d)) {
    const g = d.groups[id];
    const tabs = g.tabs.map(tabInfo).filter((t): t is SavedTab => !!t);
    groups[id] = { tabs, active: Math.max(0, g.tabs.indexOf(g.active)) };
  }
  return { v: 1, root: d.root, groups, activeGroup: d.activeGroup };
}

/** 저장된 탭 수 */
export const savedTabCount = (w: SavedWorkspace): number => Object.values(w.groups).reduce((n, g) => n + g.tabs.length, 0);

/**
 * 저장해 둔 배치로 작업 공간을 다시 만든다. 지워진 세션의 탭은 빼고, 빈 칸은 없앤다.
 * 돌려준 opened는 새 터미널 id → 그 탭 정보(다시 연결할 세션).
 */
export function restoreWorkspace(
  w: SavedWorkspace,
  sessionExists: (id: string) => boolean,
  newId: () => string,
): { desk: Desk; opened: [string, SavedTab][] } {
  let root: LayoutNode | null = w.root;
  const groups: Record<string, Group> = {};
  const opened: [string, SavedTab][] = [];
  for (const gid of paneIds(w.root)) {
    const sg = w.groups[gid];
    const kept = (sg?.tabs ?? []).filter((t) => t.sessionId === null || sessionExists(t.sessionId));
    if (!kept.length) {
      root = root ? closePane(root, gid) : null;
      continue;
    }
    const ids = kept.map(() => newId());
    kept.forEach((t, i) => opened.push([ids[i], t]));
    const active = ids[Math.min(sg.active, ids.length - 1)] ?? ids[0];
    groups[gid] = { id: gid, tabs: ids, active };
  }
  if (!root || !Object.keys(groups).length) return { desk: emptyDesk, opened: [] };
  const order = paneIds(root);
  const activeGroup = w.activeGroup && groups[w.activeGroup] ? w.activeGroup : order[0];
  return { desk: { root, groups, activeGroup, zoomed: null, broadcast: false }, opened };
}
