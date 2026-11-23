// 화면 언어. 한국어 문장을 그대로 키로 쓰고, 영어는 src/i18n/en.json에 둔다.
// 표처럼 시작할 때 만드는 문구가 있어서, 언어를 바꾸면 앱을 다시 켤 때 적용한다.
import en from "../i18n/en.json";

export type Language = "ko" | "en";

const KEY = "sshbook.language";

function loadLanguage(): Language {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

/** 이번 실행에서 쓰는 언어 */
export const language: Language = loadLanguage();

const table: Record<string, string> = language === "en" ? en : {};

export function saveLanguage(next: Language) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 저장소를 못 쓰면 한국어로 시작한다.
  }
}

export function savedLanguage(): Language {
  return loadLanguage();
}

/** 문구를 찾아 {0}, {1} 자리에 값을 넣는다. 값 안의 글자는 다시 치환하지 않는다. */
export function tx(key: string, ...args: unknown[]): string {
  const text = table[key] ?? key;
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (whole, i: string) => {
    const index = Number(i);
    if (index >= args.length) return whole;
    const v = args[index];
    return v === null || v === undefined || v === false ? "" : String(v);
  });
}

// ---- 백엔드가 보낸 문장 ----

interface Pattern {
  regex: RegExp;
  en: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const patterns: Pattern[] =
  language === "en"
    ? Object.entries(table)
        .filter(([k]) => k.includes("{}"))
        .sort(([a], [b]) => b.replace(/\{\}/g, "").length - a.replace(/\{\}/g, "").length)
        .map(([k, v]) => ({ regex: new RegExp(`^${k.split("{}").map(escape).join("([\\s\\S]*?)")}$`), en: v }))
    : [];

/** Rust에서 온 오류 문장을 번역한다. 모르는 문장(OS 오류 등)은 그대로 둔다. */
export function translateBackend(message: string, depth = 0): string {
  if (language !== "en" || !message || depth > 3) return message;
  const exact = table[message];
  if (exact !== undefined) return exact;
  for (const p of patterns) {
    const m = p.regex.exec(message);
    if (!m) continue;
    let i = 1;
    return p.en.replace(/\{\}/g, () => translateBackend(m[i++] ?? "", depth + 1));
  }
  // "무엇을 못 했습니다: OS 오류" 형태
  const cut = message.indexOf(": ");
  if (cut > 0) {
    const head = message.slice(0, cut);
    const translated = translateBackend(head, depth + 1);
    if (translated !== head) return `${translated}: ${translateBackend(message.slice(cut + 2), depth + 1)}`;
  }
  return message;
}
