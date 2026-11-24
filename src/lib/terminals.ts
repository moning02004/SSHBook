// 창(pane)마다 xterm 인스턴스와 백엔드 연결을 React 밖에서 들고 있는다.
// 분할 해제로 창이 다른 탭으로 옮겨가거나 확대/복귀로 다시 그려져도
// 화면 내용과 연결이 끊기지 않게 하려는 것이다.

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import type { AuthPrompt } from "./api";
import { api, parseOpenError, type OpenOptions } from "./api";
import { pasteWarning, sanitizePaste } from "./paste";
import { fontStack, getSettings, subscribeSettings, type Settings } from "./settings";
import { terminalThemes, type ThemeName } from "./theme";
import { tx } from "./i18n";

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

/** connecting: 접속 중(호스트 키·비밀번호 확인 포함) · live: 연결됨 · closed: 끊김 */
export type PaneStatus = "connecting" | "live" | "closed";

export interface PaneEntry {
  paneId: string;
  sessionId: string | null;
  term: Terminal;
  fit: FitAddon;
  /** React가 바뀌어도 유지되는 DOM. TerminalView가 자기 자리에 붙였다 뗀다. */
  host: HTMLDivElement;
  backendId: Promise<string | null>;
  status: PaneStatus;
  /** 지금 연결에 묶인 입력·크기 리스너. 다시 연결할 때 걷어낸다. */
  subs: { dispose(): void }[];
  /** 연결돼 있는 동안의 백엔드 터미널 id (동시 입력·파일 창에서 바로 쓴다) */
  liveId: string | null;
  search: SearchAddon;
  /** 터미널에서 입력을 기다리는 중이면 그 입력을 취소한다(창을 닫거나 잠글 때) */
  cancelPrompt: (() => void) | null;
  /** 접속 중 서버 질문(OTP)을 이 창으로 돌려받는 표시 */
  promptKey: string;
  /** 서버 질문에 답하는 중이면 연결 취소 대신 입력칸이 키를 받는다 */
  authPrompting: boolean;
  /** 서버 응답 시간(ms). SSH만, 모르면 null */
  latency: number | null;
}

const entries = new Map<string, PaneEntry>();
const byBackend = new Map<string, PaneEntry>();
let currentTheme: ThemeName = "light";
let shortcutFilter: (e: KeyboardEvent) => boolean = () => false;

// 상태가 바뀌면 React가 다시 그리도록 알린다(useSyncExternalStore).
const statusListeners = new Set<() => void>();
let statusVersion = 0;
function notify() {
  statusVersion++;
  statusListeners.forEach((f) => f());
}
function setStatus(e: PaneEntry, s: PaneStatus) {
  if (e.status === s) return;
  e.status = s;
  if (s !== "live") {
    e.liveId = null;
    e.latency = null;
  }
  notify();
}
export function subscribeStatus(cb: () => void) {
  statusListeners.add(cb);
  return () => void statusListeners.delete(cb);
}
export const statusSnapshot = () => statusVersion;
/** 아직 화면에 붙지 않은 창은 접속 중으로 본다. */
export const paneStatus = (paneId: string): PaneStatus => entries.get(paneId)?.status ?? "connecting";
export const paneLatency = (paneId: string): number | null => entries.get(paneId)?.latency ?? null;
/** 연결돼 있으면 백엔드 터미널 id (SFTP가 같은 연결을 쓴다) */
export const backendIdOf = (paneId: string): string | null => entries.get(paneId)?.liveId ?? null;

// ---- 분할 창 동시 입력 ----
// 같은 묶음 안의 창에서 친 글자를 묶음의 연결된 창 모두에 보낸다.
const broadcastOf = new Map<string, string[]>();

/** 탭마다 동시 입력이 켜진 창 묶음. 부를 때마다 통째로 바꾼다. */
export function setBroadcastGroups(groups: string[][]) {
  broadcastOf.clear();
  for (const g of groups) for (const id of g) broadcastOf.set(id, g);
}

