import { expect, test, type Locator, type Page } from "@playwright/test";

const MASTER = "Tiger-Moon-Lake-42";

const terminal = (page: Page) => page.locator(".xterm-rows").last();

// 화면 글자를 DOM에서 읽으므로 GPU(WebGL) 그리기는 끈다.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("sshbook.settings")) localStorage.setItem("sshbook.settings", JSON.stringify({ gpuRender: false }));
  });
});

async function createVault(page: Page) {
  await page.goto("/");
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(MASTER);
  await fields.nth(1).fill(MASTER);
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.getByRole("button", { name: "새 세션" })).toBeVisible();
}

async function openLocal(page: Page) {
  await page.getByTitle("localhost 연결").click();
  await expect(terminal(page)).toContainText("localhost $");
}

async function lockAndUnlock(page: Page) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "보안" }).click();
  await page.getByRole("button", { name: "잠그기", exact: true }).click();
  await page.locator("[role=alertdialog] .danger-fill").click();
  const field = page.locator('input[type="password"]');
  await expect(field).toHaveCount(1);
  await field.fill(MASTER);
  await page.getByRole("button", { name: "잠금 해제", exact: true }).click();
}

test("보관함 → 연결 → 분할 → 잠금 → 끊긴 채로 복원 → 다시 연결", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(page.locator(".group")).toHaveCount(2);
  // 배치가 저장될 시간을 준다.
  await page.waitForTimeout(600);

  await lockAndUnlock(page);
  await expect(page.locator(".group")).toHaveCount(2);
  await expect(page.locator(".xterm-rows").first()).toContainText("연결되지 않음");
  await expect(page.getByRole("button", { name: "다시 열기" })).toHaveCount(0);

  await page.locator(".xterm-helper-textarea").last().focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+r" : "Control+r");
  await expect(page.locator(".xterm-rows", { hasText: "$" }).first()).toBeVisible();
});

