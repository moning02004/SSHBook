import { useEffect, useMemo, useState } from "react";
import { api, errorText, type KnownHost } from "../lib/api";
import { IconClose, IconSearch, IconTrash } from "./Icons";
import { tx } from "../lib/i18n";
import { useEscape } from "../lib/useEscape";

interface Props {
  onClose: () => void;
}

/**
 * 보관함에 저장된(지문을 확인한) 서버 키. 서버를 다시 설치해 키가 바뀌었다면
 * 여기서 지우고 다시 연결해 새 지문을 확인한다.
 */
export function KnownHostsDialog({ onClose }: Props) {
  useEscape(onClose);
  const [list, setList] = useState<KnownHost[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setList(await api.knownHostsList());
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => void load(), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((h) => !q || `${h.hostId} ${h.fingerprint}`.toLowerCase().includes(q));
  }, [list, query]);

  const remove = async (h: KnownHost) => {
    if (!window.confirm(tx("{0}의 저장된 키를 지울까요?\n다음에 연결할 때 지문을 다시 확인합니다.", h.hostId))) return;
    try {
      await api.knownHostRemove(h.hostId);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-labelledby="kh-title">
        <div className="dialog-head">
          <h2 id="kh-title">{tx("알려진 서버")}</h2>
          <button className="icon-btn ghost" aria-label={tx("닫기")} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="dialog-body">
          <p className="hint">{tx("처음 연결할 때 지문을 확인한 서버들입니다. 서버를 다시 설치했다면 지우고 다시 연결해 새 지문을 확인하세요.")}</p>
          <label className="search">
            <IconSearch width={14} height={14} />
            <input aria-label={tx("서버 검색")} placeholder={tx("호스트나 지문으로 찾기")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          {list && list.length === 0 && <p className="empty">{tx("아직 확인한 서버가 없습니다.")}</p>}
          {shown.length > 0 && (
            <table className="kh-table">
              <thead>
                <tr>
                  <th>{tx("서버")}</th>
                  <th>{tx("키 종류")}</th>
                  <th>{tx("지문")}</th>
                  <th aria-label={tx("지우기")} />
                </tr>
              </thead>
              <tbody>
                {shown.map((h) => (
                  <tr key={h.hostId}>
                    <td className="mono">{h.hostId}</td>
                    <td className="mono">{h.algorithm}</td>
                    <td className="mono fp" title={h.fingerprint}>
                      {h.fingerprint}
                    </td>
                    <td>
                      <button className="icon-btn ghost sm danger" aria-label={tx("{0} 키 지우기", h.hostId)} title={tx("지우기")} onClick={() => void remove(h)}>
                        <IconTrash width={14} height={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
