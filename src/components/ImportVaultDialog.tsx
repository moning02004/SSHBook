import { useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { pickVaultToImport } from "../lib/dialogs";
import { IconClose } from "./Icons";
import { tx } from "../lib/i18n";
import { useEscape } from "../lib/useEscape";

export type ImportMode = "merge" | "replace";

interface Props {
  /** 다 가져왔을 때. appSettings는 적용할 앱 설정(고르지 않았으면 null) */
  onDone: (r: { mode: ImportMode; notice: string; appSettings: string | null }) => void | Promise<void>;
  onClose: () => void;
}

/** 설정 → 보안 → 가져오기: 다른 PC에서 내보낸 파일을 지금 보관함에 더하거나, 그 파일로 바꾼다. */
export function ImportVaultDialog({ onDone, onClose }: Props) {
  useEscape(onClose);
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [withSettings, setWithSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!path) return setError(tx("가져올 파일을 고르세요."));
    setBusy(true);
    try {
      if (mode === "merge") {
        const r = await api.vaultMerge(path, password);
        const notice =
          r.sessions || r.groups || r.snippets || r.hosts
            ? tx("세션 {0}개, 그룹 {1}개, 명령 {2}개, 서버 키 {3}개를 더했습니다.", r.sessions, r.groups, r.snippets, r.hosts) +
              (r.skipped ? " " + tx("이미 있는 세션 {0}개는 건너뛰었습니다.", r.skipped) : "")
            : tx("더할 것이 없었습니다. 모두 이미 있습니다.");
        await onDone({ mode, notice, appSettings: withSettings ? r.appSettings : null });
      } else {
        await api.vaultImport(path, password);
        // 파일에 든 앱 설정은 꺼내 둔다(고르지 않았으면 버린다).
        const s = await api.vaultTakeAppSettings();
        await onDone({ mode, notice: tx("보관함을 가져온 파일로 바꿨습니다. 마스터 비밀번호는 이제 그 파일의 비밀번호입니다."), appSettings: withSettings ? s : null });
      }
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog small" role="dialog" aria-labelledby="imp-title" onSubmit={submit}>
        <div className="dialog-head">
          <h2 id="imp-title">{tx("가져오기")}</h2>
          <button type="button" className="icon-btn ghost" aria-label={tx("닫기")} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="dialog-body">
          <p className="hint">{tx("다른 PC에서 내보낸 파일(.sshbook, .sshv)을 고르고, 그 파일의 마스터 비밀번호를 입력하세요.")}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input mono" style={{ flex: 1, minWidth: 0 }} readOnly value={path} placeholder="book_settings.sshbook" aria-label={tx("가져올 파일")} />
            <button type="button" className="btn" onClick={async () => setPath((await pickVaultToImport()) ?? path)}>
              {tx("파일 선택")}
            </button>
          </div>
          <label className="field">
            <span>{tx("그 파일의 마스터 비밀번호")}</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <div className="field" role="radiogroup" aria-label={tx("가져오는 방식")}>
            <span>{tx("가져오는 방식")}</span>
            <label className="check">
              <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} />
              <span>
                {tx("추가하기")}
                <br />
                <span className="hint">{tx("지금 세션은 그대로 두고, 없는 세션·그룹·명령·서버 키만 더합니다. 마스터 비밀번호도 그대로입니다.")}</span>
              </span>
            </label>
            <label className="check">
              <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
              <span>
                {tx("덮어쓰기")}
                <br />
                <span className="hint">{tx("지금 보관함을 이 파일로 통째로 바꿉니다. 지금 보관함은 같은 폴더에 .bak 파일로 남고, 마스터 비밀번호는 그 파일의 비밀번호가 됩니다.")}</span>
              </span>
            </label>
          </div>

          <label className="check">
            <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} />
            <span>{tx("앱 설정도 가져오기 (글꼴·터미널 설정·테마·언어)")}</span>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {tx("취소")}
          </button>
          <button className={`btn ${mode === "replace" ? "danger-fill" : "primary"}`} disabled={busy || !path || !password}>
            {mode === "replace" ? tx("덮어쓰기") : tx("추가하기")}
          </button>
        </div>
      </form>
    </div>
  );
}
