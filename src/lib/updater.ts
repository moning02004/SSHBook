// GitHub 릴리스로 앱 안에서 업데이트한다.
// 릴리스의 latest.json을 보고 새 버전이 있으면 받아서 설치하고 다시 시작한다.
// 받은 파일은 앱에 넣어 둔 공개 키로 서명을 확인한 뒤에만 설치된다.

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";
import { api, errorText, inTauri } from "./api";
import { tx } from "./i18n";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "available"; version: string; notes: string }
  | { phase: "downloading"; version: string; percent: number | null }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string };

let state: UpdateState = { phase: "idle" };
let pending: Update | null = null;
/** 사용자가 '나중에'를 누른 버전. 같은 버전은 자동 확인 때 다시 띄우지 않는다. */
let dismissed: string | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((f) => f());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

export const appVersion = (): Promise<string> => (inTauri ? getVersion() : Promise.resolve(tx("미리보기")));

/**
 * 새 버전을 확인한다. manual이면 '최신 버전입니다'나 오류도 보여 주고,
 * 자동 확인이면 조용히 실패하고 '나중에' 한 버전은 다시 띄우지 않는다.
 */
export async function checkForUpdate(manual: boolean): Promise<void> {
  if (!inTauri) {
    if (manual) set({ phase: "error", message: tx("브라우저 미리보기에서는 업데이트를 확인할 수 없습니다.") });
    return;
  }
  if (state.phase === "checking" || state.phase === "downloading" || state.phase === "installing") return;
  if (manual) set({ phase: "checking" });
  try {
    const update = await check();
    if (!update) {
      pending = null;
      return set(manual ? { phase: "latest" } : { phase: "idle" });
    }
    pending = update;
    if (!manual && dismissed === update.version) return set({ phase: "idle" });
    set({ phase: "available", version: update.version, notes: update.body ?? "" });
  } catch (e) {
    void api.appLog("warn", `업데이트 확인 실패: ${errorText(e)}`).catch(() => {});
    set(manual ? { phase: "error", message: checkErrorText(e) } : { phase: "idle" });
  }
}

/** 새 버전의 이 OS용 파일이 아직 안 올라왔을 때(릴리스 빌드 중) 알아듣기 쉽게 바꾼다. */
function checkErrorText(e: unknown): string {
  const text = errorText(e);
  if (/platform/i.test(text)) return tx("새 버전을 준비하는 중입니다. 잠시 뒤 다시 확인해 주세요.");
  return tx("업데이트를 확인하지 못했습니다: {0}", text);
}

export function dismissUpdate() {
  if (state.phase === "available") dismissed = state.version;
  set({ phase: "idle" });
}

/** 받아서 설치하고 다시 시작한다. Windows는 설치 프로그램이 앱을 닫고 새로 띄운다. */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update) return;
  const version = update.version;
  let total = 0;
  let got = 0;
  set({ phase: "downloading", version, percent: null });
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        set({ phase: "downloading", version, percent: total ? Math.min(100, Math.round((got / total) * 100)) : null });
      } else if (ev.event === "Finished") set({ phase: "installing", version });
    });
    await relaunch();
  } catch (e) {
    void api.appLog("warn", `업데이트 설치 실패 v${version}: ${errorText(e)}`).catch(() => {});
    set({ phase: "error", message: tx("업데이트하지 못했습니다: {0}", errorText(e)) });
  }
}

export function clearUpdateMessage() {
  if (state.phase === "latest" || state.phase === "error") set({ phase: "idle" });
}
