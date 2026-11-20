import { useState, type FormEvent } from "react";
import { api, errorText, type VaultStatus } from "../lib/api";
import { pickVaultToImport } from "../lib/dialogs";
import { IconLock } from "./Icons";

interface Props {
  status: VaultStatus;
  onOpened: () => void;
}

type Mode = "unlock" | "create" | "import";
const MIN_LEN = 8;

/** 보관함이 없으면 만들기, 있으면 잠금 해제. 다른 PC의 보관함 파일을 가져올 수도 있다. */
export function VaultScreen({ status, onOpened }: Props) {
  const [mode, setMode] = useState<Mode>(status.exists ? "unlock" : "create");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [importPath, setImportPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onOpened();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "unlock") return run(() => api.vaultUnlock(password));
    if (mode === "create") {
      if (password.length < MIN_LEN) return setError(`마스터 비밀번호는 ${MIN_LEN}자 이상이어야 합니다.`);
      if (password !== confirm) return setError("두 비밀번호가 다릅니다.");
      return run(() => api.vaultCreate(password));
    }
    if (!importPath) return setError("가져올 보관함 파일을 고르세요.");
    return run(() => api.vaultImport(importPath, password));
  };

  const switchTo = (m: Mode) => {
    setMode(m);
    setError("");
    setPassword("");
    setConfirm("");
  };

  const title = mode === "unlock" ? "보관함 잠금 해제" : mode === "create" ? "보관함 만들기" : "보관함 파일 가져오기";
  const desc =
    mode === "unlock"
      ? "세션 목록, 비밀번호, 개인 키가 이 보관함 파일 하나에 암호화되어 있습니다."
      : mode === "create"
        ? "세션과 키를 담을 보관함을 만듭니다. 이 파일과 마스터 비밀번호만 있으면 다른 PC에서도 열 수 있습니다."
        : "다른 PC에서 내보낸 보관함 파일을 고르고, 그 보관함의 마스터 비밀번호를 입력하세요.";

  return (
    <div className="vault-screen">
      <form className="vault-card" onSubmit={submit}>
        <div className="lock-icon">
          <IconLock width={24} height={24} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1>{title}</h1>
          <p>{desc}</p>
        </div>

        {mode === "import" && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input mono" style={{ flex: 1, minWidth: 0 }} readOnly value={importPath} placeholder="vault.sshv" aria-label="가져올 파일" />
            <button type="button" className="btn" onClick={async () => setImportPath((await pickVaultToImport()) ?? importPath)}>
              파일 선택
            </button>
          </div>
        )}

        <label className="field">
          <span>마스터 비밀번호</span>
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {mode === "create" && (
          <label className="field">
            <span>한 번 더 입력</span>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}

        <button className="btn primary" style={{ height: 42 }} disabled={busy}>
          {mode === "unlock" ? "잠금 해제" : mode === "create" ? "만들기" : "가져와서 열기"}
        </button>

        {mode === "create" && <p className="hint">마스터 비밀번호는 어디에도 보내지 않고 복구할 수도 없습니다. 잊어버리면 보관함을 열 수 없습니다.</p>}
        {mode === "import" && status.exists && <p className="hint">지금 PC의 보관함은 같은 폴더에 .bak 파일로 남겨 둡니다.</p>}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {mode !== "import" && (
            <button type="button" className="link" onClick={() => switchTo("import")}>다른 PC의 보관함 파일 가져오기</button>
          )}
          {mode === "import" && (
            <button type="button" className="link" onClick={() => switchTo(status.exists ? "unlock" : "create")}>돌아가기</button>
          )}
        </div>
        <p className="path">{status.path}</p>
      </form>
    </div>
  );
}
