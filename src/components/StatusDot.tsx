import type { PaneStatus } from "../lib/terminals";

const LABEL: Record<PaneStatus, string> = { live: "연결됨", connecting: "연결 중", closed: "연결 끊김" };

/** 연결 상태 점: 연두(연결됨) · 흐린 회색(끊김) · 깜빡임(연결 중) */
export function StatusDot({ status }: { status: PaneStatus }) {
  return <span className={`status-dot ${status}`} role="img" aria-label={LABEL[status]} title={LABEL[status]} />;
}
