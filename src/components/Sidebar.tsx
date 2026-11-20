import { useMemo, useState } from "react";
import { authLabel, describeSession, filterSessions, groupSessions, type Session } from "../lib/sessions";
import { IconEdit, IconExport, IconPlus, IconSearch, IconUnlock } from "./Icons";

interface Props {
  sessions: Session[];
  connected: Set<string>;
  /** 지금 보고 있는 창의 세션 */
  selectedId: string | null;
  onOpen: (s: Session) => void;
  onEdit: (s: Session) => void;
  onNew: () => void;
  onLock: () => void;
  onExport: () => void;
}

export function Sidebar({ sessions, connected, selectedId, onOpen, onEdit, onNew, onLock, onExport }: Props) {
  const [query, setQuery] = useState("");
  const sections = useMemo(() => groupSessions(filterSessions(sessions, query)), [sessions, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <label className="search">
          <IconSearch width={14} height={14} />
          <input aria-label="세션 검색" placeholder="세션 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="btn primary" onClick={onNew}>
          <IconPlus width={14} height={14} /> 새 세션
        </button>
      </div>

      <nav className="session-list" aria-label="저장된 세션">
        {sessions.length === 0 && <p className="empty">저장된 세션이 없습니다. '새 세션'으로 SSH 서버를 추가하세요.</p>}
        {sections.map((sec) => (
          <div key={sec.title ?? "_all"}>
            {sec.title && (
              <div className="section-title">
                {sec.title} <span style={{ fontWeight: 400 }}>{sec.sessions.length}</span>
              </div>
            )}
            {sec.sessions.map((s) => (
              <div key={s.id} className={`session-row${s.id === selectedId ? " selected" : ""}`}>
                <button className="session" onClick={() => onOpen(s)} title={`${s.name} 연결`}>
                  <span className={`dot${connected.has(s.id) ? " on" : ""}`} />
                  <span className="meta">
                    <span className="name">{s.name}</span>
                    <span className="sub">{describeSession(s)}</span>
                  </span>
                  <span className="badge">{authLabel(s)}</span>
                </button>
                <button className="icon-btn ghost edit" aria-label={`${s.name} 편집`} title="편집" onClick={() => onEdit(s)}>
                  <IconEdit width={14} height={14} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="vault-bar">
        <IconUnlock style={{ color: "var(--ok)" }} />
        <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>보관함 열림</span>
        <button className="icon-btn ghost" aria-label="보관함 파일 내보내기" title="보관함 파일 내보내기 (다른 PC로 옮기기)" onClick={onExport}>
          <IconExport />
        </button>
        <button className="btn subtle" onClick={onLock}>
          잠그기
        </button>
      </div>
    </aside>
  );
}
