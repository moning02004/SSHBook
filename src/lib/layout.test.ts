import { describe, expect, it } from "vitest";
import { closePane, pane, paneIds, splitPane, splitQuad, unsplit } from "./layout";

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