function sendInput(from: PaneEntry, data: string) {
  const group = broadcastOf.get(from.paneId);
  const targets = group ? group.map((id) => entries.get(id)) : [from];
  for (const e of targets) if (e?.liveId) void api.termWrite(e.liveId, data);
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// termOpen 응답보다 먼저 도착한 출력(SSH 배너 등)은 잠깐 모아 두었다가 붙인다.
const early = new Map<string, Uint8Array[]>();
const earlyExit = new Map<string, number | null>();

const RECONNECT_HINT = tx("{0}로 다시 연결", navigator.platform.toLowerCase().includes("mac") ? "⌘R" : "Ctrl+R");

function showExit(e: PaneEntry, code: number | null) {
  setStatus(e, "closed");
  e.term.write(tx("\r\n\u001b[2m[연결 종료{0} · {1}]\u001b[0m\r\n", code === null ? "" : tx(" · 코드 {0}", code), RECONNECT_HINT));
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
  await api.onAuthPrompt((req) => void answerAuth(req));
  await api.onTermLatency(({ id, ms }) => {
    const e = byBackend.get(id);
    if (e && e.status === "live" && e.latency !== ms) {
      e.latency = ms;
      notify();
    }
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
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** 터미널 안에서 한 줄을 입력받는다. hidden이면 글자를 보여 주지 않는다. Ctrl+C·Esc는 취소(null). */
function readLine(entry: PaneEntry, prompt: string, hidden: boolean, typedOnly = false): Promise<string | null> {
  const { term } = entry;
  term.write(prompt);
  term.focus();
  return new Promise((resolve) => {
    let value = "";
    const finish = (v: string | null) => {
      sub.dispose();
      entry.cancelPrompt = null;
      resolve(v);
    };
    entry.cancelPrompt = () => finish(null);
    const sub = term.onData((d) => {
      // 호스트 키 확인은 붙여넣기로 넘어가지 못하게 한 글자씩 친 것만 받는다.
      if (typedOnly && d.length > 1) return;
      for (const ch of d) {
        if (ch === "\r" || ch === "\n") {
          term.write("\r\n");
          return finish(value);
        }
        if (ch === "\x03" || ch === "\x1b") {
          term.write(ch === "\x03" ? "^C\r\n" : "\r\n");
          return finish(null);
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

/** 서버가 접속 중에 묻는 OTP 같은 질문을 터미널에서 받아 돌려준다. */
async function answerAuth(req: AuthPrompt) {
  const e = [...entries.values()].find((x) => x.promptKey === req.key);
  if (!e) return void api.termAuthAnswer(req.id, null);
  const cancelOpen = e.cancelPrompt;
  e.authPrompting = true;
  e.term.write("\r\x1b[2K");
  for (const line of [req.name, req.instructions]) {
    if (line) e.term.write(`${line.replace(/\n/g, "\r\n")}\r\n`);
  }
  const answers: string[] = [];
  let cancelled = false;
  for (const p of req.prompts) {
    const v = await readLine(e, tx("{0} {1}(ESC로 취소){2} ", p.text || tx("인증 코드:"), DIM, RESET), !p.echo);
    if (v === null) {
      cancelled = true;
      break;
    }
    answers.push(v);
  }
  e.authPrompting = false;
  e.cancelPrompt = cancelOpen;
  if (cancelled) {
    void api.termAuthAnswer(req.id, null);
    cancelOpen?.();
    return;
  }
  e.term.write(tx("{0}연결 중… (ESC로 취소){1}", DIM, RESET));
  void api.termAuthAnswer(req.id, answers);
}

/** 접속을 시도하는 동안 안내를 보여 주고, ESC·Ctrl+C면 취소한다(취소하면 null). */
function openCancellable(entry: PaneEntry, opts: OpenOptions): Promise<string | null> {
  const { term, sessionId } = entry;
  term.write(tx("{0}연결 중… (ESC로 취소){1}", DIM, RESET));
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const cleanup = () => {
      sub.dispose();
      entry.cancelPrompt = null;
      term.write("\r\x1b[2K"); // 안내 줄을 지운다
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      cleanup();
      resolve(null);
    };
    entry.cancelPrompt = cancel;
    // 방향키 등은 ESC로 시작하는 여러 글자라서, ESC 하나만 눌렀을 때만 취소한다.
    const sub = term.onData((d) => {
      if (entry.authPrompting) return;
      if (d === "\x1b" || d === "\x03") cancel();
    });
    api.termOpen(sessionId, term.cols, term.rows, opts).then(
      (id) => {
        // 취소한 뒤에 늦게 붙은 연결은 남기지 않는다.
        if (cancelled) return void api.termClose(id).catch(() => {});
        cleanup();
        resolve(id);
      },
      (err) => {
        if (cancelled) return;
        cleanup();
        reject(err);
      },
    );
  });
}

function fail(entry: PaneEntry, text: string): null {
  setStatus(entry, "closed");
  entry.term.write(`${RED}${text}${RESET} ${DIM}(${RECONNECT_HINT})${RESET}\r\n`);
  return null;
}

/** 접속을 시도하고, 호스트 키 확인이나 비밀번호가 필요하면 터미널에서 물어본 뒤 다시 시도한다. */
async function connect(entry: PaneEntry): Promise<string | null> {
  const { term } = entry;
  const opts: OpenOptions = { promptKey: entry.promptKey };
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const id = await openCancellable(entry, opts);
      const retyped = { password: opts.password, passphrase: opts.passphrase };
      // 다시 물어본 비밀번호는 더 들고 있지 않는다.
      opts.password = undefined;
      opts.passphrase = undefined;
      if (entries.get(entry.paneId) !== entry) {
        if (id) void api.termClose(id).catch(() => {});
        return null;
      }
      if (!id) return fail(entry, tx("연결을 취소했습니다."));
      // 다시 입력한 값으로 붙었으면 보관함에 반영한다. 저장된 값이 틀렸으면 바로 바꾸고,
      // 저장된 값이 없으면 저장할지 묻는다. 셸 출력은 bind 전까지 모아 두었다가 뒤에 보여 준다.
      if (entry.sessionId && (retyped.password || retyped.passphrase)) {
        const sid = entry.sessionId;
        const replaced = await api.sessionUpdateSecret(sid, retyped).catch(() => "none" as const);
        let added = false;
        if (replaced === "none" && entries.get(entry.paneId) === entry) {
          const q = retyped.password
            ? tx("이 비밀번호를 보관함에 저장할까요? 다음부터 묻지 않고 연결합니다. (y/N) ")
            : tx("이 키 암호를 보관함에 저장할까요? 다음부터 묻지 않고 연결합니다. (y/N) ");
          const yes = (await readLine(entry, q, false, true))?.trim().toLowerCase();
          if (yes === "y" || yes === "yes") added = (await api.sessionUpdateSecret(sid, retyped, true).catch(() => "none")) === "updated";
        }
        if (entries.get(entry.paneId) !== entry) {
          void api.termClose(id).catch(() => {});
          return null;
        }
        const pw = !!retyped.password;
        const note =
          replaced === "updated"
            ? pw ? tx("✓ 보관함의 비밀번호를 새로 입력한 값으로 업데이트했습니다.") : tx("✓ 보관함의 키 암호를 새로 입력한 값으로 업데이트했습니다.")
            : added
              ? pw ? tx("✓ 비밀번호를 보관함에 저장했습니다.") : tx("✓ 키 암호를 보관함에 저장했습니다.")
              : "";
        if (note) term.write(`${GREEN}${note}${RESET}\r\n`);
        retyped.password = retyped.passphrase = undefined;
      }
      bind(id, entry);
      return id;
    } catch (err) {
      // 기다리는 사이에 창을 닫았거나 보관함을 잠갔으면 더 묻지 않는다.
      if (entries.get(entry.paneId) !== entry) return null;
      const r = parseOpenError(err);
      if ("hostKey" in r) {
        const k = r.hostKey;
        if (k.kind === "changed") {
          term.write(
            tx("{0}경고: {1}의 호스트 키가 저장된 것과 다릅니다.{2}\r\n", RED, k.hostId, RESET) +
              tx("서버를 다시 설치했거나 키를 바꾼 게 아니라면, 누군가 연결을 가로채고 있을 수 있습니다.\r\n"),
          );
        } else {
          term.write(tx("처음 연결하는 서버입니다: {0}\r\n", k.hostId));
        }
        term.write(tx("{0}{1} 키 지문{2} {3}\r\n", DIM, k.algorithm, RESET, k.fingerprint));
        // 키가 바뀐 경우는 중간자 공격일 수 있어서, 지문을 직접 보고 치게 한다.
        const code = k.fingerprint.replace(/^SHA256:/, "").slice(0, 8);
        const q =
          k.kind === "changed"
            ? tx("서버 관리자에게 새 지문이 맞는지 확인했다면, 지문 앞 8글자({0})를 입력하세요 (ESC로 취소): ", code)
            : tx("이 서버를 신뢰하고 연결할까요? (yes/no, ESC로 취소) ");
        const typed = (await readLine(entry, q, false, true))?.trim();
        if (entries.get(entry.paneId) !== entry) return null;
        const accepted = k.kind === "changed" ? typed === code : typed?.toLowerCase() === "yes";
        if (!accepted) return fail(entry, tx("연결을 취소했습니다."));
        await api.hostTrust(k.hostId, k.fingerprint);
        term.write(tx("{0}호스트 키를 보관함에 저장했습니다.{1}\r\n", DIM, RESET));
        continue;
      }
      if ("ask" in r) {
        if (r.ask.message) term.write(`${RED}${r.ask.message}${RESET}\r\n`);
        const isUser = r.ask.kind === "user";
        const label = isUser ? tx("사용자 (ESC로 취소): ") : r.ask.kind === "password" ? tx("비밀번호 (ESC로 취소): ") : tx("개인 키 암호 (ESC로 취소): ");
        const v = await readLine(entry, label, !isUser);
        if (entries.get(entry.paneId) !== entry) return null;
        if (v === null) return fail(entry, tx("연결을 취소했습니다."));
        opts[r.ask.kind] = isUser ? v.trim() : v;
        continue;
      }
      return fail(entry, tx("연결하지 못했습니다: {0}", r.text));
    }
  }
  return fail(entry, tx("연결하지 못했습니다: 시도 횟수를 넘었습니다."));
}

const isMacPlatform = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

/** Ctrl+C (맥은 ⌘C가 원래 복사라서 Ctrl+C는 늘 인터럽트로 둔다) */
const isCopyKey = (e: KeyboardEvent) =>
  !isMacPlatform && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyC";

/** 앱 단축키(분할 등)는 xterm이 셸로 보내지 않도록 걸러낸다. */
export function setShortcutFilter(fn: (e: KeyboardEvent) => boolean) {
  shortcutFilter = fn;
}

export function getPane(paneId: string, sessionId: string | null, autoConnect = true): PaneEntry {
  const found = entries.get(paneId);
  if (found) return found;

  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({
    ...termOptions(getSettings()),
    // 검색 결과 강조(decoration)에 필요하다.
    allowProposedApi: true,
    theme: terminalThemes[currentTheme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon({ highlightLimit: 2000 });
  term.loadAddon(search);
  term.attachCustomKeyEventHandler((e) => {
    if (shortcutFilter(e)) return false;
    // Ctrl+C: 고른 글자가 있으면 복사하고 셸로 보내지 않는다. 없으면 평소처럼 인터럽트(^C).
    if (isCopyKey(e) && term.hasSelection()) {
      if (e.type === "keydown") {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    return true;
  });
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
    status: "connecting",
    subs: [],
    liveId: null,
    search,
    cancelPrompt: null,
    promptKey: crypto.randomUUID(),
    authPrompting: false,
    latency: null,
    backendId: Promise.resolve(null),
  };
  entries.set(paneId, entry);
  // ⌘V 등 브라우저 붙여넣기도 xterm에 닿기 전에 같은 검사를 거친다.
  host.addEventListener(
    "paste",
    (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      safePaste(entry, ev.clipboardData?.getData("text/plain") ?? "");
    },
    true,
  );
  if (autoConnect) start(entry);
  notify();
  return entry;
}

/** 지난번 탭을 연결하지 않은 채로 만든다. 사용자가 다시 연결할 때 처음 접속한다. */
export function openDisconnected(paneId: string, sessionId: string | null) {
  if (entries.has(paneId)) return;
  const entry = getPane(paneId, sessionId, false);
  setStatus(entry, "closed");
  entry.term.write(tx("\u001b[2m[지난번 탭 · 연결되지 않음 · {0}]\u001b[0m\r\n", RECONNECT_HINT));
}

function start(entry: PaneEntry) {
  const { term } = entry;
  entry.subs.forEach((d) => d.dispose());
  entry.subs = [];
  setStatus(entry, "connecting");
  entry.backendId = (async () => {
    await wireEvents();
    const id = await connect(entry);
    if (!id) return null;
    // bind()에서 이미 끝난 것으로 표시됐을 수 있다.
    if (entry.status === "connecting") {
      entry.liveId = id;
      setStatus(entry, "live");
    }
    // 연결되는 동안 창 크기가 바뀌었을 수 있으니 한 번 맞춰 준다.
    void api.termResize(id, term.cols, term.rows);
    entry.subs.push(
      term.onData((d) => sendInput(entry, d)),
      term.onResize(({ cols, rows }) => void api.termResize(id, cols, rows)),
    );
    return id;
  })();
}

/** 끊긴 창을 같은 화면에서 다시 연결한다. 끊긴 창이 아니면 false. */
export function reconnect(paneId: string): boolean {
  const e = entries.get(paneId);
  if (!e || e.status !== "closed") return false;
  setStatus(e, "connecting");
  void (async () => {
    const old = await e.backendId;
    if (old) {
      byBackend.delete(old);
      await api.termClose(old).catch(() => {});
    }
    if (!entries.has(paneId)) return;
    e.term.write("\r\n");
    start(e);
  })();
  return true;
}

/** 창을 완전히 닫을 때만 부른다(탭 이동·확대에는 부르지 않는다). */
export async function disposePane(paneId: string) {
  const e = entries.get(paneId);
  if (!e) return;
  entries.delete(paneId);
  e.subs.forEach((d) => d.dispose());
  // 비밀번호·호스트 키 입력을 기다리는 중이면 풀어 줘야 아래 await가 끝난다.
  e.cancelPrompt?.();
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
  safePaste(e, text);
}

/** 제어 문자를 빼고, 줄바꿈이 실행될 수 있으면 먼저 묻는다. */
function safePaste(e: PaneEntry, text: string) {
  const clean = sanitizePaste(text);
  if (!clean) return;
  const targets = broadcastOf.get(e.paneId)?.length ?? 1;
  const warning = pasteWarning(clean, e.term.modes.bracketedPasteMode, targets);
  if (warning && !window.confirm(warning)) return;
  e.term.paste(clean);
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
  return !!e && e.status !== "closed";
}

// ---- 터미널 안 검색 ----

const SEARCH_COLORS: ISearchOptions["decorations"] = {
  matchBackground: "#f5d97a66",
  matchBorder: "#d9a90088",
  matchOverviewRuler: "#d9a900",
  activeMatchBackground: "#ff9f1a",
  activeMatchBorder: "#ff7a00",
  activeMatchColorOverviewRuler: "#ff7a00",
};

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  regex: boolean;
}

const searchOpts = (q: SearchQuery, incremental = false): ISearchOptions => ({
  caseSensitive: q.caseSensitive,
  regex: q.regex,
  incremental,
  decorations: SEARCH_COLORS,
});

/** 찾으면 true. incremental이면 지금 위치에서 다시 찾는다(글자를 칠 때). */
export function findNext(paneId: string, q: SearchQuery, incremental = false): boolean {
  const e = entries.get(paneId);
  if (!e || !q.text) return false;
  try {
    return e.search.findNext(q.text, searchOpts(q, incremental));
  } catch {
    return false; // 정규식이 틀렸을 때
  }
}

export function findPrevious(paneId: string, q: SearchQuery): boolean {
  const e = entries.get(paneId);
  if (!e || !q.text) return false;
  try {
    return e.search.findPrevious(q.text, searchOpts(q));
  } catch {
    return false;
  }
}

export function clearSearch(paneId: string) {
  const e = entries.get(paneId);
  e?.search.clearDecorations();
  e?.term.clearSelection();
}

/** 결과 개수가 바뀔 때. index는 0부터, 너무 많으면 -1 */
export function onSearchResults(paneId: string, cb: (index: number, count: number) => void): () => void {
  const sub = entries.get(paneId)?.search.onDidChangeResults(({ resultIndex, resultCount }) => cb(resultIndex, resultCount));
  return () => sub?.dispose();
}

// ---- 명령 모음 붙여넣기 ----

/** 지금 창에 명령을 넣는다. run이면 Enter까지 보낸다. 동시 입력이 켜져 있으면 묶음 전체에 간다. */
export function insertCommand(paneId: string, command: string, run: boolean) {
  const e = entries.get(paneId);
  if (!e) return;
  e.term.paste(command);
  if (run) e.term.input("\r", true);
  e.term.focus();
}