test("새 세션은 단계별로 입력하고 저장하면 바로 연결한다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "새 세션" }).click();
  const dialog = page.locator(".session-editor");
  await dialog.getByRole("button", { name: "다음" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("호스트를 입력하세요.");

  await dialog.getByPlaceholder("10.0.1.21 또는 example.com").fill("e2e.internal");
  await dialog.getByRole("button", { name: "다음" }).click();
  await expect(dialog.getByRole("tab", { name: "인증" })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("textbox", { name: "사용자", exact: true }).fill("tester");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("tab", { name: "표시" })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "다음" }).click();
  await dialog.getByRole("button", { name: "다음" }).click();
  await dialog.getByRole("button", { name: "저장하고 연결" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(terminal(page)).toContainText("처음 연결하는 서버");
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("비밀번호");
  await page.keyboard.type("test-only");
  await page.keyboard.press("Enter");
  // 저장된 비밀번호가 없었으므로 저장할지 묻는다.
  await expect(terminal(page)).toContainText("이 비밀번호를 보관함에 저장할까요?");
  await page.keyboard.type("y");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("✓ 비밀번호를 보관함에 저장했습니다.");
  await expect(terminal(page)).toContainText("e2e.internal $");
  await expect(terminal(page)).not.toContainText("test-only");
});

test("새 세션은 왼쪽 항목도 순서대로만 넘어가고, 지나온 항목으로는 돌아갈 수 있다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "새 세션" }).click();
  const dialog = page.locator(".session-editor");
  const tab = (name: string) => dialog.getByRole("tab", { name });

  await expect(tab("인증")).toHaveAttribute("aria-disabled", "true");
  await tab("인증").click({ force: true });
  await expect(dialog.getByRole("alert")).toHaveText("지금 항목을 입력하고 '다음'을 누르세요.");
  await expect(tab("연결")).toHaveAttribute("aria-selected", "true");

  const host = dialog.getByPlaceholder("10.0.1.21 또는 example.com");
  await host.fill("e2e.internal");
  await dialog.getByRole("button", { name: "다음" }).click();
  await dialog.getByRole("textbox", { name: "사용자", exact: true }).fill("tester");
  await dialog.getByRole("button", { name: "다음" }).click();
  await expect(tab("표시")).toHaveAttribute("aria-selected", "true");

  // 지나온 항목으로는 자유롭게 간다.
  await tab("연결").click();
  await expect(tab("연결")).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  // 돌아가서 필수 칸을 지우면 앞으로 건너뛸 수 없다.
  await host.fill("");
  await tab("표시").click();
  await expect(dialog.getByRole("alert")).toHaveText("호스트를 입력하세요.");
  await expect(tab("연결")).toHaveAttribute("aria-selected", "true");
  await host.fill("e2e.internal");
  await tab("표시").click();
  await expect(tab("표시")).toHaveAttribute("aria-selected", "true");
  // 아직 안 간 항목은 막힌다.
  await tab("기록").click({ force: true });
  await expect(dialog.getByRole("alert")).toHaveText("지금 항목을 입력하고 '다음'을 누르세요.");
});

test("그룹은 목록에서 고르거나 새로 쓰고, 왼쪽에서 접고 펼친다", async ({ page }) => {
  await createVault(page);
  const editor = page.locator(".session-editor");
  const setGroup = async (name: string, group: string, pick: boolean) => {
    await page.getByRole("button", { name: `${name} 편집` }).click();
    await editor.getByRole("tab", { name: "표시" }).click();
    const field = editor.getByRole("combobox", { name: "그룹" });
    if (pick) {
      await field.click();
      await page.getByRole("option", { name: group }).click();
    } else {
      await field.fill(group);
    }
    await expect(field).toHaveValue(group);
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(editor).toHaveCount(0);
  };
  await setGroup("dev-box", "개발", false);
  await setGroup("localhost", "개발", true);

  const toggle = page.locator(".group-toggle", { hasText: "개발" });
  const row = page.locator(".session-row", { hasText: "dev-box" });
  await expect(row).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  // 검색하면 접힌 그룹도 보인다.
  await page.getByPlaceholder("세션 검색").fill("dev");
  await expect(row).toBeVisible();
  await page.getByPlaceholder("세션 검색").fill("");
  await expect(row).toHaveCount(0);
  await toggle.click();
  await expect(row).toBeVisible();
});

test("저장된 비밀번호가 틀려 다시 입력해 붙으면 그 값으로 바꾸고, 편집 창에서 볼 수 있다", async ({ page }) => {
  await createVault(page);
  await page.getByTitle("dev-box").first().click();
  await expect(terminal(page)).toContainText("처음 연결하는 서버");
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("비밀번호가 맞지 않습니다.");
  await page.keyboard.type("fresh-pw");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("✓ 보관함의 비밀번호를 새로 입력한 값으로 업데이트했습니다.");
  await expect(terminal(page)).toContainText("dev-box $");

  await page.getByRole("button", { name: "dev-box 편집" }).click();
  const editor = page.locator(".session-editor");
  await editor.getByRole("tab", { name: "인증" }).click();
  const field = editor.locator(".password-input input");
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveValue("fresh-pw");
  await editor.getByRole("button", { name: "보기" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue("fresh-pw");
  await editor.getByRole("button", { name: "숨기기" }).click();
  await expect(field).toHaveAttribute("type", "password");
});

test("사용자 없이 저장한 세션은 연결할 때 사용자와 비밀번호를 묻는다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "새 세션" }).click();
  const dialog = page.locator(".session-editor");
  await dialog.getByPlaceholder("10.0.1.21 또는 example.com").fill("nouser.internal");
  await dialog.getByRole("button", { name: "다음" }).click();
  // 사용자를 비워도 넘어간다.
  await dialog.getByRole("button", { name: "다음" }).click();
  await expect(dialog.getByRole("tab", { name: "표시" })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "다음" }).click();
  await dialog.getByRole("button", { name: "다음" }).click();
  await dialog.getByRole("button", { name: "저장하고 연결" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(terminal(page)).toContainText("처음 연결하는 서버");
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("사용자 (ESC로 취소)");
  await page.keyboard.type("alice");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("alice");
  await expect(terminal(page)).toContainText("비밀번호 (ESC로 취소)");
  await page.keyboard.type("test-only");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("이 비밀번호를 보관함에 저장할까요?");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("nouser.internal $");
});

test("바로 접속을 끄면 비밀번호를 지우고, 연결할 때마다 묻기만 한다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "dev-box 편집" }).click();
  const editor = page.locator(".session-editor");
  await editor.getByRole("tab", { name: "인증" }).click();
  const quick = editor.getByRole("checkbox", { name: /바로 접속/ });
  await expect(quick).toBeChecked();
  const pw = editor.locator(".password-input input");
  await expect(pw).toBeEnabled();
  await quick.uncheck();
  // 끄면 아래 인증 항목을 모두 막고 비워 보인다.
  await expect(pw).toBeDisabled();
  await expect(pw).toHaveValue("");
  const user = editor.getByRole("textbox", { name: "사용자", exact: true });
  await expect(user).toBeDisabled();
  await expect(user).toHaveValue("");
  await expect(editor.getByRole("button", { name: "키 파일" })).toBeDisabled();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await page.getByTitle("dev-box").first().click();
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("사용자 (ESC로 취소)");
  await page.keyboard.type("dev");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("비밀번호 (ESC로 취소)");
  await expect(terminal(page)).not.toContainText("비밀번호가 맞지 않습니다.");
  await page.keyboard.type("any-pw");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("dev-box $");
  await expect(terminal(page)).not.toContainText("비밀번호를 보관함에 저장");

  // 다시 열면 체크가 꺼져 있고 비밀번호 칸은 비어 있다.
  await page.getByRole("button", { name: "dev-box 편집" }).click();
  await editor.getByRole("tab", { name: "인증" }).click();
  await expect(quick).not.toBeChecked();
  await expect(editor.locator(".password-input input")).toHaveValue("");
});

test("비밀번호 칸을 비우고 저장하면 저장된 비밀번호를 지운다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "dev-box 편집" }).click();
  const editor = page.locator(".session-editor");
  await editor.getByRole("tab", { name: "인증" }).click();
  const field = editor.locator(".password-input input");
  await expect(field).toHaveValue("old-wrong");
  await field.fill("");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "dev-box 편집" }).click();
  await editor.getByRole("tab", { name: "인증" }).click();
  await expect(field).toHaveValue("");
});

