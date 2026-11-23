import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { tx } from "../lib/i18n";

export interface DropdownOption<T> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** 바깥에 <label>이 없을 때의 이름 */
  ariaLabel?: string;
}

const MENU_MAX = 260;
const GAP = 4;

/**
 * 앱 모양에 맞춘 선택 상자. 초점은 버튼에 두고 목록은 body에 띄운다.
 * 모달 본문이 스크롤 영역이라 그 안에 그리면 목록이 잘리기 때문이다.
 */
export function Dropdown<T extends string | number>({ value, options, onChange, ariaLabel }: Props<T>) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<CSSProperties | null>(null);
  const [active, setActive] = useState(0);
  const open = menu !== null;
  const selected = options.findIndex((o) => o.value === value);

  const show = () => {
    const b = button.current;
    if (!b) return;
    // WebKit은 버튼을 눌러도 초점을 주지 않아서 키보드 조작을 위해 직접 준다.
    b.focus();
    const r = b.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP * 2;
    const above = r.top - GAP * 2;
    const up = below < 160 && above > below;
    setMenu({
      left: r.left,
      width: r.width,
      maxHeight: Math.min(MENU_MAX, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
    setActive(Math.max(selected, 0));
  };
  const hide = () => setMenu(null);
  const choose = (i: number) => {
    hide();
    if (options[i] && options[i].value !== value) onChange(options[i].value);
  };

  // 바깥을 누르거나 뒤 화면이 움직이면 닫는다(목록이 버튼에서 떨어져 보이지 않게).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) hide();
    };
    const onScroll = (e: Event) => {
      if (e.target !== list.current) hide();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  // 고른 줄이 목록 안에 보이게 한다.
  useEffect(() => {
    const box = list.current;
    const row = box?.children[active] as HTMLElement | undefined;
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [active, open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        show();
      }
      return;
    }
    if (e.key === "Tab") return hide();
    // 열려 있는 동안의 키는 모달(Esc 닫기 등)로 넘기지 않는다.
    e.stopPropagation();
    const last = options.length - 1;
    if (e.key === "Escape") hide();
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, last));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="input dropdown"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={(e) => {
          // 바깥 <label>이 같은 버튼을 한 번 더 누르지 않게 한다.
          e.preventDefault();
          if (open) hide();
          else show();
        }}
        onKeyDown={onKey}
        onBlur={hide}
      >
        <span className="dropdown-value">{options[selected]?.label ?? tx("선택 안 됨")}</span>
      </button>
      {menu &&
        createPortal(
          <div ref={list} id={id} className="dropdown-menu" role="listbox" style={menu} onMouseDown={(e) => e.preventDefault()}>
            {options.map((o, i) => (
              <div
                key={String(o.value)}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o.value === value}
                className={`dropdown-option${i === active ? " active" : ""}`}
                title={o.label}
                onMouseEnter={() => setActive(i)}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(i);
                }}
              >
                {o.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
