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
