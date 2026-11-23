import { defineConfig } from "@playwright/test";

// 앱의 개발 미리보기(가짜 백엔드)로 핵심 화면 흐름을 확인한다.
// 브라우저를 따로 받지 않도록 설치된 Chrome을 쓴다.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5198",
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5198 --strictPort",
    url: "http://127.0.0.1:5198",
    reuseExistingServer: !process.env.CI,
  },
});
