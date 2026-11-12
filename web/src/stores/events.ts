// SSE 连接和事件分发。规则照老代码 connect()，一条都没改：
//  1. 连接 /api/events；浏览器自带的重连会带 Last-Event-ID，服务端补发错过的。
//     连接彻底断开（readyState === 2）时：先 /api/me 判断是不是登录失效（401 会弹登录页），
//     还有令牌就 3 秒后手动重连，带 ?last_id=<lastEventId>。
//  2. 每个事件带 seq；收到就记下 e.lastEventId。
//  3. 去重：当前会话的非 session 事件，seq <= snapSeq 就丢（快照里已经包含）。见 lib/seq.ts。
//  4. resync：服务端补发不了，整体重载（重取会话列表和当前会话，再通知 onReload 的订阅者）。
//  5. 只有“第一次连上”和 resync 才整体重拉；普通的短暂断线靠服务端补发。
// 本模块 import 时没有副作用；connect() 才会创建 EventSource。
import { signal } from "@preact/signals";
import { systemNotify } from "../lib/desktop";
import { eventSessionId, isCoveredBySnapshot, sessionEventSkips } from "../lib/seq";
import type { ServerEvent } from "../lib/types";
import { replace } from "../router";
import { onLoginRequired, refreshMe, token } from "./auth";
import {
  applyApproval, applyApprovalDone, applyDelta, applyDeltaReset, applyMessage, applyQuestion, applyQuestionDone,
  applyThinking, applyTool, current, eventBuffer, reloadCurrent, setReplayHandler, shouldBuffer, resetChat, snapSeq, upsertSession,
} from "./chat";
import { listSeq, loadSessions, removeFromList, sessions } from "./sessions";

/** 连接状态：idle 没连 / open 已连上 / reconnecting 重新连接中（左栏显示“重新连接中”） */
export const conn = signal<"idle" | "open" | "reconnecting">("idle");
/** 最近收到的 SSE 事件 id，手动重连时带上 */
export const lastEventId = signal("");

let es: EventSource | null = null;
let firstOpen = true;   // 这条事件流是不是第一次连上（第一次要拉全量；之后的重连靠服务端补发）
let reconnectTimer: ReturnType<typeof setTimeout> | 0 = 0;

// ---------- 整体重载 ----------

const reloadHooks = new Set<() => void>();
/** 整体重载时额外要做的事（见 boot.ts：文件库根目录还没取过就取一次） */
export function onReload(fn: () => void): () => void {
  reloadHooks.add(fn);
  return () => reloadHooks.delete(fn);
}

export function reloadAll(): void {
  loadSessions().catch(() => {});
  reloadCurrent().catch(() => {});
  for (const fn of reloadHooks) fn();
}

// ---------- 事件分发 ----------

/** 处理一个已解析的事件（不含 resync 以外的连接逻辑）。导出是为了测试 */
export function handleEvent(ev: ServerEvent): void {
  if (ev.type === "resync") return reloadAll();

  // 会话事件序号不大于详情快照的 seq：它的效果已经包含在快照里了，再应用会重复（比如 delta 文本）
  if (shouldBuffer(eventSessionId(ev))) { eventBuffer.events.push(ev); return; }   // 正在取这个会话的快照：先存着，快照应用后重放
  if (isCoveredBySnapshot(ev, current.value, snapSeq.value)) return;

  if (ev.type === "session" && ev.session) {
    const { skipList, skipCurrent } = sessionEventSkips(ev, current.value, snapSeq.value, listSeq.value);
    return upsertSession(ev.session, skipList, skipCurrent);
  }
  if (ev.type === "session_deleted") {
    removeFromList(ev.session_id as string);
    if (current.value === ev.session_id) { resetChat(); replace("/", { force: true }); }
    return;
  }

  const sid = ev.session_id || ev.approval?.session_id;
  const mine = (id: string | undefined) => sessions.value.some((s) => s.id === id);   // 只对自己列表里的会话弹系统通知
  if (ev.type === "approval" && ev.approval && mine(sid)) systemNotify("需要确认：" + ev.approval.summary);
  const qsid = ev.question?.session_id;
  if (ev.type === "question" && ev.question && mine(qsid)) systemNotify("Claude 想问你：" + ev.question.questions[0].question);

  // 提问事件先于“是不是当前会话”的检查处理：它自己比较 session_id
  if (ev.type === "question") {
    if (ev.question && qsid === current.value) applyQuestion(ev.question);
    return;
  }
  if (ev.type === "question_done") {
    if (ev.session_id === current.value) applyQuestionDone(ev.id as string);
    return;
  }

  if (sid !== current.value) return;

  switch (ev.type) {
    case "message": if (ev.message) applyMessage(ev.message); break;
    case "approval": if (ev.approval) applyApproval(ev.approval); break;
    case "approval_done": applyApprovalDone(ev.id as string); break;
    case "delta_reset": applyDeltaReset(); break;
    case "delta": applyDelta(ev.text as string); break;
    case "thinking": applyThinking(ev.text as string); break;
    case "tool": applyTool({ name: ev.name as string, detail: ev.detail }); break;
    default: break;   // 未知类型：老代码只是重渲染，状态不变
  }
}

setReplayHandler(handleEvent);

// ---------- 连接 ----------

export function connect(manual = false): void {
  clearTimeout(reconnectTimer || undefined);
  if (es) es.close();
  if (!manual) { lastEventId.value = ""; firstOpen = true; }
  else if (!lastEventId.value) firstOpen = true;   // 没有可续的 id（还没收到过事件）：重连后整体重拉
  // 令牌在 HttpOnly cookie 里，不放进网址
  const source = new EventSource("/api/events" + (manual && lastEventId.value ? "?last_id=" + encodeURIComponent(lastEventId.value) : ""));
  es = source;
  source.onopen = () => {
    conn.value = "open";
    if (firstOpen) { firstOpen = false; reloadAll(); }
  };
  source.onerror = () => {
    conn.value = "reconnecting";
    void refreshMe();   // 登录失效时 api() 会弹出登录页
    // 服务端回了非 200（比如重启中的 502）时 EventSource 不会自己重连：这里手动重连，带上最后的事件 id
    if (es && es.readyState === 2 && token.value) {
      clearTimeout(reconnectTimer || undefined);
      reconnectTimer = setTimeout(() => connect(true), 3000);
    }
  };
  source.onmessage = (e: MessageEvent) => {
    const ev = JSON.parse(e.data) as ServerEvent;
    if (e.lastEventId) lastEventId.value = e.lastEventId;
    handleEvent(ev);
  };
}

export function disconnect(): void {
  clearTimeout(reconnectTimer || undefined);
  reconnectTimer = 0;
  if (es) { es.close(); es = null; }
  conn.value = "idle";
}

// 登录失效 / 退出登录时断开（老代码的 showLogin() 里 es.close()）
onLoginRequired(disconnect);
