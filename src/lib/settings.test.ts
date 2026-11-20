import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, fontStack, normalize } from "./settings";

describe("normalize", () => {
  it("비어 있거나 깨진 값이면 기본값", () => {
    expect(normalize(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalize("x")).toEqual(DEFAULT_SETTINGS);
  });

  it("범위를 벗어난 값은 범위 안으로 맞춘다", () => {
    const s = normalize({ fontSize: 200, lineHeight: 0.2, scrollback: -5 });
    expect(s.fontSize).toBe(32);
    expect(s.lineHeight).toBe(1);
    expect(s.scrollback).toBe(0);
  });

  it("모르는 커서 모양은 기본값, 아는 값은 그대로", () => {
    expect(normalize({ cursorStyle: "wave" }).cursorStyle).toBe("block");
    expect(normalize({ cursorStyle: "bar" }).cursorStyle).toBe("bar");
  });

  it("타입이 다른 값은 무시한다", () => {
    const s = normalize({ copyOnSelect: "yes", fontSize: "20", confirmClose: false });
    expect(s.copyOnSelect).toBe(false);
    expect(s.fontSize).toBe(13);
    expect(s.confirmClose).toBe(false);
  });
});

describe("fontStack", () => {
  it("고른 글꼴 뒤에 한글 글꼴을 붙인다", () => {
    const f = fontStack("JetBrains Mono");
    expect(f.startsWith('"JetBrains Mono", ')).toBe(true);
    expect(f).toContain("Malgun Gothic");
  });

  it("따옴표를 지워 CSS가 깨지지 않게 한다", () => {
    expect(fontStack('Evil", serif; x')).toMatch(/^"Evil, serif; x", /);
  });

  it("비우면 기본 글꼴 목록", () => {
    expect(fontStack("  ").startsWith('"Cascadia Mono"')).toBe(true);
  });
});