test("호스트 키 확인은 ESC로 취소한다", async ({ page }) => {
  await createVault(page);
  await page.getByTitle("prod-web-01 연결").click();
  await expect(terminal(page)).toContainText("ESC로 취소");
  await page.keyboard.press("Escape");
  await expect(terminal(page)).toContainText("연결을 취소했습니다");
});

test("여러 줄 붙여넣기는 먼저 묻고 거절하면 입력하지 않는다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const paste = (text: string) =>
    page.locator(".xterm-helper-textarea").last().evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  let asked = "";
  page.once("dialog", async (d) => {
    asked = d.message();
    await d.dismiss();
  });
  await paste("echo one\nrm -rf x\n");
  await expect.poll(() => asked).toContain("2줄");
  await expect(terminal(page)).not.toContainText("rm -rf");
});

test("한글 조합 입력은 완성된 글자로 한 번만 보낸다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const sent = await page.locator(".xterm-helper-textarea").last().evaluate(async (el) => {
    const { api } = await import("/src/lib/api.ts" as string);
    const out: string[] = [];
    api.termWrite = async (_id: string, data: string) => void out.push(data);
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    ta.value = "";
    ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    for (const step of ["ㅎ", "하", "한", "한ㄱ", "한그", "한글"]) {
      ta.value = step;
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: step }));
      ta.dispatchEvent(new InputEvent("input", { data: step, inputType: "insertCompositionText", isComposing: true }));
    }
    ta.dispatchEvent(new CompositionEvent("compositionend", { data: "한글" }));
    await new Promise((r) => setTimeout(r, 100));
    return out;
  });
  expect(sent.join("")).toContain("한글");
  expect(sent.join("")).not.toContain("ㅎ");
});

