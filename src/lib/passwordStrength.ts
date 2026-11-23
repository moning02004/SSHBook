import { tx } from "./i18n";
// 마스터 비밀번호 강도. 외부 사전 없이, 길이·문자 종류·흔한 패턴으로 대략 잰다.
// 보관함 파일은 Argon2id로 잠기지만, 파일이 새면 비밀번호를 하나씩 대입해 볼 수 있으므로 길수록 좋다.

export interface Strength {
  /** 0 매우 약함 · 1 약함 · 2 보통 · 3 강함 · 4 매우 강함 */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  /** 더 강하게 만들 방법(이미 충분하면 빈 문자열) */
  hint: string;
}

const LABELS = [tx("매우 약함"), tx("약함"), tx("보통"), tx("강함"), tx("매우 강함")] as const;

/** 자주 쓰이는 비밀번호 조각. 들어 있으면 그만큼 빼고 센다. */
const COMMON = [
  "password", "passwd", "qwerty", "asdf", "zxcv", "letmein", "welcome", "admin", "login", "master",
  "iloveyou", "sshbook", "dragon", "monkey", "abc", "1234", "0000", "1111", "1q2w3e", "qwer",
];

function patternPenalty(pw: string): number {
  const lower = pw.toLowerCase();
  let penalty = 0;
  for (const w of COMMON) if (lower.includes(w)) penalty += w.length;
  // 같은 글자 반복(aaaa), 연속(abcd, 4321)
  let run = 1;
  for (let i = 1; i < pw.length; i++) {
    const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
    if (d === 0 || d === 1 || d === -1) {
      run++;
      if (run >= 3) penalty++;
    } else run = 1;
  }
  return penalty;
}

export function passwordStrength(pw: string): Strength {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const effective = Math.max(0, [...pw].length - patternPenalty(pw));
  // 길이가 가장 중요하고, 문자 종류는 덤
  const points = effective + (classes - 1) * 2;
  const score: Strength["score"] = points < 8 ? 0 : points < 12 ? 1 : points < 16 ? 2 : points < 20 ? 3 : 4;
  const hint =
    score >= 3
      ? ""
      : effective < [...pw].length
        ? tx("흔한 단어나 연속된 글자(1234, abcd)를 빼세요.")
        : classes < 3
          ? tx("더 길게 하거나 대문자·숫자·기호를 섞으세요.")
          : tx("단어 서너 개를 이어 붙이면 길고 외우기 쉽습니다.");
  return { score, label: LABELS[score], hint };
}
