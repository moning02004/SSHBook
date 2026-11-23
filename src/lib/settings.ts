import { tx } from "./i18n";
// 이 PC에만 기억하는 앱 설정. 보관함과 상관없고, 바꾸면 열린 터미널에 바로 적용된다.

export type CursorStyle = "block" | "bar" | "underline";

export interface Settings {
  /** 터미널 글꼴 이름. 비우면 기본 글꼴 */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** 위로 올려 볼 수 있는 줄 수 */
  scrollback: number;
  /** 글자를 끌어서 고르면 바로 복사 */
  copyOnSelect: boolean;
  /** 오른쪽 클릭으로 붙여넣기 (메뉴는 Shift+오른쪽 클릭) */
  rightClickPaste: boolean;
  /** 연결된 창을 닫을 때 묻기 */
  confirmClose: boolean;
  /** 아무 입력이 없으면 보관함을 잠그는 시간(분). 0이면 잠그지 않는다 */
  autoLockMinutes: number;
}

export const AUTO_LOCK_CHOICES = [0, 5, 10, 15, 30, 60];

export const FONT_SIZE = { min: 9, max: 32, step: 1 };
export const LINE_HEIGHTS = [1, 1.1, 1.2, 1.4];
export const SCROLLBACKS = [1000, 5000, 10000, 50000];

/** 고를 수 있는 글꼴. 이 PC에 없는 것은 목록에서 '설치 안 됨'으로 보인다. */
export const FONT_PRESETS = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "D2Coding",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Courier New",
];

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "",
  fontSize: 13,
  lineHeight: 1.1,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  rightClickPaste: false,
  confirmClose: true,
  autoLockMinutes: 15,
};

/** 한글은 고른 글꼴에 없을 수 있으므로 한글 글꼴을 뒤에 붙인다. */
const FALLBACK = '"Cascadia Mono", "SF Mono", Menlo, Consolas, "D2Coding", "Malgun Gothic", "Apple SD Gothic Neo", monospace';

export function fontStack(name: string): string {
  const n = name.trim().replace(/["\\]/g, "");
  return n ? `"${n}", ${FALLBACK}` : FALLBACK;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 저장된 값이 깨졌거나 옛 버전이어도 쓸 수 있는 값으로 맞춘다. */
export function normalize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const num = (v: unknown, fb: number) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);
  const cursor = r.cursorStyle === "bar" || r.cursorStyle === "underline" || r.cursorStyle === "block" ? r.cursorStyle : d.cursorStyle;
  return {
    fontFamily: typeof r.fontFamily === "string" ? r.fontFamily.slice(0, 80) : d.fontFamily,
    fontSize: clamp(Math.round(num(r.fontSize, d.fontSize)), FONT_SIZE.min, FONT_SIZE.max),
    lineHeight: clamp(num(r.lineHeight, d.lineHeight), 1, 2),
    cursorStyle: cursor,
    cursorBlink: bool(r.cursorBlink, d.cursorBlink),
    scrollback: clamp(Math.round(num(r.scrollback, d.scrollback)), 0, 100000),
    copyOnSelect: bool(r.copyOnSelect, d.copyOnSelect),
    rightClickPaste: bool(r.rightClickPaste, d.rightClickPaste),
    confirmClose: bool(r.confirmClose, d.confirmClose),
    autoLockMinutes: AUTO_LOCK_CHOICES.includes(num(r.autoLockMinutes, -1)) ? num(r.autoLockMinutes, 0) : d.autoLockMinutes,
  };
}

// ---- 저장과 구독 ----

const KEY = "sshbook.settings";
const OLD_ASK_ON_CLOSE = "ssh-terminal.askOnClose";

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
    // 예전 버전의 '다시 묻지 않음' 값을 이어받는다.
    const old = localStorage.getItem(OLD_ASK_ON_CLOSE);
    return normalize({ confirmClose: old === null ? true : old === "1" });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current: Settings = read();
const listeners = new Set<(s: Settings) => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = normalize({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 저장 실패는 무시한다(이번 실행 동안은 적용된다).
  }
  listeners.forEach((fn) => fn(current));
}

export function resetSettings() {
  updateSettings(DEFAULT_SETTINGS);
}

export function subscribeSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function bumpFontSize(delta: number) {
  updateSettings({ fontSize: current.fontSize + delta });
}

/** 글꼴이 이 PC에 설치돼 있는지. 기본 글꼴과 글자 폭이 다르면 있는 것으로 본다. */
export function isFontInstalled(name: string): boolean {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return true;
    const sample = tx("mmmmmmmmmmlli1WW@#가나");
    return ["monospace", "serif", "sans-serif"].some((base) => {
      ctx.font = `20px ${base}`;
      const w0 = ctx.measureText(sample).width;
      ctx.font = `20px "${name}", ${base}`;
      return ctx.measureText(sample).width !== w0;
    });
  } catch {
    return true;
  }
}
