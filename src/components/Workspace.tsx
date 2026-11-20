import type { MouseEvent, ReactNode } from "react";
import type { LayoutNode } from "../lib/layout";
import { pasteInto } from "../lib/terminals";
import { IconMore } from "./Icons";
import { TerminalView } from "./TerminalView";

export interface PaneInfo {
  sessionId: string | null;
  title: string;
  sub: string;
}

export interface Tab {
  id: string;
  root: LayoutNode;
  activePane: string;
  /** 확대 중인 창. null이면 분할 화면 그대로 */
  zoomed: string | null;
}

interface Props {
  tab: Tab;
  panes: Record<string, PaneInfo>;
  onActivate: (paneId: string) => void;
  onMenu: (paneId: string, x: number, y: number) => void;
  onUnzoom: () => void;
  /** 켜면 오른쪽 클릭은 붙여넣기, Shift+오른쪽 클릭이 메뉴 */
  rightClickPaste: boolean;
}

export function Workspace({ tab, panes, onActivate, onMenu, onUnzoom, rightClickPaste }: Props) {
  const split = tab.root.kind === "split";

  const renderPane = (id: string) => {
    const info = panes[id];
    if (!info) return null;
    const openMenu = (e: MouseEvent) => {
      e.preventDefault();
      onActivate(id);
      if (rightClickPaste && !e.shiftKey) return void pasteInto(id);
      onMenu(id, e.clientX, e.clientY);
    };
    const active = tab.activePane === id;
    return (
      <section
        key={id}
        className={`pane${active && split && !tab.zoomed ? " active" : ""}`}
        aria-label={`${info.title} 터미널`}
        onMouseDown={() => onActivate(id)}
        onContextMenu={openMenu}
      >
        <div className="pane-head">
          <span className="dot" />
          <span className="title">{info.title}</span>
          <span className="sub">{info.sub}</span>
          <span style={{ flex: 1 }} />
          {tab.zoomed === id && (
            <button className="zoom-pill" onClick={onUnzoom}>
              확대 중 · 원래대로
            </button>
          )}
          <button
            className="icon-btn ghost pane-menu"
            aria-label={`${info.title} 창 메뉴`}
            title="창 메뉴 (오른쪽 클릭과 같음)"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onActivate(id);
              onMenu(id, r.right - 264, r.bottom + 4);
            }}
          >
            <IconMore width={14} height={14} />
          </button>
        </div>
        <TerminalView paneId={id} sessionId={info.sessionId} active={active} />
      </section>
    );
  };

  const renderNode = (node: LayoutNode): ReactNode =>
    node.kind === "pane" ? (
      renderPane(node.id)
    ) : (
      <div className={`split ${node.dir}`}>
        {renderNode(node.children[0])}
        {renderNode(node.children[1])}
      </div>
    );

  return <div className="workspace">{tab.zoomed ? renderPane(tab.zoomed) : renderNode(tab.root)}</div>;
}
