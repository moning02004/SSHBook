// 터미널 안 프로그램이 보내는 OSC 신호 풀이.

/**
 * 셸이 알려 주는 지금 폴더. 모르는 형식이면 null.
 * - OSC 7: `file://호스트/경로` (경로는 URL 인코딩)
 * - OSC 9;9: `9;C:\경로` 또는 `9;"C:\경로"` (Windows Terminal 방식)
 */
export function parseCwdReport(code: 7 | 9, data: string): string | null {
  if (code === 9) {
    if (!data.startsWith("9;")) return null; // OSC 9은 알림으로도 쓰인다
    const p = data.slice(2).trim().replace(/^"(.*)"$/, "$1");
    return p || null;
  }
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  let p: string;
  try {
    p = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  // Windows: file:///C:/Users → C:/Users
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  return p;
}

/** 클립보드에 넣을 수 있는 최대 크기(base64 길이) */
const OSC52_MAX = 1024 * 1024 * 2;

/**
 * OSC 52 복사 요청(`c;base64`)을 글자로 푼다. 읽기 요청(`?`)이나 깨진 값이면 null.
 */
export function parseOsc52(data: string): string | null {
  const i = data.indexOf(";");
  if (i < 0) return null;
  const b64 = data.slice(i + 1).trim();
  if (!b64 || b64 === "?" || b64.length > OSC52_MAX) return null;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text || null;
  } catch {
    return null;
  }
}
