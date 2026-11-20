// 세션 모델과 사이드바 묶음 규칙.
// Rust 쪽 vault.rs의 Session 구조체와 필드 이름을 맞춘다(camelCase).

export type AuthMethod = "password" | "key" | "agent";

export interface Session {
  id: string;
  name: string;
  /** null 또는 빈 문자열이면 그룹 없음 */
  group: string | null;
  kind: "local" | "ssh";
  // 로컬 셸
  shell?: string;
  cwd?: string;
  // SSH
  host?: string;
  port?: number;
  user?: string;
  auth?: AuthMethod;
  /** 키를 가져올 때 읽은 원본 경로(표시용). 실제 키 내용은 보관함 안에만 있다. */
  keyPath?: string;
  // 보관함에 비밀 정보가 있는지 여부만 받는다. 내용은 프론트엔드로 넘어오지 않는다.
  hasPassword?: boolean;
  hasPrivateKey?: boolean;
  hasPassphrase?: boolean;
}

export const UNGROUPED_LABEL = "그룹 없음";

export interface SessionSection {
  /** null이면 제목 없이 목록만 보여준다 */
  title: string | null;
  sessions: Session[];
}

const groupOf = (s: Session): string | null => {
  const g = s.group?.trim();
  return g ? g : null;
};

const byName = (a: Session, b: Session) => a.name.localeCompare(b.name, "ko");

/**
 * 그룹을 하나도 쓰지 않으면 제목 없는 목록 하나를 돌려준다.
 * 그룹이 하나라도 있으면 그룹별 묶음을 만들고, 그룹 없는 세션은 맨 아래 "그룹 없음"으로 모은다.
 */
export function groupSessions(list: Session[]): SessionSection[] {
  if (list.length === 0) return [];
  const names = [...new Set(list.map(groupOf).filter((g): g is string => g !== null))].sort((a, b) =>
    a.localeCompare(b, "ko"),
  );
  if (names.length === 0) return [{ title: null, sessions: [...list].sort(byName) }];

  const sections: SessionSection[] = names.map((title) => ({
    title,
    sessions: list.filter((s) => groupOf(s) === title).sort(byName),
  }));
  const ungrouped = list.filter((s) => groupOf(s) === null).sort(byName);
  if (ungrouped.length) sections.push({ title: UNGROUPED_LABEL, sessions: ungrouped });
  return sections;
}

export function filterSessions(list: Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    [s.name, s.group ?? "", s.host ?? "", s.user ?? ""].some((v) => v.toLowerCase().includes(q)),
  );
}

export function describeSession(s: Session): string {
  if (s.kind === "local") return `${s.shell || "기본 셸"} · 로컬`;
  const port = s.port && s.port !== 22 ? `:${s.port}` : "";
  return `${s.user ? s.user + "@" : ""}${s.host ?? ""}${port}`;
}

export function authLabel(s: Session): string {
  if (s.kind === "local") return "로컬";
  return s.auth === "key" ? "키" : s.auth === "agent" ? "에이전트" : "비밀번호";
}
