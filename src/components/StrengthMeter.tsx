import { passwordStrength } from "../lib/passwordStrength";
import { tx } from "../lib/i18n";

/** 비밀번호 강도 막대 + 한 줄 안내 */
export function StrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const s = passwordStrength(password);
  return (
    <div className={`strength s${s.score}`} role="status" aria-live="polite">
      <div className="strength-bar" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < Math.max(1, s.score) ? "on" : ""} />
        ))}
      </div>
      <span className="strength-label">{tx("강도: {0}", s.label)}</span>
      {s.hint && <span className="hint">{s.hint}</span>}
    </div>
  );
}
