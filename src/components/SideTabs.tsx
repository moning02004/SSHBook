import type { KeyboardEvent } from "react";
import { tx } from "../lib/i18n";

interface Props<T extends string> {
  /** [id, 보이는 이름] */
  tabs: [T, string][];
  active: T;
  /** false를 돌려주면 옮기지 않은 것이다(초점도 그대로 둔다). */
  onPick: (id: T) => boolean | void;
  /** 버튼 id 앞에 붙인다. 패널의 aria-labelledby는 `${idPrefix}-${active}` */
  idPrefix: string;
  panelId: string;
  label: string;
  /** 값이 들어 있는 항목에 점을 찍는다(내용이 가려져 있어도 알 수 있게) */
  isMarked?: (id: T) => boolean;
  /** 아직 갈 수 없는 항목(흐리게 보인다) */
  isLocked?: (id: T) => boolean;
}

/** 모달 왼쪽의 세로 항목 목록. ↑↓ Home End로 옮겨 다닌다. */
export function SideTabs<T extends string>({ tabs, active, onPick, idPrefix, panelId, label, isMarked, isLocked }: Props<T>) {
  const onKey = (e: KeyboardEvent) => {
    const at = tabs.findIndex(([id]) => id === active);
    const to =
      e.key === "ArrowDown" ? (at + 1) % tabs.length
      : e.key === "ArrowUp" ? (at - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    if (onPick(tabs[to][0]) === false) return;
    document.getElementById(`${idPrefix}-${tabs[to][0]}`)?.focus();
  };

  return (
    <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label={label} onKeyDown={onKey}>
      {tabs.map(([id, text]) => (
        <button
          key={id}
          id={`${idPrefix}-${id}`}
          role="tab"
          aria-selected={active === id}
          aria-controls={panelId}
          tabIndex={active === id ? 0 : -1}
          aria-disabled={isLocked?.(id) || undefined}
          onClick={() => onPick(id)}
        >
          {text}
          {isMarked?.(id) && <span className="nav-dot" role="img" aria-label={tx("설정됨")} title={tx("설정됨")} />}
        </button>
      ))}
    </nav>
  );
}
