import { useMemo, useRef, useState } from "react";
import {
  describeSession,
  filterSessions,
  groupSessions,
  layoutOf,
  moveGroup,
  moveSession,
  UNGROUPED_LABEL,
  type Group,
  type Session,
  type SidebarLayout,
} from "../lib/sessions";
import { IconEdit, IconPlus, IconSearch } from "./Icons";
import { tx } from "../lib/i18n";

interface Props {
  sessions: Session[];
  /** 미리 만든 그룹과 그룹 색(설정 → 그룹) */
  groups: Group[];
  /** 끌어서 정한 순서로 보여 준다(아니면 가나다순) */
  manualOrder: boolean;
  /** 세션·그룹을 끌어다 놓았을 때 새 배치 */
  onReorder: (layout: SidebarLayout) => void;
  connected: Set<string>;
  /** 지금 보고 있는 창의 세션 */
  selectedId: string | null;
  onOpen: (s: Session) => void;
  /** 휠(가운데 버튼) 클릭: 열린 탭이 있어도 새 탭으로 연다 */
  onOpenNew: (s: Session) => void;
  onEdit: (s: Session) => void;
  /** 세션을 오른쪽 클릭했을 때 */
  onMenu: (s: Session, x: number, y: number) => void;
  onNew: () => void;
  /** 그룹 이름 바꾸기(빈 이름이면 그룹 없음으로) */
  onRenameGroup: (from: string, to: string) => void;
}

const COLLAPSED_KEY = "sshbook.collapsedGroups";

type Dragged = { kind: "session"; id: string } | { kind: "group"; name: string };
type DropTarget = { kind: "session"; group: string | null; beforeId: string | null } | { kind: "group"; before: string | null };