// macOS WebKit은 한글 조합 중에도 실제 키 코드(229가 아닌)를 보낼 때가 있다(이슈 #7).
async function typeHangulLikeWebKit(page: Page, steps: [string, string][], end: string, shiftEnterBeforeEnd: boolean) {
  return page.locator(".xterm-helper-textarea").last().evaluate(
    async (el, { steps, end, shiftEnterBeforeEnd }) => {
      const { api } = await import("/src/lib/api.ts" as string);
      const out: string[] = [];
      api.termWrite = async (_id: string, data: string) => void out.push(data);
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.value = "";
      const tick = () => new Promise((r) => setTimeout(r, 5));
      let composing = false;
      for (const [key, value] of steps) {
        // 조합을 시작하는 첫 키는 229로 오고, 조합 중인 키는 실제 키 코드(65 등)로 온다.
        const keyCode = composing ? key.toUpperCase().charCodeAt(0) : 229;
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: composing ? key : "Process", keyCode, bubbles: true, cancelable: true, isComposing: composing }));
        if (!composing) {
          ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
          composing = true;
        }
        ta.value = value;
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: value }));
        ta.dispatchEvent(new InputEvent("input", { data: value, inputType: "insertCompositionText", isComposing: true }));
        await tick();
      }
      if (shiftEnterBeforeEnd) {
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, shiftKey: true, bubbles: true, cancelable: true }));
      }
      ta.value = end;
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: end }));
      await new Promise((r) => setTimeout(r, 150));
      return out.join("");
    },
    { steps, end, shiftEnterBeforeEnd },
  );
}

test("한글 조합 중 키 코드가 229가 아니어도 자모가 잘리지 않는다 (맥)", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  // 가 → 간 → 가나(앞 글자 확정 없이 한 조합 안에서) → 가낟 → 가나다
  const sent = await typeHangulLikeWebKit(page, [["r", "ㄱ"], ["k", "가"], ["s", "간"], ["k", "가나"], ["e", "가낟"], ["k", "가나다"]], "가나다", false);
  expect(sent).toBe("가나다");
});

test("한글 조합 중 Shift+Enter는 마지막 글자를 보낸 뒤에 줄을 바꾼다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const sent = await typeHangulLikeWebKit(page, [["e", "ㄷ"], ["k", "다"]], "다", true);
  expect(sent).toBe("다\x1b\r");
});

test("~/.ssh/config에서 없는 호스트만 가져온다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "가져오기" }).click();
  await page.locator(".settings-panel").getByRole("button", { name: "가져오기" }).click();
  const dialog = page.getByRole("dialog", { name: "~/.ssh/config 가져오기" });
  await expect(dialog.getByText("이미 있음")).toBeVisible();
  await dialog.getByRole("button", { name: "2개 가져오기" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "닫기", exact: true }).first().click();
  await expect(page.locator(".session .name", { hasText: "staging" })).toBeVisible();
  await expect(page.locator(".session .name", { hasText: "bastion" })).toBeVisible();
});

