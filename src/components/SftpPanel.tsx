import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errorText, inTauri, TRANSFER_CANCELLED, type RemoteEntry, type SftpProgress } from "../lib/api";
import { pickFolder, pickSavePath, pickUploadFiles } from "../lib/dialogs";
import * as terms from "../lib/terminals";
import { IconClose, IconDownload, IconEdit, IconFile, IconFolder, IconFolderPlus, IconRefresh, IconTarget, IconTrash, IconUp, IconUpload } from "./Icons";

interface Props {
  paneId: string;
  onClose: () => void;
}

const parentOf = (p: string) => (p === "/" ? "/" : p.replace(/\/[^/]+\/?$/, "") || "/");
const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const when = (t: number | null) => (t ? dateFmt.format(new Date(t * 1000)) : "");

/**
 * 창 옆에 붙는 원격 폴더 목록(SFTP). 같은 SSH 연결을 쓴다.
 * 더블클릭: 폴더는 열고 파일은 내려받는다. 파일을 끌어다 놓으면 지금 폴더로 올린다.
 */
export function SftpPanel({ paneId, onClose }: Props) {
  const termId = terms.backendIdOf(paneId);
  const [path, setPath] = useState("");
  const [typed, setTyped] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [dropping, setDropping] = useState(false);
  /** 진행 중인 전송(한 번에 하나) */
  const [transfer, setTransfer] = useState<{ id: string; label: string; p: SftpProgress | null } | null>(null);
  const [uploadMenu, setUploadMenu] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // 진행률 이벤트는 지금 전송 것만 받는다.
  const transferId = useRef<string | null>(null);
  useEffect(() => {
    const un = api.onSftpProgress((p) => {
      if (p.transferId === transferId.current) setTransfer((t) => (t ? { ...t, p } : t));
    });
    return () => void un.then((f) => f());
  }, []);

  /** 전송 하나를 돌린다: 진행률을 보여 주고, 끝나면 결과 문구를, 취소하면 그렇게 알린다. */
  const runTransfer = async (label: string, fn: (id: string) => Promise<string>) => {
    const id = crypto.randomUUID();
    transferId.current = id;
    setTransfer({ id, label, p: null });
    setMessage(null);
    try {
      setMessage({ text: await fn(id) });
    } catch (e) {
      const text = errorText(e);
      setMessage({ text, error: text !== TRANSFER_CANCELLED });
    } finally {
      transferId.current = null;
      setTransfer(null);
    }
  };

  const load = useCallback(
    async (target: string) => {
      if (!termId) return;
      setBusy(true);
      try {
        const r = await api.sftpList(termId, target);
        setPath(r.path);
        setTyped(r.path);
        setEntries(r.entries);
        setSelected(null);
        setMessage(null);
      } catch (e) {
        setMessage({ text: errorText(e), error: true });
        setTyped(path);
      } finally {
        setBusy(false);
      }
    },
    [termId, path],
  );

  /** 터미널이 지금 있는 폴더로 간다. 알 수 없으면(리눅스가 아닌 서버 등) 홈 폴더. */
  const goTerminalDir = async (fromButton: boolean) => {
    if (!termId) return;
    const cwd = await api.sftpCwd(termId).catch(() => null);
    if (cwd) return load(cwd);
    if (fromButton) setMessage({ text: "터미널의 지금 폴더를 알 수 없습니다(리눅스 서버에서만 됩니다).", error: true });
    else await load("");
  };

  // 처음 열 때는 터미널의 지금 폴더로 연다.
  useEffect(() => {
    if (termId) void goTerminalDir(false);
  }, [termId]);

  const act = async (what: string, fn: () => Promise<string | void>) => {
    if (!termId) return;
    setBusy(true);
    setMessage({ text: `${what}…` });
    try {
      const done = await fn();
      setMessage(done ? { text: done } : null);
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  /** 파일·폴더를 지금 폴더로 올린다(폴더는 안의 것까지 모두). */
  const upload = async (locals: string[]) => {
    if (!termId || locals.length === 0 || transfer) return;
    const label = locals.length === 1 ? `${baseName(locals[0])} 올리는 중` : `${locals.length}개 올리는 중`;
    const dir = path;
    await runTransfer(label, async (id) => {
      try {
        const n = await api.sftpUpload(termId, locals, dir, id);
        return `파일 ${n}개를 올렸습니다.`;
      } finally {
        await load(dir);
      }
    });
  };

  /** 파일은 저장할 곳을, 폴더는 내려받을 폴더를 골라 내려받는다. */
  const download = async (e: RemoteEntry) => {
    if (!termId || transfer) return;
    const dest = e.isDir ? await pickFolder(`'${e.name}' 폴더를 내려받을 곳`) : await pickSavePath(e.name);
    if (!dest) return;
    await runTransfer(`${e.name} 내려받는 중`, async (id) => {
      const remote = joinPath(path, e.name);
      let n: number;
      try {
        // 파일은 저장 창에서 이미 덮어쓰기를 확인했다.
        n = await api.sftpDownload(termId, remote, dest, e.isDir, !e.isDir, id);
      } catch (err) {
        const text = errorText(err);
        if (!text.startsWith("exists:")) throw err;
        if (!window.confirm(`'${text.slice(7)}' 폴더가 이미 있습니다.\n같은 이름의 파일을 덮어쓸까요?`)) return "내려받기를 취소했습니다.";
        n = await api.sftpDownload(termId, remote, dest, true, true, id);
      }
      return `내려받았습니다 (${humanSize(n)}): ${e.isDir ? `${dest}/${e.name}` : dest}`;
    });
  };

  const open = (e: RemoteEntry) => (e.isDir || e.isLink ? void load(joinPath(path, e.name)) : void download(e));

  const mkdir = async () => {
    const name = window.prompt("새 폴더 이름");
    if (!name?.trim() || !termId) return;
    await act("폴더 만드는 중", async () => {
      await api.sftpMkdir(termId, joinPath(path, name.trim()));
      await load(path);
    });
  };

  const rename = async (e: RemoteEntry) => {
    const name = window.prompt("새 이름", e.name);
    if (!name?.trim() || name === e.name || !termId) return;
    await act("이름 바꾸는 중", async () => {
      await api.sftpRename(termId, joinPath(path, e.name), joinPath(path, name.trim()));
      await load(path);
    });
  };

  const remove = async (e: RemoteEntry) => {
    if (!termId || !window.confirm(`'${e.name}'${e.isDir ? " 폴더" : ""}를 서버에서 지울까요? 되돌릴 수 없습니다.`)) return;
    await act("지우는 중", async () => {
      await api.sftpRemove(termId, joinPath(path, e.name), e.isDir);
      await load(path);
    });
  };

  // OS에서 파일을 끌어다 놓으면 이 창 위에 놓였을 때만 올린다.
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    if (!inTauri) return;
    const inside = (x: number, y: number) => {
      const r = panel.current?.getBoundingClientRect();
      const s = window.devicePixelRatio || 1;
      return !!r && x / s >= r.left && x / s <= r.right && y / s >= r.top && y / s <= r.bottom;
    };
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "leave") return setDropping(false);
      const hit = inside(p.position.x, p.position.y);
      if (p.type === "over" || p.type === "enter") return setDropping(hit);
      if (p.type === "drop") {
        setDropping(false);
        if (hit) void uploadRef.current(p.paths);
      }
    });
    return () => void un.then((f) => f());
  }, []);

  const sel = entries.find((e) => e.name === selected) ?? null;

  return (
    <aside
      ref={panel}
      className={`sftp${dropping ? " dropping" : ""}`}
      aria-label="원격 파일"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (!sel) return;
        if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "INPUT") open(sel);
        if (e.key === "Backspace" && (e.target as HTMLElement).tagName !== "INPUT") void load(parentOf(path));
      }}
    >
      <div className="sftp-head">
        <span className="sftp-title">파일</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn ghost sm" title="터미널의 지금 폴더로" aria-label="터미널의 지금 폴더로" disabled={!termId || busy} onClick={() => void goTerminalDir(true)}>
          <IconTarget width={14} height={14} />
        </button>
        <button className="icon-btn ghost sm" title="새 폴더" aria-label="새 폴더" disabled={!termId || busy} onClick={() => void mkdir()}>
          <IconFolderPlus width={14} height={14} />
        </button>
        <span className="upload-wrap">
          <button
            className="icon-btn ghost sm"
            title="올리기 (파일·폴더를 끌어다 놓아도 됩니다)"
            aria-label="올리기"
            aria-expanded={uploadMenu}
            disabled={!termId || busy || !!transfer}
            onClick={() => setUploadMenu((v) => !v)}
          >
            <IconUpload width={14} height={14} />
          </button>
          {uploadMenu && (
            <span className="upload-menu" role="menu" onMouseLeave={() => setUploadMenu(false)}>
              <button role="menuitem" onClick={async () => { setUploadMenu(false); void upload(await pickUploadFiles()); }}>
                파일 올리기…
              </button>
              <button role="menuitem" onClick={async () => { setUploadMenu(false); const f = await pickFolder("올릴 폴더"); if (f) void upload([f]); }}>
                폴더 올리기…
              </button>
            </span>
          )}
        </span>
        <button className="icon-btn ghost sm" title="새로 고침" aria-label="새로 고침" disabled={!termId || busy} onClick={() => void load(path)}>
          <IconRefresh width={14} height={14} />
        </button>
        <button className="icon-btn ghost sm" title="파일 창 닫기" aria-label="파일 창 닫기" onClick={onClose}>
          <IconClose width={13} height={13} />
        </button>
      </div>

      {!termId ? (
        <p className="sftp-empty">연결되면 서버의 파일을 볼 수 있습니다.</p>
      ) : (
        <>
          <form
            className="sftp-path"
            onSubmit={(e) => {
              e.preventDefault();
              void load(typed);
            }}
          >
            <button type="button" className="icon-btn ghost sm" title="위 폴더" aria-label="위 폴더" disabled={busy || path === "/"} onClick={() => void load(parentOf(path))}>
              <IconUp width={14} height={14} />
            </button>
            <input className="input mono" aria-label="원격 경로" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
          </form>

          <ul className="sftp-list" role="listbox" aria-label={`${path} 안의 파일`} aria-busy={busy}>
            {entries.length === 0 && !busy && <li className="sftp-empty">빈 폴더입니다.</li>}
            {entries.map((e) => (
              <li
                key={e.name}
                role="option"
                aria-selected={selected === e.name}
                tabIndex={0}
                className={`sftp-row${selected === e.name ? " selected" : ""}`}
                onClick={() => setSelected(e.name)}
                onFocus={() => setSelected(e.name)}
                onDoubleClick={() => open(e)}
                title={e.isDir ? "더블클릭: 열기" : "더블클릭: 내려받기"}
              >
                {e.isDir ? <IconFolder width={14} height={14} className="ic dir" /> : <IconFile width={14} height={14} className="ic" />}
                <span className="nm">{e.name}{e.isLink ? " →" : ""}</span>
                <span className="meta">{e.isDir ? when(e.mtime) : humanSize(e.size)}</span>
                <span className="row-actions">
                  {!e.isLink && (
                    <button className="icon-btn ghost xs" title={e.isDir ? "폴더째 내려받기" : "내려받기"} aria-label={`${e.name} 내려받기`} disabled={!!transfer} onClick={(ev) => { ev.stopPropagation(); void download(e); }}>
                      <IconDownload width={12} height={12} />
                    </button>
                  )}
                  <button className="icon-btn ghost xs" title="이름 바꾸기" aria-label={`${e.name} 이름 바꾸기`} onClick={(ev) => { ev.stopPropagation(); void rename(e); }}>
                    <IconEdit width={12} height={12} />
                  </button>
                  <button className="icon-btn ghost xs danger" title="지우기" aria-label={`${e.name} 지우기`} onClick={(ev) => { ev.stopPropagation(); void remove(e); }}>
                    <IconTrash width={12} height={12} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {transfer && (
        <div className="sftp-transfer" role="status" aria-live="polite">
          <div className="row">
            <span className="label">{transfer.label}</span>
            <button className="btn subtle sm" onClick={() => void api.sftpCancel(transfer.id)}>
              취소
            </button>
          </div>
          <div className="progress" aria-hidden>
            <span
              className={transfer.p && transfer.p.total > 0 ? "" : "indeterminate"}
              style={{ width: transfer.p && transfer.p.total > 0 ? `${Math.round((transfer.p.done / transfer.p.total) * 100)}%` : "30%" }}
            />
          </div>
          {transfer.p && (
            <div className="detail">
              {humanSize(transfer.p.done)} / {humanSize(transfer.p.total)} · 파일 {transfer.p.filesDone}/{transfer.p.filesTotal}
              {transfer.p.file && <span className="file"> · {transfer.p.file}</span>}
            </div>
          )}
        </div>
      )}
      {(message || dropping) && (
        <div className={`sftp-msg${message?.error ? " error" : ""}`} role="status">
          {dropping ? `여기에 놓으면 ${path || "지금 폴더"}로 올립니다` : message?.text}
        </div>
      )}
    </aside>
  );
}
