import type { PaneStatus } from "../lib/terminals";
import { tx } from "../lib/i18n";

const LABEL: Record<PaneStatus, string> = { live: tx("연결됨"), connecting: tx("연결 중"), closed: tx("연결 끊김") };

/** 연결 상태 점: 연두(연결됨) · 흐린 회색(끊김) · 깜빡임(연결 중) */
export function StatusDot({ status }: { status: PaneStatus }) {
  return <span className={`status-dot ${status}`} role="img" aria-label={LABEL[status]} title={LABEL[status]} />;
}
