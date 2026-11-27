import { describe, expect, it } from "vitest";
import { parseCwdReport, parseOsc52 } from "./osc";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("parseCwdReport", () => {
  it("OSC 7 file URL", () => {
    expect(parseCwdReport(7, "file://mac.local/Users/me/my%20work")).toBe("/Users/me/my work");
    expect(parseCwdReport(7, "file:///C:/Users/me")).toBe("C:/Users/me");
    expect(parseCwdReport(7, "http://x/y")).toBeNull();
    expect(parseCwdReport(7, "file://h/%E0%A4%A")).toBeNull();
  });

  it("OSC 9;9 Windows Terminal 방식", () => {
    expect(parseCwdReport(9, "9;C:\\Users\\me")).toBe("C:\\Users\\me");
    expect(parseCwdReport(9, '9;"C:\\Program Files"')).toBe("C:\\Program Files");
    // OSC 9 알림은 폴더가 아니다
    expect(parseCwdReport(9, "빌드 끝")).toBeNull();
    expect(parseCwdReport(9, "4;1;50")).toBeNull();
  });
});

describe("parseOsc52", () => {
  it("복사 요청을 글자로 푼다", () => {
    expect(parseOsc52(`c;${b64("안녕 hello\n")}`)).toBe("안녕 hello\n");
    expect(parseOsc52(`;${b64("x")}`)).toBe("x");
  });

  it("읽기 요청과 깨진 값은 무시한다", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("c;")).toBeNull();
    expect(parseOsc52("nosemicolon")).toBeNull();
    expect(parseOsc52("c;!!!")).toBeNull();
    expect(parseOsc52(`c;${btoa("\xff\xfe")}`)).toBeNull();
  });
});
