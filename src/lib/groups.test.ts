import { describe, expect, it } from "vitest";
import {
  activate,
  addTab,
  cycleTab,
  neighborGroup,
  nthTab,
  restoreWorkspace,
  savedTabCount,
  saveWorkspace,
  allTabs,
  canDrop,
  closeTabs,
  emptyDesk,
  groupOf,
  groupOrder,
  moveTab,
  quad,
  splitWith,
  toggleZoom,
  unsplitAll,
  visibleTabs,
  type Desk,
} from "./groups";

/** 칸 g1에 탭 a b c */
const oneGroup = (): Desk => ["a", "b", "c"].reduce((d, id) => addTab(d, id, "g1"), emptyDesk);

describe("addTab / closeTabs", () => {
  it("creates the first group and appends tabs", () => {
    const d = oneGroup();
    expect(groupOrder(d)).toEqual(["g1"]);
    expect(d.groups.g1.tabs).toEqual(["a", "b", "c"]);
    expect(d.groups.g1.active).toBe("c");
  });

  it("shows the neighbour when the visible tab closes, and removes empty groups", () => {
    let d = activate(oneGroup(), "b");
    d = closeTabs(d, ["b"]);
    expect(d.groups.g1.active).toBe("c");
    d = splitWith(d, "g1", "right", "x", "g2");
    expect(groupOrder(d)).toEqual(["g1", "g2"]);
    d = closeTabs(d, ["x"]);
    expect(groupOrder(d)).toEqual(["g1"]);
    expect(d.activeGroup).toBe("g1");
    expect(closeTabs(d, ["a", "c"])).toEqual(emptyDesk);
  });
});

describe("moveTab", () => {
  it("reorders within the tab bar", () => {
    const d = moveTab(oneGroup(), "c", { kind: "bar", groupId: "g1", index: 0 }, "n");
    expect(d.groups.g1.tabs).toEqual(["c", "a", "b"]);
    // 제자리에 놓는 것은 옮기기가 아니다.
    expect(canDrop(oneGroup(), "a", { kind: "bar", groupId: "g1", index: 1 })).toBe(false);
  });

  it("drags a tab to an edge to make a new group, then into another group's bar", () => {
    let d = moveTab(oneGroup(), "b", { kind: "edge", groupId: "g1", side: "right" }, "g2");
    expect(groupOrder(d)).toEqual(["g1", "g2"]);
    expect(d.groups.g1.tabs).toEqual(["a", "c"]);
    expect(d.groups.g2.tabs).toEqual(["b"]);
    expect(d.activeGroup).toBe("g2");

    // g2의 유일한 탭을 g1 탭 줄로 → g2는 사라진다
    d = moveTab(d, "b", { kind: "bar", groupId: "g1", index: 1 }, "n");
    expect(groupOrder(d)).toEqual(["g1"]);
    expect(d.groups.g1.tabs).toEqual(["a", "b", "c"]);
    expect(groupOf(d, "b")?.id).toBe("g1");
  });

  it("refuses to split a group with its own only tab", () => {
    const d = splitWith(oneGroup(), "g1", "bottom", "x", "g2");
    expect(canDrop(d, "x", { kind: "edge", groupId: "g2", side: "left" })).toBe(false);
    expect(moveTab(d, "x", { kind: "edge", groupId: "g2", side: "left" }, "g3")).toBe(d);
    // 다른 칸 가장자리에는 된다.
    expect(groupOrder(moveTab(d, "x", { kind: "edge", groupId: "g1", side: "left" }, "g3"))).toEqual(["g3", "g1"]);
  });
});

describe("visible tabs, zoom, quad, unsplit", () => {
  it("lists one visible tab per group", () => {
    let d = splitWith(oneGroup(), "g1", "right", "x", "g2");
    expect(visibleTabs(d)).toEqual(["c", "x"]);
    d = toggleZoom(d, "g1");
    expect(visibleTabs(d)).toEqual(["c"]);
  });

  it("quads a group and merges everything back", () => {
    let d = quad(oneGroup(), "g1", ["p", "q", "r"], ["g2", "g3", "g4"]);
    expect(groupOrder(d).sort()).toEqual(["g1", "g2", "g3", "g4"]);
    expect(visibleTabs(d).sort()).toEqual(["c", "p", "q", "r"]);
    d = unsplitAll(d);
    expect(groupOrder(d)).toEqual(["g1"]);
    expect(allTabs(d).sort()).toEqual(["a", "b", "c", "p", "q", "r"]);
  });
});


describe("keyboard navigation", () => {
  // g1 | g2
  //    | g3
  const rects = [
    { id: "g1", left: 0, top: 0, right: 100, bottom: 200 },
    { id: "g2", left: 110, top: 0, right: 200, bottom: 95 },
    { id: "g3", left: 110, top: 105, right: 200, bottom: 200 },
  ];
  it("finds the pane in that direction", () => {
    expect(neighborGroup(rects, "g1", "right")).toMatch(/g2|g3/);
    expect(neighborGroup(rects, "g2", "down")).toBe("g3");
    expect(neighborGroup(rects, "g3", "up")).toBe("g2");
    expect(neighborGroup(rects, "g3", "left")).toBe("g1");
    expect(neighborGroup(rects, "g1", "left")).toBeNull();
  });

  it("cycles and jumps between tabs", () => {
    const d = oneGroup(); // a b c, c 보임
    expect(cycleTab(d, 1).groups.g1.active).toBe("a");
    expect(cycleTab(d, -1).groups.g1.active).toBe("b");
    expect(nthTab(d, 1).groups.g1.active).toBe("a");
    expect(nthTab(d, 9).groups.g1.active).toBe("c");
    expect(nthTab(d, 5)).toBe(d);
  });
});

describe("workspace save/restore", () => {
  it("round-trips layout, names and the visible tab, dropping deleted sessions", () => {
    let d = splitWith(oneGroup(), "g1", "right", "x", "g2");
    d = activate(d, "b");
    const info: Record<string, { sessionId: string | null; name?: string }> = {
      a: { sessionId: "s-a" },
      b: { sessionId: "s-b", name: "로그" },
      c: { sessionId: null },
      x: { sessionId: "s-gone" },
    };
    const saved = saveWorkspace(d, (id) => info[id])!;
    expect(savedTabCount(saved)).toBe(4);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);

    let n = 0;
    const { desk, opened } = restoreWorkspace(saved, (id) => id !== "s-gone", () => `p${++n}`);
    // s-gone만 있던 g2는 사라진다
    expect(groupOrder(desk)).toEqual(["g1"]);
    expect(opened.map(([, t]) => t.sessionId)).toEqual(["s-a", "s-b", null]);
    expect(opened[1][1].name).toBe("로그");
    // 보이던 탭(b = 두 번째)이 다시 보인다
    expect(desk.groups.g1.active).toBe(opened[1][0]);
  });

  it("restores nothing when every session is gone", () => {
    const saved = saveWorkspace(addTab(emptyDesk, "a", "g1"), () => ({ sessionId: "gone" }))!;
    expect(restoreWorkspace(saved, () => false, () => "p").desk).toEqual(emptyDesk);
  });
});
