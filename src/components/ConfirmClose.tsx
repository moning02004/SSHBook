import { useEffect, useRef, useState } from "react";

interface Props {
  /** 닫히는 세션 이름들 */
  names: string[];
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

/** 연결된 세션을 닫기 전에 한 번 더 묻는다. */
export function ConfirmClose({ names, onConfirm, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), []);

  const what = names.length === 1 ? `'${names[0]}'` : `${names.length}개`;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog small"
        role="alertdialog"
        aria-labelledby="cc-title"
        aria-describedby="cc-desc"
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <div className="dialog-body">
          <h2 id="cc-title" style={{ margin: 0, fontSize: 16 }}>
            닫으시겠습니까?
          </h2>
          <p id="cc-desc" className="hint" style={{ fontSize: 13 }}>
            {what} 세션이 종료됩니다. 실행 중인 작업도 함께 끝납니다.
          </p>
          <label className="check">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            <span>다시 묻지 않음</span>
          </label>
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            취소
          </button>
          <button ref={okRef} className="btn danger-fill" onClick={() => onConfirm(dontAsk)}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
