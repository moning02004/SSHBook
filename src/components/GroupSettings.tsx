import { useState } from "react";
import { api, errorText } from "../lib/api";
import { tx } from "../lib/i18n";
import { COLOR_LABEL, SESSION_COLORS, type Group, type Session, type SessionColor } from "../lib/sessions";
import { IconPlus, IconTrash } from "./Icons";

interface Props {
  groups: Group[];
  sessions: Session[];
  /** 그룹을 바꾼 뒤 세션과 그룹 목록을 다시 읽는다 */
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}

const byName = (a: Group, b: Group) => a.name.localeCompare(b.name, "ko");

/** 설정 → 그룹: 그룹을 미리 만들고, 색을 정하고, 이름을 바꾸거나 지운다. */
export function GroupSettings({ groups, sessions, onChanged, onNotice }: Props) {
  const [draft, setDraft] = useState("");
  const count = (name: string) => sessions.filter((s) => s.group?.trim() === name).length;
  const sorted = [...groups].sort(byName);

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await onChanged();
      return true;
    } catch (e) {
      onNotice(tx("그룹을 바꾸지 못했습니다: {0}", errorText(e)));
      return false;
    }
  };

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    // 아직 안 쓴 색을 먼저 준다. 다 썼으면 색 없이 만든다.
    const used = new Set(groups.map((g) => g.color));
    const color = SESSION_COLORS.find((c) => !used.has(c)) ?? null;
    if (await run(() => api.groupAdd(name, color))) setDraft("");
  };

  const rename = (g: Group, to: string) => {
    const name = to.trim();
    if (!name || name === g.name) return;
    if (groups.some((x) => x.name === name) && !window.confirm(tx("'{0}' 그룹이 이미 있습니다. 두 그룹을 합칠까요?", name))) return;
    void run(() => api.sessionsRenameGroup(g.name, name));
  };

  const remove = (g: Group) => {
    const n = count(g.name);
    if (n > 0 && !window.confirm(tx("'{0}' 그룹을 지울까요? 세션 {1}개는 그룹 없음으로 옮깁니다.", g.name, n))) return;
    void run(() => api.groupDelete(g.name));
  };

  const setColor = (g: Group, color: SessionColor | null) => void run(() => api.groupSetColor(g.name, color));

  return (
    <section className="settings-section">
      <h3>{tx("그룹")}</h3>
      <p className="hint" style={{ margin: 0 }}>
        {tx("세션이 없어도 그룹을 미리 만들어 둘 수 있습니다. 색은 왼쪽 목록의 그룹 이름과 안내선에 보입니다.")}
      </p>
      <form
        className="row-gap"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="input" style={{ flex: 1 }} aria-label={tx("새 그룹 이름")} placeholder={tx("새 그룹 이름")} value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          <IconPlus width={13} height={13} /> {tx("그룹 만들기")}
        </button>
      </form>

      {sorted.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>{tx("아직 그룹이 없습니다. 위에서 만들면 왼쪽 목록에 바로 보입니다.")}</p>
      ) : (
        <ul className="group-list">
          {sorted.map((g) => (
            <li key={g.name} className={g.color ? `env-${g.color}` : undefined}>
              <input
                // 이름이 바뀌면 새 값으로 다시 그린다.
                key={g.name}
                className="input group-name"
                aria-label={tx("{0} 그룹 이름", g.name)}
                defaultValue={g.name}
                maxLength={60}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    e.currentTarget.value = g.name;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.value.trim()) e.currentTarget.value = g.name;
                  else rename(g, e.currentTarget.value);
                }}
              />
              <span className="hint group-count">{tx("세션 {0}개", count(g.name))}</span>
              <div className="swatches" role="radiogroup" aria-label={tx("그룹 색")}>
                <button role="radio" aria-checked={!g.color} className="swatch none" title={tx("색 없음")} aria-label={tx("색 없음")} onClick={() => setColor(g, null)} />
                {SESSION_COLORS.map((c) => (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={g.color === c}
                    className={`swatch env-${c}`}
                    title={COLOR_LABEL[c]}
                    aria-label={COLOR_LABEL[c]}
                    onClick={() => setColor(g, c)}
                  />
                ))}
              </div>
              <button className="icon-btn ghost" aria-label={tx("{0} 그룹 지우기", g.name)} title={tx("지우기")} onClick={() => remove(g)}>
                <IconTrash width={14} height={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
