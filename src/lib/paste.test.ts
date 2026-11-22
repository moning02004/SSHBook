import { describe, expect, it } from "vitest";
import { pasteWarning, sanitizePaste } from "./paste";

describe("paste safety", () => {
  it("removes control characters but keeps tabs and newlines", () => {
    expect(sanitizePaste("a\tb\r\nc\x1b[201~d\x07\x9b")).toBe("a\tb\nc[201~d");
  });

  it("asks only when a newline could run something", () => {
    expect(pasteWarning("ls -la", false, 1)).toBeNull();
    expect(pasteWarning("rm -rf x\n", false, 1)).toMatch(/1줄/);
    expect(pasteWarning("a\nb", true, 1)).toBeNull();
    expect(pasteWarning("a\nb", true, 4)).toMatch(/창 4개/);
  });

  it("shows a short preview", () => {
    const w = pasteWarning(Array.from({ length: 8 }, (_, i) => `line${i}`).join("\n"), false, 1)!;
    expect(w).toContain("line4");
    expect(w).not.toContain("line5");
    expect(w).toContain("외 3줄");
  });
});
