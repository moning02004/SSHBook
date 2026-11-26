import { useMemo, useState } from "react";
import { describeSession, filterSessions, groupSessions, UNGROUPED_LABEL, type Group, type Session } from "../lib/sessions";
import { IconEdit, IconPlus, IconSearch } from "./Icons";
import { tx } from "../lib/i18n";

interface Props {
  sessions: Session[];
  /** 미리 만든 그룹과 그룹 색(설정 → 그룹) */
  groups: Group[];
  connected: Set<string>;
  /** 지금 보고 있는 창의 세션 */
  selectedId: string | null;
  onOpen: (s: Session) => void;
  onEdit: (s: Session) => void;
  /** 세션을 오른쪽 클릭했을 때 */
  onMenu: (s: Session, x: number, y: number) => void;
  onNew: () => void;
  /** 그룹 이름 바꾸기(빈 이름이면 그룹 없음으로) */
  onRenameGroup: (from: string, to: string) => void;
}

const COLLAPSED_KEY = "sshbook.collapsedGroups";

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function Sidebar({ sessions, groups, connected, selectedId, onOpen, onEdit, onMenu, onNew, onRenameGroup }: Props) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  // 접은 그룹. 다음에 켤 때도 그대로 둔다.
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(title)) next.add(title);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 저장하지 못해도 이번 실행 동안은 접힌 채로 둔다.
      }
      return next;
    });
  // 검색할 때는 찾은 세션이 있는 그룹만 보인다.
  const sections = useMemo(
    () => groupSessions(filterSessions(sessions, query), query.trim() ? [] : groups.map((g) => g.name)),
    [sessions, groups, query],
  );
  const colorOf = useMemo(() => new Map(groups.map((g) => [g.name, g.color ?? null])), [groups]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <label className="search">
          <IconSearch width={14} height={14} />
          <input aria-label={tx("세션 검색")} placeholder={tx("세션 검색")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="btn primary" onClick={onNew}>
          <IconPlus width={14} height={14} />{" "}{tx("새 세션")}
        </button>
      </div>

      <nav className="session-list" aria-label={tx("저장된 세션")}>
        {sessions.length === 0 && <p className="empty">{tx("저장된 세션이 없습니다. '새 세션'으로 SSH 서버를 추가하세요.")}</p>}
        {sections.map((sec) => {
          // 검색 중에는 찾은 세션이 가려지지 않게 모두 펼친다.
          const folded = !!sec.title && !query.trim() && collapsed.has(sec.title);
          const color = sec.title ? colorOf.get(sec.title) : null;
          return (
          <div key={sec.title ?? "_all"} className={color ? `group-colored env-${color}` : undefined}>
            {sec.title && (
              <div className="section-title" onDoubleClick={() => sec.title !== UNGROUPED_LABEL && setRenaming(sec.title)}>
                {renaming === sec.title ? (
                  <input
                    className="group-rename"
                    aria-label={tx("그룹 이름")}
                    autoFocus
                    defaultValue={sec.title}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(null);
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    onBlur={(e) => {
                      const to = e.currentTarget.value;
                      setRenaming(null);
                      if (sec.title && to.trim() !== sec.title) onRenameGroup(sec.title, to);
                    }}
                  />
                ) : (
                  <>
                    <button
                      className="group-toggle"
                      aria-expanded={!folded}
                      title={folded ? tx("펼치기") : tx("접기")}
                      onClick={() => sec.title && toggle(sec.title)}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <span className="chevron" aria-hidden />
                      <span>{sec.title}</span> <span style={{ fontWeight: 400 }}>{sec.sessions.length}</span>
                    </button>
                    {sec.title !== UNGROUPED_LABEL && (
                      <button className="icon-btn ghost xs group-edit" aria-label={tx("{0} 그룹 이름 바꾸기", sec.title)} title={tx("그룹 이름 바꾸기 (더블클릭)")} onClick={() => setRenaming(sec.title)}>
                        <IconEdit width={11} height={11} />
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {!folded && (
            <div className={sec.title ? "group-items" : undefined}>
            {sec.sessions.length === 0 && <p className="group-empty">{tx("세션이 없습니다.")}</p>}
            {sec.sessions.map((s) => (
              <div
                key={s.id}
                className={`session-row${s.id === selectedId ? " selected" : ""}${s.color ? ` env-row env-${s.color}` : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(s, e.clientX, e.clientY);
                }}
              >
                <button className="session" onClick={() => onOpen(s)} title={tx("{0} 연결 (열린 탭이 있으면 그 탭으로)", s.name)}>
                  <span className={`dot${connected.has(s.id) ? " on" : ""}`} />
                  <span className="meta">
                    <span className="name">{s.name}</span>
                    <span className="sub">{describeSession(s)}</span>
                  </span>
                </button>
                <button className="icon-btn ghost edit" aria-label={tx("{0} 편집", s.name)} title={tx("편집")} onClick={() => onEdit(s)}>
                  <IconEdit width={14} height={14} />
                </button>
              </div>
            ))}
            </div>
            )}
          </div>
          );
        })}
      </nav>
    </aside>
  );
}
