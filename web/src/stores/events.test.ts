import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ServerEvent, Session } from "../lib/types";
import { me } from "./auth";
import * as chat from "./chat";
import { conn, connect, disconnect, handleEvent, lastEventId } from "./events";
import { listSeq, sessions } from "./sessions";

const sess = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, title: "t" + id, user_id: 1, created: 1, updated: 100, ...over }) as Session;
const msg = (id: number, role = "assistant", content = "c"): Message => ({ id, role, content, created: 1 });

function setCurrent(id: string, snap = 10) {
  chat.resetChat();
  chat.current.value = id;
  chat.currentSess.value = sess(id);
  chat.snapSeq.value = snap;
}

beforeEach(() => {
  me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
  sessions.value = [];
  listSeq.value = 0;
  chat.resetChat();
});

describe("seq 去重：snapSeq", () => {
  it("seq 不大于快照的 delta 被丢掉，更新的被应用", () => {
    setCurrent("a", 10);
    handleEvent({ type: "delta", session_id: "a", text: "旧", seq: 10 });
    handleEvent({ type: "delta", session_id: "a", text: "旧2", seq: 3 });
    expect(chat.liveText.value).toBe("");
    handleEvent({ type: "delta", session_id: "a", text: "新", seq: 11 });
    handleEvent({ type: "delta", session_id: "a", text: "字", seq: 12 });
    expect(chat.liveText.value).toBe("新字");
    expect(chat.liveActive.value).toBe(true);
  });

  it("快照序号为 0 时（还没取到快照）所有事件都应用", () => {
    setCurrent("a", 0);
    handleEvent({ type: "delta", session_id: "a", text: "x", seq: 1 });
    expect(chat.liveText.value).toBe("x");
  });

  it("别的会话的事件不影响当前会话", () => {
    setCurrent("a", 0);
    handleEvent({ type: "delta", session_id: "b", text: "x", seq: 5 });
    expect(chat.liveText.value).toBe("");
    expect(chat.liveActive.value).toBe(false);
  });

  it("消息按 id 去重：快照里已有的消息再来一次不会重复", () => {
    setCurrent("a", 0);
    chat.messages.value = [msg(1, "user")];
    handleEvent({ type: "message", session_id: "a", message: msg(1, "user"), seq: 5 });
    handleEvent({ type: "message", session_id: "a", message: msg(2), seq: 6 });
    handleEvent({ type: "message", session_id: "a", message: msg(2), seq: 7 });
    expect(chat.messages.value.map((m) => m.id)).toEqual([1, 2]);
  });

  it("approval 事件按快照序号去重，也按 id 去重", () => {
    setCurrent("a", 10);
    const ap = (id: string, seq: number): ServerEvent => ({ type: "approval", approval: { id, session_id: "a", summary: "s" }, seq });
    handleEvent(ap("x", 9));
    expect(chat.approvals.value).toEqual([]);
    handleEvent(ap("y", 11));
    handleEvent(ap("y", 12));
    expect(chat.approvals.value.map((a) => a.id)).toEqual(["y"]);
    handleEvent({ type: "approval_done", session_id: "a", id: "y", seq: 13 });
    expect(chat.approvals.value).toEqual([]);
  });

  it("question 事件：只收当前会话的，按 id 去重；question_done 移除", () => {
    setCurrent("a", 0);
    const q = (id: string, sid: string): ServerEvent => ({ type: "question", question: { id, session_id: sid, questions: [] }, seq: 5 });
    handleEvent(q("q1", "b"));
    expect(chat.questions.value).toEqual([]);
    handleEvent(q("q1", "a"));
    handleEvent(q("q1", "a"));
    expect(chat.questions.value.length).toBe(1);
    handleEvent({ type: "question_done", session_id: "b", id: "q1" });
    expect(chat.questions.value.length).toBe(1);
    handleEvent({ type: "question_done", session_id: "a", id: "q1" });
    expect(chat.questions.value).toEqual([]);
  });
});

