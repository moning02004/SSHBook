import { IconPrompt } from "./Icons";
import { tx } from "../lib/i18n";

/** 앱을 여는 동안 보이는 화면: 로고와 움직이는 점 세 개 */
export function Splash() {
  return (
    <div className="splash" role="status" aria-label={tx("여는 중")}>
      <div className="splash-brand">
        <IconPrompt width={30} height={30} />
        SSHBook
      </div>
      <div className="splash-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
