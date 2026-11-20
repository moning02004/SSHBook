import { open, save } from "@tauri-apps/plugin-dialog";
import { inTauri } from "./api";

const VAULT_FILTER = [{ name: "SSH Terminal 보관함", extensions: ["sshv"] }];

export async function pickKeyFile(): Promise<string | null> {
  if (!inTauri) return window.prompt("개인 키 파일 경로", "~/.ssh/id_ed25519");
  const r = await open({ title: "개인 키 파일 선택", multiple: false, directory: false });
  return typeof r === "string" ? r : null;
}

export async function pickVaultToImport(): Promise<string | null> {
  if (!inTauri) return window.prompt("보관함 파일 경로", "vault.sshv");
  const r = await open({ title: "보관함 파일 가져오기", multiple: false, directory: false, filters: VAULT_FILTER });
  return typeof r === "string" ? r : null;
}

export async function pickExportPath(): Promise<string | null> {
  if (!inTauri) return window.prompt("내보낼 경로", "vault.sshv");
  return save({ title: "보관함 파일 내보내기", defaultPath: "vault.sshv", filters: VAULT_FILTER });
}
