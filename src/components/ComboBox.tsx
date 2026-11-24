import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { tx } from "../lib/i18n";

interface Props {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

const MENU_MAX = 260;
const GAP = 4;

/**
 * 글자를 직접 넣을 수도 있고, 있는 값 목록에서 고를 수도 있는 입력 칸.
 * 목록은 Dropdown과 같은 모양으로 body에 띄운다(모달 본문 스크롤에 잘리지 않게).
 */
export function ComboBox({ value, options, onChange, placeholder, ariaLabel }: Props) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<CSSProperties | null>(null);
  // 화살표 버튼으로 열면 전체 목록, 글자를 치면 그 글자가 들어간 것만 보인다.
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState(-1);
  const open = menu !== null;

  const q = value.trim().toLowerCase();
  const shown = filter && q ? options.filter((o) => o.toLowerCase().includes(q)) : options;

  const show = (filtered: boolean) => {
    const b = box.current;
    if (!b || options.length === 0) return;
    const r = b.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP * 2;
    const above = r.top - GAP * 2;
    const up = below < 160 && above > below;
    setFilter(filtered);
    setMenu({
      left: r.left,
      width: r.width,
      maxHeight: Math.min(MENU_MAX, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
    setActive(-1);
  };
  const hide = () => setMenu(null);
  const choose = (v: string) => {
    hide();
    if (v !== value) onChange(v);
    input.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !list.current?.contains(t)) hide();
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

  useEffect(() => {
    const el = list.current;
    const row = el?.children[active] as HTMLElement | undefined;
    if (!el || !row) return;
    if (row.offsetTop < el.scrollTop) el.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = row.offsetTop + row.offsetHeight - el.clientHeight;
  }, [active, open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        show(false);
      }
      return;
    }
    if (e.key === "Tab") return hide();
    const last = shown.length - 1;
    if (e.key === "Escape") {
      // 목록만 닫고 모달은 그대로 둔다.
      e.stopPropagation();
      hide();
    } else if (e.key === "Enter") {
      if (active < 0 || !shown[active]) return hide();
      e.stopPropagation();
      choose(shown[active]);
    } else if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, last));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className="combo">
      <input
        ref={input}
        className="input"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) show(true);
          else {
            setFilter(true);
            setActive(-1);
          }
        }}
        onClick={() => {
          if (!open) show(false);
        }}
        onKeyDown={onKey}
        onBlur={hide}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          aria-label={tx("목록 보기")}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // 바깥 <label>이 입력 칸을 한 번 더 누르지 않게 한다.
            e.preventDefault();
            input.current?.focus();
            if (open) hide();
            else show(false);
          }}
        />
      )}
      {menu &&
        shown.length > 0 &&
        createPortal(
          <div ref={list} id={id} className="dropdown-menu" role="listbox" style={menu} onMouseDown={(e) => e.preventDefault()}>
            {shown.map((o, i) => (
              <div
                key={o}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o === value}
                className={`dropdown-option${i === active ? " active" : ""}`}
                title={o}
                onMouseEnter={() => setActive(i)}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(o);
                }}
              >
                {o}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
