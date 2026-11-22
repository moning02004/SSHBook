// 터미널 붙여넣기 안전장치.
// 웹페이지에서 복사한 글에는 보이지 않는 줄바꿈이나 제어 문자가 숨어 있을 수 있고,
// 셸은 줄바꿈을 만나면 그 줄을 바로 실행한다.

/** 제어 문자를 뺀다(탭·줄바꿈만 남긴다). ESC가 빠지므로 괄호 붙여넣기 끝 표시를 흉내 낼 수 없다. */
export function sanitizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/**
 * 물어봐야 하면 확인 문구를, 아니면 null.
 * bracketed: 셸이 붙여넣기를 실행하지 않고 받는 모드
 * targets: 입력이 가는 창 수(동시 입력이면 2 이상)
 */
export function pasteWarning(text: string, bracketed: boolean, targets: number): string | null {
  if (!text.includes("\n")) return null;
  if (bracketed && targets <= 1) return null;
  const lines = text.replace(/\n$/, "").split("\n");
  const preview = lines.slice(0, 5).map((l) => (l.length > 70 ? `${l.slice(0, 70)}…` : l)).join("\n");
  const more = lines.length > 5 ? `\n… 외 ${lines.length - 5}줄` : "";
  const where = targets > 1 ? `동시 입력 중인 창 ${targets}개에` : "터미널에";
  return `${where} ${lines.length}줄을 붙여 넣습니다. 줄바꿈이 있으면 바로 실행될 수 있습니다.\n\n${preview}${more}\n\n붙여 넣을까요?`;
}
