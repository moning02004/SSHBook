// 창(pane)마다 xterm 인스턴스와 백엔드 연결을 React 밖에서 들고 있는다.
// 분할 해제로 창이 다른 탭으로 옮겨가거나 확대/복귀로 다시 그려져도
// 화면 내용과 연결이 끊기지 않게 하려는 것이다.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { api, parseOpenError, type OpenOptions } from "./api";
import { fontStack, getSettings, subscribeSettings, type Settings } from "./settings";
import { terminalThemes, type ThemeName } from "./theme";

const termOptions = (s: Settings) => ({
  fontFamily: fontStack(s.fontFamily),
  fontSize: s.fontSize,
  lineHeight: s.lineHeight,
  cursorStyle: s.cursorStyle,
  cursorBlink: s.cursorBlink,
  scrollback: s.scrollback,
});

/** 화면에 붙어 있는 창만 크기를 다시 맞춘다(떼어 둔 창은 다시 붙을 때 맞춰진다). */
function refit(e: PaneEntry) {
  if (e.host.isConnected && e.host.clientWidth > 0 && e.host.clientHeight > 0) e.fit.fit();
}

// 설정이 바뀌면 열린 터미널 전부에 바로 적용한다.
subscribeSettings((s) => {
  const opts = termOptions(s);
  entries.forEach((e) => {
    Object.assign(e.term.options, opts);
    refit(e);
  });
});

export interface PaneEntry {
  paneId: string;
  sessionId: string | null;
  term: Terminal;
  fit: FitAddon;
  /** React가 바뀌어도 유지되는 DOM. TerminalView가 자기 자리에 붙였다 뗀다. */
  host: HTMLDivElement;
  backendId: Promise<string | null>;
  exited: boolean;
}

const entries = new Map<string, PaneEntry>();
const byBackend = new Map<string, PaneEntry>();
let currentTheme: ThemeName = "light";
let shortcutFilter: (e: KeyboardEvent) => boolean = () => false;

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// termOpen 응답보다 먼저 도착한 출력(SSH 배너 등)은 잠깐 모아 두었다가 붙인다.
const early = new Map<string, Uint8Array[]>();
const earlyExit = new Map<string, number | null>();

function showExit(e: PaneEntry, code: number | null) {
  e.exited = true;
  e.term.write(`\r\n\x1b[2m[연결 종료${code === null ? "" : ` · 코드 ${code}`}]\x1b[0m\r\n`);
}

let wired = false;
async function wireEvents() {
  if (wired) return;
  wired = true;
  await api.onTermData(({ id, data }) => {
    const e = byBackend.get(id);
    if (e) return e.term.write(fromB64(data));
    const buf = early.get(id) ?? [];
    if (buf.length < 256) buf.push(fromB64(data));
    early.set(id, buf);
  });
  await api.onTermExit(({ id, code }) => {
    const e = byBackend.get(id);
    if (e) showExit(e, code);
    else earlyExit.set(id, code);
  });
}

