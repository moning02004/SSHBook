import { useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { passwordStrength } from "../lib/passwordStrength";
import { IconClose } from "./Icons";
import { StrengthMeter } from "./StrengthMeter";

interface Props {
  onDone: (message: string) => void;
  onClose: () => void;
}

/** 마스터 비밀번호 바꾸기. 이 PC에서 기억하기가 켜져 있으면 새 키로 함께 바뀐다. */
export function ChangePasswordDialog({ onDone, onClose }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < 8) return setError("새 비밀번호는 8자 이상이어야 합니다.");
    if (passwordStrength(next).score === 0) return setError("새 비밀번호가 너무 약합니다. 더 길게 하거나 흔한 단어를 빼세요.");
    if (next !== again) return setError("새 비밀번호 두 개가 다릅니다.");
    if (next === current) return setError("지금 비밀번호와 같습니다.");
    setBusy(true);
    try {
      await api.vaultChangePassword(current, next);
      // 입력값은 바로 비운다(화면 메모리에 오래 남기지 않는다).
      setCurrent("");
      setNext("");
      setAgain("");
      onDone("마스터 비밀번호를 바꿨습니다. 예전에 내보낸 보관함 파일은 예전 비밀번호로 열립니다.");
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog small" role="dialog" aria-labelledby="cp-title" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-head">
          <h2 id="cp-title">마스터 비밀번호 바꾸기</h2>
          <button type="button" className="icon-btn ghost" aria-label="닫기" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="dialog-body">
          <label className="field">
            <span>지금 비밀번호</span>
            <input className="input" type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="field">
            <span>새 비밀번호</span>
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <StrengthMeter password={next} />
          <label className="field">
            <span>새 비밀번호 한 번 더</span>
            <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={busy || !current || !next}>
            바꾸기
          </button>
        </div>
      </form>
    </div>
  );
}
