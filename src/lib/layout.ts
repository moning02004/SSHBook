// 한 탭 안의 창 배치를 이진 트리로 표현한다.
// "오른쪽으로 분할" = row, "아래로 분할" = column. 4분할은 row 안에 column 두 개.

export type SplitDir = "row" | "column";

export type LayoutNode =
  | { kind: "pane"; id: string }
  /** ratio: 첫째 칸이 차지하는 몫(0~1). 없으면 반반 */
  | { kind: "split"; dir: SplitDir; children: [LayoutNode, LayoutNode]; ratio?: number };

export const MIN_RATIO = 0.15;
export const ratioOf = (node: LayoutNode): number => (node.kind === "split" ? (node.ratio ?? 0.5) : 1);

/**
 * path(0=첫째, 1=둘째 칸을 따라 내려가는 길)에 있는 분할의 비율을 바꾼다.
 * 너무 좁아지지 않게 MIN_RATIO ~ 1-MIN_RATIO로 묶는다.
 */
export function setRatio(root: LayoutNode, path: number[], ratio: number): LayoutNode {
  if (root.kind !== "split") return root;
  if (path.length === 0) {
    const r = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
    return { ...root, ratio: Math.abs(r - 0.5) < 0.005 ? undefined : r };
  }
  const [i, ...rest] = path;
  const children = [...root.children] as [LayoutNode, LayoutNode];
  children[i] = setRatio(children[i], rest, ratio);
  return { ...root, children };
}

export const pane = (id: string): LayoutNode => ({ kind: "pane", id });

export function paneIds(node: LayoutNode): string[] {
  return node.kind === "pane" ? [node.id] : [...paneIds(node.children[0]), ...paneIds(node.children[1])];
}

export function isSplit(node: LayoutNode): boolean {
  return node.kind === "split";
}

function replacePane(node: LayoutNode, targetId: string, make: () => LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.id === targetId ? make() : node;
  const [a, b] = node.children;
  const na = replacePane(a, targetId, make);
  const nb = replacePane(b, targetId, make);
  return na === a && nb === b ? node : { ...node, children: [na, nb] };
}

/** targetId 창을 둘로 나눈다. 기존 창은 왼쪽(위), 새 창은 오른쪽(아래)에 놓인다. */
export function splitPane(root: LayoutNode, targetId: string, dir: SplitDir, newId: string): LayoutNode {
  return replacePane(root, targetId, () => ({ kind: "split", dir, children: [pane(targetId), pane(newId)] }));
}

/** targetId 창을 4분할한다. 순서: 왼쪽 위(기존), 오른쪽 위, 왼쪽 아래, 오른쪽 아래. */
export function splitQuad(root: LayoutNode, targetId: string, newIds: [string, string, string]): LayoutNode {
  const [tr, bl, br] = newIds;
  return replacePane(root, targetId, () => ({
    kind: "split",
    dir: "row",
    children: [
      { kind: "split", dir: "column", children: [pane(targetId), pane(bl)] },
      { kind: "split", dir: "column", children: [pane(tr), pane(br)] },
    ],
  }));
}

/** 창 하나를 닫는다. 남은 형제가 부모 자리를 차지한다. 마지막 창을 닫으면 null. */
export function closePane(root: LayoutNode, id: string): LayoutNode | null {
  if (root.kind === "pane") return root.id === id ? null : root;
  const [a, b] = root.children;
  const na = closePane(a, id);
  const nb = closePane(b, id);
  if (na === null) return nb;
  if (nb === null) return na;
  return na === a && nb === b ? root : { ...root, children: [na, nb] };
}

/** 분할 해제: keepId 창만 남기고, 나머지 창 id는 따로 돌려준다(새 탭으로 옮기는 데 쓴다). */
export function unsplit(root: LayoutNode, keepId: string): { root: LayoutNode; detached: string[] } {
  const ids = paneIds(root);
  if (!ids.includes(keepId)) return { root, detached: [] };
  return { root: pane(keepId), detached: ids.filter((id) => id !== keepId) };
}

/** 창을 놓을 자리: 대상 창의 어느 쪽에 붙일지 */
export type DropSide = "left" | "right" | "top" | "bottom";

/**
 * targetId 창 옆에 tree(다른 탭의 배치 전체나 창 하나)를 붙인다.
 * left/top이면 tree가 앞(왼쪽·위)에, right/bottom이면 뒤(오른쪽·아래)에 온다.
 */
export function insertBeside(root: LayoutNode, targetId: string, tree: LayoutNode, side: DropSide): LayoutNode {
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  return replacePane(root, targetId, () => ({
    kind: "split",
    dir,
    children: before ? [tree, pane(targetId)] : [pane(targetId), tree],
  }));
}

/**
 * 같은 탭 안에서 창 하나를 다른 창 옆으로 옮긴다. 옮길 수 없으면(같은 창, 없는 창) 그대로 돌려준다.
 */
export function movePane(root: LayoutNode, paneId: string, targetId: string, side: DropSide): LayoutNode {
  const ids = paneIds(root);
  if (paneId === targetId || !ids.includes(paneId) || !ids.includes(targetId)) return root;
  const rest = closePane(root, paneId);
  return rest ? insertBeside(rest, targetId, pane(paneId), side) : root;
}

/**
 * 끌어서 놓을 자리. 창 안에서 가장 가까운 가장자리(가로·세로의 1/3 안쪽)를 고르고,
 * 가운데쯤이면 null(놓지 않음).
 */
export function sideAt(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): DropSide | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const d: [DropSide, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][1] <= 1 / 3 ? d[0][0] : null;
}
