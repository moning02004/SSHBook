import type { ITheme } from "@xterm/xterm";

export type ThemeName = "light" | "dark";
const KEY = "sshbook.theme";

/** 기본은 라이트. 사용자가 바꾸면 그 값을 기억한다. */
export function loadTheme(): ThemeName {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 저장 실패는 무시한다(다음 실행 때 라이트로 시작).
  }
}

export const terminalThemes: Record<ThemeName, ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#2c323b",
    cursor: "#2f6fe4",
    cursorAccent: "#ffffff",
    selectionBackground: "#d6e3fb",
    black: "#1b1f24",
    red: "#c0262d",
    green: "#17804a",
    yellow: "#8f5400",
    blue: "#2459c9",
    magenta: "#8b3fb5",
    cyan: "#0f7487",
    white: "#5f6873",
    brightBlack: "#56606b",
    brightRed: "#d6383f",
    brightGreen: "#1f9a5a",
    brightYellow: "#a86a00",
    brightBlue: "#2f6fe4",
    brightMagenta: "#a252cc",
    brightCyan: "#138aa0",
    brightWhite: "#1b1f24",
  },
  dark: {
    background: "#0b0d10",
    foreground: "#d3d7dc",
    cursor: "#5b9cff",
    cursorAccent: "#0b0d10",
    selectionBackground: "#264166",
    black: "#1b1f24",
    red: "#ff7b7b",
    green: "#6fd39b",
    yellow: "#e8b45a",
    blue: "#7fb2ff",
    magenta: "#d2a6ff",
    cyan: "#6ccfe0",
    white: "#d3d7dc",
    brightBlack: "#8a939d",
    brightRed: "#ff9b9b",
    brightGreen: "#8ee6b4",
    brightYellow: "#f4cd84",
    brightBlue: "#a3c8ff",
    brightMagenta: "#e2c2ff",
    brightCyan: "#93e1ee",
    brightWhite: "#ffffff",
  },
};
