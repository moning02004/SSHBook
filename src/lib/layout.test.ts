import { describe, expect, it } from "vitest";
import { closePane, insertBeside, movePane, pane, paneIds, ratioOf, setRatio, sideAt, splitPane, splitQuad, unsplit } from "./layout";

describe("layout", () => {
  it("단일 창을 오른쪽으로 분할하면 row 분할이 된다", () => {
    const r = splitPane(pane("a"), "a", "row", "b");
    expect(r).toEqual({ kind: "split", dir: "row", children: [pane("a"), pane("b")] });
  });

  it("분할된 창을 다시 아래로 나눌 수 있다", () => {
    const r = splitPane(splitPane(pane("a"), "a", "row", "b"), "b", "column", "c");
    expect(paneIds(r)).toEqual(["a", "b", "c"]);
  });

  it("4분할은 왼쪽 위, 왼쪽 아래, 오른쪽 위, 오른쪽 아래 순서의 트리가 된다", () => {
    const r = splitQuad(pane("a"), "a", ["tr", "bl", "br"]);
    expect(paneIds(r)).toEqual(["a", "bl", "tr", "br"]);
  });

  it("창을 닫으면 형제가 부모 자리를 차지한다", () => {
    const r = splitPane(pane("a"), "a", "row", "b");
    expect(closePane(r, "b")).toEqual(pane("a"));
    expect(closePane(pane("a"), "a")).toBeNull();
  });

  it("분할 해제는 고른 창만 남기고 나머지 id를 돌려준다", () => {
    const r = splitQuad(pane("a"), "a", ["b", "c", "d"]);
    const { root, detached } = unsplit(r, "c");
    expect(root).toEqual(pane("c"));
    expect(detached.sort()).toEqual(["a", "b", "d"]);
  });

  it("없는 창을 대상으로 하면 트리를 그대로 둔다", () => {
    const r = pane("a");
    expect(splitPane(r, "zzz", "row", "b")).toBe(r);
    expect(unsplit(r, "zzz")).toEqual({ root: r, detached: [] });
  });
});

describe("setRatio", () => {
  it("changes the split at the path and clamps", () => {
    const root = splitQuad(pane("a"), "a", ["b", "c", "d"]);
    const r1 = setRatio(root, [], 0.7);
    expect(ratioOf(r1)).toBeCloseTo(0.7);
    const r2 = setRatio(r1, [1], 0.01);
    expect(r2.kind === "split" && ratioOf(r2.children[1])).toBeCloseTo(0.15);
    // 다른 칸은 그대로
    expect(r2.kind === "split" && ratioOf(r2.children[0])).toBe(0.5);
    expect(paneIds(r2)).toEqual(paneIds(root));
  });

  it("snaps back to half and ignores panes", () => {
    const root = splitPane(pane("a"), "a", "row", "b");
    const r = setRatio(setRatio(root, [], 0.8), [], 0.501);
    expect(r.kind === "split" && r.ratio).toBeUndefined();
    expect(setRatio(pane("a"), [], 0.3)).toEqual(pane("a"));
  });
});

describe("insertBeside", () => {
  it("puts another tab's layout on the chosen side", () => {
    const other = splitPane(pane("x"), "x", "column", "y");
    const right = insertBeside(pane("a"), "a", other, "right");
    expect(right).toEqual({ kind: "split", dir: "row", children: [pane("a"), other] });
    const top = insertBeside(pane("a"), "a", pane("b"), "top");
    expect(top).toEqual({ kind: "split", dir: "column", children: [pane("b"), pane("a")] });
  });

  it("only touches the target pane", () => {
    const root = splitPane(pane("a"), "a", "row", "b");
    expect(paneIds(insertBeside(root, "b", pane("c"), "left"))).toEqual(["a", "c", "b"]);
  });
});

describe("movePane", () => {
  it("moves a pane next to another one in the same tab", () => {
    const root = splitQuad(pane("a"), "a", ["b", "c", "d"]); // a b / c d → 순서 a c b d
    const moved = movePane(root, "a", "d", "bottom");
    expect(paneIds(moved).sort()).toEqual(["a", "b", "c", "d"]);
    expect(paneIds(moved).indexOf("a")).toBe(paneIds(moved).indexOf("d") + 1);
  });

  it("ignores moving onto itself or unknown panes", () => {
    const root = splitPane(pane("a"), "a", "row", "b");
    expect(movePane(root, "a", "a", "left")).toBe(root);
    expect(movePane(root, "z", "a", "left")).toBe(root);
  });
});

describe("sideAt", () => {
  const r = { left: 0, top: 0, width: 300, height: 300 };
  it("picks the nearest edge, or nothing in the middle", () => {
    expect(sideAt(20, 150, r)).toBe("left");
    expect(sideAt(290, 150, r)).toBe("right");
    expect(sideAt(150, 10, r)).toBe("top");
    expect(sideAt(150, 280, r)).toBe("bottom");
    expect(sideAt(150, 150, r)).toBeNull();
    expect(sideAt(-5, 150, r)).toBeNull();
  });
});
