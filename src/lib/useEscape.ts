import { useEffect, useRef } from "react";

// 모달이 열려 있으면 초점이 어디에 있든(터미널 포함) ESC로 맨 위 모달만 닫는다.
const stack: { current: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || !stack.length) return;
  // 열린 드롭다운은 ESC로 목록만 닫는다.
  if (document.querySelector('.dropdown[aria-expanded="true"]')) return;
  // 터미널이 ESC를 셸로 보내지 않게 여기서 끝낸다.
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].current();
}

export function useEscape(onEscape: () => void) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!stack.length) window.addEventListener("keydown", onKeyDown, true);
    stack.push(handler);
    return () => {
      stack.splice(stack.indexOf(handler), 1);
      if (!stack.length) window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}