/** 섹션 제목 → 그룹 이름(제목 없음·'그룹 없음'은 null) */
const groupOfTitle = (title: string | null) => (title === null || title === UNGROUPED_LABEL ? null : title);
/** 마우스가 이만큼 움직여야 끌기로 본다(그냥 누르기와 구분) */
const DRAG_START_PX = 5;

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function Sidebar({ sessions, groups, manualOrder, onReorder, connected, selectedId, onOpen, onOpenNew, onEdit, onMenu, onNew, onRenameGroup }: Props) {
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
    () => groupSessions(filterSessions(sessions, query), query.trim() ? [] : groups.map((g) => g.name), manualOrder),
    [sessions, groups, query, manualOrder],
  );
  const colorOf = useMemo(() => new Map(groups.map((g) => [g.name, g.color ?? null])), [groups]);

  // ---- 끌어서 순서 바꾸기(검색 중에는 끈다) ----
  // HTML 드래그는 Windows에서 파일 끌어다 놓기 설정과 부딪혀서 탭처럼 마우스 이벤트로 만든다.
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const swallowClick = useRef(false);
  const latest = useRef(sections);
  latest.current = sections;

  const targetAt = (x: number, y: number, what: Dragged): DropTarget | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const secEl = el?.closest<HTMLElement>("[data-section]");
    if (!secEl || !navRef.current?.contains(secEl)) return null;
    const group = secEl.dataset.group ? secEl.dataset.group : null;
    if (what.kind === "group") {
      if (group === null) return { kind: "group", before: null };
      const r = secEl.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { kind: "group", before: group };
      const all = [...navRef.current.querySelectorAll<HTMLElement>("[data-section]")];
      const next = all.slice(all.indexOf(secEl) + 1).find((s) => s.dataset.group);
      return { kind: "group", before: next?.dataset.group ?? null };
    }
    const row = el?.closest<HTMLElement>("[data-session-id]");
    if (!row) return { kind: "session", group, beforeId: null };
    const r = row.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { kind: "session", group, beforeId: row.dataset.sessionId ?? null };
    const next = row.nextElementSibling as HTMLElement | null;
    return { kind: "session", group, beforeId: next?.dataset.sessionId ?? null };
  };

  const startDrag = (e: React.MouseEvent, what: Dragged) => {
    if (e.button !== 0 || query.trim()) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let target: DropTarget | null = null;
    const move = (ev: MouseEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
        active = true;
        setDragged(what);
        document.body.classList.add("sidebar-dragging");
      }
      ev.preventDefault();
      window.getSelection()?.removeAllRanges();
      target = targetAt(ev.clientX, ev.clientY, what);
      setDrop(target);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!active) return;
      document.body.classList.remove("sidebar-dragging");
      setDragged(null);
      setDrop(null);
      // 놓은 자리에서 클릭(연결·접기)이 일어나지 않게 한 번 삼킨다.
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      if (!target) return;
      const secs = latest.current;
      const next =
        what.kind === "session" && target.kind === "session"
          ? moveSession(secs, what.id, target.group, target.beforeId)
          : what.kind === "group" && target.kind === "group"
            ? moveGroup(secs, what.name, target.before)
            : secs;
      if (next !== secs) onReorder(layoutOf(next));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 그룹을 끌 때 before가 없으면 '그룹 없음' 위, 그것도 없으면 마지막 그룹 아래에 선을 긋는다.
  const lastGroup = [...sections].reverse().find((s) => groupOfTitle(s.title) !== null)?.title ?? null;
  const hasUngrouped = sections.some((s) => s.title === UNGROUPED_LABEL);
  const sectionDropClass = (title: string | null) => {
    if (!drop) return "";
    const g = groupOfTitle(title);
    if (drop.kind === "session") return drop.beforeId === null && drop.group === g ? " drop-end" : "";
    if (drop.before !== null) return drop.before === g ? " drop-group-before" : "";
    if (title === UNGROUPED_LABEL) return " drop-group-before";
    return !hasUngrouped && title === lastGroup ? " drop-group-after" : "";
  };

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

      <nav
        ref={navRef}
        className="session-list"
        aria-label={tx("저장된 세션")}
        onClickCapture={(e) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        {sessions.length === 0 && <p className="empty">{tx("저장된 세션이 없습니다. '새 세션'으로 SSH 서버를 추가하세요.")}</p>}
        {sections.map((sec) => {
          // 검색 중에는 찾은 세션이 가려지지 않게 모두 펼친다.
          const folded = !!sec.title && !query.trim() && collapsed.has(sec.title);
          const color = sec.title ? colorOf.get(sec.title) : null;
          return (
          <div
            key={sec.title ?? "_all"}
            data-section
            data-group={groupOfTitle(sec.title) ?? ""}
            className={`sidebar-section${color ? ` group-colored env-${color}` : ""}${dragged?.kind === "group" && dragged.name === sec.title ? " dragging" : ""}${sectionDropClass(sec.title)}`}
          >
            {sec.title && (
              <div
                className="section-title"
                title={sec.title !== UNGROUPED_LABEL && !query.trim() ? tx("끌어서 그룹 순서 바꾸기") : undefined}
                onMouseDown={(e) => {
                  const name = groupOfTitle(sec.title);
                  if (name && renaming !== sec.title && !(e.target as HTMLElement).closest(".group-edit")) startDrag(e, { kind: "group", name });
                }}
                onDoubleClick={() => sec.title !== UNGROUPED_LABEL && setRenaming(sec.title)}
              >
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
                data-session-id={s.id}
                className={`session-row${s.id === selectedId ? " selected" : ""}${s.color ? ` env-row env-${s.color}` : ""}${dragged?.kind === "session" && dragged.id === s.id ? " dragging" : ""}${drop?.kind === "session" && drop.beforeId === s.id ? " drop-before" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(s, e.clientX, e.clientY);
                }}
              >
                <button
                  className="session"
                  onClick={() => onOpen(s)}
                  // 휠 클릭은 새 탭. 누를 때 막아야 브라우저 자동 스크롤이 뜨지 않는다.
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                    else startDrag(e, { kind: "session", id: s.id });
                  }}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    onOpenNew(s);
                  }}
                  title={tx("{0} 연결 (열린 탭이 있으면 그 탭으로, 휠 클릭은 새 탭, 끌어서 순서 바꾸기)", s.name)}
                >
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
