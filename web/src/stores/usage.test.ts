import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replace, startRouter, stopRouter } from "../router";
import { me } from "./auth";
import { data, error, loadUsage, range, startUsageSync, state, usageQuery } from "./usage";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("用量查询串", () => {
  it("本月不带参数；全部是 all=true；上月是上个月 1 号到最后一天", () => {
    const now = new Date(2026, 10, 11);   // 2026-11-11
    expect(usageQuery("month", now)).toBe("");
    expect(usageQuery("all", now)).toBe("all=true");
    expect(usageQuery("last", now)).toBe("from=2026-10-01&to=2026-10-31");
  });
  it("一月份的上月是去年十二月；三月份的上月是二月（闰年二十九天）", () => {
    expect(usageQuery("last", new Date(2026, 0, 5))).toBe("from=2025-12-01&to=2025-12-31");
    expect(usageQuery("last", new Date(2028, 2, 1))).toBe("from=2028-02-01&to=2028-02-29");
  });
});

describe("用量加载", () => {
  const calls: string[] = [];
  let turnsFail = false;
  let stop: () => void;
  beforeEach(() => {
    calls.length = 0; turnsFail = false;
    me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
    history.replaceState(null, "", "/");
    stopRouter(); startRouter();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith("/api/usage/me/turns")) return turnsFail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify([{ session_title: "会话", preview: "p" }]), { status: 200 });
      if (url.includes("all=true")) return new Response(JSON.stringify({ detail: "出错了" }), { status: 500 });
      return new Response(JSON.stringify({ has_data: true, total: { input: 5 } }), { status: 200 });
    }));
    stop = startUsageSync();
  });
  afterEach(() => { stop(); stopRouter(); vi.unstubAllGlobals(); });

  it("进入 /usage 自动取本月，并带上最近 20 轮", async () => {
    replace("/usage", { force: true });
    await wait();
    expect(range.value).toBe("month");
    expect(state.value).toBe("ok");
    expect(calls).toEqual(["/api/usage/me", "/api/usage/me/turns?limit=20"]);
    expect(data.value?.turns[0].session_title).toBe("会话");
  });
  it("最近 20 轮取不到不影响汇总；汇总失败显示错误文案", async () => {
    turnsFail = true;
    await loadUsage("last");
    expect(state.value).toBe("ok");
    expect(data.value?.turns).toEqual([]);
    expect(calls[0]).toMatch(/^\/api\/usage\/me\?from=\d{4}-\d{2}-01&to=/);
    await loadUsage("all");
    expect(state.value).toBe("error");
    expect(error.value).toBe("出错了");
  });
  it("先后点了两个页签：只认最后一次的结果", async () => {
    const a = loadUsage("last");
    const b = loadUsage("month");
    await Promise.all([a, b]);
    expect(range.value).toBe("month");
    expect(state.value).toBe("ok");
  });
});
