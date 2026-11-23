// 호스트·사용자·경로·명령을 입력하는 앱이라 OS의 자동 대문자, 자동 수정, 맞춤법 제안은 방해만 된다.
// 입력칸마다 적지 않고, 초점이 가는 순간 꺼서 새로 생기는 칸(터미널 포함)까지 한 번에 다룬다.

export function disableTextAssist(el: EventTarget | null) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (el.getAttribute("autocapitalize") === "off") return;
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocorrect", "off");
  el.spellcheck = false;
}

export function installTextAssistGuard() {
  document.addEventListener("focusin", (e) => disableTextAssist(e.target), true);
  disableTextAssist(document.activeElement);
}
