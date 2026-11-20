import { useRef, type MouseEvent, type ReactNode } from "react";
import type { Desk, Group, TabDrop } from "../lib/groups";
import { ratioOf, type LayoutNode } from "../lib/layout";
import type { SessionColor } from "../lib/sessions";
import { paneLatency, paneStatus, pasteInto } from "../lib/terminals";
import { IconBroadcast, IconClose, IconFolder, IconMore, IconPlus } from "./Icons";
import { SearchBar } from "./SearchBar";
import { SftpPanel } from "./SftpPanel";
import { StatusDot } from "./StatusDot";
import { TerminalView } from "./TerminalView";

export interface PaneInfo {
  sessionId: string | null;
  title: string;
  sub: string;
  /** 서버 환경 색 */
  color?: SessionColor | null;
  /** SSH 창이면 true (파일 창을 열 수 있다) */
  ssh?: boolean;
}

interface Props {
  desk: Desk;
  panes: Record<string, PaneInfo>;
  onActivateTab: (paneId: string) => void;
  onActivateGroup: (groupId: string) => void;
  onCloseTab: (paneId: string) => void;
  /** 탭을 오른쪽 클릭했을 때 */
  onTabMenu: (paneId: string, x: number, y: number) => void;
  /** 터미널을 오른쪽 클릭했을 때(또는 칸의 ⋯ 버튼) */
  onPaneMenu: (paneId: string, x: number, y: number) => void;
  /** 칸의 + : 그 칸에 로컬 셸 탭을 연다 */
  onNewTab: (groupId: string) => void;
  onTabDragStart: (e: MouseEvent, paneId: string) => void;
  /** 끌고 있는 탭과 놓을 자리 */
  dragging: string | null;
  /** center: 칸 한가운데에 놓아 그 칸의 탭으로 넣는 경우 */
  drop: (TabDrop & { center?: boolean }) | null;
  onUnzoom: () => void;
  /** 켜면 오른쪽 클릭은 붙여넣기, Shift+오른쪽 클릭이 메뉴 */
  rightClickPaste: boolean;
  /** 분할 경계를 끌었을 때. path는 루트에서 그 분할까지의 길 */
  onResize: (path: number[], ratio: number) => void;
  searchPane: string | null;
  onCloseSearch: () => void;
  sftpPanes: Set<string>;
  onToggleSftp: (paneId: string) => void;
  onToggleBroadcast: () => void;
}

function latencyClass(ms: number) {
  return ms >= 300 ? " slow" : ms >= 120 ? " meh" : "";
}

export function Workspace(props: Props) {
  const { desk, onResize } = props;
  const multi = !!desk.root && desk.root.kind === "split";

  const renderNode = (node: LayoutNode, path: number[]): ReactNode => {
    if (node.kind === "pane") {
      const g = desk.groups[node.id];
      return g ? <GroupView key={g.id} group={g} multi={multi} {...props} /> : null;
    }
    const r = ratioOf(node);
    return (
      <div className={`split ${node.dir}`}>
        <div className="split-cell" style={{ flex: `${r} 1 0` }}>
          {renderNode(node.children[0], [...path, 0])}
        </div>
        <Divider dir={node.dir} onResize={(ratio) => onResize(path, ratio)} />
        <div className="split-cell" style={{ flex: `${1 - r} 1 0` }}>
          {renderNode(node.children[1], [...path, 1])}
        </div>
      </div>
    );
  };

  if (!desk.root) return null;
  const zoomed = desk.zoomed ? desk.groups[desk.zoomed] : null;
  return <div className="workspace">{zoomed ? <GroupView group={zoomed} multi {...props} /> : renderNode(desk.root, [])}</div>;
}

