import { describe, expect, it } from "vitest";
import { groupSessions, layoutOf, moveGroup, moveSession, type Session, UNGROUPED_LABEL } from "./sessions";

const s = (name: string, group: string | null = null): Session => ({ id: name, name, group, kind: "ssh" });

describe("groupSessions", () => {
  it("세션이 없으면 빈 목록", () => {
    expect(groupSessions([])).toEqual([]);
  });

  it("그룹을 하나도 안 쓰면 '그룹 없음' 없이 제목 없는 목록 하나", () => {
    const r = groupSessions([s("b"), s("a"), s("c", "  ")]);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBeNull();
    expect(r[0].sessions.map((x) => x.name)).toEqual(["a", "b", "c"]);
  });

  it("그룹이 하나라도 생기면 그룹 없는 세션은 맨 아래 '그룹 없음'으로", () => {
    const r = groupSessions([s("local"), s("web", "운영"), s("dev", "개발"), s("db", "운영")]);
    expect(r.map((x) => x.title)).toEqual(["개발", "운영", UNGROUPED_LABEL]);
    expect(r[1].sessions.map((x) => x.name)).toEqual(["db", "web"]);
    expect(r[2].sessions.map((x) => x.name)).toEqual(["local"]);
  });

  it("모든 세션에 그룹이 있으면 '그룹 없음' 묶음은 만들지 않는다", () => {
    const r = groupSessions([s("web", "운영")]);
    expect(r.map((x) => x.title)).toEqual(["운영"]);
  });

  it("미리 만든 그룹은 세션이 없어도 빈 묶음으로 보인다", () => {
    const r = groupSessions([s("local"), s("web", "운영")], ["개발", "운영", " "]);
    expect(r.map((x) => [x.title, x.sessions.length])).toEqual([
      ["개발", 0],
      ["운영", 1],
      [UNGROUPED_LABEL, 1],
    ]);
    expect(groupSessions([], ["개발"]).map((x) => x.title)).toEqual(["개발"]);
  });
});

describe("직접 정한 순서", () => {
  const mk = (id: string, name: string, group?: string): Session => ({ id, name, kind: "ssh", host: "h", group: group ?? null }) as Session;
  const list = [mk("c", "다", "운영"), mk("a", "가", "개발"), mk("b", "나", "운영"), mk("d", "라")];

  it("manual이면 그룹과 세션을 주어진 순서대로 둔다", () => {
    const secs = groupSessions(list, ["운영", "개발"], true);
    expect(secs.map((x) => x.title)).toEqual(["운영", "개발", UNGROUPED_LABEL]);
    expect(secs[0].sessions.map((x) => x.id)).toEqual(["c", "b"]);
    // manual이 아니면 지금처럼 가나다순
    expect(groupSessions(list, ["운영", "개발"]).map((x) => x.title)).toEqual(["개발", "운영", UNGROUPED_LABEL]);
  });

  it("세션을 같은 그룹 안에서, 다른 그룹으로, 그룹 없음으로 옮긴다", () => {
    const secs = groupSessions(list, ["운영", "개발"], true);
    expect(layoutOf(moveSession(secs, "b", "운영", "c")).sessions.map((x) => x.id)).toEqual(["b", "c", "a", "d"]);
    const moved = layoutOf(moveSession(secs, "c", "개발", null));
    expect(moved.sessions).toEqual([
      { id: "b", group: "운영" },
      { id: "a", group: "개발" },
      { id: "c", group: "개발" },
      { id: "d", group: null },
    ]);
    expect(layoutOf(moveSession(secs, "a", null, "d")).sessions.at(-2)).toEqual({ id: "a", group: null });
  });

  it("그룹 순서를 바꾸고, '그룹 없음'은 늘 맨 끝에 둔다", () => {
    const secs = groupSessions(list, ["운영", "개발"], true);
    expect(layoutOf(moveGroup(secs, "개발", "운영")).groups).toEqual(["개발", "운영"]);
    const toEnd = moveGroup(moveGroup(secs, "개발", "운영"), "개발", null);
    expect(toEnd.map((x) => x.title)).toEqual(["운영", "개발", UNGROUPED_LABEL]);
  });

  it("빈 그룹으로도 옮긴다", () => {
    const secs = groupSessions(list, ["운영", "개발", "빈"], true);
    expect(layoutOf(moveSession(secs, "d", "빈", null)).sessions.at(-1)).toEqual({ id: "d", group: "빈" });
  });
});
