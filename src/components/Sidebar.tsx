import { useMemo, useState } from "react";
import { describeSession, filterSessions, groupSessions, UNGROUPED_LABEL, type Session } from "../lib/sessions";
import { IconEdit, IconPlus, IconSearch } from "./Icons";
import { tx } from "../lib/i18n";

interface Props {
  sessions: Session[];
  connected: Set<string>;
  /** 지금 보고 있는 창의 세션 */
  selectedId: string | null;
  onOpen: (s: Session) => void;
  onEdit: (s: Session) => void;
  onNew: () => void;
  /** 그룹 이름 바꾸기(빈 이름이면 그룹 없음으로) */
  onRenameGroup: (from: string, to: string) => void;
}

export function Sidebar({ sessions, connected, selectedId, onOpen, onEdit, onNew, onRenameGroup }: Props) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const sections = useMemo(() => groupSessions(filterSessions(sessions, query)), [sessions, query]);

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
        {sections.map((sec) => (
          <div key={sec.title ?? "_all"}>
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
                    <span>{sec.title}</span> <span style={{ fontWeight: 400 }}>{sec.sessions.length}</span>
                    {sec.title !== UNGROUPED_LABEL && (
                      <button className="icon-btn ghost xs group-edit" aria-label={tx("{0} 그룹 이름 바꾸기", sec.title)} title={tx("그룹 이름 바꾸기 (더블클릭)")} onClick={() => setRenaming(sec.title)}>
                        <IconEdit width={11} height={11} />
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {sec.sessions.map((s) => (
              <div key={s.id} className={`session-row${s.id === selectedId ? " selected" : ""}${s.color ? ` env-row env-${s.color}` : ""}`}>
                <button className="session" onClick={() => onOpen(s)} title={tx("{0} 연결", s.name)}>
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
        ))}
      </nav>
    </aside>
  );
}
