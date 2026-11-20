import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText, type VaultBackup, type VaultStatus } from "../lib/api";
import { pickVaultToImport } from "../lib/dialogs";
import { passwordStrength } from "../lib/passwordStrength";
import { IconLock } from "./Icons";
import { StrengthMeter } from "./StrengthMeter";

interface Props {
  status: VaultStatus;
  onOpened: () => void;
  /** 앱을 막 켰을 때만 true. 키체인에 기억된 키가 있으면 바로 연다(잠근 뒤에는 자동으로 열지 않는다). */
  autoUnlock: boolean;
}

type Mode = "unlock" | "create" | "import" | "restore";

const dateFmt = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const MIN_LEN = 8;

/** 보관함이 없으면 만들기, 있으면 잠금 해제. 다른 PC의 보관함 파일을 가져올 수도 있다. */
export function VaultScreen({ status, onOpened, autoUnlock }: Props) {
  const [mode, setMode] = useState<Mode>(status.exists ? "unlock" : "create");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [importPath, setImportPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(status.remembered);
  const [backups, setBackups] = useState<VaultBackup[] | null>(null);
  const [chosen, setChosen] = useState("");

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

  const unlockRemembered = () => run(() => api.vaultUnlockRemembered());
  const tried = useRef(false);
  useEffect(() => {
    if (autoUnlock && status.exists && status.remembered && !tried.current) {
      tried.current = true;
      void unlockRemembered();
    }
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "unlock") return run(() => api.vaultUnlock(password, remember));
    if (mode === "create") {
      if (password.length < MIN_LEN) return setError(`마스터 비밀번호는 ${MIN_LEN}자 이상이어야 합니다.`);
      if (passwordStrength(password).score === 0) return setError("비밀번호가 너무 약합니다. 더 길게 하거나 흔한 단어를 빼세요.");
      if (password !== confirm) return setError("두 비밀번호가 다릅니다.");
      return run(() => api.vaultCreate(password));
    }
    if (mode === "restore") {
      if (!chosen) return setError("되돌릴 백업을 고르세요.");
      return run(() => api.vaultRestore(chosen, password));
    }
    if (!importPath) return setError("가져올 보관함 파일을 고르세요.");
    return run(() => api.vaultImport(importPath, password));
  };

  const switchTo = (m: Mode) => {
    if (m === "restore")
      void api
        .vaultBackups()
        .then((b) => {
          setBackups(b);
          setChosen(b[0]?.path ?? "");
        })
        .catch((e) => setError(errorText(e)));
    setMode(m);
    setError("");
    setPassword("");
    setConfirm("");
  };

  const title =
    mode === "unlock" ? "보관함 잠금 해제" : mode === "create" ? "보관함 만들기" : mode === "restore" ? "백업에서 되돌리기" : "보관함 파일 가져오기";
  const desc =
    mode === "unlock"
      ? "세션 목록, 비밀번호, 개인 키가 이 보관함 파일 하나에 암호화되어 있습니다."
      : mode === "restore"
        ? "보관함은 저장할 때 자동으로 백업됩니다(한 시간에 하나, 최근 10개). 되돌릴 시점을 고르고, 그때의 마스터 비밀번호를 입력하세요."
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

        {mode === "restore" && (
          <div className="backup-list" role="radiogroup" aria-label="백업 시점">
            {backups?.length === 0 && <p className="hint">아직 백업이 없습니다.</p>}
            {backups?.map((b) => (
              <label key={b.path} className="check">
                <input type="radio" name="backup" checked={chosen === b.path} onChange={() => setChosen(b.path)} />
                <span>
                  {dateFmt.format(new Date(b.modified * 1000))} <span className="hint">· {(b.size / 1024).toFixed(1)} KB</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <label className="field">
          <span>{mode === "restore" ? "그 백업의 마스터 비밀번호" : "마스터 비밀번호"}</span>
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {mode === "create" && <StrengthMeter password={password} />}
        {mode === "create" && (
          <label className="field">
            <span>한 번 더 입력</span>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}
        {mode === "unlock" && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>
              이 PC에서 기억하기
              <br />
              <span className="hint">다음부터 OS 키체인으로 바로 엽니다. 다른 사람과 같이 쓰는 PC에서는 끄세요.</span>
            </span>
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}

        <button className="btn primary" style={{ height: 42 }} disabled={busy}>
          {mode === "unlock" ? "잠금 해제" : mode === "create" ? "만들기" : mode === "restore" ? "되돌리고 열기" : "가져와서 열기"}
        </button>
        {mode === "unlock" && status.remembered && (
          <button type="button" className="btn" style={{ height: 42 }} disabled={busy} onClick={() => void unlockRemembered()}>
            이 PC에 기억된 키로 열기
          </button>
        )}

        {mode === "create" && <p className="hint">마스터 비밀번호는 어디에도 보내지 않고 복구할 수도 없습니다. 잊어버리면 보관함을 열 수 없습니다.</p>}
        {(mode === "import" || mode === "restore") && status.exists && <p className="hint">지금 PC의 보관함은 같은 폴더에 .bak 파일로 남겨 둡니다.</p>}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {(mode === "unlock" || mode === "create") && (
            <button type="button" className="link" onClick={() => switchTo("import")}>다른 PC의 보관함 파일 가져오기</button>
          )}
          {mode === "unlock" && (
            <button type="button" className="link" onClick={() => switchTo("restore")}>백업에서 되돌리기</button>
          )}
          {(mode === "import" || mode === "restore") && (
            <button type="button" className="link" onClick={() => switchTo(status.exists ? "unlock" : "create")}>돌아가기</button>
          )}
        </div>
        <p className="path">{status.path}</p>
      </form>
    </div>
  );
}
