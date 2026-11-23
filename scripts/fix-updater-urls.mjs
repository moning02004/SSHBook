#!/usr/bin/env node
// tauri-action 1.x는 초안 릴리스의 latest.json에 GitHub API 주소(api.github.com/.../assets/<id>)를 적는다.
// 이 주소는 로그인 없이 IP당 시간당 60회로 막히므로, 공개 다운로드 주소로 바꾼다.
// 서명은 파일 내용에 걸려 있어서 주소를 바꿔도 그대로 유효하다.
//
// 사용: node scripts/fix-updater-urls.mjs <latest.json> <release.json> <owner/repo>
import { readFileSync, writeFileSync } from "node:fs";

export function fixUpdaterUrls(latest, release, repo) {
  const names = new Map(release.assets.map((a) => [String(a.id), a.name]));
  const tag = encodeURIComponent(release.tag_name);
  const platforms = {};
  for (const [key, entry] of Object.entries(latest.platforms)) {
    const id = /\/releases\/assets\/(\d+)$/.exec(entry.url)?.[1];
    const name = id ? names.get(id) : decodeURIComponent(entry.url.split("/").pop());
    if (!name || !names.size || ![...names.values()].includes(name)) throw new Error(`${key}: 릴리스에 없는 파일입니다: ${entry.url}`);
    platforms[key] = { ...entry, url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}` };
  }
  return { ...latest, platforms };
}

if (process.argv[1]?.endsWith("fix-updater-urls.mjs")) {
  const [latestPath, releasePath, repo] = process.argv.slice(2);
  if (!latestPath || !releasePath || !repo) throw new Error("사용: fix-updater-urls.mjs <latest.json> <release.json> <owner/repo>");
  const fixed = fixUpdaterUrls(JSON.parse(readFileSync(latestPath, "utf8")), JSON.parse(readFileSync(releasePath, "utf8")), repo);
  writeFileSync(latestPath, `${JSON.stringify(fixed, null, 2)}\n`);
  console.log(`latest.json 주소 ${Object.keys(fixed.platforms).length}개를 공개 다운로드 주소로 바꿨습니다.`);
}
