# SSHBook

Windows와 macOS에서 쓰는 SSH / 로컬 터미널. 서버 접속 정보를 마스터 비밀번호로 잠근 보관함 하나에 모아 둔다.
Tauri 2 + React + xterm.js.

## 설치

[Releases](https://github.com/moning02004/SSHBook/releases/latest)에서 내려받는다.

| OS | 파일 |
|---|---|
| Windows 10/11 | `SSHBook_<버전>_x64-setup.exe` (또는 `.msi`) |
| macOS 11 이상 (Intel·Apple Silicon) | `SSHBook_<버전>_universal.dmg` |

코드 서명을 하지 않은 빌드라서 처음 실행할 때 OS가 경고한다.

- **Windows**: "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**.
  스마트 앱 컨트롤이 켜진 PC에서는 서명 없는 앱이 아예 막힐 수 있다.
- **macOS**: "확인되지 않은 개발자" 또는 "손상되었기 때문에 열 수 없습니다"가 뜨면
  앱을 `응용 프로그램`으로 옮긴 뒤 터미널에서 한 번 실행한다.

  ```bash
  xattr -dr com.apple.quarantine /Applications/SSHBook.app
  ```

### 업데이트

한 번 설치한 뒤에는 앱이 켜질 때 새 버전을 확인하고, 있으면 오른쪽 아래에 알려 준다.
**지금 업데이트**를 누르면 내려받아 설치하고 다시 시작한다. 설정 → 업데이트에서 직접 확인할 수도 있다.
받은 파일은 앱에 들어 있는 공개 키로 서명을 확인한 뒤에만 설치된다.

## 릴리스 만들기

`npm run version:bump -- 0.4.0`으로 버전 세 곳(tauri.conf.json, package.json, Cargo.toml)과 lock 파일을 한 번에 올리고,
`CHANGELOG.md`의 "다음 버전" 아래 내용을 `## 0.4.0 — 날짜`로 옮긴 뒤 같은 버전 태그를 올리면
GitHub Actions(`.github/workflows/release.yml`)가 Windows·macOS 설치 파일을 만들어 Releases에 붙인다.

```bash
git tag v0.1.0
git push origin v0.1.0
```

앱 안 업데이트용 서명 키가 필요하다(처음 한 번).

1. `npx tauri signer generate -w ~/.tauri/sshbook.key`로 키를 만든다. 암호를 정해 넣는다.
2. 공개 키(`~/.tauri/sshbook.key.pub` 내용)를 `tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다.
3. GitHub 저장소 Settings → Secrets and variables → Actions에 등록한다.
   - `TAURI_SIGNING_PRIVATE_KEY`: 개인 키 파일(`~/.tauri/sshbook.key`) 내용 전체
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 키 암호

개인 키를 잃어버리면 이미 설치된 앱에 더는 업데이트를 보낼 수 없다. 따로 백업해 둔다.

## 기능

- **보관함**: 세션·비밀번호·개인 키·명령 모음·확인한 서버 키를 마스터 비밀번호로 잠근 파일 하나(`vault.sshv`)에 둔다.
  다른 PC로 내보내기·가져오기, 비밀번호 바꾸기(강도 표시), 자동 백업과 되돌리기, 자동 잠금, 마스터 비밀번호 끄기(선택)
- **SSH** (`russh`): 비밀번호 / 개인 키(암호 포함) / SSH 에이전트, 처음 보는 서버는 지문 확인, 키가 바뀌면 경고
  - 점프 호스트(다른 세션을 거쳐 접속), 연결 시 시작 경로, 포트 포워딩(-L / -R / SOCKS5), 응답 시간 표시
  - 세션 기록(출력을 시각과 함께 파일로), 세션 복제, 환경 색(운영=빨강 등)
- **화면**: 파이참처럼 칸마다 탭 줄. 탭을 끌어 다른 칸·가장자리로 옮겨 분할, 경계 끌어서 크기 조절, 4분할, 크게 보기,
  탭 이름 바꾸기, 보이는 칸에 동시 입력, 다시 켜면 지난번 작업 공간을 끊긴 상태로 복원(탭마다 ⌘R / Ctrl+R로 연결)
- **파일 창 (SFTP)**: 터미널의 지금 폴더에서 열기, 폴더째 올리기·내려받기(진행률·취소), 끌어다 놓아 올리기
- **그 밖**: 터미널 안 검색, 명령 모음(스니펫), 호스트 목록, 로컬 셸, 라이트/다크, 앱 안 업데이트
- **OTP·2단계 인증**: 서버가 묻는 코드를 터미널에서 입력한다(비밀번호나 키 뒤에 OTP를 요구하는 서버 포함)
- **`~/.ssh/config` 가져오기**: 설정 → 가져오기에서 호스트를 골라 세션으로 만든다. 설정 파일은 바꾸지 않는다
- **한국어·영어 화면**: 설정 → 화면에서 고르고 앱을 다시 켜면 적용된다

## 단축키

| 하는 일 | macOS | Windows |
|---|---|---|
| 호스트 목록 | `⌘D` | `Alt+D` |
| 끊긴 탭 다시 연결 | `⌘R` | `Ctrl+R` (끊긴 탭에서만) |
| 탭 닫기 | `⌘W` | `Ctrl+Shift+W` |
| 다음 / 이전 탭 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 같음 |
| n번째 탭 (9 = 마지막) | `⌘1` … `⌘9` | `Alt+1` … `Alt+9` |
| 옆 칸으로 이동 | `⌘⌥` + 방향키 | `Ctrl+Alt` + 방향키 |
| 오른쪽 / 아래로 분할 | `Alt+Shift+→` / `↓` | 같음 |
| 이 칸만 크게 보기 | `⌘⇧Z` | `Ctrl+Shift+Z` |
| 터미널에서 찾기 | `⌘F` | `Ctrl+Shift+F` |
| 명령 모음 | `⌘⇧S` | `Ctrl+Shift+S` |
| 파일 창 | `⌘⇧O` | `Ctrl+Shift+O` |
| 동시 입력 켜기·끄기 | `⌘⇧I` | `Ctrl+Shift+I` |
| 설정 | `⌘,` | `Ctrl+,` |
| 글자 크게 / 작게 / 원래대로 | `⌘=` / `⌘-` / `⌘0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

탭 이름은 탭을 더블클릭해서 바꾼다. 셸에서 쓰는 `Ctrl+D`(EOF), `Ctrl+R`(기록 검색, 맥), `Ctrl+F`(Windows)는 셸로 그대로 간다.

## 무엇이 어디에 저장되나

| 무엇 | 어디 | 보호 |
|---|---|---|
| 세션, 비밀번호, 개인 키, 명령 모음, 확인한 서버 키 | 앱 데이터 폴더의 `vault.sshv` | 마스터 비밀번호(Argon2id + AES-256-GCM), 파일 권한 0600 |
| 보관함 자동 백업 (한 시간에 하나, 최근 10개) | 같은 폴더의 `backups/` | 백업할 때의 마스터 비밀번호, 0600 |
| 마스터 비밀번호를 껐을 때의 열쇠 | 같은 폴더의 `vault.key` | 파일 권한 0600뿐이다. 내 계정으로 도는 프로그램은 읽을 수 있으니 FileVault를 켜 둔다 |
| 세션 기록(켠 세션만) | 앱 데이터 폴더의 `logs/` | **평문**, 0600. 화면에 보인 내용이 그대로 남는다 |
| 진단 로그 `sshbook-app.log` | `logs/` | 연결 결과·오류만, 비밀번호와 화면 내용은 남기지 않는다 |
| 설정, 작업 공간 배치(세션 id·탭 이름) | 앱의 로컬 저장소 | 비밀 정보 없음 |

앱 데이터 폴더: macOS `~/Library/Application Support/com.moning02004.sshbook`, Windows `%APPDATA%\com.moning02004.sshbook`.
설정 → 세션 기록·진단 로그 → "기록 폴더 열기"로 바로 열 수 있다.

## 업데이트 서명 키

앱 안 업데이트는 릴리스 파일을 업데이트 서명 키로 확인한 뒤에만 설치한다(코드 서명과는 별개).

- **백업**: `~/.tauri/sshbook.key`와 그 암호를 비밀번호 관리자 등 PC 밖에 보관한다. 잃어버리면 설치된 앱에 더는 업데이트를 보낼 수 없고, 직접 새로 설치해야 한다.
- **교체** (키가 샜거나 바꾸고 싶을 때):
  1. 새 키를 만든다: `npx tauri signer generate -w ~/.tauri/sshbook-2.key`
  2. `tauri.conf.json`의 `plugins.updater.pubkey`를 새 공개 키로 바꾸고, GitHub Secrets는 **옛 개인 키 그대로** 둔 채 릴리스한다.
     설치된 앱은 옛 키로 서명된 이 업데이트를 받고, 이제부터 새 키를 믿는다.
  3. 그다음 릴리스부터 GitHub Secrets(`TAURI_SIGNING_PRIVATE_KEY`, `..._PASSWORD`)를 새 키로 바꾼다.
- 옛 키가 이미 샜다면 2번 릴리스를 서두르고, 그 전 버전을 쓰는 사람에게는 직접 새로 설치하라고 알린다.

## 처음 준비

| 도구 | Windows | macOS |
|---|---|---|
| Node.js 20+ | 설치되어 있음 | `brew install node` |
| Rust | `winget install Rustlang.Rustup` | `curl https://sh.rustup.rs -sSf \| sh` |
| C/C++ 빌드 도구 | Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발" (아래 명령) | `xcode-select --install` |
| WebView | WebView2 (Windows 11에 기본 포함) | 기본 포함 |

Windows 빌드 도구 설치 (관리자 권한 창이 뜬다):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

빌드 중 `애플리케이션 제어 정책에서 이 파일을 차단했습니다 (os error 4551)`가 나오면 Windows의 스마트 앱 컨트롤이
cargo가 만든 빌드 스크립트를 막는 것이다. Windows 보안 → 앱 및 브라우저 컨트롤 → 스마트 앱 컨트롤을 꺼야 빌드된다.

## 실행

```bash
npm install
npm run tauri dev      # 앱 실행 (처음엔 Rust 빌드로 몇 분 걸림)
npm run dev            # 화면만 브라우저에서 보기 (가짜 백엔드, 저장 안 됨)
npm test               # 화면 로직 테스트(칸·탭, 작업 공간, 비밀번호 강도 등)
npm run test:e2e       # 핵심 화면 흐름 E2E (설치된 Chrome 사용)
cd src-tauri && cargo test   # 보관함·SSH·포워딩·기록 테스트(내장 테스트 서버)

# 실제 OpenSSH 서버로 통합 테스트 (Docker 필요)
docker build -t sshbook-it-sshd .github/sshd
docker run -d --name sshbook-it -p 127.0.0.1:2222:22 sshbook-it-sshd
cd src-tauri && cargo test it_ -- --ignored
npm run tauri build    # 설치 파일 만들기 (Windows: .msi/.exe, macOS: .dmg/.app)
```

설치 파일은 그 OS에서 빌드해야 한다. Windows용은 Windows에서, macOS용은 Mac에서 만든다.
두 OS 모두 받으려면 GitHub Actions에서 `tauri-apps/tauri-action`으로 빌드하면 된다.

## 보관함 형식

파일 하나가 전부다. PC 고유 정보를 섞지 않아서 파일과 마스터 비밀번호만 있으면 어느 PC에서든 열린다.

```json
{
  "format": "sshbook-vault",
  "version": 1,
  "kdf":    { "alg": "argon2id", "m_kib": 65536, "t": 3, "p": 1, "salt": "<base64>" },
  "cipher": { "alg": "aes-256-gcm", "nonce": "<base64>" },
  "ciphertext": "<base64>"
}
```

- 마스터 비밀번호 → Argon2id(64 MiB, 3회) → 256비트 키
- 내용(세션 목록 + 비밀번호·개인 키·패스프레이즈) → AES-256-GCM. 머리글은 AAD로 묶어 변조를 막는다.
- 저장할 때마다 nonce를 새로 뽑고, 임시 파일에 쓴 뒤 바꿔치기한다.
- 복호화는 Rust 쪽에서만 한다. 프론트엔드에는 비밀 정보가 "있음/없음"만 전달된다.
- 마스터 비밀번호는 복구할 수 없다.

저장 위치: Windows `%APPDATA%\com.moning02004.sshbook\vault.sshv`, macOS `~/Library/Application Support/com.moning02004.sshbook/vault.sshv`.
예전 이름(SSH Terminal)으로 만든 보관함(`"format": "ssh-terminal-vault"`)도 그대로 열리고, 다음에 저장할 때 새 형식 이름으로 바뀐다.

## 구조

```
src/
  App.tsx                 탭·분할·단축키·대화상자를 묶는 곳
  lib/layout.ts           분할 트리 (split / quad / close / unsplit) + 테스트
  lib/sessions.ts         세션 모델, 그룹 묶음 규칙 + 테스트
  lib/terminals.ts        창별 xterm 인스턴스 관리 (탭을 옮겨도 화면과 연결 유지)
  lib/api.ts              Rust 명령 호출 + 브라우저용 가짜 백엔드
  components/             Sidebar, Workspace, ContextMenu, SessionEditor, VaultScreen
src-tauri/src/
  lib.rs                  Tauri 명령
  vault.rs                보관함 암호화 + 테스트
  pty.rs                  로컬 셸
  ssh.rs                  SSH 접속·인증·호스트 키 확인 + 테스트
  testdata/               테스트 전용 SSH 키
```
