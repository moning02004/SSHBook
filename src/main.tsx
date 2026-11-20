import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { api, errorText } from "./lib/api";
import { applyTheme, loadTheme } from "./lib/theme";

// 첫 화면이 깜빡이지 않게 렌더 전에 테마를 먼저 건다.
applyTheme(loadTheme());

// 처리하지 못한 오류는 진단 로그에 남긴다(설정 → 세션 기록·진단 로그 → 폴더 열기).
const report = (what: string) => void api.appLog("error", what.slice(0, 2000)).catch(() => {});
window.addEventListener("error", (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`처리하지 못한 거부: ${errorText(e.reason)}`));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
