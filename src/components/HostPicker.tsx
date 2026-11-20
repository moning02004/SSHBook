import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { describeSession, filterSessions, groupSessions, type Session } from "../lib/sessions";
import { IconEdit, IconPrompt, IconSearch, IconTrash } from "./Icons";

interface Props {
  sessions: Session[];
  /** 지금 연결돼 있는 세션 id */
  connected: Set<string>;
  onConnect: (s: Session) => void;
  onEdit: (s: Session) => void;
  onDelete: (s: Session) => void;
  onClose: () => void;
}

/**
 * ⌘D(맥) · Alt+D(Windows)로 여는 호스트 목록. ↑↓로 고르고 Enter로 바로 연결한다.
 * 글자를 치면 이름·호스트로 거른다.
 */
export function HostPicker({ sessions, connected, onConnect, onEdit, onDelete, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // 사이드바와 같은 순서(그룹별)로 보여 준다.
  const list = useMemo(() => groupSessions(filterSessions(sessions, query)).flatMap((g) => g.sessions), [sessions, query]);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  // 거른 결과나 삭제로 목록이 줄면 고른 줄을 안으로 당긴다.
  useEffect(() => setIndex((i) => Math.max(0, Math.min(i, list.length - 1))), [list.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const current = list[index];

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return setIndex((i) => (list.length ? (i + 1) % list.length : 0));
      case "ArrowUp":
        e.preventDefault();
        return setIndex((i) => (list.length ? (i - 1 + list.length) % list.length : 0));
      case "Home":
        e.preventDefault();
        return setIndex(0);
      case "End":
        e.preventDefault();
        return setIndex(Math.max(0, list.length - 1));
      case "Enter":
        e.preventDefault();
        if (current) onConnect(current);
        return;
      case "Escape":
        e.preventDefault();
        return onClose();
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog picker" role="dialog" aria-label="호스트 목록" onKeyDown={onKeyDown}>
        <div className="picker-top">
          <label className="search">
            <IconSearch width={14} height={14} />
            <input
              ref={inputRef}
              aria-label="호스트 검색"
              placeholder="호스트 검색 · ↑↓ 고르기 · Enter 연결"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              role="combobox"
              aria-expanded
              aria-controls="host-picker-list"
              aria-activedescendant={current ? `hp-${current.id}` : undefined}
            />
          </label>
        </div>

        <ul ref={listRef} id="host-picker-list" className="picker-list" role="listbox" aria-label="저장된 호스트">
          {list.length === 0 && (
            <li className="empty">{sessions.length === 0 ? "저장된 세션이 없습니다." : "맞는 호스트가 없습니다."}</li>
          )}
          {list.map((s, i) => (
            <li
              key={s.id}
              id={`hp-${s.id}`}
              data-i={i}
              role="option"
              aria-selected={i === index}
              className={`picker-row${i === index ? " selected" : ""}`}
              onMouseMove={() => i !== index && setIndex(i)}
              onDoubleClick={() => onConnect(s)}
            >
              <span className={`dot${connected.has(s.id) ? " on" : ""}`} title={connected.has(s.id) ? "연결됨" : "연결 안 됨"} />
              <span className="meta">
                <span className="name">{s.name}</span>
                <span className="sub">{describeSession(s)}</span>
              </span>
              {s.group && <span className="badge">{s.group}</span>}
              <span className="actions">
                <button className="btn subtle sm" tabIndex={-1} onClick={() => onConnect(s)}>
                  <IconPrompt width={13} height={13} /> 연결
                </button>
                <button className="icon-btn ghost sm" tabIndex={-1} aria-label={`${s.name} 편집`} title="편집" onClick={() => onEdit(s)}>
                  <IconEdit width={14} height={14} />
                </button>
                <button
                  className="icon-btn ghost sm danger"
                  tabIndex={-1}
                  aria-label={`${s.name} 삭제`}
                  title="삭제"
                  onClick={() => onDelete(s)}
                >
                  <IconTrash width={14} height={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>

        <div className="picker-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 고르기</span>
          <span><kbd>Enter</kbd> 연결</span>
          <span><kbd>Esc</kbd> 닫기</span>
        </div>
      </div>
    </div>
  );
}
