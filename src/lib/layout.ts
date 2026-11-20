// 한 탭 안의 창 배치를 이진 트리로 표현한다.
// "오른쪽으로 분할" = row, "아래로 분할" = column. 4분할은 row 안에 column 두 개.

export type SplitDir = "row" | "column";

export type LayoutNode =
  | { kind: "pane"; id: string }
  | { kind: "split"; dir: SplitDir; children: [LayoutNode, LayoutNode] };

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