function bind(id: string, entry: PaneEntry) {
  byBackend.set(id, entry);
  early.get(id)?.forEach((b) => entry.term.write(b));
  early.delete(id);
  if (earlyExit.has(id)) {
    showExit(entry, earlyExit.get(id) ?? null);
    earlyExit.delete(id);
  }
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** 터미널 안에서 한 줄을 입력받는다. hidden이면 글자를 보여 주지 않는다. Ctrl+C·Esc는 취소(null). */
function readLine(term: Terminal, prompt: string, hidden: boolean): Promise<string | null> {
  term.write(prompt);
  term.focus();
  return new Promise((resolve) => {
    let value = "";
    const sub = term.onData((d) => {
      for (const ch of d) {
        if (ch === "\r" || ch === "\n") {
          sub.dispose();
          term.write("\r\n");
          return resolve(value);
        }
        if (ch === "\x03" || ch === "\x1b") {
          sub.dispose();
          term.write("^C\r\n");
          return resolve(null);
        }
        if (ch === "\x7f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            if (!hidden) term.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        if (!hidden) term.write(ch);
      }
    });
  });
}

function fail(entry: PaneEntry, text: string): null {
  entry.exited = true;
  entry.term.write(`${RED}${text}${RESET}\r\n`);
  return null;
}

/** 접속을 시도하고, 호스트 키 확인이나 비밀번호가 필요하면 터미널에서 물어본 뒤 다시 시도한다. */
async function connect(entry: PaneEntry): Promise<string | null> {
  const { term, sessionId } = entry;
  const opts: OpenOptions = {};
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const id = await api.termOpen(sessionId, term.cols, term.rows, opts);
      bind(id, entry);
      return id;
    } catch (err) {
      const r = parseOpenError(err);
      if ("hostKey" in r) {
        const k = r.hostKey;
        if (k.kind === "changed") {
          term.write(
            `${RED}경고: ${k.hostId}의 호스트 키가 저장된 것과 다릅니다.${RESET}\r\n` +
              `서버를 다시 설치했거나 키를 바꾼 게 아니라면, 누군가 연결을 가로채고 있을 수 있습니다.\r\n`,
          );
        } else {
          term.write(`처음 연결하는 서버입니다: ${k.hostId}\r\n`);
        }
        term.write(`${DIM}${k.algorithm} 키 지문${RESET} ${k.fingerprint}\r\n`);
        const q = k.kind === "changed" ? "새 키로 바꾸고 연결할까요? (yes/no) " : "이 서버를 신뢰하고 연결할까요? (yes/no) ";
        const ans = (await readLine(term, q, false))?.trim().toLowerCase();
        if (ans !== "yes" && ans !== "y") return fail(entry, "연결을 취소했습니다.");
        await api.hostTrust(k.hostId);
        term.write(`${DIM}호스트 키를 보관함에 저장했습니다.${RESET}\r\n`);
        continue;
      }
      if ("ask" in r) {
        if (r.ask.message) term.write(`${RED}${r.ask.message}${RESET}\r\n`);
        const v = await readLine(term, r.ask.kind === "password" ? "비밀번호: " : "개인 키 암호: ", true);
        if (v === null) return fail(entry, "연결을 취소했습니다.");
        opts[r.ask.kind] = v;
        continue;
      }
      return fail(entry, `연결하지 못했습니다: ${r.text}`);
    }
  }
  return fail(entry, "연결하지 못했습니다: 시도 횟수를 넘었습니다.");
}

/** 앱 단축키(분할 등)는 xterm이 셸로 보내지 않도록 걸러낸다. */
export function setShortcutFilter(fn: (e: KeyboardEvent) => boolean) {
  shortcutFilter = fn;
}

export function getPane(paneId: string, sessionId: string | null): PaneEntry {
  const found = entries.get(paneId);
  if (found) return found;

  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({
    ...termOptions(getSettings()),
    allowProposedApi: false,
    theme: terminalThemes[currentTheme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => !shortcutFilter(e));
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text && getSettings().copyOnSelect) void navigator.clipboard.writeText(text).catch(() => {});
  });

  const entry: PaneEntry = {
    paneId,
    sessionId,
    term,
    fit,
    host,
    exited: false,
    backendId: Promise.resolve(null),
  };
  entries.set(paneId, entry);

  entry.backendId = (async () => {
    await wireEvents();
    const id = await connect(entry);
    if (!id) return null;
    // 연결되는 동안 창 크기가 바뀌었을 수 있으니 한 번 맞춰 준다.
    void api.termResize(id, term.cols, term.rows);
    term.onData((d) => void api.termWrite(id, d));
    term.onResize(({ cols, rows }) => void api.termResize(id, cols, rows));
    return id;
  })();
  return entry;
}

/** 창을 완전히 닫을 때만 부른다(탭 이동·확대에는 부르지 않는다). */
export async function disposePane(paneId: string) {
  const e = entries.get(paneId);
  if (!e) return;
  entries.delete(paneId);
  const id = await e.backendId;
  if (id) {
    byBackend.delete(id);
    await api.termClose(id).catch(() => {});
  }
  e.term.dispose();
  e.host.remove();
}

export async function disposeAll() {
  await Promise.all([...entries.keys()].map(disposePane));
}

export function setTerminalTheme(theme: ThemeName) {
  currentTheme = theme;
  entries.forEach((e) => (e.term.options.theme = terminalThemes[theme]));
}

export function copySelection(paneId: string) {
  const text = entries.get(paneId)?.term.getSelection();
  if (text) void navigator.clipboard.writeText(text);
}

export async function pasteInto(paneId: string) {
  const e = entries.get(paneId);
  if (!e) return;
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) e.term.paste(text);
}

export function clearPane(paneId: string) {
  entries.get(paneId)?.term.clear();
}

export function focusPane(paneId: string) {
  entries.get(paneId)?.term.focus();
}

/** 연결이 살아 있는 창인지(닫기 전에 확인할 대상) */
export function isLive(paneId: string): boolean {
  const e = entries.get(paneId);
  return !!e && !e.exited;
}