describe("session 事件：listSeq 和 snapSeq 的 stale 判断", () => {
  it("事件比列表快照旧：不覆盖列表项（但列表里没有时也不会加进去）", () => {
    listSeq.value = 20;
    sessions.value = [sess("a", { title: "新标题", updated: 200 })];
    handleEvent({ type: "session", session: sess("a", { title: "旧标题", updated: 100 }), seq: 20 });
    expect(sessions.value[0].title).toBe("新标题");
    handleEvent({ type: "session", session: sess("a", { title: "更新的", updated: 300 }), seq: 21 });
    expect(sessions.value[0].title).toBe("更新的");
  });

  it("只收自己的会话进列表；列表按 updated 倒序", () => {
    handleEvent({ type: "session", session: sess("a", { updated: 100 }), seq: 1 });
    handleEvent({ type: "session", session: sess("b", { updated: 300 }), seq: 2 });
    handleEvent({ type: "session", session: sess("c", { user_id: 2, updated: 999 }), seq: 3 });
    expect(sessions.value.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("当前会话：事件比详情快照旧时不覆盖当前会话对象；session 事件不会被 snapSeq 丢掉", () => {
    setCurrent("a", 10);
    handleEvent({ type: "session", session: sess("a", { title: "旧" }), seq: 9 });
    expect(chat.currentSess.value?.title).toBe("ta");
    handleEvent({ type: "session", session: sess("a", { title: "新" }), seq: 11 });
    expect(chat.currentSess.value?.title).toBe("新");
    // 但列表仍然被更新（listSeq 是 0）
    expect(sessions.value.find((s) => s.id === "a")?.title).toBe("新");
  });

  it("当前会话变成不在运行：实时回复清空", () => {
    setCurrent("a", 0);
    handleEvent({ type: "delta", session_id: "a", text: "x", seq: 1 });
    expect(chat.liveActive.value).toBe(true);
    handleEvent({ type: "session", session: sess("a", { running: true }), seq: 2 });
    expect(chat.liveActive.value).toBe(true);
    handleEvent({ type: "session", session: sess("a", { running: false }), seq: 3 });
    expect(chat.liveActive.value).toBe(false);
    expect(chat.liveText.value).toBe("");
  });

  it("没有 seq 的 session 事件两个 stale 判断都不触发", () => {
    listSeq.value = 99;
    setCurrent("a", 99);
    handleEvent({ type: "session", session: sess("a", { title: "无序号" }) });
    expect(sessions.value[0].title).toBe("无序号");
    expect(chat.currentSess.value?.title).toBe("无序号");
  });

  it("session_deleted：从列表移除；删的是当前会话则清空并回到首页", () => {
    history.replaceState(null, "", "/s/a");
    sessions.value = [sess("a"), sess("b")];
    setCurrent("a", 0);
    handleEvent({ type: "session_deleted", session_id: "b" });
    expect(sessions.value.map((s) => s.id)).toEqual(["a"]);
    expect(chat.current.value).toBe("a");
    handleEvent({ type: "session_deleted", session_id: "a" });
    expect(sessions.value).toEqual([]);
    expect(chat.current.value).toBeNull();
    expect(location.pathname).toBe("/");
  });
});

describe("实时回复", () => {
  it("用户消息开启新的实时回复并重置思考块展开状态；助手消息结束实时回复；event 消息不影响", () => {
    setCurrent("a", 0);
    chat.thinkOpen.value = true;
    handleEvent({ type: "message", session_id: "a", message: msg(1, "user"), seq: 1 });
    expect(chat.liveActive.value).toBe(true);
    expect(chat.thinkOpen.value).toBe(false);
    handleEvent({ type: "tool", session_id: "a", name: "Bash", detail: "ls", seq: 2 });
    handleEvent({ type: "message", session_id: "a", message: msg(2, "event"), seq: 3 });
    expect(chat.liveActive.value).toBe(true);
    expect(chat.liveTools.value).toEqual([{ name: "Bash", detail: "ls" }]);
    handleEvent({ type: "message", session_id: "a", message: msg(3, "assistant"), seq: 4 });
    expect(chat.liveActive.value).toBe(false);
    expect(chat.liveTools.value).toEqual([]);
  });

  it("delta_reset 清掉文字和思考，保留工具步骤", () => {
    setCurrent("a", 0);
    handleEvent({ type: "tool", session_id: "a", name: "Read", detail: "x", seq: 1 });
    handleEvent({ type: "delta", session_id: "a", text: "abc", seq: 2 });
    handleEvent({ type: "thinking", session_id: "a", text: "嗯", seq: 3 });
    handleEvent({ type: "delta_reset", session_id: "a", seq: 4 });
    expect(chat.liveText.value).toBe("");
    expect(chat.liveThinking.value).toBe("");
    expect(chat.liveTools.value.length).toBe(1);
  });

  it("thinking 累加；delta 在没有实时回复时自己建一个", () => {
    setCurrent("a", 0);
    handleEvent({ type: "thinking", session_id: "a", text: "甲", seq: 1 });
    handleEvent({ type: "thinking", session_id: "a", text: "乙", seq: 2 });
    expect(chat.liveThinking.value).toBe("甲乙");
    expect(chat.liveActive.value).toBe(true);
  });
});

describe("resync", () => {
  it("收到 resync 重取会话列表和当前会话", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(url === "/api/sessions?limit=200" ? [] : { seq: 7, session: sess("a"), messages: [], has_more: false, live: null, approvals: [] }), { status: 200 });
    }));
    setCurrent("a", 3);
    handleEvent({ type: "resync" });
    await vi.waitFor(() => expect(chat.snapSeq.value).toBe(7));
    expect(calls).toContain("/api/sessions?limit=200");
    expect(calls).toContain("/api/sessions/a");
    vi.unstubAllGlobals();
  });
});

