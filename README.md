# SSH Terminal

Windows와 macOS에서 쓰는 SSH / 로컬 터미널. Tauri 2 + React + xterm.js.

## 지금 되는 것

- 마스터 비밀번호로 잠그는 보관함 파일 하나(`vault.sshv`)에 세션과 비밀 정보 저장
- 보관함 내보내기 / 다른 PC에서 가져오기
- 세션 저장: SSH(비밀번호 / 키 파일 / 에이전트), 로컬 셸
- 사이드바 그룹: 그룹을 하나도 안 쓰면 그냥 목록, 하나라도 쓰면 그룹별 + 맨 아래 "그룹 없음"
- 로컬 셸 열기 (Windows ConPTY, macOS openpty)
- SSH 접속 (`russh`): 비밀번호 / 개인 키(암호 걸린 키 포함) / SSH 에이전트
  - 처음 보는 서버는 터미널 안에서 호스트 키 지문을 보여 주고 `yes`를 받은 뒤 보관함에 저장한다. 키가 바뀌면 경고한다.
  - 비밀번호나 키 암호가 저장돼 있지 않거나 틀리면 터미널 안에서 다시 묻는다(입력은 화면에 안 보이고, 저장하지 않는다).
  - 에이전트: Windows는 "OpenSSH Authentication Agent" 서비스, macOS는 `SSH_AUTH_SOCK`
- 창에서 오른쪽 클릭 → 오른쪽/아래로 분할, 4분할, 이 창만 크게 보기, 분할 해제(나머지는 새 탭으로)
- 라이트 모드 기본, 다크 모드 전환(설정 기억)
- 설정(`Ctrl+,`): 글꼴·크기·줄 간격, 커서, 스크롤 기록, 고르면 복사, 오른쪽 클릭 붙여넣기, 닫기 확인. 바꾸면 열린 터미널에 바로 적용
- 글자 크기 단축키: `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, `Ctrl`+마우스 휠
- 사이드바 접기(`Ctrl+Shift+B`), 전체 화면(`F11`), 연결된 창을 닫을 때 확인

## 아직 안 되는 것

- 분할 경계선 드래그로 크기 조절
- "이 PC에서 기억하기"(OS 키체인으로 자동 잠금 해제), 자동 잠금 타이머

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
npm test               # 분할·그룹 로직 테스트
cd src-tauri && cargo test   # 보관함 암호화 + SSH 접속 테스트(내장 테스트 서버)
npm run tauri build    # 설치 파일 만들기 (Windows: .msi/.exe, macOS: .dmg/.app)
```

설치 파일은 그 OS에서 빌드해야 한다. Windows용은 Windows에서, macOS용은 Mac에서 만든다.
두 OS 모두 받으려면 GitHub Actions에서 `tauri-apps/tauri-action`으로 빌드하면 된다.

## 보관함 형식

파일 하나가 전부다. PC 고유 정보를 섞지 않아서 파일과 마스터 비밀번호만 있으면 어느 PC에서든 열린다.

```json
{
  "format": "ssh-terminal-vault",
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

저장 위치: Windows `%APPDATA%\com.example.sshterminal\vault.sshv`, macOS `~/Library/Application Support/com.example.sshterminal/vault.sshv`.
배포 전에 `src-tauri/tauri.conf.json`의 `identifier`를 실제 값으로 바꾼다(바꾸면 저장 폴더도 바뀐다).

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
