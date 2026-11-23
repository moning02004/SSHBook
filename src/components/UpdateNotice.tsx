import { clearUpdateMessage, dismissUpdate, installUpdate, useUpdateState } from "../lib/updater";
import { tx } from "../lib/i18n";

interface Props {
  /** 지금 연결돼 있는 창 수. 업데이트하면 앱이 다시 시작되면서 끊긴다. */
  liveCount: number;
}

/** 오른쪽 아래 업데이트 알림 카드 */
export function UpdateNotice({ liveCount }: Props) {
  const st = useUpdateState();
  if (st.phase === "idle" || st.phase === "checking") return null;
  // '최신 버전'과 확인 오류는 설정 화면에서 보여 준다.
  if (st.phase === "latest") return null;

  return (
    <div className="update-card" role="status" aria-live="polite">
      {st.phase === "available" && (
        <>
          <div className="update-title">{tx("새 버전 v{0}이 나왔습니다", st.version)}</div>
          {st.notes && <pre className="update-notes">{st.notes.split("## 내려받기")[0].trim()}</pre>}
          <p className="hint">
            {liveCount > 0
              ? tx("업데이트하면 앱이 다시 시작되고, 연결된 창 {0}개가 끊깁니다.", liveCount)
              : tx("업데이트하면 앱이 다시 시작됩니다.")}
          </p>
          <div className="row-gap">
            <span style={{ flex: 1 }} />
            <button className="btn subtle" onClick={dismissUpdate}>
              {tx("나중에")}
            </button>
            <button className="btn primary subtle" onClick={() => void installUpdate()}>
              {tx("지금 업데이트")}
            </button>
          </div>
        </>
      )}
      {st.phase === "downloading" && (
        <>
          <div className="update-title">{tx("v{0} 내려받는 중", st.version)}{st.percent !== null ? ` · ${st.percent}%` : "…"}</div>
          <div className="progress" aria-hidden>
            <span style={{ width: `${st.percent ?? 30}%` }} className={st.percent === null ? "indeterminate" : ""} />
          </div>
        </>
      )}
      {st.phase === "installing" && <div className="update-title">{tx("v{0} 설치 중… 곧 다시 시작합니다", st.version)}</div>}
      {st.phase === "error" && (
        <>
          <div className="update-title">{tx("업데이트 오류")}</div>
          <p className="hint">{st.message}</p>
          <div className="row-gap">
            <span style={{ flex: 1 }} />
            <button className="btn subtle" onClick={clearUpdateMessage}>
              {tx("닫기")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
