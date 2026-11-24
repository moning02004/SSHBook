import { expect, test, type Page } from "@playwright/test";

const MASTER = "Tiger-Moon-Lake-42";

const terminal = (page: Page) => page.locator(".xterm-rows").last();

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
  await dialog.getByPlaceholder("deploy").fill("tester");
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
  await expect(terminal(page)).toContainText("e2e.internal $");
  await expect(terminal(page)).not.toContainText("test-only");
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

  await page.getByRole("button", { name: "New session" }).click();
  for (const tab of await page.locator(".session-editor").getByRole("tab").all()) {
    await tab.click();
    expect(await korean(), await tab.innerText()).toEqual([]);
  }
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
  await page.getByTitle("localhost 연결 (열린 탭이 있으면 그 탭으로)").click();
  await expect(tabs).toHaveCount(1);

  await page.locator(".session-row", { hasText: "localhost" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "새 탭으로 추가" }).click();
  await expect(tabs).toHaveCount(2);

  // 다른 탭(새 로컬 셸)에 있다가 세션을 누르면 그 세션의 탭으로 돌아온다.
  await page.getByRole("button", { name: "이 칸에 새 탭 (로컬 셸)" }).click();
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toHaveClass(/selected/);
  await page.getByTitle("localhost 연결 (열린 탭이 있으면 그 탭으로)").click();
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).not.toHaveClass(/selected/);
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
