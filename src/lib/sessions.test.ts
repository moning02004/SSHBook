import { describe, expect, it } from "vitest";
import { groupSessions, type Session, UNGROUPED_LABEL } from "./sessions";

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
});
