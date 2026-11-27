import { tx } from "./i18n";
// 세션 모델과 사이드바 묶음 규칙.
// Rust 쪽 vault.rs의 Session 구조체와 필드 이름을 맞춘다(camelCase).

export type AuthMethod = "password" | "key" | "agent";

/** 서버 환경 색. 운영 서버를 빨강으로 두면 탭과 창 테두리에 보인다. */
export const SESSION_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type SessionColor = (typeof SESSION_COLORS)[number];
export const COLOR_LABEL: Record<SessionColor, string> = {
  red: tx("빨강 (운영)"),
  orange: tx("주황 (스테이징)"),
  yellow: tx("노랑"),
  green: tx("초록 (개발)"),
  blue: tx("파랑"),
  purple: tx("보라"),
};

/** 세션 그룹. 세션 없이 미리 만들 수 있고 색을 정할 수 있다(설정 → 그룹). */
export interface Group {
  name: string;
  color?: SessionColor | null;
}

export type ForwardKind = "local" | "remote" | "dynamic";

/** 포트 포워딩 하나. dynamic(SOCKS)은 host/port를 쓰지 않는다. */
export interface Forward {
  kind: ForwardKind;
  bindPort: number;
  host?: string;
  port?: number;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export interface Session {
  id: string;
  name: string;
  /** null 또는 빈 문자열이면 그룹 없음 */
  group: string | null;
  kind: "local" | "ssh";
  // 로컬 셸
  shell?: string;
  /** 로컬 셸: 시작 폴더. SSH: 연결하자마자 이동할 경로(비우면 홈 폴더) */
  cwd?: string;
  // SSH
  host?: string;
  port?: number;
  user?: string;
  auth?: AuthMethod;
  /** 키를 가져올 때 읽은 원본 경로(표시용). 실제 키 내용은 보관함 안에만 있다. */
  keyPath?: string;
  color?: SessionColor | null;
  /** 거쳐 갈 서버(다른 SSH 세션의 id) */
  jumpId?: string | null;
  forwards?: Forward[];
  /** 터미널 출력을 시각과 함께 파일로 남긴다 */
  logOutput?: boolean;
  /** 바로 접속을 끈 세션: 비밀번호를 저장하지 않고 연결할 때마다 묻는다 */
  askLogin?: boolean;
  // 보관함에 비밀 정보가 있는지 여부만 받는다. 내용은 프론트엔드로 넘어오지 않는다.
  hasPassword?: boolean;
  hasPrivateKey?: boolean;
  hasPassphrase?: boolean;
}

export const UNGROUPED_LABEL = tx("그룹 없음");

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
export function groupSessions(list: Session[], extraGroups: string[] = [], manual = false): SessionSection[] {
  const extra = extraGroups.map((g) => g.trim()).filter(Boolean);
  if (list.length === 0 && extra.length === 0) return [];
  // 직접 정한 순서(manual)면 그룹은 extraGroups 순서, 세션은 목록 순서 그대로. 아니면 가나다순.
  const sort = (xs: Session[]) => (manual ? xs : [...xs].sort(byName));
  const all = [...new Set(manual ? [...extra, ...list.map(groupOf).filter((g): g is string => g !== null)] : [...list.map(groupOf).filter((g): g is string => g !== null), ...extra])];
  const names = manual ? all : all.sort((a, b) => a.localeCompare(b, "ko"));
  if (names.length === 0) return [{ title: null, sessions: sort(list) }];

  const sections: SessionSection[] = names.map((title) => ({
    title,
    sessions: sort(list.filter((s) => groupOf(s) === title)),
  }));
  const ungrouped = sort(list.filter((s) => groupOf(s) === null));
  if (ungrouped.length) sections.push({ title: UNGROUPED_LABEL, sessions: ungrouped });
  return sections;
}

/** 사이드바 배치: 그룹 순서와, 세션마다 순서대로 속한 그룹 */
export interface SidebarLayout {
  groups: string[];
  sessions: { id: string; group: string | null }[];
}

/** 섹션 제목을 그룹 이름으로(제목 없음·'그룹 없음'은 null) */
const groupOfSection = (sec: SessionSection): string | null => (sec.title === null || sec.title === UNGROUPED_LABEL ? null : sec.title);

export function layoutOf(sections: SessionSection[]): SidebarLayout {
  return {
    groups: sections.map(groupOfSection).filter((g): g is string => g !== null),
    sessions: sections.flatMap((sec) => sec.sessions.map((s) => ({ id: s.id, group: groupOfSection(sec) }))),
  };
}

/**
 * 세션 하나를 옮긴다. group 섹션의 beforeId 앞에 넣고, beforeId가 없으면 그 그룹 맨 끝에 넣는다.
 * 그룹을 바꾸면 세션의 그룹도 바뀐다.
 */
export function moveSession(sections: SessionSection[], id: string, group: string | null, beforeId: string | null): SessionSection[] {
  const moving = sections.flatMap((s) => s.sessions).find((s) => s.id === id);
  if (!moving || beforeId === id) return sections;
  const out = sections.map((sec) => ({ ...sec, sessions: sec.sessions.filter((s) => s.id !== id) }));
  let target = out.find((sec) => groupOfSection(sec) === group);
  if (!target) {
    // '그룹 없음' 섹션이 아직 없으면 만든다(그룹이 하나도 없으면 제목 없는 목록).
    target = { title: group ?? (out.some((s) => s.title !== null) ? UNGROUPED_LABEL : null), sessions: [] };
    out.push(target);
  }
  const at = beforeId ? target.sessions.findIndex((s) => s.id === beforeId) : -1;
  const moved = { ...moving, group };
  if (at < 0) target.sessions.push(moved);
  else target.sessions.splice(at, 0, moved);
  return out;
}

/** 그룹 하나를 before 그룹 앞으로 옮긴다(before가 없으면 그룹들 맨 끝, '그룹 없음' 앞). */
export function moveGroup(sections: SessionSection[], name: string, before: string | null): SessionSection[] {
  const sec = sections.find((s) => groupOfSection(s) === name);
  if (!sec || before === name) return sections;
  const rest = sections.filter((s) => s !== sec);
  const at = before ? rest.findIndex((s) => groupOfSection(s) === before) : rest.findIndex((s) => groupOfSection(s) === null);
  if (at < 0) rest.push(sec);
  else rest.splice(at, 0, sec);
  return rest;
}

export function describeForward(f: Forward): string {
  const dest = `${f.host || "?"}:${f.port || "?"}`;
  if (f.kind === "local") return tx("내 PC :{0} → {1}", f.bindPort, dest);
  if (f.kind === "remote") return tx("서버 :{0} → 내 PC {1}", f.bindPort, dest);
  return `SOCKS5 :${f.bindPort}`;
}

/** 저장하기 전에 확인한다. 문제가 있으면 사용자에게 보여 줄 문장을 돌려준다. */
export function forwardProblem(f: Forward): string | null {
  const okPort = (p: number | undefined) => !!p && p >= 1 && p <= 65535;
  if (!okPort(f.bindPort)) return tx("포워딩 포트는 1~65535 사이여야 합니다.");
  if (f.kind !== "dynamic" && (!f.host?.trim() || !okPort(f.port))) return tx("포워딩 목적지의 호스트와 포트를 입력하세요.");
  return null;
}

export function filterSessions(list: Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    [s.name, s.group ?? "", s.host ?? "", s.user ?? ""].some((v) => v.toLowerCase().includes(q)),
  );
}

export function describeSession(s: Session): string {
  if (s.kind === "local") return tx("{0} · 로컬", s.shell || tx("기본 셸"));
  const port = s.port && s.port !== 22 ? `:${s.port}` : "";
  return `${s.user ? s.user + "@" : ""}${s.host ?? ""}${port}`;
}

