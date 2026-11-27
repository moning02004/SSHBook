import { open, save } from "@tauri-apps/plugin-dialog";
import { inTauri } from "./api";
import { tx } from "./i18n";

const VAULT_FILTER = [{ name: tx("SSHBook 설정·보관함"), extensions: ["sshbook", "sshv"] }];
/** 내보낼 때 처음 보이는 파일 이름(바꿀 수 있다) */
export const EXPORT_DEFAULT_NAME = "book_settings.sshbook";

export async function pickKeyFile(): Promise<string | null> {
  if (!inTauri) return window.prompt(tx("개인 키 파일 경로"), "~/.ssh/id_ed25519");
  const r = await open({ title: tx("개인 키 파일 선택"), multiple: false, directory: false });
  return typeof r === "string" ? r : null;
}

export async function pickVaultToImport(): Promise<string | null> {
  if (!inTauri) return window.prompt(tx("보관함 파일 경로"), EXPORT_DEFAULT_NAME);
  const r = await open({ title: tx("보관함 파일 가져오기"), multiple: false, directory: false, filters: VAULT_FILTER });
  return typeof r === "string" ? r : null;
}

export async function pickExportPath(): Promise<string | null> {
  if (!inTauri) return window.prompt(tx("내보낼 경로"), EXPORT_DEFAULT_NAME);
  const r = await save({ title: tx("세션·그룹·설정 내보내기"), defaultPath: EXPORT_DEFAULT_NAME, filters: [{ name: tx("SSHBook 설정"), extensions: ["sshbook"] }] });
  if (!r) return null;
  // 확장자를 지웠으면 붙인다.
  return /\.(sshbook|sshv)$/i.test(r) ? r : `${r}.sshbook`;
}

/** 내려받을 파일을 저장할 곳 */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!inTauri) return window.prompt(tx("저장할 경로"), `~/Downloads/${defaultName}`);
  return save({ title: tx("내려받기"), defaultPath: defaultName });
}

/** 폴더 하나 고르기(폴더 내려받기 대상, 폴더 올리기) */
export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return window.prompt(title, "~/Downloads");
  const r = await open({ title, multiple: false, directory: true });
  return typeof r === "string" ? r : null;
}

/** 올릴 파일들 */
export async function pickUploadFiles(): Promise<string[]> {
  if (!inTauri) {
    const p = window.prompt(tx("올릴 파일 경로"), "~/notes.txt");
    return p ? [p] : [];
  }
  const r = await open({ title: tx("올릴 파일 선택"), multiple: true, directory: false });
  return Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
}