test("영어 화면에는 한글이 남지 않는다", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sshbook.language", "en"));
  await page.goto("/");
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(MASTER);
  await fields.nth(1).fill(MASTER);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible();

  // 언어 이름과 글꼴 미리보기의 한글 예시만 그대로 둔다.
  const korean = () =>
    page.evaluate(() => {
      const text = document.body.innerText.replaceAll("한국어", "").replace(/배포 로그|가나/g, "");
      const attrs = [...document.querySelectorAll("[placeholder],[title],[aria-label]")].flatMap((el) =>
        ["placeholder", "title", "aria-label"].map((a) => el.getAttribute(a) ?? ""),
      );
      return [...text.split("\n"), ...attrs].filter((s) => /[가-힣]/.test(s));
    });
  expect(await korean()).toEqual([]);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const tab of await page.getByRole("tab").all()) {
    await tab.click();
    expect(await korean(), await tab.innerText()).toEqual([]);
  }
  await page.locator(".settings-dialog").getByRole("button", { name: "Close", exact: true }).last().click();

  // 새 세션은 순서대로만 넘어가므로 필수 칸을 채우며 '다음'으로 모든 항목을 본다.
  await page.getByRole("button", { name: "New session" }).click();
  const editor = page.locator(".session-editor");
  await editor.getByRole("button", { name: "Next" }).click();
  expect(await korean(), "connect error").toEqual([]);
  for (const value of ["e2e.internal", "tester", "", "", ""]) {
    const current = await editor.getByRole("tab", { selected: true }).innerText();
    expect(await korean(), current).toEqual([]);
    if (value) await editor.locator("#se-panel input:not([type=checkbox])").first().fill(value);
    const next = editor.getByRole("button", { name: "Next" });
    if (await next.count()) await next.click();
  }
  await expect(editor.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  await page.locator(".session-editor").getByRole("button", { name: "Cancel" }).click();

  await page.getByTitle("prod-web-01").first().click();
  await expect(terminal(page)).toContainText("First connection");
  await expect(terminal(page)).toContainText("Esc to cancel");
  await page.keyboard.press("Escape");
  await expect(terminal(page)).toContainText("Connection cancelled.");
  expect(await korean()).toEqual([]);
});

test("ESC는 초점이 터미널에 있어도 맨 위 모달만 닫고 셸로 보내지 않는다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const sent = await page.evaluateHandle(async () => {
    const { api } = await import("/src/lib/api.ts" as string);
    const out: string[] = [];
    api.termWrite = async (_id: string, data: string) => void out.push(data);
    return out;
  });
  const settings = page.locator(".settings-dialog");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "보안" }).click();
  await page.getByRole("button", { name: "알려진 서버 관리" }).click();
  const known = page.getByRole("dialog", { name: "알려진 서버" });
  await expect(known).toBeVisible();

  await page.locator(".xterm-helper-textarea").last().focus();
  await page.keyboard.press("Escape");
  await expect(known).toHaveCount(0);
  await expect(settings).toBeVisible();

  // 열린 드롭다운은 목록만 닫는다.
  await page.locator(".settings-panel .dropdown").first().click();
  await expect(page.locator(".dropdown-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".dropdown-menu")).toHaveCount(0);
  await expect(settings).toBeVisible();

  await page.locator(".xterm-helper-textarea").last().focus();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  expect(await sent.evaluate((o) => o.join(""))).not.toContain("\x1b");

  for (const open of ["새 세션"]) {
    await page.getByRole("button", { name: open }).click();
    await expect(page.locator(".session-editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".session-editor")).toHaveCount(0);
  }
});

test("세션을 다시 누르면 열린 탭으로 가고, 오른쪽 클릭 메뉴로는 새 탭을 더한다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const tabs = page.locator(".gtab");
  await expect(tabs).toHaveCount(1);
  await page.getByTitle(/^localhost 연결/).click();
  await expect(tabs).toHaveCount(1);

  await page.locator(".session-row", { hasText: "localhost" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "새 탭으로 열기" }).click();
  await expect(tabs).toHaveCount(2);

  // 다른 탭(새 로컬 셸)에 있다가 세션을 누르면 그 세션의 탭으로 돌아온다.
  await page.getByRole("button", { name: "이 칸에 새 탭 (로컬 셸)" }).click();
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toHaveClass(/selected/);
  await page.getByTitle(/^localhost 연결/).click();
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).not.toHaveClass(/selected/);
});

test("사이드바 세션을 휠 클릭하면 열린 탭이 있어도 새 탭을 연다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const tabs = page.locator(".gtab");
  await expect(tabs).toHaveCount(1);
  await page.getByTitle(/^localhost 연결/).click({ button: "middle" });
  await expect(tabs).toHaveCount(2);
});

