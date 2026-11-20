import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { errorText } from "../lib/api";
import type { Snippet } from "../lib/sessions";
import { IconEdit, IconPlus, IconSearch, IconSnippet, IconTrash } from "./Icons";

interface Props {
  snippets: Snippet[];
  /** 붙여 넣을 창이 있는지 */
  canInsert: boolean;
  onInsert: (s: Snippet, run: boolean) => void;
  onSave: (s: Snippet) => Promise<void>;
  onDelete: (s: Snippet) => Promise<void>;
  onClose: () => void;
}

const isMac = navigator.platform.toLowerCase().includes("mac");
const RUN_KEY = isMac ? "⌘Enter" : "Ctrl+Enter";

/** 명령 모음. ↑↓로 고르고 Enter는 붙여넣기, ⌘/Ctrl+Enter는 붙여넣고 실행. */
export function SnippetsDialog({ snippets, canInsert, onInsert, onSave, onDelete, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...snippets].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return q ? sorted.filter((s) => `${s.name}\n${s.command}`.toLowerCase().includes(q)) : sorted;
  }, [snippets, query]);
  const current = list[index];

  useEffect(() => setIndex((i) => Math.max(0, Math.min(i, list.length - 1))), [list.length]);
  useEffect(() => {
    if (!editing) search.current?.focus();
  }, [editing]);

  const onKey = (e: KeyboardEvent) => {
    if (editing) {
      if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return setIndex((i) => (list.length ? (i + 1) % list.length : 0));
      case "ArrowUp":
        e.preventDefault();
        return setIndex((i) => (list.length ? (i - 1 + list.length) % list.length : 0));
      case "Enter":
        e.preventDefault();
        if (current && canInsert) onInsert(current, e.metaKey || e.ctrlKey);
        return;
      case "Escape":
        e.preventDefault();
        return onClose();
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.command.trim()) return setError("명령을 입력하세요.");
    try {
      await onSave(editing);
      setEditing(null);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog picker" role="dialog" aria-label="명령 모음" onKeyDown={onKey}>
        {editing ? (
          <>
            <div className="dialog-head">
              <h2>{editing.id ? "명령 고치기" : "명령 추가"}</h2>
            </div>
            <div className="dialog-body">
              <label className="field">
                <span>이름</span>
                <input className="input" autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="비우면 명령 첫 줄" />
              </label>
              <label className="field">
                <span>명령</span>
                <textarea
                  className="input mono snippet-cmd"
                  value={editing.command}
                  onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  placeholder="docker compose logs -f --tail=200 api"
                  spellCheck={false}
                  rows={4}
                />
              </label>
              <p className="hint">보관함에 같이 저장되므로 보관함을 옮기면 다른 PC에서도 씁니다.</p>
              {error && <p className="error" role="alert">{error}</p>}
            </div>
            <div className="dialog-foot">
              <span className="spacer" />
              <button className="btn" onClick={() => setEditing(null)}>
                취소
              </button>
              <button className="btn primary" onClick={() => void save()}>
                저장
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="picker-top row-gap">
              <label className="search" style={{ flex: 1 }}>
                <IconSearch width={14} height={14} />
                <input ref={search} aria-label="명령 검색" placeholder="명령 검색 · ↑↓ 고르기" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} />
              </label>
              <button className="btn" style={{ height: 38 }} onClick={() => setEditing({ id: "", name: "", command: "" })}>
                <IconPlus width={14} height={14} /> 추가
              </button>
            </div>
            <ul className="picker-list" role="listbox" aria-label="저장된 명령">
              {list.length === 0 && (
                <li className="empty">{snippets.length === 0 ? "저장된 명령이 없습니다. '추가'로 자주 쓰는 명령을 넣어 두세요." : "맞는 명령이 없습니다."}</li>
              )}
              {list.map((s, i) => (
                <li
                  key={s.id}
                  role="option"
                  aria-selected={i === index}
                  className={`picker-row${i === index ? " selected" : ""}`}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onDoubleClick={() => canInsert && onInsert(s, false)}
                >
                  <IconSnippet width={14} height={14} style={{ flex: "none", color: "var(--muted)" }} />
                  <span className="meta">
                    <span className="name">{s.name}</span>
                    <span className="sub">{s.command.split("\n")[0]}</span>
                  </span>
                  <span className="actions">
                    <button className="btn subtle sm" tabIndex={-1} disabled={!canInsert} title="붙여넣기 (Enter)" onClick={() => onInsert(s, false)}>
                      넣기
                    </button>
                    <button className="btn subtle sm" tabIndex={-1} disabled={!canInsert} title={`붙여넣고 실행 (${RUN_KEY})`} onClick={() => onInsert(s, true)}>
                      실행
                    </button>
                    <button className="icon-btn ghost sm" tabIndex={-1} aria-label={`${s.name} 고치기`} title="고치기" onClick={() => setEditing(s)}>
                      <IconEdit width={14} height={14} />
                    </button>
                    <button
                      className="icon-btn ghost sm danger"
                      tabIndex={-1}
                      aria-label={`${s.name} 지우기`}
                      title="지우기"
                      onClick={() => window.confirm(`'${s.name}' 명령을 지울까요?`) && void onDelete(s)}
                    >
                      <IconTrash width={14} height={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="picker-foot">
              <span><kbd>Enter</kbd> 붙여넣기</span>
              <span><kbd>{RUN_KEY}</kbd> 붙여넣고 실행</span>
              <span><kbd>Esc</kbd> 닫기</span>
              {!canInsert && <span>· 탭을 먼저 여세요</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
