import { clearUpdateMessage, dismissUpdate, installUpdate, useUpdateState } from "../lib/updater";

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
          <div className="update-title">새 버전 v{st.version}이 나왔습니다</div>
          <p className="hint">
            {liveCount > 0
              ? `업데이트하면 앱이 다시 시작되고, 연결된 창 ${liveCount}개가 끊깁니다.`
              : "업데이트하면 앱이 다시 시작됩니다."}
          </p>
          <div className="row-gap">
            <span style={{ flex: 1 }} />
            <button className="btn subtle" onClick={dismissUpdate}>
              나중에
            </button>
            <button className="btn primary subtle" onClick={() => void installUpdate()}>
              지금 업데이트
            </button>
          </div>
        </>
      )}
      {st.phase === "downloading" && (
        <>
          <div className="update-title">v{st.version} 내려받는 중{st.percent !== null ? ` · ${st.percent}%` : "…"}</div>
          <div className="progress" aria-hidden>
            <span style={{ width: `${st.percent ?? 30}%` }} className={st.percent === null ? "indeterminate" : ""} />
          </div>
        </>
      )}
      {st.phase === "installing" && <div className="update-title">v{st.version} 설치 중… 곧 다시 시작합니다</div>}
      {st.phase === "error" && (
        <>
          <div className="update-title">업데이트 오류</div>
          <p className="hint">{st.message}</p>
          <div className="row-gap">
            <span style={{ flex: 1 }} />
            <button className="btn subtle" onClick={clearUpdateMessage}>
              닫기
            </button>
          </div>
        </>
      )}
    </div>
  );
}
