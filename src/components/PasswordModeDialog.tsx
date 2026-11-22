import { useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { passwordStrength } from "../lib/passwordStrength";
import { IconClose } from "./Icons";
import { StrengthMeter } from "./StrengthMeter";

interface Props {
  /**
   * disable: 마스터 비밀번호 끄기 · enable: 다시 켜기
   * export: 비밀번호 없이 쓰는 중에 내보낼 파일의 비밀번호 받기
   */
  mode: "disable" | "enable" | "export";
  /** export일 때 입력한 비밀번호를 넘긴다 */
  onDone: (password: string) => void | Promise<void>;
  onClose: () => void;
}

const TITLE = { disable: "마스터 비밀번호 끄기", enable: "마스터 비밀번호 켜기", export: "내보낼 파일의 비밀번호" };
const ACTION = { disable: "끄기", enable: "켜기", export: "다음" };

export function PasswordModeDialog({ mode, onDone, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isNew = mode !== "disable";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (isNew) {
      if (password.length < 8) return setError("비밀번호는 8자 이상이어야 합니다.");
      if (passwordStrength(password).score === 0) return setError("비밀번호가 너무 약합니다. 더 길게 하거나 흔한 단어를 빼세요.");
      if (password !== again) return setError("두 비밀번호가 다릅니다.");
    }
    setBusy(true);
    try {
      if (mode === "disable") await api.vaultDisablePassword(password);
      if (mode === "enable") await api.vaultEnablePassword(password);
      await onDone(password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog small" role="dialog" aria-labelledby="pm-title" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-head">
          <h2 id="pm-title">{TITLE[mode]}</h2>
          <button type="button" className="icon-btn ghost" aria-label="닫기" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="dialog-body">
          {mode === "disable" && (
            <div className="warn-box">
              <b>앱이 비밀번호 없이 바로 열립니다.</b>
              <ul>
                <li>이 Mac을 내 계정으로 쓸 수 있는 사람은 저장된 서버에 바로 접속할 수 있습니다.</li>
                <li>내 계정으로 실행되는 프로그램은 저장된 서버 비밀번호와 키를 읽을 수 있습니다.</li>
                <li>잠그기와 자동 잠금은 쓸 수 없습니다. FileVault(디스크 암호화)를 켜 두세요.</li>
              </ul>
            </div>
          )}
          {mode === "enable" && <p className="hint">보관함과 비밀번호 없이 쓰는 동안 생긴 백업을 이 비밀번호로 다시 암호화합니다. 잊어버리면 열 수 없습니다.</p>}
          {mode === "export" && <p className="hint">다른 PC에서 이 파일을 열 때 쓸 비밀번호입니다. 이 PC의 보관함에는 영향이 없습니다.</p>}
          <label className="field">
            <span>{mode === "disable" ? "지금 마스터 비밀번호" : "비밀번호"}</span>
            <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {isNew && <StrengthMeter password={password} />}
          {isNew && (
            <label className="field">
              <span>한 번 더 입력</span>
              <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button className={`btn ${mode === "disable" ? "danger-fill" : "primary"}`} disabled={busy || !password}>
            {busy ? "처리 중…" : ACTION[mode]}
          </button>
        </div>
      </form>
    </div>
  );
}
