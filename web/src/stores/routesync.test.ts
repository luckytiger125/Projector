import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../lib/types";
import { loc, replace, startRouter, stopRouter } from "../router";
import { me } from "./auth";
import * as chat from "./chat";
import { syncRoute } from "./routesync";
import { sessions } from "./sessions";
import { toasts } from "./ui";

const sess = (id: string): Session => ({ id, title: "t", user_id: 1, created: 1, updated: 1 }) as Session;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

beforeEach(() => {
  me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
  sessions.value = [];
  chat.resetChat();
  history.replaceState(null, "", "/s/new");
  stopRouter(); startRouter();
});
afterEach(() => { vi.unstubAllGlobals(); stopRouter(); });

describe("路由同步", () => {
  it("/s/{id}：取会话；current 已经是它就不再取", async () => {
    const f = vi.fn(async (url: string) => json(url.endsWith("/links") ? [] : { seq: 1, session: sess("a"), messages: [], has_more: false, live: null, approvals: [] }));
    vi.stubGlobal("fetch", f);
    await syncRoute({ name: "session", id: "a" });
    expect(chat.current.value).toBe("a");
    expect(f).toHaveBeenCalledTimes(2);
    await syncRoute({ name: "session", id: "a" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("新建会话：ensureSession 设好 current 并把网址从 /s/new 换成 /s/{id}，路由同步不会重复取", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sessions" && init?.method === "POST") return json(sess("n1"));
      return json({});
    });
    vi.stubGlobal("fetch", f);
    const hist = history.length;
    const id = await chat.ensureSession("你好");
    expect(id).toBe("n1");
    expect(chat.current.value).toBe("n1");
    expect(location.pathname).toBe("/s/n1");
    expect(history.length).toBe(hist);   // replace，不堆历史
    expect(loc.value.route).toEqual({ name: "session", id: "n1" });
    expect(sessions.value.map((s) => s.id)).toEqual(["n1"]);
    const calls = f.mock.calls.length;
    await syncRoute(loc.value.route);   // 路由变化触发的同步
    expect(f.mock.calls.length).toBe(calls);
    expect(chat.current.value).toBe("n1");
  });

  it("会话不存在：提示并 replace 到首页", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "会话不存在" }, 404)));
    replace("/s/zzz", { force: true });
    await syncRoute({ name: "session", id: "zzz" });
    expect(toasts.value.at(-1)).toMatchObject({ text: "会话不存在", kind: "err" });
    expect(location.pathname).toBe("/");
    expect(chat.current.value).toBeNull();
  });

  it("回到首页 / 新会话：清空当前会话", async () => {
    chat.current.value = "a";
    chat.messages.value = [{ id: 1, role: "user", content: "x", created: 1 }];
    await syncRoute({ name: "home" });
    expect(chat.current.value).toBeNull();
    expect(chat.messages.value).toEqual([]);
  });
});

describe("取快照期间的事件缓冲", () => {
  it("快照之后产生的事件不丢，快照之前的被丢掉", async () => {
    const { handleEvent } = await import("./events");
    let resolve!: (r: Response) => void;
    const f = vi.fn((url: string) => url.endsWith("/links") ? Promise.resolve(json([])) : new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", f);
    const p = chat.openSession("a");
    // 取快照期间到达的事件
    handleEvent({ type: "delta", session_id: "a", text: "旧", seq: 9 });
    handleEvent({ type: "delta", session_id: "a", text: "新", seq: 12 });
    handleEvent({ type: "session", session: { ...sess("a"), title: "更新后", running: true }, seq: 13 });
    expect(chat.liveText.value).toBe("");   // 还没应用
    resolve(json({ seq: 10, session: sess("a"), messages: [], has_more: false, live: { text: "快照里的", thinking: "", tools: [] }, approvals: [] }));
    await p;
    expect(chat.liveText.value).toBe("快照里的新");   // seq 9 被丢，seq 12 追加
    expect(chat.currentSess.value?.title).toBe("更新后");
    expect(chat.eventBuffer.sid).toBeNull();
  });

  it("取失败：缓冲清掉，不残留", async () => {
    const { handleEvent } = await import("./events");
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "没有" }, 404)));
    const p = chat.openSession("b");
    handleEvent({ type: "delta", session_id: "b", text: "x", seq: 5 });
    await expect(p).rejects.toThrow("没有");
    expect(chat.eventBuffer.sid).toBeNull();
    expect(chat.eventBuffer.events).toEqual([]);
  });

  it("别的会话的事件不进缓冲", async () => {
    const { handleEvent } = await import("./events");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    void chat.openSession("a");
    handleEvent({ type: "delta", session_id: "zz", text: "x", seq: 5 });
    expect(chat.eventBuffer.events).toEqual([]);
  });
});
