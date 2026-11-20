import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { applyTheme, loadTheme } from "./lib/theme";

// 첫 화면이 깜빡이지 않게 렌더 전에 테마를 먼저 건다.
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