/** 칸 하나: 위에 탭 줄, 아래에 보이는 탭의 터미널 */
function GroupView(props: Props & { group: Group; multi: boolean }) {
  const { group: g, multi, desk, panes, dragging, drop } = props;
  const activeGroup = desk.activeGroup === g.id;
  const id = g.active;
  const info = panes[id];
  const status = paneStatus(id);
  const ms = status === "live" ? paneLatency(id) : null;
  const broadcasting = desk.broadcast && multi && !desk.zoomed;
  const zoomed = desk.zoomed === g.id;
  const myDrop = drop && drop.groupId === g.id ? drop : null;

  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    props.onActivateTab(id);
    if (props.rightClickPaste && !e.shiftKey) return void pasteInto(id);
    props.onPaneMenu(id, e.clientX, e.clientY);
  };

  const cls = [
    "group",
    activeGroup && multi && !desk.zoomed ? "active" : "",
    info?.color ? `env env-${info.color}` : "",
    broadcasting ? "broadcast" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={cls} data-group-id={g.id} aria-label={`${info?.title ?? "터미널"} 칸`} onMouseDown={() => props.onActivateGroup(g.id)}>
      <div className="group-bar" data-group-bar={g.id}>
        <div className="group-tabs" role="tablist" aria-label="이 칸의 탭">
          {g.tabs.map((t, i) => {
            const p = panes[t];
            const st = paneStatus(t);
            const tcls = [
              "gtab",
              t === g.active ? "selected" : "",
              st === "closed" ? "closed" : "",
              p?.color ? `env-tab env-${p.color}` : "",
              dragging === t ? "drag-source" : "",
              myDrop?.kind === "bar" && myDrop.index === i ? "drop-before" : "",
              myDrop?.kind === "bar" && myDrop.index === g.tabs.length && i === g.tabs.length - 1 && !myDrop.center ? "drop-after" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={t}
                data-tab-pane={t}
                className={tcls}
                title={p?.sub}
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).closest(".close")) return;
                  props.onTabDragStart(e, t);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onTabMenu(t, e.clientX, e.clientY);
                }}
                onAuxClick={(e) => {
                  // 가운데 버튼 클릭으로 닫기
                  if (e.button === 1) {
                    e.preventDefault();
                    props.onCloseTab(t);
                  }
                }}
              >
                <button role="tab" aria-selected={t === g.active} className="gtab-label" onClick={() => props.onActivateTab(t)}>
                  <StatusDot status={st} />
                  <span className="t">{p?.title ?? "터미널"}</span>
                </button>
                <button className="close" aria-label={`${p?.title ?? "탭"} 닫기`} title="탭 닫기" onClick={() => props.onCloseTab(t)}>
                  <IconClose width={11} height={11} />
                </button>
              </div>
            );
          })}
          <button className="icon-btn ghost gnew" aria-label="이 칸에 새 탭 (로컬 셸)" title="이 칸에 새 탭 (로컬 셸)" onClick={() => props.onNewTab(g.id)}>
            <IconPlus width={13} height={13} />
          </button>
        </div>
        <div className="group-tools">
          {ms !== null && (
            <span className={`latency${latencyClass(ms)}`} title="서버 응답 시간">
              {ms}ms
            </span>
          )}
          {broadcasting && (
            <button className="zoom-pill broadcast-pill" title="보이는 모든 칸에 같은 입력을 보내는 중 · 눌러서 끄기" onClick={props.onToggleBroadcast}>
              <IconBroadcast width={12} height={12} /> 동시 입력
            </button>
          )}
          {zoomed && (
            <button className="zoom-pill" onClick={props.onUnzoom}>
              확대 중 · 원래대로
            </button>
          )}
          {info?.ssh && (
            <button
              className="icon-btn ghost pane-menu"
              aria-pressed={props.sftpPanes.has(id)}
              aria-label="파일 창"
              title="파일 창 (SFTP)"
              onClick={() => props.onToggleSftp(id)}
            >
              <IconFolder width={14} height={14} />
            </button>
          )}
          <button
            className="icon-btn ghost pane-menu"
            aria-label="칸 메뉴"
            title="메뉴 (오른쪽 클릭과 같음)"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              props.onPaneMenu(id, r.right - 264, r.bottom + 4);
            }}
          >
            <IconMore width={14} height={14} />
          </button>
        </div>
      </div>

      <div className="group-body" data-group-body={g.id} onContextMenu={openMenu}>
        <div className="pane-term">
          {info && <TerminalView key={id} paneId={id} sessionId={info.sessionId} active={activeGroup && props.searchPane !== id} />}
          {props.searchPane === id && <SearchBar paneId={id} onClose={props.onCloseSearch} />}
        </div>
        {info?.ssh && props.sftpPanes.has(id) && <SftpPanel paneId={id} onClose={() => props.onToggleSftp(id)} />}
        {myDrop?.kind === "edge" && <div className={`drop-hint ${myDrop.side}`} aria-hidden />}
        {myDrop?.kind === "bar" && myDrop.center && <div className="drop-hint center" aria-hidden />}
      </div>
    </section>
  );
}

/** 분할 경계. 끌어서 크기를 바꾸고, 더블클릭하면 반반으로 돌아간다. */
function Divider({ dir, onResize }: { dir: "row" | "column"; onResize: (ratio: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const start = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: globalThis.MouseEvent) => {
      const ratio = dir === "row" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      onResize(ratio);
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.classList.remove("resizing", "resizing-row", "resizing-column");
    };
    document.body.classList.add("resizing", `resizing-${dir}`);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  return (
    <div
      ref={ref}
      className={`divider-${dir}`}
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      title="끌어서 크기 조절 · 더블클릭하면 반반"
      onMouseDown={start}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onResize(0.5);
      }}
    />
  );
}