test("사이드바 세션과 그룹을 끌어서 순서와 그룹을 바꾸고, 잠갔다 열어도 남는다", async ({ page }) => {
  await createVault(page);
  const names = () => page.locator(".session-row .name").allTextContents();
  const titles = () => page.locator(".group-toggle > span:nth-child(2)").allTextContents();
  /** from을 to의 위쪽(top) 또는 아래쪽 끝 근처로 끌어다 놓는다 */
  const drag = async (from: Locator, to: Locator, where: "top" | "bottom") => {
    const a = (await from.boundingBox())!;
    const b = (await to.boundingBox())!;
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 20, a.y + a.height / 2 + 8, { steps: 3 });
    const y = where === "top" ? b.y + 3 : b.y + b.height - 3;
    await page.mouse.move(b.x + 20, y, { steps: 6 });
    await page.mouse.up();
  };
  const row = (name: string) => page.locator(".session-row", { hasText: name });

  await expect.poll(names).toEqual(["dev-box", "localhost", "prod-web-01"]);
  await drag(row("prod-web-01"), row("dev-box"), "top");
  await expect.poll(names).toEqual(["prod-web-01", "dev-box", "localhost"]);
  // 끌어다 놓은 것은 클릭(연결)으로 치지 않는다.
  await expect(page.locator(".gtab")).toHaveCount(0);

  // 그룹 두 개를 만든다: 가나다순이면 개발 → 운영
  const editor = page.locator(".session-editor");
  for (const [name, group] of [["dev-box", "운영"], ["localhost", "개발"]]) {
    await page.getByRole("button", { name: `${name} 편집` }).click();
    await editor.getByRole("tab", { name: "표시" }).click();
    await editor.getByRole("combobox", { name: "그룹" }).fill(group);
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(editor).toHaveCount(0);
  }
  await expect.poll(async () => (await titles()).length).toBe(3);
  const before = await titles();
  expect(before.slice(0, 2).sort()).toEqual(["개발", "운영"]);

  // 그룹 순서: 두 번째 그룹을 첫 그룹 위로
  const title = (t: string) => page.locator(".section-title", { hasText: t });
  await drag(title(before[1]), title(before[0]), "top");
  await expect.poll(titles).toEqual([before[1], before[0], "그룹 없음"]);
  // 그룹 바꾸기: prod-web-01을 '개발' 그룹 제목 위에 놓으면 그 그룹 끝으로
  await drag(row("prod-web-01"), title("개발"), "bottom");
  await expect.poll(titles).toEqual([before[1], before[0]]);
  await expect(page.locator('[data-group="개발"] .session-row .name')).toHaveText(["localhost", "prod-web-01"]);

  // 검색 중에는 끌지 않는다
  await page.getByPlaceholder("세션 검색").fill("o");
  const snapshot = await names();
  await drag(row("localhost"), row("dev-box"), "top");
  await expect.poll(names).toEqual(snapshot);
  await page.getByPlaceholder("세션 검색").fill("");

  // 탭이 없으면 확인 없이 바로 잠근다.
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "보안" }).click();
  await page.getByRole("button", { name: "잠그기", exact: true }).click();
  await page.locator('input[type="password"]').fill(MASTER);
  await page.getByRole("button", { name: "잠금 해제", exact: true }).click();
  await expect.poll(titles).toEqual([before[1], before[0]]);
  await expect(page.locator('[data-group="개발"] .session-row .name')).toHaveText(["localhost", "prod-web-01"]);
});

test("세션 오른쪽 클릭 메뉴에서 세션을 제거한다", async ({ page }) => {
  await createVault(page);
  await page.locator(".session-row", { hasText: "prod-web-01" }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.locator(".menu-title")).toHaveText("prod-web-01");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("menuitem", { name: "제거…" }).click();
  await expect(page.locator(".session-row", { hasText: "prod-web-01" })).toHaveCount(0);
});