// ---------- 连接：假的 EventSource ----------

class FakeES {
  static all: FakeES[] = [];
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(public url: string) { FakeES.all.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  emit(ev: ServerEvent, id = "") { this.onmessage?.({ data: JSON.stringify(ev), lastEventId: id } as MessageEvent); }
}

describe("连接和重连", () => {
  beforeEach(() => {
    FakeES.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  });
  afterEach(() => {
    disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("首次连接不带 last_id；记下事件 id；出错显示“重新连接中”", async () => {
    const { token } = await import("./auth");
    token.value = "tok";
    connect();
    const es = FakeES.all[0];
    expect(es.url).toBe("/api/events");
    es.onopen?.();
    expect(conn.value).toBe("open");
    es.emit({ type: "delta", session_id: "zz", text: "x", seq: 5 }, "BOOT-5");
    expect(lastEventId.value).toBe("BOOT-5");
    es.onerror?.();
    expect(conn.value).toBe("reconnecting");
  });

  it("连接彻底断开（readyState 2）且有令牌：3 秒后手动重连并带上 last_id", async () => {
    const { token } = await import("./auth");
    token.value = "tok";
    connect();
    const es = FakeES.all[0];
    es.emit({ type: "delta", session_id: "zz", text: "x", seq: 5 }, "BOOT-5");
    es.readyState = 2;
    es.onerror?.();
    expect(FakeES.all.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(FakeES.all.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeES.all.length).toBe(2);
    expect(es.closed).toBe(true);
    expect(FakeES.all[1].url).toBe("/api/events?last_id=BOOT-5");
  });

  it("没有令牌时不手动重连", async () => {
    const { token } = await import("./auth");
    token.value = "";
    connect();
    const es = FakeES.all[0];
    es.readyState = 2;
    es.onerror?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeES.all.length).toBe(1);
  });

  it("只有第一次连上才整体重拉；之后的重连（浏览器自动重连）不重拉", async () => {
    const { token } = await import("./auth");
    token.value = "tok";
    const f = vi.mocked(fetch);
    connect();
    const es = FakeES.all[0];
    es.onopen?.();
    const after1 = f.mock.calls.filter((c) => c[0] === "/api/sessions?limit=200").length;
    expect(after1).toBe(1);
    es.onerror?.();
    es.onopen?.();
    expect(f.mock.calls.filter((c) => c[0] === "/api/sessions?limit=200").length).toBe(1);
  });

  it("手动重连但还没收到过事件（没有 last_id）：重连后整体重拉", async () => {
    const { token } = await import("./auth");
    token.value = "tok";
    const f = vi.mocked(fetch);
    connect();
    FakeES.all[0].onopen?.();
    FakeES.all[0].readyState = 2;
    FakeES.all[0].onerror?.();
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeES.all[1].url).toBe("/api/events");
    FakeES.all[1].onopen?.();
    expect(f.mock.calls.filter((c) => c[0] === "/api/sessions?limit=200").length).toBe(2);
  });

  it("断开后不再重连", async () => {
    const { token } = await import("./auth");
    token.value = "tok";
    connect();
    FakeES.all[0].readyState = 2;
    FakeES.all[0].onerror?.();
    disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeES.all.length).toBe(1);
    expect(conn.value).toBe("idle");
  });
});
