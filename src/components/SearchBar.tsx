import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as terms from "../lib/terminals";
import { IconClose } from "./Icons";
import { tx } from "../lib/i18n";

interface Props {
  paneId: string;
  onClose: () => void;
}

/** 창 오른쪽 위에 뜨는 검색 줄. Enter 다음, Shift+Enter 이전, Esc 닫기 */
export function SearchBar({ paneId, onClose }: Props) {
  const [text, setText] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const q: terms.SearchQuery = { text, caseSensitive, regex };

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const off = terms.onSearchResults(paneId, (index, count) => setResult({ index, count }));
    return () => {
      off();
      terms.clearSearch(paneId);
    };
  }, [paneId]);

  // 글자나 옵션이 바뀌면 지금 위치에서 다시 찾는다.
  useEffect(() => {
    if (!text) {
      terms.clearSearch(paneId);
      setResult(null);
      return;
    }
    if (!terms.findNext(paneId, q, true)) setResult({ index: -1, count: 0 });
  }, [text, caseSensitive, regex]);

  const close = () => {
    onClose();
    terms.focusPane(paneId);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return close();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) terms.findPrevious(paneId, q);
      else terms.findNext(paneId, q);
    }
  };

  const label =
    !text || !result ? "" : result.count === 0 ? tx("없음") : result.index < 0 ? tx("{0}+개", result.count) : `${result.index + 1}/${result.count}`;

  return (
    <div className="search-bar" role="search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
      <input
        ref={input}
        aria-label={tx("터미널에서 찾기")}
        placeholder={tx("찾기")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={text && result?.count === 0 ? "no-match" : ""}
      />
      <span className="count" aria-live="polite">{label}</span>
      <button className={`opt${caseSensitive ? " on" : ""}`} aria-pressed={caseSensitive} title={tx("대소문자 구분")} onClick={() => setCase((v) => !v)}>
        Aa
      </button>
      <button className={`opt${regex ? " on" : ""}`} aria-pressed={regex} title={tx("정규식")} onClick={() => setRegex((v) => !v)}>
        .*
      </button>
      <button className="opt" title={tx("이전 (Shift+Enter)")} aria-label={tx("이전")} disabled={!text} onClick={() => terms.findPrevious(paneId, q)}>
        ↑
      </button>
      <button className="opt" title={tx("다음 (Enter)")} aria-label={tx("다음")} disabled={!text} onClick={() => terms.findNext(paneId, q)}>
        ↓
      </button>
      <button className="opt" title={tx("닫기 (Esc)")} aria-label={tx("검색 닫기")} onClick={close}>
        <IconClose width={12} height={12} />
      </button>
    </div>
  );
}