test("없는 무료 글꼴은 설정에서 바로 설치한다", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sshbook.settings", JSON.stringify({ gpuRender: false, fontFamily: "D2Coding" }));
    // 이 PC에 D2Coding이 이미 있어도 '없음'으로 보이게 글자 폭을 늘 같게 잰다.
    CanvasRenderingContext2D.prototype.measureText = () => ({ width: 100 }) as TextMetrics;
  });
  await createVault(page);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "화면" }).click();
  const box = page.locator(".font-missing");
  await expect(box).toContainText("D2Coding이(가) 이 PC에 없어");
  await box.getByRole("button", { name: "설치하기" }).click();
  // 미리보기 브라우저에는 실제로 설치되지 않으므로 다시 시작하라는 안내가 나온다.
  await expect(box).toContainText("다시 시작하면 적용됩니다");
  await expect(box.getByRole("button", { name: "다시 시작" })).toBeVisible();
});

test("파일 창에서 새 폴더를 만들고 이름을 바꾼다 (맥 웹뷰는 window.prompt가 없다)", async ({ page }) => {
  // window.prompt를 쓰면 실패하도록 막는다.
  await page.addInitScript(() => {
    window.prompt = () => {
      throw new Error("window.prompt 사용");
    };
  });
  await createVault(page);
  await page.getByTitle(/^prod-web-01 연결/).click();
  await expect(terminal(page)).toContainText("yes/no");
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect(terminal(page)).toContainText("prod-web-01 $");
  await page.locator(".xterm-screen").last().click({ button: "right" });
  await page.getByRole("menuitem", { name: "파일 창 열기 (SFTP)" }).click();
  const panel = page.getByRole("complementary", { name: "원격 파일" });
  await expect(panel.getByRole("option").first()).toBeVisible();

  await panel.getByRole("button", { name: "새 폴더" }).click();
  await panel.getByRole("textbox", { name: "새 폴더 이름" }).fill("배포-기록");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("option", { name: /배포-기록/ })).toBeVisible();

  await panel.getByRole("option", { name: /배포-기록/ }).hover();
  await panel.getByRole("button", { name: "배포-기록 이름 바꾸기" }).click();
  await panel.getByRole("textbox", { name: "새 이름" }).fill("배포-로그");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("option", { name: /배포-로그/ })).toBeVisible();
  await expect(panel.getByRole("option", { name: /배포-기록/ })).toHaveCount(0);

  // Esc는 취소하고 파일 창은 닫지 않는다.
  await panel.getByRole("button", { name: "새 폴더" }).click();
  await panel.getByRole("textbox", { name: "새 폴더 이름" }).fill("만들지-않음");
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("option", { name: /만들지-않음/ })).toHaveCount(0);
});

test("설정의 기본 로컬 셸(WSL)로 로컬 셸 탭을 연다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "터미널" }).click();
  const field = page.getByRole("combobox", { name: "기본 로컬 셸" });
  await field.click();
  // 이 PC에서 찾은 셸 목록에서 고른다.
  await page.getByRole("option", { name: "wsl.exe -d Ubuntu-24.04" }).click();
  await expect(field).toHaveValue("wsl.exe -d Ubuntu-24.04");
  await page.getByRole("button", { name: "닫기", exact: true }).first().click();
  await openLocal(page);

  const shells = await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts" as string);
    const seen: (string | null | undefined)[] = [];
    const open = api.termOpen.bind(api);
    api.termOpen = (sid: string | null, c: number, r: number, o?: { shell?: string }) => {
      seen.push(sid === null ? o?.shell : `session:${sid}`);
      return open(sid, c, r, o);
    };
    (window as unknown as { __seen: unknown[] }).__seen = seen;
    return seen;
  });
  expect(shells).toEqual([]);
  await page.getByRole("button", { name: "이 칸에 새 탭 (로컬 셸)" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __seen: unknown[] }).__seen)).toEqual(["wsl.exe -d Ubuntu-24.04"]);
});

test("셸 출력의 링크를 누르면 브라우저로 연다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  await page.keyboard.type("link");
  await page.keyboard.press("Enter");
  const row = page.locator(".xterm-rows").last().locator("> div", { hasText: "https://example.com/docs" });
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  // 링크 위로 마우스를 옮긴 뒤 누른다.
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.click(box.x + 60, box.y + box.height / 2);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []))
    .toEqual(["https://example.com/docs?a=1&b=2"]);
});

