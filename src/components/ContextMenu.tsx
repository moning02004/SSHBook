import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem =
  | { label: string; shortcut?: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | "separator";

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  /** 무엇에 대한 메뉴인지 맨 위에 보인다(세션 이름 등) */
  header?: { title: string; sub?: string };
  onClose: () => void;
}

/** 마우스 위치에 뜨는 메뉴. 바깥 클릭, Esc, 창 크기 변경 시 닫힌다. */
export function ContextMenu({ x, y, items, header, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    // 마우스로 연 메뉴는 첫 항목을 미리 강조하지 않는다. 방향키를 누르면 그때 고른다.
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const n = buttons.length;
      const next = e.key === "ArrowDown" ? (i + 1) % n : i < 0 ? n - 1 : (i - 1 + n) % n;
      buttons[next]?.focus();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const hasIcons = items.some((it) => it !== "separator" && it.icon);

  return (
    <div ref={ref} className="menu" role="menu" tabIndex={-1} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {header && (
        <div className="menu-head">
          <span className="menu-title">{header.title}</span>
          {header.sub && <span className="menu-sub">{header.sub}</span>}
        </div>
      )}
      {items.map((item, i) =>
        item === "separator" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {hasIcons && <span className="menu-icon">{item.icon}</span>}
            <span className="label">{item.label}</span>
            {item.shortcut && <span className="key">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
