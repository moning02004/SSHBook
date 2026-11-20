// 이 PC에만 기억하는 화면 설정. 보관함과 상관없고, 못 읽으면 기본값을 쓴다.

const PREFIX = "ssh-terminal.";

export function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function saveFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(PREFIX + key, value ? "1" : "0");
  } catch {
    // 저장 실패는 무시한다.
  }
}

/** 사이드바를 접었는지 */
export const SIDEBAR_HIDDEN = "sidebarHidden";
