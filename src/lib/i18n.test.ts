import { describe, expect, it, vi } from "vitest";
import en from "../i18n/en.json";

async function load(lang: "ko" | "en") {
  vi.resetModules();
  vi.stubGlobal("localStorage", { getItem: () => lang, setItem: () => {} });
  return import("./i18n");
}

describe("i18n", () => {
  it("keeps Korean as the default and fills values", async () => {
    const { tx, translateBackend } = await load("ko");
    expect(tx("세션 {0}개를 가져왔습니다.{1}", 2, "")).toBe("세션 2개를 가져왔습니다.");
    expect(translateBackend("포트 80를 열지 못했습니다 (x)")).toBe("포트 80를 열지 못했습니다 (x)");
  });

  it("translates UI text and does not re-expand values", async () => {
    const { tx } = await load("en");
    expect(tx("저장")).toBe("Save");
    expect(tx("{0} 연결", "{1}", "x")).toBe("Connect {1}");
    expect(tx("없는 문장")).toBe("없는 문장");
  });

  it("translates backend errors with their details", async () => {
    const { translateBackend } = await load("en");
    expect(translateBackend("비밀번호가 맞지 않습니다.")).toBe("Wrong password.");
    expect(translateBackend("포트 8000를 열지 못했습니다 (in use)")).toBe("Could not open port 8000 (in use)");
    expect(translateBackend("셸을 열지 못했습니다: broken pipe")).toBe("Could not open the shell: broken pipe");
    expect(translateBackend("connection reset")).toBe("connection reset");
  });

  it("has an entry with the same placeholders for every key", () => {
    for (const [k, v] of Object.entries(en as Record<string, string>)) {
      const holes = (s: string) => (s.match(/\{\d*\}/g) ?? []).sort();
      expect(holes(v), k).toEqual(holes(k));
    }
  });
});
