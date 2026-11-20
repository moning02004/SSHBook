// 버전을 한 번에 올린다: tauri.conf.json, package.json, package-lock.json, Cargo.toml, Cargo.lock
//   npm run version:bump -- 0.4.0
import { readFileSync, writeFileSync } from "node:fs";

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("쓰는 법: npm run version:bump -- <major.minor.patch>  (예: 0.4.0)");
  process.exit(1);
}

const edit = (path, fn) => {
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`${path}: 버전을 찾지 못했습니다`);
  writeFileSync(path, after);
  console.log(`  ${path}`);
};

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const prev = conf.version;
if (prev === next) {
  console.error(`이미 ${next}입니다.`);
  process.exit(1);
}
console.log(`${prev} → ${next}`);

edit("src-tauri/tauri.conf.json", (t) => t.replace(`"version": "${prev}"`, `"version": "${next}"`));
edit("package.json", (t) => t.replace(`"version": "${prev}"`, `"version": "${next}"`));
// package-lock: 맨 위와 packages[""]의 sshbook 버전 두 곳
edit("package-lock.json", (t) => t.replace(new RegExp(`("name": "sshbook",\\s+"version": )"${prev}"`, "g"), `$1"${next}"`));
edit("src-tauri/Cargo.toml", (t) => t.replace(/^version = ".*"$/m, `version = "${next}"`));
edit("src-tauri/Cargo.lock", (t) => t.replace(new RegExp(`(name = "sshbook"\\nversion = )"${prev}"`), `$1"${next}"`));

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## ${next} `)) {
  console.log(`\nCHANGELOG.md의 "## 다음 버전" 아래 내용을 "## ${next} — 날짜" 아래로 옮기세요.`);
}