test("로컬 셸에 파일을 끌어다 놓으면 경로를 넣는다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  const slot = page.locator(".term-slot").first();
  const box = (await slot.boundingBox())!;
  await page.evaluate(
    ([x, y]) =>
      (window as unknown as { __sshbookDropFiles: (x: number, y: number, p: string[]) => Promise<void> }).__sshbookDropFiles(x, y, [
        "/Users/me/a.txt",
        "/Users/me/내 문서.txt",
      ]),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  await expect(page.locator(".xterm-rows").first()).toContainText("/Users/me/a.txt '/Users/me/내 문서.txt'");
});

test("탭을 휠 클릭하면 닫는다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  await page.getByRole("button", { name: "이 칸에 새 탭 (로컬 셸)" }).click();
  const tabs = page.locator(".gtab");
  await expect(tabs).toHaveCount(2);
  await tabs.first().click({ button: "middle" });
  const confirm = page.locator("[role=alertdialog] .danger-fill");
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(tabs).toHaveCount(1);
});

test("Ctrl+C는 고른 글자가 있으면 복사한다", async ({ page, context, browserName }) => {
  test.skip(process.platform === "darwin" || browserName !== "chromium", "Windows·Linux 단축키");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createVault(page);
  await openLocal(page);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  // 마지막 줄(프롬프트 "localhost $")을 끌어서 고른다.
  const row = page.locator(".xterm-rows").last().locator("> div", { hasText: "localhost $" }).last();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("localhost");
  // 복사한 뒤에는 선택이 풀려서, 다음 Ctrl+C는 셸로 간다.
  await expect(page.locator(".xterm-selection div")).toHaveCount(0);
});

test("Shift+Enter는 명령을 실행하지 않고 줄을 바꾼다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  await page.keyboard.type("echo a");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("b");
  await expect(terminal(page)).toContainText("> b");
});

test("터미널 안 프로그램이 보낸 복사(OSC 52)를 클립보드에 넣는다", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "클립보드 권한");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createVault(page);
  await openLocal(page);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.type("osc52");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copied by app");
});

test("로컬 셸 메뉴에 지금 폴더 열기가 있다", async ({ page }) => {
  await createVault(page);
  await openLocal(page);
  await page.locator(".xterm-screen").last().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /지금 폴더를 (탐색기|Finder)에서 열기/ })).toBeEnabled();
});

test("설정에서 만든 빈 그룹은 사이드바에 '세션이 없습니다.'로 보이고 색을 바꿀 수 있다", async ({ page }) => {
  await createVault(page);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("tab", { name: "그룹" }).click();
  await page.getByLabel("새 그룹 이름").fill("스테이징");
  await page.getByRole("button", { name: "그룹 만들기" }).click();
  await expect(page.getByLabel("스테이징 그룹 이름", { exact: true })).toHaveValue("스테이징");

  const group = page.locator(".session-list > div", { hasText: "스테이징" });
  await expect(group.locator(".group-empty")).toHaveText("세션이 없습니다.");
  // 새 그룹은 아직 안 쓴 첫 색(빨강)을 받는다. 다른 색으로 바꾸면 사이드바도 바뀐다.
  await expect(group).toHaveClass(/env-red/);
  await page.locator(".group-list li", { has: page.getByLabel("스테이징 그룹 이름", { exact: true }) }).getByRole("radio", { name: /파랑/ }).click();
  await expect(group).toHaveClass(/env-blue/);

  // 이름을 바꾸면 사이드바도 따라간다.
  const name = page.getByLabel("스테이징 그룹 이름", { exact: true });
  await name.fill("stage");
  await name.press("Enter");
  await expect(page.locator(".session-list .section-title", { hasText: "stage" })).toBeVisible();

  // 지우면 사라진다(세션이 없으니 묻지 않는다).
  await page.getByRole("button", { name: "stage 그룹 지우기" }).click();
  await expect(page.locator(".session-list .section-title", { hasText: "stage" })).toHaveCount(0);
});
