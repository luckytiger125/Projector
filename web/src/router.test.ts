import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLeaveGuard, back, closeOverlay, isOverlay, loc, mainRoute, navigate, overlayRoute, parsePath, parseRoute,
  replace, routeToPath, startRouter, stopRouter, type Route,
} from "./router";

describe("parseRoute", () => {
  it("基本路径", () => {
    expect(parseRoute("/")).toEqual({ name: "home" });
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("/board")).toEqual({ name: "board" });
    expect(parseRoute("/s/new")).toEqual({ name: "new" });
    expect(parseRoute("/s/abc123")).toEqual({ name: "session", id: "abc123" });
    expect(parseRoute("/s/abc123/steps")).toEqual({ name: "steps", id: "abc123" });
  });
  it("忽略多余的斜杠", () => {
    expect(parseRoute("/s/abc/")).toEqual({ name: "session", id: "abc" });
    expect(parseRoute("//board//")).toEqual({ name: "board" });
  });
  it("文件库", () => {
    expect(parseRoute("/files")).toEqual({ name: "files" });
    expect(parseRoute("/files", "?path=" + encodeURIComponent("D:\\报告\\a b.md"))).toEqual({ name: "files", path: "D:\\报告\\a b.md" });
    expect(parseRoute("/files/trash")).toEqual({ name: "files", trash: true });
  });
  it("知识库", () => {
    expect(parseRoute("/kb")).toEqual({ name: "kb", tab: "home" });
    expect(parseRoute("/kb/notes")).toEqual({ name: "kb", tab: "notes" });
    expect(parseRoute("/kb/notes", "?note=" + encodeURIComponent("团队/规范 1.md"))).toEqual({ name: "kb", tab: "notes", note: "团队/规范 1.md" });
    expect(parseRoute("/kb/graph")).toEqual({ name: "kb", tab: "graph" });
    expect(parseRoute("/kb/graph", "?note=x")).toEqual({ name: "kb", tab: "graph" });
    expect(parseRoute("/kb/other")).toEqual({ name: "notfound" });
  });
  it("技能、用量、手机", () => {
    expect(parseRoute("/skills")).toEqual({ name: "skills" });
    expect(parseRoute("/skills/" + encodeURIComponent("周报 助手"))).toEqual({ name: "skills", skill: "周报 助手" });
    expect(parseRoute("/usage")).toEqual({ name: "usage" });
    expect(parseRoute("/mobile")).toEqual({ name: "mobile" });
  });
  it("管理后台：缺省页签是 users，未知页签是 notfound", () => {
    expect(parseRoute("/admin")).toEqual({ name: "admin", tab: "users" });
    expect(parseRoute("/admin/settings")).toEqual({ name: "admin", tab: "settings" });
    expect(parseRoute("/admin/nope")).toEqual({ name: "notfound" });
  });
  it("不认识的路径、坏的编码、带点或斜杠的会话 id", () => {
    expect(parseRoute("/nope")).toEqual({ name: "notfound" });
    expect(parseRoute("/api/me")).toEqual({ name: "notfound" });
    expect(parseRoute("/s/%E0%A4%A")).toEqual({ name: "notfound" });
    expect(parseRoute("/s/a.b")).toEqual({ name: "notfound" });
    expect(parseRoute("/s/new/steps")).toEqual({ name: "notfound" });
    expect(parseRoute("/s")).toEqual({ name: "notfound" });
    expect(parseRoute("/usage/x")).toEqual({ name: "notfound" });
  });
});

describe("routeToPath", () => {
  const cases: Route[] = [
    { name: "home" }, { name: "board" }, { name: "new" }, { name: "session", id: "ab12" }, { name: "steps", id: "ab12" },
    { name: "files" }, { name: "files", path: "D:\\报告\\a b&c.md" }, { name: "files", trash: true },
    { name: "kb", tab: "home" }, { name: "kb", tab: "notes" }, { name: "kb", tab: "notes", note: "团队/规范?1" }, { name: "kb", tab: "graph" },
    { name: "skills" }, { name: "skills", skill: "周报 助手" }, { name: "usage" }, { name: "mobile" },
    { name: "admin", tab: "users" }, { name: "admin", tab: "settings" },
  ];
  it("生成后再解析得到同一个路由", () => {
    for (const r of cases) expect(parsePath(routeToPath(r)), routeToPath(r)).toEqual(r);
  });
  it("具体写法", () => {
    expect(routeToPath({ name: "session", id: "x" })).toBe("/s/x");
    expect(routeToPath({ name: "steps", id: "x" })).toBe("/s/x/steps");
    expect(routeToPath({ name: "files", path: "a b" })).toBe("/files?path=a%20b");
    expect(routeToPath({ name: "kb", tab: "notes", note: "n" })).toBe("/kb/notes?note=n");
    expect(routeToPath({ name: "notfound" })).toBe("/");
  });
  it("令牌之类的东西不会出现在路径里（路径只由路由字段生成）", () => {
    expect(routeToPath({ name: "files", path: "x" })).not.toMatch(/token/i);
  });
});

describe("isOverlay", () => {
  it("弹层类和主界面类", () => {
    for (const n of ["steps", "files", "kb", "skills", "usage", "mobile", "admin"]) expect(isOverlay({ name: n } as Route)).toBe(true);
    for (const n of ["home", "board", "new", "session", "notfound"]) expect(isOverlay({ name: n } as Route)).toBe(false);
  });
});

