import { useEffect, useState } from "react";
import { api, type ShellChoice } from "../lib/api";
import { ComboBox } from "./ComboBox";

let cache: Promise<ShellChoice[]> | null = null;
/** 셸 목록은 앱을 켜 있는 동안 한 번만 찾는다(WSL 확인이 조금 걸린다). */
const loadShells = () => (cache ??= api.localShells().catch(() => []));

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

/** 셸 명령 칸. 직접 쓰거나(인자 포함) 이 PC에서 찾은 셸(cmd, PowerShell, WSL 배포판 …)을 고른다. */
export function ShellInput({ value, onChange, placeholder, ariaLabel }: Props) {
  const [shells, setShells] = useState<ShellChoice[]>([]);
  useEffect(() => {
    let alive = true;
    void loadShells().then((list) => alive && setShells(list));
    return () => {
      alive = false;
    };
  }, []);
  return <ComboBox value={value} options={shells.map((s) => s.command)} onChange={onChange} placeholder={placeholder} ariaLabel={ariaLabel} />;
}
