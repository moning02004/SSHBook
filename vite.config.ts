/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri가 고정 포트로 개발 서버를 찾으므로 1420을 쓴다.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // e2e/는 Playwright가 돌린다.
  test: { include: ["src/**/*.test.ts"] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    // 데스크톱 앱이라 xterm이 든 단일 번들(약 600KB)도 괜찮다.
    chunkSizeWarningLimit: 1500,
  },
});
