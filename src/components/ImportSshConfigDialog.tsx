import { useEffect, useMemo, useState } from "react";
import { api, errorText, type ConfigHost } from "../lib/api";
import type { Session } from "../lib/sessions";
import { IconClose } from "./Icons";

interface Props {
  sessions: Session[];
  /** 가져온 뒤 세션 목록을 다시 읽는다 */
  onImported: (message: string) => void | Promise<void>;
  onClose: () => void;
}

const sameServer = (s: Session, h: ConfigHost) =>
  s.kind === "ssh" && s.host?.toLowerCase() === h.host.toLowerCase() && (s.port ?? 22) === h.port && s.user === h.user;

/** ~/.ssh/config의 호스트를 골라 세션으로 만든다. 설정 파일은 고치지 않고 비밀번호도 읽지 않는다. */
export function ImportSshConfigDialog({ sessions, onImported, onClose }: Props) {
  const [hosts, setHosts] = useState<ConfigHost[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canImport = useMemo(
    () => (h: ConfigHost) => !!h.user && !sessions.some((s) => sameServer(s, h)),
    [sessions],
  );

  useEffect(() => {
    api
      .sshConfigHosts()
      .then((list) => {
        setHosts(list);
        setPicked(new Set(list.filter(canImport).map((h) => h.alias)));
      })
      .catch((e) => {
        setHosts([]);
        setError(errorText(e));
      });
    // 처음 열 때 한 번만 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (alias: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(alias)) next.add(alias);
      return next;
    });

  const run = async () => {
    if (!hosts) return;
    setBusy(true);
    setError("");
    const chosen = hosts.filter((h) => picked.has(h.alias) && canImport(h));
    const made = new Map<string, Session>();
    try {
      for (const h of chosen) {
        const session: Session = {
          id: "",
          name: h.alias,
          group: null,
          kind: "ssh",
          host: h.host,
          port: h.port,
          user: h.user ?? "",
          auth: h.identityFile ? "key" : "password",
          ...(h.identityFile ? { keyPath: h.identityFile } : {}),
        };
        made.set(h.alias, await api.sessionSave(session));
      }
      // 점프 호스트는 모두 만든 뒤에 이어 준다. 여러 단계 점프는 앱이 지원하지 않는다.
      let jumpsSkipped = 0;
      for (const h of chosen) {
        if (!h.proxyJump) continue;
        const via = h.proxyJump.includes(",") ? undefined : (made.get(h.proxyJump) ?? sessions.find((s) => s.kind === "ssh" && s.name === h.proxyJump));
        const self = made.get(h.alias);
        if (via && self && via.id !== self.id) await api.sessionSave({ ...self, jumpId: via.id });
        else jumpsSkipped += 1;
      }
      const note = jumpsSkipped ? ` 점프 호스트 ${jumpsSkipped}개는 직접 지정해 주세요.` : "";
      await onImported(`세션 ${chosen.length}개를 가져왔습니다.${note}`);
      onClose();
    } catch (e) {
      await onImported(`세션 ${made.size}개까지 가져왔습니다.`);
      setError(errorText(e));
      setBusy(false);
    }
  };

  const count = hosts?.filter((h) => picked.has(h.alias) && canImport(h)).length ?? 0;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-labelledby="ic-title" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-head">
          <h2 id="ic-title">~/.ssh/config 가져오기</h2>
          <button className="icon-btn ghost" aria-label="닫기" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="dialog-body">
          <p className="hint">호스트 정보만 세션으로 옮깁니다. 키 파일은 그 경로를 그대로 쓰고, 비밀번호는 연결할 때 묻습니다.</p>
          {hosts === null && <p className="hint">읽는 중…</p>}
          {hosts?.length === 0 && !error && <p className="empty">가져올 호스트가 없습니다.</p>}
          {!!hosts?.length && (
            <ul className="import-list">
              {hosts.map((h) => {
                const ok = canImport(h);
                return (
                  <li key={h.alias}>
                    <label className={`check${ok ? "" : " disabled"}`}>
                      <input type="checkbox" disabled={!ok} checked={ok && picked.has(h.alias)} onChange={() => toggle(h.alias)} />
                      <span>
                        {h.alias}
                        <span className="hint mono">
                          {h.user ? `${h.user}@` : ""}
                          {h.host}
                          {h.port !== 22 ? `:${h.port}` : ""}
                          {h.proxyJump ? ` · 점프 ${h.proxyJump}` : ""}
                          {!h.user ? " · 사용자 없음" : !ok ? " · 이미 있음" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {error && <p className="error form-error" role="alert">{error}</p>}
        <div className="dialog-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={busy || count === 0} onClick={() => void run()}>
            {count}개 가져오기
          </button>
        </div>
      </div>
    </div>
  );
}