// ---------- 带 History API 的行为 ----------

function reset(path = "/") {
  history.replaceState(null, "", path);
  stopRouter();
  startRouter();
}

describe("navigate / replace / closeOverlay（jsdom 的 History API）", () => {
  beforeEach(() => reset("/"));
  afterEach(() => stopRouter());

  it("navigate 更新 location 和路由", () => {
    navigate("/s/abc");
    expect(location.pathname).toBe("/s/abc");
    expect(loc.value.route).toEqual({ name: "session", id: "abc" });
    expect(mainRoute.value).toEqual({ name: "session", id: "abc" });
    expect(overlayRoute.value).toBeNull();
  });

  it("从主界面打开弹层：记下背景，主界面路由仍是背景", () => {
    navigate("/s/abc");
    navigate("/kb");
    expect(loc.value.state.bg).toBe("/s/abc");
    expect(mainRoute.value).toEqual({ name: "session", id: "abc" });
    expect(overlayRoute.value).toEqual({ name: "kb", tab: "home" });
  });

  it("弹层里换弹层：背景沿用；弹层内部 replace 不堆历史", () => {
    navigate("/s/abc");
    navigate("/files");
    const idx = loc.value.state.idx;
    replace({ name: "files", path: "D:\\x" });
    expect(loc.value.state.idx).toBe(idx);
    expect(loc.value.state.bg).toBe("/s/abc");
    navigate("/kb");
    expect(loc.value.state.bg).toBe("/s/abc");
  });

  it("刷新后弹层和背景还原：history.state 里的 bg 还在", () => {
    navigate("/s/abc");
    navigate("/kb/graph");
    stopRouter();
    startRouter();   // 相当于刷新后重新读取
    expect(loc.value.route).toEqual({ name: "kb", tab: "graph" });
    expect(mainRoute.value).toEqual({ name: "session", id: "abc" });
  });

  it("直接打开弹层（没有 bg）：背景是值班板；步骤记录的背景是它的会话", () => {
    reset("/kb");
    expect(mainRoute.value).toEqual({ name: "home" });
    reset("/s/xyz/steps");
    expect(mainRoute.value).toEqual({ name: "session", id: "xyz" });
  });

  it("关闭弹层：从应用里点开的是后退", async () => {
    navigate("/s/abc");
    navigate("/kb");
    const before = history.length;
    const popped = new Promise<void>((res) => window.addEventListener("popstate", () => res(), { once: true }));
    closeOverlay();
    await popped;
    expect(location.pathname).toBe("/s/abc");
    expect(history.length).toBe(before);   // 没有新增历史
    expect(overlayRoute.value).toBeNull();
  });

  it("关闭弹层：直接打开的是 replace 到背景，不后退出应用", () => {
    reset("/files");
    const before = history.length;
    closeOverlay();
    expect(location.pathname).toBe("/");
    expect(history.length).toBe(before);
    expect(overlayRoute.value).toBeNull();
  });

  it("后退和前进：popstate 后路由跟着变", async () => {
    navigate("/s/a");
    navigate("/s/b");
    const popped = () => new Promise<void>((res) => window.addEventListener("popstate", () => res(), { once: true }));
    let p = popped(); back(); await p;
    expect(loc.value.route).toEqual({ name: "session", id: "a" });
    p = popped(); history.forward(); await p;
    expect(loc.value.route).toEqual({ name: "session", id: "b" });
  });

  it("同一个地址再 navigate 不会堆历史", () => {
    navigate("/s/a");
    const n = history.length;
    navigate("/s/a");
    expect(history.length).toBe(n);
  });

  it("离开守卫：拦住 navigate、closeOverlay（replace 路径）", () => {
    reset("/kb/notes");
    let allow = false;
    const off = addLeaveGuard(() => allow);
    expect(navigate("/s/a")).toBe(false);
    expect(closeOverlay()).toBe(false);
    expect(location.pathname).toBe("/kb/notes");
    allow = true;
    expect(closeOverlay()).toBe(true);
    expect(location.pathname).toBe("/");
    off();
  });

  it("离开守卫：拦住后退键，位置回到原处", async () => {
    navigate("/s/a");
    navigate("/kb/notes");
    const calls: string[] = [];
    const off = addLeaveGuard((to) => { calls.push(to); return false; });
    const popped = (n: number) => new Promise<void>((res) => {
      let k = 0;
      const h = () => { if (++k >= n) { window.removeEventListener("popstate", h); res(); } };
      window.addEventListener("popstate", h);
    });
    const p = popped(2);   // 一次后退 + 拦截后走回去
    back();
    await p;
    expect(calls).toEqual(["/s/a"]);
    expect(location.pathname).toBe("/kb/notes");
    expect(loc.value.route).toEqual({ name: "kb", tab: "notes" });
    off();
  });

  it("closeOverlay 走后退时守卫只问一次", async () => {
    navigate("/s/a");
    navigate("/kb/notes");
    let n = 0;
    const off = addLeaveGuard(() => { n++; return true; });
    const p = new Promise<void>((res) => window.addEventListener("popstate", () => res(), { once: true }));
    closeOverlay();
    await p;
    expect(n).toBe(1);
    off();
  });
});
