import { useState } from "react";
import { tx } from "../lib/i18n";
import { IconEye, IconEyeOff } from "./Icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/** 오른쪽 '보기' 버튼으로 글자를 보이거나 가리는 비밀번호 칸 */
export function PasswordInput({ value, onChange, placeholder, disabled }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input
        className="input"
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button
        type="button"
        className="password-toggle"
        aria-pressed={shown}
        disabled={disabled}
        aria-label={shown ? tx("숨기기") : tx("보기")}
        title={shown ? tx("숨기기") : tx("보기")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          // 바깥 <label>이 입력 칸을 한 번 더 누르지 않게 한다.
          e.preventDefault();
          setShown((v) => !v);
        }}
      >
        {shown ? <IconEyeOff width={16} height={16} /> : <IconEye width={16} height={16} />}
      </button>
    </div>
  );
}
