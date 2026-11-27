import { useEffect, useRef } from "react";
import { attachGpuRenderer, getPane } from "../lib/terminals";

interface Props {
  paneId: string;
  sessionId: string | null;
  active: boolean;
}

/** 레지스트리에 있는 xterm을 이 자리에 붙인다. 떼어낼 때 연결은 끊지 않는다. */
export function TerminalView({ paneId, sessionId, active }: Props) {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const entry = getPane(paneId, sessionId);
    el.appendChild(entry.host);
    if (!entry.term.element) entry.term.open(entry.host);
    attachGpuRenderer(entry);

    const fit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) entry.fit.fit();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => {
      ro.disconnect();
      if (entry.host.parentNode === el) el.removeChild(entry.host);
    };
  }, [paneId, sessionId]);

  useEffect(() => {
    if (active) getPane(paneId, sessionId).term.focus();
  }, [active, paneId, sessionId]);

  return <div ref={slot} className="term-slot" />;
}
